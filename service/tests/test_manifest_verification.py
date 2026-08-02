from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import runner  # noqa: E402


class ManifestVerificationTests(unittest.TestCase):
    """B2 is eventually consistent, so a manifest read straight after upload can
    hash to a mismatch. Reporting a good asset as tampered with is the worst
    failure mode this feature has, so a False must survive a fresh read."""

    def setUp(self) -> None:
        self.key = "peg/runs/x/manifest.json"
        self.raw = json.dumps({"canonical_hash": "abc"}).encode()
        # Don't spend the real consistency backoff in unit tests.
        sleep = mock.patch.object(runner.time, "sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def _with_verdicts(self, *verdicts):
        """Patch parse_manifest to return the given verify() results in order."""
        results = iter(verdicts)

        def fake_parse(_payload):
            verdict = next(results)
            if isinstance(verdict, Exception):
                raise verdict
            return mock.Mock(verify=mock.Mock(return_value=verdict))

        return mock.patch.object(runner, "parse_manifest", side_effect=fake_parse)

    def test_first_read_verifying_is_believed_immediately(self) -> None:
        with self._with_verdicts(True), mock.patch.object(runner, "fetch_object") as fetch:
            self.assertIs(runner._verify_manifest(self.key, self.raw), True)
        fetch.assert_not_called()

    def test_a_stale_read_is_rechecked_before_reporting_failure(self) -> None:
        with self._with_verdicts(False, True), mock.patch.object(
            runner, "fetch_object", return_value=self.raw
        ) as fetch:
            self.assertIs(runner._verify_manifest(self.key, self.raw), True)
        fetch.assert_called_once_with(self.key)

    def test_a_genuinely_bad_manifest_still_reports_false(self) -> None:
        with self._with_verdicts(False, False, False), mock.patch.object(
            runner, "fetch_object", return_value=self.raw
        ):
            self.assertIs(runner._verify_manifest(self.key, self.raw), False)

    def test_unreadable_manifest_reports_none_not_false(self) -> None:
        """None means 'could not check' and must never render as verified."""
        with self._with_verdicts(ValueError("bad"), ValueError("bad"), ValueError("bad")), (
            mock.patch.object(runner, "fetch_object", return_value=self.raw)
        ):
            self.assertIsNone(runner._verify_manifest(self.key, self.raw))


if __name__ == "__main__":
    unittest.main()
