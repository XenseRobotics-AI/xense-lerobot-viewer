import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import sync_hf_dataset_stats as stats


class FakeApi:
    files: list[str] = []

    def list_repo_files(self, **_kwargs):
        return list(self.files)


def fake_hub_module(contents: dict[str, bytes]) -> types.SimpleNamespace:
    def hf_hub_download(*, filename: str, local_dir: str, **_kwargs) -> str:
        destination = Path(local_dir) / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents[filename])
        return str(destination)

    return types.SimpleNamespace(HfApi=FakeApi, hf_hub_download=hf_hub_download)


class MetadataSyncTest(unittest.TestCase):
    def test_downloads_complete_meta_tree_and_never_data_or_videos(self) -> None:
        FakeApi.files = [
            "README.md",
            "data/chunk-000/file.parquet",
            "videos/camera.mp4",
            "meta/info.json",
            "meta/episodes/chunk-000/file-000.parquet",
            "meta/nested/config.json",
        ]
        contents = {
            "meta/info.json": b'{"codebase_version":"v3.0"}',
            "meta/episodes/chunk-000/file-000.parquet": b"parquet",
            "meta/nested/config.json": b"{}",
        }
        with tempfile.TemporaryDirectory() as root, patch.dict(
            sys.modules, {"huggingface_hub": fake_hub_module(contents)}
        ):
            target = Path(root) / "TacVerse" / "example"
            (target / "data").mkdir(parents=True)
            (target / "data" / "keep.parquet").write_bytes(b"keep")
            (target / "videos").mkdir()
            (target / "videos" / "keep.mp4").write_bytes(b"keep")

            with patch.object(stats, "progress") as reporter:
                files, archive = stats.download_metadata(
                    "TacVerse/example", str(target), root, "TacVerse", None
                )

            progress_events = [call.kwargs for call in reporter.call_args_list]
            self.assertTrue(any(event.get("filesTotal") == 3 for event in progress_events))
            self.assertTrue(any("bytesPerSecond" in event for event in progress_events))

            self.assertEqual(files, sorted(contents))
            for filename, expected in contents.items():
                self.assertEqual((target / filename).read_bytes(), expected)
            self.assertEqual((target / "data" / "keep.parquet").read_bytes(), b"keep")
            self.assertEqual((target / "videos" / "keep.mp4").read_bytes(), b"keep")
            self.assertEqual(archive["files"], 0)



    def test_remote_manifest_fills_missing_hardware_and_stats_from_partial_cache(self) -> None:
        revision = "0905-sha"
        remote_files = [
            "README.md",
            "data/chunk-000/file.parquet",
            "videos/camera.mp4",
            "meta/info.json",
            "meta/hardware.json",
            "meta/stats.json",
        ]
        contents = {
            "meta/info.json": b'{"total_episodes": 1}',
            "meta/hardware.json": b'{"robot_id":"bi_taccap_3"}',
            "meta/stats.json": b'{"episodes": {}}',
        }
        calls: list[dict[str, object]] = []

        class RemoteApi:
            def list_repo_files(self, **kwargs):
                calls.append(kwargs)
                return remote_files

        def download(*, filename: str, local_dir: str, **kwargs) -> str:
            calls.append({"download": filename, **kwargs})
            destination = Path(local_dir) / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(contents[filename])
            return str(destination)

        hub = types.SimpleNamespace(HfApi=RemoteApi, hf_hub_download=download)
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as cache:
            partial = (
                Path(cache)
                / "datasets--TacVerse--0905"
                / "snapshots"
                / revision
                / "meta"
                / "info.json"
            )
            partial.parent.mkdir(parents=True)
            partial.write_bytes(contents["meta/info.json"])
            target = Path(root) / "TacVerse" / "0905"
            with patch.dict(
                sys.modules, {"huggingface_hub": hub}
            ), patch.dict("os.environ", {"HF_HUB_CACHE": cache}):
                files, _archive = stats.download_metadata(
                    "TacVerse/0905",
                    str(target),
                    root,
                    "TacVerse",
                    None,
                    revision=revision,
                )

            self.assertEqual(
                files, ["meta/hardware.json", "meta/info.json", "meta/stats.json"]
            )
            self.assertTrue(any("revision" in call and call["revision"] == revision for call in calls))
            for filename, expected in contents.items():
                self.assertEqual((target / filename).read_bytes(), expected)
            stats.write_marker(str(target), revision, files)
            marker = json.loads(
                Path(stats.marker_path(str(target))).read_text(encoding="utf-8")
            )
            self.assertEqual(
                set(marker["files"]),
                {"meta/info.json", "meta/hardware.json", "meta/stats.json"},
            )

    def test_folder_sync_uses_remote_manifest_and_cached_files_only_as_download_acceleration(self) -> None:
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as cache:
            revision = "cached-sha"
            snapshot = (
                Path(cache)
                / "datasets--TacVerse--sampledata"
                / "snapshots"
                / revision
                / "child-a"
                / "meta"
            )
            snapshot.mkdir(parents=True)
            source = snapshot / "info.json"
            source.write_bytes(b'{"total_episodes": 1}')
            listed: list[dict[str, object]] = []

            class CachedApi:
                def list_repo_files(self, **kwargs):
                    listed.append(kwargs)
                    return ["child-a/meta/info.json"]

            def unavailable_download(**_kwargs):
                raise AssertionError("the explicitly listed cached file should be copied")

            hub = types.SimpleNamespace(
                HfApi=CachedApi, hf_hub_download=unavailable_download
            )
            with patch.dict(
                sys.modules, {"huggingface_hub": hub}
            ), patch.dict("os.environ", {"HF_HUB_CACHE": cache}):
                target = Path(root) / "TacVerse" / "sampledata"
                files, _archive = stats.download_metadata(
                    "TacVerse/sampledata",
                    str(target),
                    root,
                    "TacVerse",
                    None,
                    revision=revision,
                )

            self.assertEqual(files, ["child-a/meta/info.json"])
            self.assertEqual(listed[0]["revision"], revision)
            self.assertEqual(
                (target / "child-a" / "meta" / "info.json").read_bytes(),
                source.read_bytes(),
            )

    def test_folder_sync_selects_only_direct_child_meta_trees(self) -> None:
        FakeApi.files = [
            "README.md",
            "child-a/meta/info.json",
            "child-a/meta/stats.json",
            "child-a/data/file.parquet",
            "child-a/videos/camera.mp4",
            "child-b/meta/info.json",
            "child-b/meta/episodes/chunk.parquet",
            "child-b/grandchild/meta/info.json",
            "data/meta/info.json",
            "videos/meta/info.json",
        ]
        contents = {
            "child-a/meta/info.json": b'{"codebase_version":"v3.0"}',
            "child-a/meta/stats.json": b"{}",
            "child-b/meta/info.json": b'{"codebase_version":"v3.0"}',
            "child-b/meta/episodes/chunk.parquet": b"parquet",
        }
        with tempfile.TemporaryDirectory() as root, patch.dict(
            sys.modules, {"huggingface_hub": fake_hub_module(contents)}
        ):
            target = Path(root) / "TacVerse" / "sampledata"
            files, _archive = stats.download_metadata(
                "TacVerse/sampledata",
                str(target),
                root,
                "TacVerse",
                None,
            )

            self.assertEqual(files, sorted(contents))
            for filename, expected in contents.items():
                self.assertEqual((target / filename).read_bytes(), expected)
            self.assertFalse((target / "child-a" / "data").exists())
            self.assertFalse((target / "child-a" / "videos").exists())
            self.assertFalse((target / "child-b" / "grandchild").exists())

    def test_file_listing_uses_a_bounded_request_and_filters_payload_data(self) -> None:
        calls: list[dict[str, object]] = []

        class BoundedApi:
            endpoint = "https://huggingface.co"

            def _build_hf_headers(self, **_kwargs):
                return {"authorization": "Bearer test"}

        def fake_backoff(_method, url, **kwargs):
            calls.append({"url": url, **kwargs})
            return types.SimpleNamespace(
                json=lambda: [
                    {"type": "file", "path": "meta/info.json"},
                    {"type": "file", "path": "../data/large.parquet"},
                ],
                links={},
            )

        hub = types.SimpleNamespace(
            HfApi=BoundedApi,
            constants=types.SimpleNamespace(DEFAULT_REVISION="main"),
        )
        utils = types.SimpleNamespace(
            http_backoff=fake_backoff,
            hf_raise_for_status=lambda _response: None,
        )
        with patch.dict(
            sys.modules,
            {"huggingface_hub": hub, "huggingface_hub.utils": utils},
        ):
            self.assertEqual(
                stats.list_metadata_files(
                    "TacVerse/example", "token", revision="0905-sha"
                ),
                ["meta/info.json"],
            )

        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["url"].endswith("/tree/0905-sha/meta"))
        self.assertEqual(calls[0]["timeout"], stats.METADATA_LIST_TIMEOUT_SECONDS)
        self.assertEqual(calls[0]["max_retries"], stats.METADATA_LIST_RETRIES)

    def test_remote_manifest_failure_leaves_existing_metadata_and_marker_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "TacVerse" / "0905"
            old = target / "meta" / "info.json"
            old.parent.mkdir(parents=True)
            old.write_text("old")
            stats.write_marker(str(target), "old-sha", ["meta/info.json"])
            marker_before = Path(stats.marker_path(str(target))).read_bytes()

            hub = types.SimpleNamespace(
                hf_hub_download=lambda **_kwargs: (_ for _ in ()).throw(
                    AssertionError("download should not start when remote listing fails")
                )
            )
            with patch.dict(sys.modules, {"huggingface_hub": hub}), patch.object(
                stats, "list_metadata_files", side_effect=RuntimeError("remote listing failed")
            ):
                with self.assertRaisesRegex(RuntimeError, "remote listing failed"):
                    stats.download_metadata(
                        "TacVerse/0905", str(target), root, "TacVerse", None, revision="new-sha"
                    )

            self.assertEqual(old.read_text(), "old")
            self.assertEqual(Path(stats.marker_path(str(target))).read_bytes(), marker_before)

    def test_missing_meta_tree_is_a_successful_empty_snapshot(self) -> None:
        class BoundedApi:
            endpoint = "https://huggingface.co"

            def _build_hf_headers(self, **_kwargs):
                return {}

        class EntryNotFoundError(Exception):
            pass

        hub = types.SimpleNamespace(
            HfApi=BoundedApi,
            constants=types.SimpleNamespace(DEFAULT_REVISION="main"),
        )
        utils = types.SimpleNamespace(
            http_backoff=lambda *_args, **_kwargs: types.SimpleNamespace(
                json=lambda: [], links={}
            ),
            hf_raise_for_status=lambda _response: (_ for _ in ()).throw(
                EntryNotFoundError("meta not found")
            ),
        )
        with patch.dict(
            sys.modules,
            {"huggingface_hub": hub, "huggingface_hub.utils": utils},
        ):
            self.assertEqual(stats.list_metadata_files("TacVerse/empty", None), [])

    def test_old_marker_version_forces_refresh_even_with_the_same_sha(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "TacVerse" / "0905"
            info = target / "meta" / "info.json"
            info.parent.mkdir(parents=True)
            info.write_text("{}")
            marker = Path(stats.marker_path(str(target)))
            marker.parent.mkdir(parents=True)
            marker.write_text(
                json.dumps({"version": 4, "sha": "same-sha", "files": {"meta/info.json": 2}})
            )

            self.assertFalse(stats.stats_is_current(str(target), "same-sha"))

    def test_dynamic_marker_accepts_an_empty_meta_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "TacVerse" / "empty"
            stats.write_marker(str(target), "empty-sha", [])
            marker = json.loads(Path(stats.marker_path(str(target))).read_text())
            self.assertEqual(marker["version"], stats.STATS_MARKER_VERSION)
            self.assertEqual(marker["files"], {})
            self.assertTrue(stats.stats_is_current(str(target), "empty-sha"))

    def test_marker_tracks_nested_json_and_parquet_files(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "TacVerse" / "dynamic"
            files = ["meta/info.json", "meta/episodes/chunk.parquet"]
            for filename in files:
                destination = target / filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(filename.encode())
            stats.write_marker(str(target), "sha", files)
            marker = json.loads(Path(stats.marker_path(str(target))).read_text())
            self.assertEqual(set(marker["files"]), set(files))
            self.assertTrue(stats.stats_is_current(str(target), "sha"))
            (target / files[1]).write_bytes(b"changed")
            self.assertFalse(stats.stats_is_current(str(target), "sha"))

    def test_archives_metadata_removed_from_the_remote_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "TacVerse" / "example"
            current = target / "meta" / "info.json"
            removed = target / "meta" / "nested" / "old.parquet"
            current.parent.mkdir(parents=True)
            removed.parent.mkdir(parents=True)
            current.write_text("{}")
            removed.write_bytes(b"old")
            stats.write_marker(
                str(target),
                "old-sha",
                ["meta/info.json", "meta/nested/old.parquet"],
            )

            result = stats.archive_deleted_metadata(
                root,
                "TacVerse",
                "TacVerse/example",
                str(target),
                ["meta/info.json"],
            )

            self.assertEqual(result["snapshots"], 1)
            self.assertEqual(result["files"], 1)
            self.assertFalse(removed.exists())
            archived = list(
                (Path(root) / "TacVerse-removed").glob(
                    "example--meta-*/meta/nested/old.parquet"
                )
            )
            self.assertEqual(len(archived), 1)
            self.assertEqual(archived[0].read_bytes(), b"old")

    def test_archives_removed_top_level_repos_with_timestamp_conflicts(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            org = Path(root) / "TacVerse"
            gone = org / "gone"
            keep = org / "keep"
            released = org / "released" / "workflow-copy"
            for directory in (gone, keep, released):
                directory.mkdir(parents=True)
                (directory / "file").write_text(directory.name)
            existing = Path(root) / "TacVerse-removed" / "gone"
            existing.mkdir(parents=True)
            (existing / "existing").write_text("existing")

            result = stats.archive_removed_repos(
                root, "TacVerse", ["TacVerse/keep"]
            )

            self.assertEqual(result["repositories"], 1)
            self.assertEqual(result["files"], 1)
            self.assertFalse(gone.exists())
            self.assertTrue(keep.exists())
            self.assertTrue(released.exists())
            self.assertTrue(existing.exists())
            conflicts = list((Path(root) / "TacVerse-removed").glob("gone-*"))
            self.assertEqual(len(conflicts), 1)
            self.assertEqual((conflicts[0] / "file").read_text(), "gone")

    def test_does_not_archive_top_level_repos_for_other_organizations(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            local = Path(root) / "OtherOrg" / "local-only"
            local.mkdir(parents=True)
            (local / "file").write_text("keep")
            result = stats.archive_removed_repos(root, "OtherOrg", [])
            self.assertEqual(result["repositories"], 0)
            self.assertTrue(local.exists())
            self.assertFalse((Path(root) / "OtherOrg-removed").exists())

    def test_connectivity_failures_are_detected_for_fail_fast_handling(self) -> None:
        self.assertTrue(stats.is_hub_connectivity_error(TimeoutError("timed out")))
        self.assertTrue(stats.is_hub_connectivity_error(ConnectionError("reset")))
        self.assertFalse(stats.is_hub_connectivity_error(ValueError("bad metadata")))
        self.assertIn("hf-mirror.com", stats.connectivity_hint("https://huggingface.co"))

    def test_rejects_paths_outside_meta(self) -> None:
        self.assertTrue(stats.is_metadata_path("meta/info.json"))
        self.assertTrue(stats.is_metadata_path("child/meta/info.json"))
        self.assertFalse(stats.is_metadata_path("data/file.parquet"))
        self.assertFalse(stats.is_metadata_path("videos/file.mp4"))
        self.assertFalse(stats.is_metadata_path("meta/../data/file.parquet"))
        self.assertFalse(stats.is_metadata_path("../child/meta/info.json"))
        self.assertFalse(stats.is_metadata_path("child/grandchild/meta/info.json"))
        self.assertFalse(stats.is_metadata_path("child\\meta\\info.json"))


if __name__ == "__main__":
    unittest.main()
