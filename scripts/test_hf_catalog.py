import json
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import hf_catalog


class CatalogEntryTest(unittest.TestCase):
    def test_same_sha_cache_hit_backfills_listing_fields(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/example",
            sha="same-sha",
            created_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
            last_modified=datetime(2026, 9, 5, 6, tzinfo=timezone.utc),
            downloads=42,
        )
        old = {
            "repoId": "TacVerse/example",
            "sha": "same-sha",
            "totalEpisodes": 7,
        }
        with tempfile.TemporaryDirectory() as root:
            entry = hf_catalog.build_entry(
                object(), item, Path(root), None, old, False
            )
        self.assertEqual(entry["totalEpisodes"], 7)
        self.assertEqual(entry["createdAt"], "2026-08-01T00:00:00+00:00")
        self.assertEqual(entry["lastModified"], "2026-09-05T06:00:00+00:00")
        self.assertEqual(entry["downloads"], 42)

    def test_missing_info_keeps_a_minimal_catalog_row_with_null_stats(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/no-info",
            sha="sha",
            createdAt="2026-08-01T00:00:00Z",
            lastModified="2026-09-05T06:00:00Z",
            downloads="9",
        )

        def missing_info(**_kwargs):
            raise FileNotFoundError("meta/info.json missing")

        module = types.SimpleNamespace(hf_hub_download=missing_info)
        with tempfile.TemporaryDirectory() as root, patch.dict(
            sys.modules, {"huggingface_hub": module}
        ):
            entry = hf_catalog.build_entry(
                object(), item, Path(root), "secret", None, False
            )

        self.assertEqual(entry["repoId"], "TacVerse/no-info")
        self.assertEqual(entry["metadataState"], "error")
        self.assertEqual(entry["totalEpisodes"], None)
        self.assertEqual(entry["totalFrames"], None)
        self.assertEqual(entry["durationHours"], None)
        self.assertEqual(entry["downloads"], 9)

    def test_minimal_entry_redacts_no_catalog_fields(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/broken",
            sha="broken-sha",
            createdAt=None,
            lastModified=None,
            downloads=None,
        )
        with tempfile.TemporaryDirectory() as root:
            entry = hf_catalog.minimal_entry(
                item, Path(root), "could not parse metadata"
            )
        self.assertEqual(entry["sha"], "broken-sha")
        self.assertIsNone(entry["createdAt"])
        self.assertIsNone(entry["lastModified"])
        self.assertIsNone(entry["downloads"])

    def test_detects_folder_children_and_keeps_corrupt_children_partial(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/sampledata",
            sha="folder-sha",
            createdAt=None,
            lastModified=None,
            downloads=5,
        )

        class Api:
            def list_repo_tree(self, **_kwargs):
                return [
                    types.SimpleNamespace(path="child-a", type="directory"),
                    types.SimpleNamespace(path="child-b", type="directory"),
                    types.SimpleNamespace(path="data", type="directory"),
                    types.SimpleNamespace(path="../escape", type="directory"),
                ]

            def list_repo_commits(self, **_kwargs):
                return []

        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary)

            def download(*, filename: str, **_kwargs):
                if filename == "meta/info.json":
                    raise FileNotFoundError("root info missing")
                target = temp / filename.replace("/", "-")
                if filename == "child-a/meta/info.json":
                    target.write_text(
                        '{"codebase_version":"v3.0","robot_type":"robot-a",'
                        '"total_episodes":2,"total_frames":7200,"fps":10}'
                    )
                    return str(target)
                if filename == "child-b/meta/info.json":
                    target.write_text("{broken")
                    return str(target)
                raise FileNotFoundError(filename)

            module = types.SimpleNamespace(hf_hub_download=download)
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                entry = hf_catalog.build_entry(
                    Api(), item, temp, None, None, False
                )

        self.assertEqual(entry["layout"], "folder")
        self.assertEqual(entry["metadataState"], "partial")
        self.assertEqual([child["name"] for child in entry["children"]], [
            "child-a",
            "child-b",
        ])
        self.assertEqual(entry["children"][0]["totalEpisodes"], 2)
        self.assertEqual(entry["children"][0]["durationHours"], 0.2)
        self.assertEqual(entry["children"][1]["metadataState"], "error")

    def test_local_snapshot_folder_probe_skips_remote_tree_and_reports_progress(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/sampledata",
            sha="folder-sha",
            createdAt=None,
            lastModified=None,
            downloads=5,
        )

        class Api:
            def list_repo_tree(self, **_kwargs):
                raise AssertionError("cached Folder should not list the remote tree")

            def list_repo_commits(self, **_kwargs):
                return []

        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as cache:
            snapshot = (
                Path(cache)
                / "datasets--TacVerse--sampledata"
                / "snapshots"
                / "folder-sha"
            )
            for name, episodes in (("child-a", 2), ("child-b", 3)):
                info = snapshot / name / "meta" / "info.json"
                info.parent.mkdir(parents=True)
                info.write_text(
                    json.dumps({"total_episodes": episodes, "total_frames": 20, "fps": 10})
                )

            def download(*, filename: str, local_files_only: bool = False, **_kwargs):
                if not local_files_only:
                    raise AssertionError("cached metadata should not use the Hub")
                return str(snapshot / filename)

            module = types.SimpleNamespace(hf_hub_download=download)
            progress = []
            with patch.dict(
                sys.modules, {"huggingface_hub": module}
            ), patch.dict("os.environ", {"HF_HUB_CACHE": cache}):
                entry = hf_catalog.build_entry(
                    Api(), item, Path(root), None, None, False,
                    lambda *event: progress.append(event),
                )

        self.assertEqual(entry["layout"], "folder")
        self.assertEqual(len(entry["children"]), 2)
        self.assertEqual(progress[-1][0:2], (2, 2))

    def test_old_catalog_versions_force_same_sha_layout_reprobe(self) -> None:
        old = {
            "org": "TacVerse",
            "datasets": [{"repoId": "TacVerse/sampledata", "sha": "same"}],
        }
        current = {
            "catalogVersion": hf_catalog.CATALOG_VERSION,
            "datasets": [{"repoId": "TacVerse/sampledata", "sha": "same"}],
        }
        self.assertEqual(hf_catalog.reusable_cache_entries(old), {})
        self.assertEqual(
            hf_catalog.reusable_cache_entries(current)["TacVerse/sampledata"][
                "sha"
            ],
            "same",
        )


if __name__ == "__main__":
    unittest.main()
