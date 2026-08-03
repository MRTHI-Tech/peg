from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import runner  # noqa: E402
import workflows  # noqa: E402


def missing() -> ClientError:
    return ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")


class WorkflowStorageTests(unittest.TestCase):
    def test_workflow_keys_are_scoped_to_the_workspace(self) -> None:
        self.assertNotEqual(
            workflows.workflow_key("org_a", "wf_1"),
            workflows.workflow_key("org_b", "wf_1"),
        )
        self.assertTrue(
            workflows.workflow_key("org_a", "wf_1").startswith(
                f"{runner.workspace_prefix('org_a')}/"
            )
        )

    def test_ids_cannot_escape_the_workflow_prefix(self) -> None:
        for value in ("../other", "a/b", "", "spaces are not ids"):
            with self.assertRaises(workflows.WorkflowError):
                workflows.workflow_key("org_a", value)

    def test_save_derives_counts_and_server_timestamp(self) -> None:
        client = mock.Mock()
        payload = {
            "id": "wf_1",
            "name": " Campaign ",
            "nodes": [{"id": "n1"}],
            "edges": [],
            "updatedAt": "old",
            "nodeCount": 99,
        }
        with (
            mock.patch.object(runner, "_s3", return_value=client),
            mock.patch.object(runner, "_bucket", return_value="bucket"),
        ):
            saved = workflows.save_workflow("org_a", "wf_1", payload)

        self.assertEqual(saved["name"], "Campaign")
        self.assertEqual(saved["nodeCount"], 1)
        self.assertNotEqual(saved["updatedAt"], "old")
        body = json.loads(client.put_object.call_args.kwargs["Body"])
        self.assertEqual(body["nodes"], [{"id": "n1"}])

    def test_load_refreshes_owned_asset_urls_and_thumbnail(self) -> None:
        key = f"{runner.workspace_prefix('org_a')}/runs/day/run/assets/output.png"
        document = {
            "id": "wf_1",
            "name": "Campaign",
            "nodes": [{"id": "n1", "result": {"assetKey": key, "url": "expired"}}],
            "edges": [],
            "updatedAt": "2026-08-03T10:00:00+00:00",
            "nodeCount": 1,
        }
        with (
            mock.patch.object(runner, "fetch_object", return_value=json.dumps(document).encode()),
            mock.patch.object(runner, "presign", return_value="signed:fresh"),
        ):
            loaded = workflows.load_workflow("org_a", "wf_1")

        self.assertEqual(loaded["nodes"][0]["result"]["url"], "signed:fresh")
        self.assertEqual(loaded["thumbnailUrl"], "signed:fresh")

    def test_missing_workflow_is_distinct_from_storage_failure(self) -> None:
        with mock.patch.object(runner, "fetch_object", side_effect=missing()):
            with self.assertRaises(workflows.WorkflowNotFound):
                workflows.load_workflow("org_a", "wf_missing")

    def test_list_returns_documents_newest_first(self) -> None:
        prefix = f"{workflows.workflow_prefix('org_a')}/"
        paginator = mock.Mock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {
                        "Key": f"{prefix}wf_old/workflow.json",
                        "LastModified": datetime.now(timezone.utc),
                    },
                    {
                        "Key": f"{prefix}wf_new/workflow.json",
                        "LastModified": datetime.now(timezone.utc),
                    },
                    {"Key": f"{prefix}wf_new/other.json"},
                ]
            }
        ]
        client = mock.Mock()
        client.get_paginator.return_value = paginator
        documents = {
            "wf_old": {"id": "wf_old", "nodes": [], "edges": [], "updatedAt": "2026-08-01"},
            "wf_new": {"id": "wf_new", "nodes": [], "edges": [], "updatedAt": "2026-08-03"},
        }

        def fetch(key: str) -> bytes:
            workflow_id = key[len(prefix) :].split("/")[0]
            return json.dumps(documents[workflow_id]).encode()

        with (
            mock.patch.object(runner, "_s3", return_value=client),
            mock.patch.object(runner, "_bucket", return_value="bucket"),
            mock.patch.object(runner, "fetch_object", side_effect=fetch),
        ):
            listed = workflows.list_workflows("org_a")

        self.assertEqual([item["id"] for item in listed], ["wf_new", "wf_old"])
        self.assertEqual(listed[0]["nodes"], [])


if __name__ == "__main__":
    unittest.main()
