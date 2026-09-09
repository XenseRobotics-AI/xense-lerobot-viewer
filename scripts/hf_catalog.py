#!/usr/bin/env python3
"""Build the lightweight, versioned Hugging Face catalog used by Workbench."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_ENDPOINT", "https://huggingface.co")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "15")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")

CATALOG_VERSION = 3
RESERVED_ROOT_DIRECTORIES = {"data", "videos", "meta"}


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    text = str(value).strip()
    return text or None


def safe_error(exc: Exception, token: str | None) -> str:
    message = str(exc)
    return message.replace(token, "[REDACTED]") if token else message


def safe_segment(value: str) -> bool:
    return (
        bool(value)
        and value not in {".", ".."}
        and "/" not in value
        and "\\" not in value
        and not value.startswith(".")
    )


def is_missing_entry(exc: Exception) -> bool:
    if type(exc).__name__ in {"EntryNotFoundError", "RemoteEntryNotFoundError", "FileNotFoundError"}:
        return True
    message = str(exc).lower()
    return "404" in message and ("not found" in message or "entry" in message)


def local_state(root: Path, repo_id: str) -> str:
    dataset_dir = root.joinpath(*repo_id.split("/"))
    if not dataset_dir.is_dir():
        return "missing"
    info = dataset_dir / "meta" / "info.json"
    data = dataset_dir / "data"
    videos = dataset_dir / "videos"
    if info.is_file() and data.is_dir() and videos.is_dir():
        return "downloaded"
    return "incomplete"


def read_cache(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def reusable_cache_entries(cached: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entries = {
        str(entry.get("repoId")): entry
        for entry in cached.get("datasets", [])
        if isinstance(entry, dict) and entry.get("repoId")
    }
    version = cached.get("catalogVersion")
    if version == CATALOG_VERSION:
        return entries
    # Version 2 did not need a new probe for ordinary datasets. Folder rows
    # must be omitted so their root tree is re-listed without child metadata.
    if version == CATALOG_VERSION - 1:
        return {
            repo_id: entry
            for repo_id, entry in entries.items()
            if entry.get("layout") != "folder"
        }
    return {}


def uploader_for(api: Any, repo_id: str, token: str | None) -> str | None:
    try:
        commits = list(
            api.list_repo_commits(
                repo_id=repo_id, repo_type="dataset", token=token
            )
        )
        if not commits:
            return None
        commit = commits[-1]
        authors = getattr(commit, "authors", None)
        author = (
            authors[0]
            if isinstance(authors, (list, tuple)) and authors
            else getattr(commit, "author", None)
        )
        if isinstance(author, str) and author.strip():
            return author.strip()
        if isinstance(author, dict):
            name = author.get("name") or author.get("email")
            return str(name).strip() if name else None
    except Exception:
        return None
    return None


def catalog_fields(item: Any) -> dict[str, Any]:
    downloads = getattr(item, "downloads", None)
    try:
        downloads = int(downloads) if downloads is not None else None
    except (TypeError, ValueError):
        downloads = None
    return {
        "sha": str(getattr(item, "sha", None))
        if getattr(item, "sha", None)
        else None,
        "createdAt": iso(
            getattr(item, "createdAt", None)
            or getattr(item, "created_at", None)
        ),
        "lastModified": iso(
            getattr(item, "lastModified", None)
            or getattr(item, "last_modified", None)
        ),
        "downloads": downloads,
    }


def info_fields(info: dict[str, Any]) -> dict[str, Any]:
    def number(key: str) -> float | None:
        value = info.get(key)
        try:
            parsed = float(value) if value is not None else None
        except (TypeError, ValueError):
            return None
        return parsed if parsed is not None and parsed >= 0 else None

    frames = number("total_frames")
    episodes = number("total_episodes")
    tasks = number("total_tasks")
    fps = number("fps")
    duration = (
        frames / fps / 3600
        if frames is not None and fps is not None and frames > 0 and fps > 0
        else None
    )

    def integer_if_whole(value: float | None) -> int | float | None:
        if value is None:
            return None
        return int(value) if value.is_integer() else value

    robot_type = info.get("robot_type")
    return {
        "totalEpisodes": integer_if_whole(episodes),
        "totalFrames": integer_if_whole(frames),
        "totalTasks": integer_if_whole(tasks),
        "fps": fps,
        "durationHours": round(duration, 6) if duration is not None else None,
        "robotType": robot_type.strip()
        if isinstance(robot_type, str) and robot_type.strip()
        else None,
    }


def minimal_entry(
    item: Any, root: Path, metadata_error: str | None = None
) -> dict[str, Any]:
    repo_id = str(getattr(item, "id", ""))
    return {
        "repoId": repo_id,
        "org": repo_id.split("/", 1)[0] if "/" in repo_id else "",
        "name": repo_id.rsplit("/", 1)[-1],
        "layout": "dataset",
        "children": [],
        "localState": local_state(root, repo_id),
        "totalEpisodes": None,
        "totalFrames": None,
        "totalTasks": None,
        "fps": None,
        "durationHours": None,
        "robotType": None,
        **catalog_fields(item),
        "metadataState": "error" if metadata_error else "unknown",
        **({"metadataError": metadata_error} if metadata_error else {}),
    }


def root_child_names(
    api: Any, repo_id: str, token: str | None, revision: str | None = None
) -> list[str]:
    list_tree = getattr(api, "list_repo_tree", None)
    if callable(list_tree):
        items = list(
            list_tree(
                repo_id=repo_id,
                path_in_repo="",
                recursive=False,
                repo_type="dataset",
                revision=revision,
                token=token,
            )
        )
        output: set[str] = set()
        for item in items:
            raw_path = getattr(item, "path", None)
            item_type = str(getattr(item, "type", "")).lower()
            if not isinstance(raw_path, str) or not safe_segment(raw_path):
                continue
            if item_type == "file":
                continue
            if (
                raw_path not in RESERVED_ROOT_DIRECTORIES
                and raw_path not in {"README.md", ".gitattributes"}
            ):
                output.add(raw_path)
        return sorted(output)

    files = api.list_repo_files(
        repo_id=repo_id,
        repo_type="dataset",
        revision=revision,
        token=token,
    )
    output = set()
    for filename in files:
        parts = str(filename).split("/")
        if (
            len(parts) >= 2
            and safe_segment(parts[0])
            and parts[0] not in RESERVED_ROOT_DIRECTORIES
        ):
            output.add(parts[0])
    return sorted(output)


def read_downloaded_info(
    repo_id: str,
    filename: str,
    token: str | None,
    revision: str | None = None,
) -> dict[str, Any]:
    from huggingface_hub import hf_hub_download

    if revision:
        try:
            downloaded = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                repo_type="dataset",
                token=token,
                revision=revision,
                local_files_only=True,
            )
        except Exception:
            downloaded = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                repo_type="dataset",
                token=token,
                revision=revision,
            )
    else:
        # Without an immutable SHA, a local-only "main" snapshot may be stale.
        downloaded = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            repo_type="dataset",
            token=token,
            revision=None,
        )
    parsed = json.loads(Path(downloaded).read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"{filename} must contain a JSON object")
    return parsed


def folder_children(
    api: Any,
    repo_id: str,
    token: str | None,
    progress: Any | None = None,
    revision: str | None = None,
) -> list[dict[str, Any]]:
    names = root_child_names(api, repo_id, token, revision)
    children = []
    for index, name in enumerate(names, start=1):
        children.append({"name": name, "path": name})
        if progress:
            progress(index, len(names), name)
    return children


def build_entry(
    api: Any,
    item: Any,
    root: Path,
    token: str | None,
    old: dict[str, Any] | None,
    force: bool,
    progress: Any | None = None,
) -> dict[str, Any]:
    repo_id = str(getattr(item, "id", ""))
    fields = catalog_fields(item)
    sha = fields["sha"]
    if (
        old
        and sha
        and not force
        and old.get("sha") == sha
    ):
        entry = dict(old)
        entry["localState"] = local_state(root, repo_id)
        entry.update(fields)
        return entry

    try:
        info = read_downloaded_info(repo_id, "meta/info.json", token, sha)
    except Exception as exc:
        if not is_missing_entry(exc):
            return minimal_entry(item, root, safe_error(exc, token))
        try:
            children = folder_children(
                api, repo_id, token, progress, revision=sha
            )
        except Exception as child_exc:
            return minimal_entry(item, root, safe_error(child_exc, token))
        if not children:
            return minimal_entry(item, root, safe_error(exc, token))
        return {
            **minimal_entry(item, root),
            "layout": "folder",
            "children": children,
            **fields,
            "uploader": uploader_for(api, repo_id, token),
            "metadataState": "ok",
        }

    return {
        **minimal_entry(item, root),
        "layout": "dataset",
        "children": [],
        **info_fields(info),
        **fields,
        "uploader": uploader_for(api, repo_id, token),
        "metadataState": "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--org", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    try:
        from huggingface_hub import HfApi
    except Exception as exc:
        emit({"type": "error", "error": f"huggingface_hub is unavailable: {exc}"})
        return 1

    root = Path(args.root).resolve()
    cache_path = Path(args.cache).resolve()
    cached = read_cache(cache_path)
    # Schema upgrades retain safe ordinary rows but deliberately invalidate
    # same-SHA Folder rows so their root layout is re-discovered.
    old_by_repo = reusable_cache_entries(cached)
    token = os.environ.get("HF_TOKEN") or None
    api = HfApi()
    try:
        repos = list(
            api.list_datasets(
                author=args.org,
                sort="lastModified",
                expand=["sha", "createdAt", "lastModified", "downloads"],
                token=token,
            )
        )
    except Exception as exc:
        emit(
            {
                "type": "error",
                "error": f"Could not list datasets for {args.org}: {safe_error(exc, token)}",
            }
        )
        return 1

    entries: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    total = len(repos)
    for index, item in enumerate(repos, start=1):
        repo_id = str(getattr(item, "id", ""))
        emit(
            {
                "type": "progress",
                "progress": {
                    "phase": "metadata",
                    "index": index,
                    "total": total,
                    "repoId": repo_id,
                },
            }
        )
        try:
            def folder_progress(
                completed: int,
                child_total: int,
                child_name: str | None,
            ) -> None:
                fraction = completed / child_total if child_total else 1
                emit(
                    {
                        "type": "progress",
                        "progress": {
                            "phase": "folder",
                            "index": index,
                            "total": total,
                            "repoId": repo_id,
                            "child": child_name,
                            "childIndex": completed,
                            "childTotal": child_total,
                            "percent": round(
                                ((index - 1) + fraction) / total * 100, 1
                            )
                            if total
                            else 100,
                        },
                    }
                )

            entry = build_entry(
                api,
                item,
                root,
                token,
                old_by_repo.get(repo_id),
                args.force,
                folder_progress,
            )
            entries.append(entry)
            if entry.get("metadataState") in {"error", "partial"}:
                failures.append(
                    {
                        "repoId": repo_id,
                        "error": str(
                            entry.get("metadataError") or "Metadata unavailable"
                        ),
                    }
                )
        except Exception as exc:
            error = safe_error(exc, token)
            failures.append({"repoId": repo_id, "error": error})
            entries.append(minimal_entry(item, root, error))

    result = {
        "catalogVersion": CATALOG_VERSION,
        "org": args.org,
        "refreshedAt": datetime.now(timezone.utc).isoformat(),
        "datasets": entries,
        "failures": failures,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f"{args.org}.", suffix=".tmp", dir=str(cache_path.parent)
    )
    os.close(fd)
    try:
        Path(temporary).write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, cache_path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    emit({"type": "result", "result": result})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
