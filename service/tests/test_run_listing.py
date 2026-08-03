from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import runner  # noqa: E402


def obj(key: str, when: str):
    return {"Key": key, "LastModified": datetime.fromisoformat(when).replace(tzinfo=timezone.utc)}


class ListRunsTests(unittest.TestCase):
    """The gallery's empty state is real storage being empty, so this listing is
    what has to be right — not a first-run flag somewhere in the UI."""

    def _list(self, contents, workspace="org_a"):
        paginator = mock.Mock()
        paginator.paginate.return_value = [{"Contents": contents}]
        client = mock.Mock()
        client.get_paginator.return_value = paginator
        with (
            mock.patch.object(runner, "_s3", return_value=client),
            mock.patch.object(runner, "_bucket", return_value="bucket"),
            mock.patch.object(runner, "presign", side_effect=lambda k: f"signed:{k}"),
        ):
            return runner.list_runs(workspace)

    def test_a_workspace_with_no_objects_lists_nothing(self) -> None:
        self.assertEqual(self._list([]), [])

    def test_assets_of_one_run_collapse_to_a_single_entry(self) -> None:
        p = f"{runner.workspace_prefix('org_a')}/runs/2026-08-03/job_1/assets"
        got = self._list([obj(f"{p}/a.jpg", "2026-08-03T10:00"), obj(f"{p}/b.jpg", "2026-08-03T10:01")])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["asset_count"], 2)

    def test_the_newest_asset_becomes_the_thumbnail(self) -> None:
        p = f"{runner.workspace_prefix('org_a')}/runs/2026-08-03/job_1/assets"
        got = self._list([obj(f"{p}/old.jpg", "2026-08-03T10:00"), obj(f"{p}/new.jpg", "2026-08-03T12:00")])
        self.assertTrue(got[0]["asset_key"].endswith("new.jpg"))

    def test_runs_come_back_newest_first(self) -> None:
        base = f"{runner.workspace_prefix('org_a')}/runs"
        got = self._list([
            obj(f"{base}/2026-08-01/job_old/assets/a.jpg", "2026-08-01T10:00"),
            obj(f"{base}/2026-08-03/job_new/assets/a.jpg", "2026-08-03T10:00"),
        ])
        self.assertEqual([r["run_id"] for r in got], ["job_new", "job_old"])

    def test_manifests_are_not_mistaken_for_assets(self) -> None:
        base = f"{runner.workspace_prefix('org_a')}/runs/2026-08-03/job_1"
        got = self._list([obj(f"{base}/manifest.json", "2026-08-03T10:00")])
        self.assertEqual(got, [])

    def test_thumbnails_are_presigned_because_the_bucket_is_private(self) -> None:
        p = f"{runner.workspace_prefix('org_a')}/runs/2026-08-03/job_1/assets"
        got = self._list([obj(f"{p}/a.jpg", "2026-08-03T10:00")])
        self.assertTrue(got[0]["url"].startswith("signed:"))


if __name__ == "__main__":
    unittest.main()
