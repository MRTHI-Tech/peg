"""Durable, workspace-scoped canvas documents.

A workflow is one JSON object in B2. The graph is intentionally stored as the
UI-shaped document: Genblaze consumes one node at a time, while this record's
job is to restore the editor exactly as the user left it.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from botocore.exceptions import ClientError

import runner


WORKFLOW_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MAX_WORKFLOWS = 100


class WorkflowError(RuntimeError):
    pass


class WorkflowNotFound(WorkflowError):
    pass


def validate_id(workflow_id: str) -> str:
    value = workflow_id.strip()
    if not WORKFLOW_ID.fullmatch(value):
        raise WorkflowError("invalid workflow id")
    return value


def workflow_prefix(workspace: str) -> str:
    return f"{runner.workspace_prefix(workspace)}/workflows"


def workflow_key(workspace: str, workflow_id: str) -> str:
    return f"{workflow_prefix(workspace)}/{validate_id(workflow_id)}/workflow.json"


def _is_missing(exc: ClientError) -> bool:
    code = str(exc.response.get("Error", {}).get("Code", ""))
    return code in {"404", "NoSuchKey", "NotFound"}


def _read(workspace: str, workflow_id: str) -> dict[str, Any]:
    try:
        raw = runner.fetch_object(workflow_key(workspace, workflow_id))
    except ClientError as exc:
        if _is_missing(exc):
            raise WorkflowNotFound("workflow not found") from exc
        raise

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise WorkflowError("stored workflow is not valid JSON") from exc
    if not isinstance(data, dict):
        raise WorkflowError("stored workflow is not an object")
    return data


def _refresh_asset_urls(document: dict[str, Any], workspace: str) -> None:
    """Replace expiring URLs without allowing a document to sign another workspace."""
    owned_prefix = f"{runner.workspace_prefix(workspace)}/"
    thumbnail: str | None = None
    for node in document.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        result = node.get("result")
        if not isinstance(result, dict):
            continue
        key = result.get("assetKey")
        if isinstance(key, str) and key.startswith(owned_prefix):
            result["url"] = runner.presign(key)
        if isinstance(result.get("url"), str) and result["url"]:
            thumbnail = result["url"]
    if thumbnail:
        document["thumbnailUrl"] = thumbnail


def load_workflow(workspace: str, workflow_id: str) -> dict[str, Any]:
    document = _read(workspace, workflow_id)
    _refresh_asset_urls(document, workspace)
    return document


def save_workflow(
    workspace: str, workflow_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    workflow_id = validate_id(workflow_id)
    if payload.get("id") != workflow_id:
        raise WorkflowError("workflow id does not match the request path")

    nodes = payload.get("nodes")
    edges = payload.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise WorkflowError("workflow nodes and edges must be arrays")

    document = dict(payload)
    document.update(
        {
            "id": workflow_id,
            "name": str(payload.get("name") or "Untitled project").strip()[:200]
            or "Untitled project",
            "nodes": nodes,
            "edges": edges,
            "nodeCount": len(nodes),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "version": 1,
        }
    )
    runner._s3().put_object(
        Bucket=runner._bucket(),
        Key=workflow_key(workspace, workflow_id),
        Body=json.dumps(document, separators=(",", ":")).encode(),
        ContentType="application/json",
    )
    _refresh_asset_urls(document, workspace)
    return document


def list_workflows(workspace: str, limit: int = MAX_WORKFLOWS) -> list[dict[str, Any]]:
    """List editable projects, newest first.

    B2 cannot query document fields, so each workflow JSON object is read, then
    reduced to card metadata before it crosses the API boundary.
    This is intentionally capped; a database/index becomes worthwhile before a
    workspace grows beyond this MVP-scale project count.
    """
    prefix = f"{workflow_prefix(workspace)}/"
    paginator = runner._s3().get_paginator("list_objects_v2")
    documents: list[dict[str, Any]] = []

    for page in paginator.paginate(Bucket=runner._bucket(), Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj.get("Key", "")
            if not key.endswith("/workflow.json"):
                continue
            rest = key[len(prefix) :].split("/")
            if len(rest) != 2 or rest[1] != "workflow.json":
                continue
            try:
                document = _read(workspace, rest[0])
            except (WorkflowError, ClientError):
                # One corrupt/orphaned document must not make every project vanish.
                continue
            nodes = document.get("nodes") if isinstance(document.get("nodes"), list) else []
            summary: dict[str, Any] = {
                "id": document.get("id", rest[0]),
                "name": document.get("name", "Untitled project"),
                # Keep the response compatible with WorkflowCard without sending
                # every parameter or multi-megabyte inline reference to the grid.
                "nodes": [],
                "edges": [],
                "nodeCount": len(nodes),
                "updatedAt": document.get("updatedAt", ""),
                "version": document.get("version", 1),
            }
            owned_prefix = f"{runner.workspace_prefix(workspace)}/"
            for node in reversed(nodes):
                result = node.get("result") if isinstance(node, dict) else None
                key = result.get("assetKey") if isinstance(result, dict) else None
                if isinstance(key, str) and key.startswith(owned_prefix):
                    summary["thumbnailUrl"] = runner.presign(key)
                    break
            documents.append(summary)

    documents.sort(key=lambda item: str(item.get("updatedAt", "")), reverse=True)
    return documents[:limit]
