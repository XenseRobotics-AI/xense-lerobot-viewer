#!/usr/bin/env python3
"""Sync only dataset statistics metadata into the local viewer cache.

This path mirrors the main Hugging Face sync, but it only pulls lightweight
metadata files (`meta/info.json` and `meta/hardware.json`) so Workbench
statistics can discover and filter new datasets without moving video or parquet
payloads. It is intentionally separate from the full
sync so the integrity checks for the complete dataset cache stay untouched.

Protocol: one JSON object per line on stdout, matching the viewer's other
streaming routes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Stats sync is metadata-only; use the authoritative Hub endpoint by default.
os.environ.setdefault("HF_ENDPOINT", "https://huggingface.co")

from sync_hf_dataset import (
    emit,
    fail,
    list_org_repos,
    missing_dependency,
    progress,
    stats_repo_target,
)

STATS_MARKER = os.path.join(".cache", "huggingface", "viewer_stats.json")
STATS_MARKER_VERSION = 2
METADATA_FILES = ("meta/info.json", "meta/hardware.json")
OPTIONAL_METADATA_FILES = {"meta/hardware.json"}


def safe_error(exc: Exception, token: str | None) -> str:
    message = str(exc)
    if token:
        message = message.replace(token, "[REDACTED]")
    env_token = os.environ.get("HF_TOKEN")
    if env_token:
        message = message.replace(env_token, "[REDACTED]")
    return message


def marker_path(target: str) -> str:
    return os.path.join(target, STATS_MARKER)


def read_marker(target: str) -> dict[str, Any] | None:
    try:
        value = json.loads(Path(marker_path(target)).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def write_marker(target: str, sha: str | None) -> None:
    if not sha:
        return
    files: dict[str, int] = {}
    for filename in METADATA_FILES:
        try:
            files[filename] = (Path(target) / filename).stat().st_size
        except OSError:
            if filename not in OPTIONAL_METADATA_FILES:
                return
    marker = {
        "version": STATS_MARKER_VERSION,
        "sha": sha,
        "files": files,
        "refreshedAt": datetime.now(timezone.utc).isoformat(),
    }
    marker_file = Path(marker_path(target))
    marker_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker_file.with_name(f"{marker_file.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(marker, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, marker_file)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def stats_is_current(target: str, sha: str | None) -> bool:
    if not sha:
        return False
    marker = read_marker(target)
    if not marker or marker.get("sha") != sha:
        return False
    if marker.get("version") != STATS_MARKER_VERSION:
        return False
    files = marker.get("files")
    if not isinstance(files, dict):
        return False
    expected_info = files.get("meta/info.json")
    if not isinstance(expected_info, int):
        return False
    for filename, expected in files.items():
        if filename not in METADATA_FILES or not isinstance(expected, int):
            return False
        try:
            size = (Path(target) / filename).stat().st_size
        except OSError:
            return False
        if size != expected:
            return False
    return True


def is_missing_optional_metadata(exc: Exception) -> bool:
    name = type(exc).__name__
    if name in {"EntryNotFoundError", "RemoteEntryNotFoundError"}:
        return True
    message = str(exc).lower()
    return "404" in message and "not found" in message


def download_metadata(repo_id: str, target: str, token: str | None) -> None:
    from huggingface_hub import hf_hub_download

    with tempfile.TemporaryDirectory() as tmpdir:
        for filename in METADATA_FILES:
            try:
                downloaded = hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                    repo_type="dataset",
                    token=token,
                    local_dir=tmpdir,
                )
            except Exception as exc:
                if (
                    filename in OPTIONAL_METADATA_FILES
                    and is_missing_optional_metadata(exc)
                ):
                    try:
                        (Path(target) / filename).unlink()
                    except FileNotFoundError:
                        pass
                    continue
                raise
            source = Path(downloaded)
            if not source.is_file():
                if filename in OPTIONAL_METADATA_FILES:
                    try:
                        (Path(target) / filename).unlink()
                    except FileNotFoundError:
                        pass
                    continue
                raise FileNotFoundError(f"Could not download {filename} for {repo_id}")
            destination = Path(target) / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(f"{destination.name}.tmp")
            shutil.copy2(source, temporary)
            os.replace(temporary, destination)


def preflight(repo_id: str, token: str | None) -> str | None:
    from huggingface_hub import hf_hub_download

    endpoint = os.environ.get("HF_ENDPOINT", "")
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            hf_hub_download(
                repo_id=repo_id,
                filename="meta/info.json",
                repo_type="dataset",
                token=token,
                local_dir=tmpdir,
            )
        return None
    except Exception as exc:
        name = type(exc).__name__
        if name in ("LocalEntryNotFoundError", "FileMetadataError"):
            if "hf-mirror" in endpoint or endpoint not in ("", "https://huggingface.co"):
                return (
                    f"{endpoint} cannot serve downloads. "
                    "The viewer's stats-only sync needs direct Hub metadata access."
                )
            return f"Could not reach the Hub: {exc}"
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True, help="Hugging Face org / author")
    parser.add_argument("--root", required=True, help="local dataset root")
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="report what would be downloaded, transfer nothing",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-fetch every repo, including repos already at the remote commit",
    )
    args = parser.parse_args()

    blocker = missing_dependency()
    if blocker:
        return fail(blocker)

    token = os.environ.get("HF_TOKEN") or None
    endpoint = os.environ.get("HF_ENDPOINT", "")
    progress(phase="listing", endpoint=endpoint, org=args.org, percent=0)

    try:
        repos = list_org_repos(args.org, None, token)
    except Exception as exc:
        return fail(f"Could not list stats files for {args.org}: {safe_error(exc, token)}")

    repo_ids = [repo_id for repo_id, _sha in repos]
    remote_shas = {repo_id: sha for repo_id, sha in repos}
    pending = [
        repo_id
        for repo_id, sha in repos
        if args.force or not stats_is_current(stats_repo_target(args.root, args.org, repo_id), sha)
    ]

    def emit_result(downloaded: int, failed: list[dict[str, str]], work: list[str]) -> int:
        emit(
            {
                "type": "result",
                "result": {
                    "org": args.org,
                    "endpoint": endpoint,
                    "repos": repo_ids,
                    "pending": pending,
                    "downloaded": downloaded,
                    "skipped": len(repo_ids) - len(work),
                    "failed": failed,
                    "listOnly": args.list_only,
                },
            }
        )
        return 0

    if not repo_ids:
        return emit_result(0, [], [])

    if args.list_only:
        return emit_result(0, [], pending)

    work = repo_ids if args.force else pending
    if not work:
        progress(phase="complete", total=0, percent=100)
        return emit_result(0, [], work)

    progress(phase="preflight", percent=0)
    blocker = preflight(work[0], token)
    if blocker:
        return fail(blocker)

    downloaded = 0
    failed: list[dict[str, str]] = []
    total = len(work)

    for index, repo_id in enumerate(work, start=1):
        target = stats_repo_target(args.root, args.org, repo_id)
        progress(
            phase="downloading",
            repo=repo_id,
            index=index,
            total=total,
            percent=round((index - 1) / total * 100),
        )
        try:
            download_metadata(repo_id, target, token)
            write_marker(target, remote_shas.get(repo_id))
            downloaded += 1
        except Exception as exc:
            failed.append({"repo": repo_id, "error": safe_error(exc, token)})
            progress(phase="failed", repo=repo_id, index=index, total=total)

    progress(phase="complete", total=total, percent=100)
    return emit_result(downloaded, failed, work)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        raise SystemExit(fail(traceback.format_exc(limit=3)))
