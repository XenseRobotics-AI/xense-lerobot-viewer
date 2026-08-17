#!/usr/bin/env python3
"""Build a lightweight Hugging Face dataset catalog for the local Viewer.

This command is intentionally explicit: the Next route invokes it only after a
user presses Refresh statistics. It reads small metadata files from the Hub,
never downloads videos or parquet data, and writes a cache under the local
dataset root. Credentials come from HF_TOKEN / the normal huggingface_hub
cache and are never included in emitted JSON.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


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
    """Keep Hub diagnostics useful without persisting the bearer token."""
    message = str(exc)
    return message.replace(token, "[REDACTED]") if token else message


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


def uploader_for(api: Any, repo_id: str, token: str | None) -> str | None:
    try:
        commits = list(api.list_repo_commits(repo_id=repo_id, repo_type="dataset", token=token))
        if not commits:
            return None
        # The Hub returns newest first; the final item is the earliest author.
        commit = commits[-1]
        authors = getattr(commit, "authors", None)
        if isinstance(authors, (list, tuple)) and authors:
            author = authors[0]
        else:
            author = getattr(commit, "author", None)
        if isinstance(author, str) and author.strip():
            return author.strip()
        if isinstance(author, dict):
            name = author.get("name") or author.get("email")
            return str(name).strip() if name else None
    except Exception:
        return None
    return None


def build_entry(api: Any, item: Any, root: Path, token: str | None, old: dict[str, Any] | None, force: bool) -> dict[str, Any]:
    repo_id = str(getattr(item, "id", ""))
    sha = getattr(item, "sha", None)
    sha = str(sha) if sha else None
    if old and not force and old.get("sha") == sha:
        entry = dict(old)
        entry["localState"] = local_state(root, repo_id)
        return entry

    info: dict[str, Any] = {}
    metadata_error: str | None = None
    try:
        from huggingface_hub import hf_hub_download

        info_file = hf_hub_download(
            repo_id=repo_id,
            filename="meta/info.json",
            repo_type="dataset",
            token=token,
        )
        parsed = json.loads(Path(info_file).read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            info = parsed
    except Exception as exc:
        metadata_error = safe_error(exc, token)

    frames = info.get("total_frames")
    episodes = info.get("total_episodes")
    fps = info.get("fps")
    try:
        frames_num = float(frames or 0)
    except (TypeError, ValueError):
        frames_num = 0.0
    try:
        episodes_num = int(episodes or 0)
    except (TypeError, ValueError):
        episodes_num = 0
    try:
        fps_num = float(fps or 0)
    except (TypeError, ValueError):
        fps_num = 0.0
    duration = frames_num / fps_num / 3600 if frames_num > 0 and fps_num > 0 else 0
    return {
        "repoId": repo_id,
        "org": repo_id.split("/", 1)[0] if "/" in repo_id else "",
        "name": repo_id.rsplit("/", 1)[-1],
        "localState": local_state(root, repo_id),
        "totalEpisodes": episodes_num,
        "totalFrames": int(frames_num) if frames_num.is_integer() else frames_num,
        "totalTasks": int(info.get("total_tasks") or 0),
        "fps": fps_num,
        "durationHours": round(duration, 6),
        "robotType": info.get("robot_type"),
        "sha": sha,
        "lastModified": iso(getattr(item, "lastModified", None)),
        "uploader": uploader_for(api, repo_id, token),
        "metadataState": "ok" if not metadata_error else "error",
        **({"metadataError": metadata_error} if metadata_error else {}),
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
    old_by_repo = {
        str(entry.get("repoId")): entry
        for entry in cached.get("datasets", [])
        if isinstance(entry, dict) and entry.get("repoId")
    }
    token = os.environ.get("HF_TOKEN") or None
    api = HfApi()
    try:
        repos = list(
            api.list_datasets(
                author=args.org,
                sort="lastModified",
                expand=["sha"],
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
        emit({"type": "progress", "progress": {"phase": "metadata", "index": index, "total": total, "repoId": repo_id}})
        try:
            entries.append(build_entry(api, item, root, token, old_by_repo.get(repo_id), args.force))
        except Exception as exc:
            failures.append({"repoId": repo_id, "error": safe_error(exc, token)})

    result = {
        "org": args.org,
        "refreshedAt": datetime.now(timezone.utc).isoformat(),
        "datasets": entries,
        "failures": failures,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f"{args.org}.", suffix=".tmp", dir=str(cache_path.parent))
    os.close(fd)
    try:
        Path(temporary).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
