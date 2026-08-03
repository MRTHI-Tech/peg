from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import brand  # noqa: E402
import runner  # noqa: E402


class WorkspacePrefixTests(unittest.TestCase):
    """Every object a workspace owns hangs off its own prefix, which is what
    makes a fresh sign-in an empty state with no first-run handling anywhere."""

    def test_two_workspaces_never_share_a_brand_document(self) -> None:
        self.assertNotEqual(brand.brand_key("org_a"), brand.brand_key("org_b"))

    def test_every_brand_path_sits_under_the_workspace_prefix(self) -> None:
        prefix = runner.workspace_prefix("org_a")
        for key in (
            brand.brand_key("org_a"),
            brand.style_prefix("org_a"),
            brand.logo_prefix("org_a"),
        ):
            self.assertTrue(key.startswith(prefix), key)

    def test_workspaces_stay_under_the_projects_peg_prefix(self) -> None:
        """The bucket holds an unrelated project; PEG writes under `peg/` only."""
        self.assertTrue(runner.workspace_prefix("org_a").startswith(f"{runner.PREFIX}/"))

    def test_a_workspace_id_cannot_escape_its_prefix(self) -> None:
        for bad in ("../other", "org_a/../org_b", ""):
            with self.assertRaises(ValueError):
                runner.workspace_prefix(bad)


if __name__ == "__main__":
    unittest.main()
