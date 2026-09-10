import json
import sys
import types
import tempfile
import unittest
from unittest.mock import patch

import hf_download
from pathlib import Path
from types import SimpleNamespace

from hf_download import (
    build_check_result,
    parse_source,
    promote_download,
    read_state,
    selected_files,
    write_state,
)


def remote(path: str, size: int | None = 1):
    return SimpleNamespace(rfilename=path, size=size)


class HfDownloadTest(unittest.TestCase):
    def test_parses_standard_and_folder_sources(self):
        self.assertEqual(parse_source("TacVerse/example")[:2], ("TacVerse/example", None))
        self.assertEqual(
            parse_source("TacVerse/opendata/child")[:2],
            ("TacVerse/opendata", "child"),
        )

    def test_rejects_unsafe_sources(self):
        for value in (
            "https://huggingface.co/TacVerse/example",
            "TacVerse//example",
            "TacVerse/../example",
            "TacVerse\\example",
            "/TacVerse/example",
            "TacVerse/opendata/child/extra",
            "TacVerse/.hidden",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_source(value)

    def test_selects_the_four_scope_variants_and_strips_folder_prefix(self):
        files = [
            remote("meta/info.json", 2),
            remote("data/a.parquet", 3),
            remote("child/meta/info.json", 4),
            remote("child/data/a.parquet", 5),
            remote("other/meta/info.json", 6),
        ]
        self.assertEqual(
            [f["localPath"] for f in selected_files(files, None, "all")],
            ["child/data/a.parquet", "child/meta/info.json", "data/a.parquet", "meta/info.json", "other/meta/info.json"],
        )
        self.assertEqual(
            [f["localPath"] for f in selected_files(files, None, "meta")],
            ["meta/info.json"],
        )
        self.assertEqual(
            [f["localPath"] for f in selected_files(files, "child", "all")],
            ["data/a.parquet", "meta/info.json"],
        )
        self.assertEqual(
            [f["localPath"] for f in selected_files(files, "child", "meta")],
            ["meta/info.json"],
        )

    def test_check_reports_count_size_target_and_local_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            (target / "meta").mkdir(parents=True)
            write_state(root, ("TacVerse", "example"), "TacVerse/example", None, "meta", "abc")
            result = build_check_result(
                "TacVerse/example", str(root), "meta", "abc",
                [remote("meta/info.json", 7), remote("data/a", None)],
            )
            self.assertEqual(result["fileCount"], 1)
            self.assertEqual(result["sizeBytes"], 7)
            self.assertEqual(result["targetPath"], str(target))
            self.assertTrue(result["matchesRevision"])

    def test_full_replace_removes_stale_files_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            (target / "data").mkdir(parents=True)
            (target / "stale.txt").write_text("old")
            staged = root / "staged"
            (staged / "data").mkdir(parents=True)
            (staged / "data" / "new.txt").write_text("new")
            backup = promote_download(staged, target, root, ("TacVerse", "example"), "all")
            self.assertFalse((target / "stale.txt").exists())
            self.assertEqual((target / "data" / "new.txt").read_text(), "new")
            self.assertEqual((backup / "stale.txt").read_text(), "old")

    def test_meta_replace_preserves_data_and_removes_stale_meta(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            (target / "meta").mkdir(parents=True)
            (target / "meta" / "stale.json").write_text("old")
            (target / "data").mkdir()
            (target / "data" / "keep.parquet").write_text("data")
            staged = root / "staged"
            (staged / "meta").mkdir(parents=True)
            (staged / "meta" / "info.json").write_text("new")
            promote_download(staged, target, root, ("TacVerse", "example"), "meta")
            self.assertFalse((target / "meta" / "stale.json").exists())
            self.assertEqual((target / "meta" / "info.json").read_text(), "new")
            self.assertEqual((target / "data" / "keep.parquet").read_text(), "data")

    def test_promotion_failure_restores_existing_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            target.mkdir(parents=True)
            (target / "old.txt").write_text("old")
            staged = root / "staged"
            staged.mkdir()
            (staged / "new.txt").write_text("new")
            with self.assertRaises(OSError):
                promote_download(
                    staged, target, root, ("TacVerse", "example"), "all",
                    fail_after_backup=True,
                )
            self.assertEqual((target / "old.txt").read_text(), "old")
            self.assertFalse((target / "new.txt").exists())

    def test_meta_state_invalidates_full_consistency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parts = ("TacVerse", "example")
            write_state(root, parts, "TacVerse/example", None, "all", "one")
            write_state(root, parts, "TacVerse/example", None, "meta", "two")
            state = read_state(root, parts)
            self.assertEqual(state["metaSha"], "two")
            self.assertIsNone(state["fullSha"])
            self.assertEqual(state["fullConsistency"], "unknown")

    def test_revision_change_does_not_touch_existing_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            target.mkdir(parents=True)
            (target / "keep.txt").write_text("keep")
            info = SimpleNamespace(sha="new-sha", siblings=[])
            request = {
                "source": "TacVerse/example",
                "destinationRoot": str(root),
                "scope": "all",
                "revisionSha": "old-sha",
            }
            with patch("hf_download._api_and_info", return_value=(None, info)):
                with self.assertRaises(hf_download.DownloadConflict):
                    hf_download.download(request, None)
            self.assertEqual((target / "keep.txt").read_text(), "keep")

    def test_download_failure_and_cancel_leave_existing_target_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            target.mkdir(parents=True)
            (target / "keep.txt").write_text("keep")
            info = SimpleNamespace(
                sha="abcdef1234567", siblings=[remote("meta/info.json", 3)]
            )
            request = {
                "source": "TacVerse/example",
                "destinationRoot": str(root),
                "scope": "all",
                "revisionSha": info.sha,
            }
            module = types.ModuleType("huggingface_hub")

            def fail_download(**_kwargs):
                raise RuntimeError("network failed")

            module.hf_hub_download = fail_download
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                with patch("hf_download._api_and_info", return_value=(None, info)):
                    with self.assertRaises(RuntimeError):
                        hf_download.download(request, None)
            self.assertEqual((target / "keep.txt").read_text(), "keep")

            hf_download._cancelled = True
            try:
                with patch.dict(sys.modules, {"huggingface_hub": module}):
                    with patch("hf_download._api_and_info", return_value=(None, info)):
                        with self.assertRaises(hf_download.DownloadCancelled):
                            hf_download.download(request, None)
            finally:
                hf_download._cancelled = False
            self.assertEqual((target / "keep.txt").read_text(), "keep")

    def test_folder_download_uses_checked_revision_and_strips_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.write_bytes(b"abc")
            info = SimpleNamespace(
                sha="abcdef1234567",
                siblings=[remote("child/meta/info.json", 3)],
            )
            revisions = []
            module = types.ModuleType("huggingface_hub")

            def fake_download(**kwargs):
                revisions.append(kwargs["revision"])
                return str(cache)

            module.hf_hub_download = fake_download
            request = {
                "source": "TacVerse/opendata/child",
                "destinationRoot": str(root),
                "scope": "meta",
                "revisionSha": info.sha,
            }
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                with patch("hf_download._api_and_info", return_value=(None, info)):
                    result = hf_download.download(request, None)
            target = root / "TacVerse" / "opendata" / "child"
            self.assertEqual((target / "meta" / "info.json").read_bytes(), b"abc")
            self.assertEqual(revisions, [info.sha])
            self.assertTrue(result["metaOnly"])

    def test_rejects_existing_target_symlink_that_escapes_root(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "root"
            outside = base / "outside"
            root.mkdir()
            outside.mkdir()
            (root / "TacVerse").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                hf_download.target_for(root.resolve(), ("TacVerse", "example"))


    def test_state_write_failure_rolls_back_promoted_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "TacVerse" / "example"
            target.mkdir(parents=True)
            (target / "keep.txt").write_text("keep")
            cache = root / "cache"
            cache.write_bytes(b"abc")
            info = SimpleNamespace(
                sha="abcdef1234567", siblings=[remote("meta/info.json", 3)]
            )
            module = types.ModuleType("huggingface_hub")
            module.hf_hub_download = lambda **_kwargs: str(cache)
            request = {
                "source": "TacVerse/example",
                "destinationRoot": str(root),
                "scope": "all",
                "revisionSha": info.sha,
            }
            with patch.dict(sys.modules, {"huggingface_hub": module}):
                with patch("hf_download._api_and_info", return_value=(None, info)):
                    with patch("hf_download.write_state", side_effect=OSError("disk full")):
                        with self.assertRaises(OSError):
                            hf_download.download(request, None)
            self.assertEqual((target / "keep.txt").read_text(), "keep")
            self.assertFalse((target / "meta" / "info.json").exists())


if __name__ == "__main__":
    unittest.main()
