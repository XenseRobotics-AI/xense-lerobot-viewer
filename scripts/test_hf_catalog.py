import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import hf_catalog


class CatalogEntryTest(unittest.TestCase):
    def test_storage_falls_back_to_repository_detail_when_listing_omits_it(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/example",
            sha="same-sha",
            createdAt=None,
            lastModified=None,
            downloads=0,
        )

        class Api:
            def dataset_info(self, **kwargs):
                self.kwargs = kwargs
                return types.SimpleNamespace(used_storage=1234)

        with tempfile.TemporaryDirectory() as root:
            entry = hf_catalog.build_entry(
                Api(),
                item,
                Path(root),
                "token",
                None,
                False,
            )
        self.assertEqual(entry["storageBytes"], 1234)

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

    def test_folder_lists_only_safe_direct_child_names_without_metadata_downloads(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/sampledata", sha="folder-sha", createdAt=None,
            lastModified=None, downloads=5,
        )
        calls = []

        class Api:
            def list_repo_tree(self, **kwargs):
                calls.append({"tree": kwargs})
                return [
                    types.SimpleNamespace(path="child-a", type="directory"),
                    types.SimpleNamespace(path="child-b", type="directory"),
                    types.SimpleNamespace(path="data", type="directory"),
                    types.SimpleNamespace(path="nested/child", type="directory"),
                    types.SimpleNamespace(path="../escape", type="directory"),
                ]

            def list_repo_commits(self, **_kwargs):
                return []

        def download(*, filename: str, revision=None, **_kwargs):
            calls.append({"download": filename, "revision": revision})
            raise FileNotFoundError(filename)

        module = types.SimpleNamespace(hf_hub_download=download)
        with tempfile.TemporaryDirectory() as root, patch.dict(
            sys.modules, {"huggingface_hub": module}
        ):
            entry = hf_catalog.build_entry(
                Api(), item, Path(root), None, None, False
            )

        self.assertEqual(entry["layout"], "folder")
        self.assertEqual(entry["metadataState"], "ok")
        self.assertEqual(entry["children"], [
            {"name": "child-a", "path": "child-a"},
            {"name": "child-b", "path": "child-b"},
        ])
        self.assertEqual(
            [call["download"] for call in calls if "download" in call],
            ["meta/info.json", "meta/info.json"],
        )
        self.assertEqual(calls[-1]["tree"]["revision"], "folder-sha")


    def test_folder_tree_listing_uses_exact_revision_and_reports_progress(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/sampledata",
            sha="folder-sha",
            createdAt=None,
            lastModified=None,
            downloads=5,
        )
        tree_calls = []

        class Api:
            def list_repo_tree(self, **kwargs):
                tree_calls.append(kwargs)
                return [
                    types.SimpleNamespace(path="child-a", type="directory"),
                    types.SimpleNamespace(path="child-b", type="directory"),
                ]

            def list_repo_commits(self, **_kwargs):
                return []

        def download(*, filename: str, **_kwargs):
            raise FileNotFoundError(filename)

        module = types.SimpleNamespace(hf_hub_download=download)
        progress = []
        with tempfile.TemporaryDirectory() as root, patch.dict(
            sys.modules, {"huggingface_hub": module}
        ):
            entry = hf_catalog.build_entry(
                Api(), item, Path(root), None, None, False,
                lambda *event: progress.append(event),
            )

        self.assertEqual(entry["layout"], "folder")
        self.assertEqual(len(entry["children"]), 2)
        self.assertEqual(tree_calls[0]["revision"], "folder-sha")
        self.assertEqual(progress[-1][0:2], (2, 2))

    def test_new_sha_reads_new_info_instead_of_stale_main_cache(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/example", sha="new-sha", createdAt=None,
            lastModified=None, downloads=0,
        )
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary)
            old = temp / "old.json"
            new = temp / "new.json"
            old.write_text('{"total_frames":36000,"fps":10}')
            new.write_text('{"total_frames":72000,"fps":10}')

            def download(*, revision=None, **kwargs):
                calls.append({"revision": revision, **kwargs})
                return str(new if revision == "new-sha" else old)

            module = types.SimpleNamespace(hf_hub_download=download)
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                entry = hf_catalog.build_entry(
                    object(), item, temp, None,
                    {"repoId": "TacVerse/example", "sha": "old-sha", "durationHours": 1},
                    False,
                )

        self.assertEqual(entry["durationHours"], 2)
        self.assertTrue(calls)
        self.assertTrue(all(call["revision"] == "new-sha" for call in calls))

    def test_missing_sha_skips_unverifiable_local_only_cache(self) -> None:
        item = types.SimpleNamespace(
            id="TacVerse/example", sha=None, createdAt=None,
            lastModified=None, downloads=0,
        )
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            info = Path(temporary) / "current.json"
            info.write_text(
                "{\"total_frames\":72000,\"fps\":10}", encoding="utf-8"
            )

            def download(**kwargs):
                calls.append(kwargs)
                return str(info)

            module = types.SimpleNamespace(hf_hub_download=download)
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                entry = hf_catalog.build_entry(
                    object(), item, Path(temporary), None,
                    {"repoId": "TacVerse/example", "sha": None, "durationHours": 1},
                    False,
                )

        self.assertEqual(entry["durationHours"], 2)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("local_files_only", calls[0])

    def test_old_catalog_versions_reprobe_only_folder_rows(self) -> None:
        old = {
            "catalogVersion": hf_catalog.CATALOG_VERSION - 1,
            "org": "TacVerse",
            "datasets": [
                {"repoId": "TacVerse/ordinary", "sha": "same"},
                {
                    "repoId": "TacVerse/sampledata",
                    "sha": "same-folder",
                    "layout": "folder",
                },
            ],
        }
        current = {
            "catalogVersion": hf_catalog.CATALOG_VERSION,
            "datasets": [{"repoId": "TacVerse/sampledata", "sha": "same"}],
        }
        self.assertEqual(
            list(hf_catalog.reusable_cache_entries(old)),
            ["TacVerse/ordinary"],
        )
        self.assertEqual(
            hf_catalog.reusable_cache_entries(current)["TacVerse/sampledata"][
                "sha"
            ],
            "same",
        )
        self.assertEqual(hf_catalog.reusable_cache_entries({"datasets": []}), {})



if __name__ == "__main__":
    unittest.main()
