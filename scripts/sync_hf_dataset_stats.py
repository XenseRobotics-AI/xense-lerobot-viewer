#!/usr/bin/env python3
"""Sync only dataset statistics metadata into the local viewer cache.

This path mirrors the main Hugging Face sync, but it only pulls the complete
`meta/**` tree so Workbench statistics can discover and filter new datasets
without moving `data/` or `videos/` payloads. It is intentionally separate from
the full sync so the integrity checks for the complete dataset cache stay
untouched.

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
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

# Stats sync is metadata-only; use the authoritative Hub endpoint by default.
os.environ.setdefault("HF_ENDPOINT", "https://huggingface.co")
# A stalled metadata HEAD/resolve request should fail quickly and surface an
# actionable endpoint choice instead of leaving the Workbench at 1/N for minutes.
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "15")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

from sync_hf_dataset import (
    emit,
    fail,
    list_org_repos,
    missing_dependency,
    progress,
    stats_repo_target,
)

STATS_MARKER = os.path.join(".cache", "huggingface", "viewer_stats.json")
# Earlier markers allowed Folder child metadata into the manifest.
# Bump this whenever the manifest contract changes so the next refresh checks
# the Hub again even when the repository SHA is unchanged.
STATS_MARKER_VERSION = 6
WORKFLOW_BUCKETS = {"merged", "raw", "failed", "released", "in-processing"}
METADATA_LIST_TIMEOUT_SECONDS = 15
METADATA_LIST_RETRIES = 2


def safe_error(exc: Exception, token: str | None) -> str:
    message = str(exc)
    if token:
        message = message.replace(token, "[REDACTED]")
    env_token = os.environ.get("HF_TOKEN")
    if env_token:
        message = message.replace(env_token, "[REDACTED]")
    return message


def is_hub_connectivity_error(exc: Exception) -> bool:
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    if any(
        marker in name
        for marker in ("timeout", "connection", "proxyerror", "sslerror")
    ):
        return True
    return any(
        marker in message
        for marker in (
            "timed out",
            "connection refused",
            "connection reset",
            " 429",
            " 502",
            " 503",
            " 504",
        )
    )


def connectivity_hint(endpoint: str) -> str:
    if endpoint.rstrip("/") == "https://huggingface.co":
        return (
            " Official Hub connectivity failed; switch the Workbench Hub selector "
            "to hf-mirror.com or configure HTTPS_PROXY/VPN."
        )
    return (
        " Hub connectivity failed; try the official endpoint or configure "
        "HTTPS_PROXY/VPN."
    )


def marker_path(target: str) -> str:
    return os.path.join(target, STATS_MARKER)


def read_marker(target: str) -> dict[str, Any] | None:
    try:
        value = json.loads(Path(marker_path(target)).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _safe_metadata_parts(filename: str) -> list[str] | None:
    if not isinstance(filename, str) or not filename or "\\" in filename:
        return None
    if filename.startswith("/") or "\x00" in filename:
        return None
    parts = filename.split("/")
    return None if any(part in {"", ".", ".."} for part in parts) else parts


def is_metadata_path(filename: str) -> bool:
    """Allow only a repository's root meta/** tree."""
    parts = _safe_metadata_parts(filename)
    return bool(parts and len(parts) >= 2 and parts[0] == "meta")


def is_legacy_metadata_path(filename: str) -> bool:
    """Recognize old direct-child metadata solely so it can be archived."""
    parts = _safe_metadata_parts(filename)
    if not parts:
        return False
    return is_metadata_path(filename) or (
        len(parts) >= 3
        and parts[1] == "meta"
        and parts[0] not in {"data", "videos", "meta"}
        and not parts[0].startswith(".")
    )


def write_marker(target: str, sha: str | None, metadata_files: list[str]) -> None:
    if not sha:
        return
    files: dict[str, int] = {}
    for filename in metadata_files:
        if not is_metadata_path(filename):
            raise ValueError(f"Unsafe metadata path: {filename}")
        files[filename] = (Path(target) / filename).stat().st_size
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
    version = marker.get("version")
    files = marker.get("files")
    if not isinstance(files, dict):
        return False
    if version == STATS_MARKER_VERSION:
        pass
    elif version == STATS_MARKER_VERSION - 1:
        # Version 5 may be reused only when it contains root meta/**. A Folder
        # marker from that version contains child/meta/** and must be rebuilt.
        if not files:
            return False
    else:
        return False
    for filename, expected in files.items():
        if not isinstance(filename, str) or not is_metadata_path(filename):
            return False
        if not isinstance(expected, int) or expected < 0:
            return False
        try:
            size = (Path(target) / filename).stat().st_size
        except OSError:
            return False
        if size != expected:
            return False
    # An empty map is a valid snapshot for a Hub repository with no meta/ tree.
    return True


def cached_metadata_file(
    repo_id: str, revision: str | None, filename: str
) -> Path | None:
    if not revision or not is_metadata_path(filename):
        return None
    parts = repo_id.split("/")
    if len(parts) != 2 or any(
        not part or part in {".", ".."} or "/" in part or "\\" in part
        for part in parts
    ):
        return None
    if "/" in revision or "\\" in revision or revision in {".", ".."}:
        return None
    cache_root = Path(
        os.environ.get("HF_HUB_CACHE")
        or Path.home() / ".cache" / "huggingface" / "hub"
    )
    snapshot = (
        cache_root
        / f"datasets--{parts[0]}--{parts[1]}"
        / "snapshots"
        / revision
    )
    candidate = snapshot.joinpath(*filename.split("/"))
    return candidate if candidate.is_file() else None


def list_metadata_files(
    repo_id: str, token: str | None, revision: str | None = None
) -> list[str]:
    """List the remote metadata tree, or direct Folder-child metadata trees.

    The local HF snapshot is deliberately not consulted here. A snapshot may
    be incomplete (for example, containing only ``meta/info.json``), so it is
    suitable for accelerating downloads but cannot be the source of truth for
    the manifest.
    """
    from huggingface_hub import HfApi

    api = HfApi()

    def select_snapshot(files: list[str]) -> list[str]:
        safe_files = sorted({name for name in files if is_metadata_path(name)})
        return (
            [name for name in safe_files if name.startswith("meta/")]
            if "meta/info.json" in safe_files
            else []
        )

    build_headers = getattr(api, "_build_hf_headers", None)
    if not callable(build_headers):
        files = api.list_repo_files(
            repo_id=repo_id,
            repo_type="dataset",
            revision=revision,
            token=token,
        )
        return select_snapshot([str(filename) for filename in files])

    try:
        from huggingface_hub import constants
        from huggingface_hub.utils import hf_raise_for_status, http_backoff
    except ImportError:
        files = api.list_repo_files(
            repo_id=repo_id,
            repo_type="dataset",
            revision=revision,
            token=token,
        )
        return select_snapshot([str(filename) for filename in files])

    headers = build_headers(token=token)
    encoded_repo = "/".join(quote(part, safe="") for part in repo_id.split("/"))
    revision_ref = quote(revision or constants.DEFAULT_REVISION, safe="")

    def tree_items(path_in_repo: str, recursive: bool) -> list[dict[str, Any]]:
        encoded_path = "/".join(
            quote(part, safe="") for part in path_in_repo.split("/") if part
        )
        suffix = f"/{encoded_path}" if encoded_path else ""
        url = (
            f"{api.endpoint}/api/datasets/{encoded_repo}/tree/"
            f"{revision_ref}{suffix}"
        )
        params: dict[str, str] | None = {
            "recursive": "true" if recursive else "false",
            "expand": "false",
        }
        items: list[dict[str, Any]] = []
        while url:
            response = http_backoff(
                "GET",
                url,
                max_retries=METADATA_LIST_RETRIES,
                base_wait_time=0.5,
                max_wait_time=4,
                retry_on_status_codes=(429, 500, 502, 503, 504),
                headers=headers,
                params=params,
                timeout=METADATA_LIST_TIMEOUT_SECONDS,
            )
            try:
                hf_raise_for_status(response)
            except Exception as exc:
                if type(exc).__name__ in {
                    "EntryNotFoundError",
                    "RemoteEntryNotFoundError",
                }:
                    return []
                raise
            payload = response.json()
            if not isinstance(payload, list):
                raise RuntimeError(
                    f"Unexpected file-list response for {repo_id}"
                )
            items.extend(item for item in payload if isinstance(item, dict))
            url = response.links.get("next", {}).get("url")
            params = None
        return items

    def files_for_tree(path_in_repo: str) -> list[str]:
        prefix = f"{path_in_repo}/" if path_in_repo else ""
        output: list[str] = []
        for item in tree_items(path_in_repo, True):
            if item.get("type") != "file":
                continue
            raw_path = item.get("path")
            if not isinstance(raw_path, str):
                continue
            filename = (
                raw_path
                if raw_path == path_in_repo or raw_path.startswith(prefix)
                else f"{prefix}{raw_path}"
            )
            if is_metadata_path(filename):
                output.append(filename)
        return output

    root_meta = files_for_tree("meta")
    return sorted(set(root_meta)) if "meta/info.json" in root_meta else []


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def available_destination(base: Path, *, always_stamp: bool = False) -> Path:
    candidate = base.with_name(f"{base.name}-{utc_stamp()}") if always_stamp else base
    if not candidate.exists():
        return candidate
    if not always_stamp:
        candidate = base.with_name(f"{base.name}-{utc_stamp()}")
        if not candidate.exists():
            return candidate
    index = 2
    while candidate.with_name(f"{candidate.name}-{index}").exists():
        index += 1
    return candidate.with_name(f"{candidate.name}-{index}")


def file_count(directory: Path) -> int:
    try:
        return sum(1 for item in directory.rglob("*") if item.is_file())
    except OSError:
        return 0


def archive_removed_repos(root: str, org: str, repo_ids: list[str]) -> dict[str, Any]:
    result: dict[str, Any] = {"repositories": 0, "files": 0, "failures": []}
    # The direct top-level statistics-copy layout is specific to TacVerse.
    if org != "TacVerse":
        return result
    org_dir = Path(root) / org
    if not org_dir.is_dir():
        return result
    remote_names = {repo_id.rsplit("/", 1)[-1] for repo_id in repo_ids}
    removed_root = Path(root) / f"{org}-removed"
    try:
        candidates = list(org_dir.iterdir())
    except OSError as exc:
        result["failures"].append({"scope": "repositories", "error": str(exc)})
        return result
    for source in candidates:
        if (
            not source.is_dir()
            or source.name.startswith(".")
            or source.name in WORKFLOW_BUCKETS
            or source.name in remote_names
        ):
            continue
        try:
            count = file_count(source)
            removed_root.mkdir(parents=True, exist_ok=True)
            destination = available_destination(removed_root / source.name)
            shutil.move(str(source), str(destination))
            result["repositories"] += 1
            result["files"] += count
        except Exception as exc:
            result["failures"].append(
                {"scope": "repository", "repo": f"{org}/{source.name}", "error": str(exc)}
            )
    return result


def archive_deleted_metadata(
    root: str,
    org: str,
    repo_id: str,
    target: str,
    remote_files: list[str],
) -> dict[str, Any]:
    result: dict[str, Any] = {"snapshots": 0, "files": 0, "failures": []}
    marker = read_marker(target) or {}
    old_files = marker.get("files")
    if not isinstance(old_files, dict):
        return result
    removed = [
        filename
        for filename in old_files
        if isinstance(filename, str)
        and is_legacy_metadata_path(filename)
        and filename not in remote_files
        and (Path(target) / filename).is_file()
    ]
    if not removed:
        return result
    name = repo_id.rsplit("/", 1)[-1]
    archive_root = available_destination(
        Path(root) / f"{org}-removed" / f"{name}--meta", always_stamp=True
    )
    moved = 0
    for filename in removed:
        source = Path(target) / filename
        destination = archive_root / filename
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
            moved += 1
        except Exception as exc:
            result["failures"].append(
                {"scope": "metadata", "repo": repo_id, "path": filename, "error": str(exc)}
            )
    result["snapshots"] = 1 if moved else 0
    result["files"] = moved
    return result


def download_metadata(
    repo_id: str,
    target: str,
    root: str,
    org: str,
    token: str | None,
    index: int = 1,
    total: int = 1,
    revision: str | None = None,
) -> tuple[list[str], dict[str, Any]]:
    from huggingface_hub import hf_hub_download

    metadata_files = list_metadata_files(repo_id, token, revision)
    files_total = len(metadata_files)
    progress(
        phase="downloading",
        repo=repo_id,
        index=index,
        total=total,
        percent=round((index - 1) / total * 100, 1),
        repoPercent=0,
        filesDone=0,
        filesTotal=files_total,
        bytes=0,
        bytesPerSecond=0,
    )
    # Download the complete remote snapshot before mutating the current one.
    with tempfile.TemporaryDirectory() as tmpdir:
        def download_one(filename: str) -> tuple[str, Path]:
            cached = cached_metadata_file(repo_id, revision, filename)
            if cached is not None:
                destination = Path(tmpdir) / filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(cached, destination)
                return filename, destination
            try:
                downloaded = hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                    repo_type="dataset",
                    revision=revision,
                    token=token,
                    local_dir=tmpdir,
                    local_files_only=True,
                )
            except Exception:
                downloaded = hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                    repo_type="dataset",
                    revision=revision,
                    token=token,
                    local_dir=tmpdir,
                )
            source = Path(downloaded)
            if not source.is_file():
                raise FileNotFoundError(
                    f"Could not download {filename} for {repo_id}"
                )
            return filename, source

        futures = {}
        if metadata_files:
            with ThreadPoolExecutor(max_workers=min(4, len(metadata_files))) as pool:
                futures = {
                    pool.submit(download_one, filename): filename
                    for filename in metadata_files
                }
                pending = set(futures)
                started = time.monotonic()
                last_bytes = 0
                last_at = started
                completed: set = set()
                while pending:
                    done, pending = wait(pending, timeout=0.5)
                    current_bytes = sum(
                        item.stat().st_size
                        for item in Path(tmpdir).rglob("*")
                        if item.is_file()
                    )
                    now = time.monotonic()
                    elapsed = now - last_at
                    rate = (
                        max(0, current_bytes - last_bytes) / elapsed
                        if elapsed > 0
                        else 0
                    )
                    completed.update(done)
                    progress(
                        phase="downloading",
                        repo=repo_id,
                        index=index,
                        total=total,
                        percent=round(
                            ((index - 1) + len(completed) / files_total)
                            / total
                            * 100,
                            1,
                        )
                        if files_total
                        else round((index - 1) / total * 100, 1),
                        repoPercent=round(
                            len(completed) / files_total * 100, 1
                        )
                        if files_total
                        else 100,
                        filesDone=len(completed),
                        filesTotal=files_total,
                        bytes=current_bytes,
                        bytesPerSecond=round(rate, 1),
                    )
                    last_bytes = current_bytes
                    last_at = now
                downloaded_files = [future.result() for future in futures]
        else:
            downloaded_files = []
            progress(
                phase="downloading",
                repo=repo_id,
                index=index,
                total=total,
                percent=round(index / total * 100, 1),
                repoPercent=100,
                filesDone=0,
                filesTotal=0,
                bytes=0,
                bytesPerSecond=0,
            )

        archive = archive_deleted_metadata(root, org, repo_id, target, metadata_files)
        for filename, source in downloaded_files:
            destination = Path(target) / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(f"{destination.name}.tmp")
            shutil.copy2(source, temporary)
            os.replace(temporary, destination)
    return metadata_files, archive


def preflight(repo_id: str, token: str | None) -> str | None:
    endpoint = os.environ.get("HF_ENDPOINT", "")
    try:
        list_metadata_files(repo_id, token)
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

    archive: dict[str, Any] = {
        "repositories": 0,
        "metadataSnapshots": 0,
        "files": 0,
        "failures": [],
    }

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
                    "archivedRepos": archive["repositories"],
                    "archivedMetaSnapshots": archive["metadataSnapshots"],
                    "archivedFiles": archive["files"],
                    "archiveFailures": archive["failures"],
                },
            }
        )
        return 0

    if args.list_only:
        return emit_result(0, [], pending)

    removed_repos = archive_removed_repos(args.root, args.org, repo_ids)
    archive["repositories"] = removed_repos["repositories"]
    archive["files"] = removed_repos["files"]
    archive["failures"].extend(removed_repos["failures"])

    work = repo_ids if args.force else pending
    if not work:
        progress(phase="complete", total=0, percent=100)
        return emit_result(0, [], work)

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
            metadata_files, metadata_archive = download_metadata(
                repo_id,
                target,
                args.root,
                args.org,
                token,
                index,
                total,
                revision=remote_shas.get(repo_id),
            )
            archive["metadataSnapshots"] += metadata_archive["snapshots"]
            archive["files"] += metadata_archive["files"]
            archive["failures"].extend(metadata_archive["failures"])
            if metadata_archive["failures"]:
                # Leave the marker stale so the next explicit refresh retries
                # files that could not be moved into the archive.
                raise RuntimeError(
                    f"Could not archive {len(metadata_archive['failures'])} removed meta files"
                )
            write_marker(target, remote_shas.get(repo_id), metadata_files)
            downloaded += 1
        except Exception as exc:
            error = safe_error(exc, token)
            failed.append({"repo": repo_id, "error": error})
            progress(phase="failed", repo=repo_id, index=index, total=total)
            if is_hub_connectivity_error(exc):
                return fail(
                    f"Stats sync stopped at {repo_id}: {error}.{connectivity_hint(endpoint)}"
                )

    progress(phase="complete", total=total, percent=100)
    return emit_result(downloaded, failed, work)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        raise SystemExit(fail(traceback.format_exc(limit=3)))
