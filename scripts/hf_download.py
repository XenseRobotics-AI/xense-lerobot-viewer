#!/usr/bin/env python3
"""Safely download one immutable Hugging Face dataset snapshot.

The Next.js route sends one JSON request on stdin.  ``check`` emits one JSON
object; ``download`` emits NDJSON progress followed by a result.  All paths are
derived here from a validated two- or three-segment source, and a completed
snapshot is promoted only after every selected file has been verified.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "15")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")
if "hf-mirror" in os.environ.get("HF_ENDPOINT", ""):
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CONTROL_DIR = ".xense-viewer"
STAGING_DIR = "hf-download-staging"
BACKUP_DIR = "hf-download-backups"
STATE_DIR = "hf-download-state"
PROGRESS_REPORT_INTERVAL = 0.5


class DownloadConflict(RuntimeError):
    pass


class DownloadCancelled(RuntimeError):
    pass


_cancelled = False


def _cancel(_signum: int, _frame: Any) -> None:
    global _cancelled
    _cancelled = True


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _progress_tqdm_class(callback: Callable[[int], None]) -> type[Any] | None:
    """Build a silent Hugging Face progress bar that forwards byte deltas.

    ``hf_hub_download`` already streams in chunks and accepts a ``tqdm_class``
    hook. Using that hook keeps the Hub cache, resume, and Xet support intact
    while allowing the NDJSON stream to carry progress during a large file.
    """
    try:
        from huggingface_hub.utils import tqdm as hf_tqdm
    except (ImportError, ModuleNotFoundError):
        return None

    class DownloadProgressTqdm(hf_tqdm):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            # Xet uses the same bar for reconstruction and transfer when the
            # class exposes update_transfer. Report only transfer bytes for
            # Xet, while regular HTTP downloads report from update().
            name = str(kwargs.get("name") or "")
            self._xense_is_xet = name.startswith("huggingface_hub.xet_get")
            kwargs["disable"] = True
            super().__init__(*args, **kwargs)

        def update(self, n: int | float = 1) -> Any:
            result = super().update(n)
            if not self._xense_is_xet and n:
                callback(int(n))
            return result

        def update_transfer(self, n: int | float = 1) -> None:
            if self._xense_is_xet and n:
                callback(int(n))

    return DownloadProgressTqdm


def safe_error(exc: BaseException, token: str | None) -> str:
    message = str(exc)
    return message.replace(token, "[REDACTED]") if token else message


def parse_source(value: Any) -> tuple[str, str | None, tuple[str, ...]]:
    """Return (real repo id, optional child folder, local path segments)."""
    if not isinstance(value, str):
        raise ValueError("source must be a Hugging Face path with two or three segments.")
    source = value.strip()
    if (
        not source
        or "://" in source
        or "\\" in source
        or source.startswith("/")
        or source.endswith("/")
    ):
        raise ValueError("source must be a safe two- or three-segment Hugging Face path.")
    parts = tuple(source.split("/"))
    if len(parts) not in (2, 3) or any(not SEGMENT.fullmatch(part) for part in parts):
        raise ValueError("source must be a safe two- or three-segment Hugging Face path.")
    return "/".join(parts[:2]), parts[2] if len(parts) == 3 else None, parts


def normalize_root(value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("destinationRoot must be a non-empty path.")
    expanded = Path(value.strip()).expanduser()
    if not expanded.is_absolute():
        expanded = Path.cwd() / expanded
    return expanded.resolve(strict=False)


def target_for(root: Path, source_parts: tuple[str, ...]) -> Path:
    target = root.joinpath(*source_parts)
    resolved = target.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("The destination escapes the selected download root.") from exc
    return resolved


def _remote_path(item: Any) -> str | None:
    value = getattr(item, "rfilename", None) or getattr(item, "path", None)
    return value if isinstance(value, str) and value else None


def _remote_size(item: Any) -> int | None:
    value = getattr(item, "size", None)
    return value if isinstance(value, int) and value >= 0 else None


def selected_files(
    siblings: Iterable[Any], subfolder: str | None, scope: str
) -> list[dict[str, Any]]:
    if scope not in {"all", "meta"}:
        raise ValueError("scope must be all or meta.")
    prefix = f"{subfolder}/" if subfolder else ""
    required = f"{prefix}meta/" if scope == "meta" else prefix
    output: list[dict[str, Any]] = []
    for item in siblings:
        remote = _remote_path(item)
        if not remote or not remote.startswith(required):
            continue
        parts = remote.split("/")
        if any(not part or part in {".", ".."} or "\\" in part for part in parts):
            raise ValueError("The repository contains an unsafe file path.")
        stripped = remote[len(prefix) :] if prefix else remote
        if scope == "meta" and not stripped.startswith("meta/"):
            continue
        output.append({"remotePath": remote, "localPath": stripped, "size": _remote_size(item)})
    return sorted(output, key=lambda entry: entry["remotePath"])


def _state_path(root: Path, parts: tuple[str, ...]) -> Path:
    candidate = (
        root / CONTROL_DIR / STATE_DIR / Path(*parts[:-1]) / f"{parts[-1]}.json"
    ).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("The download state path escapes the selected root.") from exc
    return candidate


def read_state(root: Path, parts: tuple[str, ...]) -> dict[str, Any]:
    try:
        value = json.loads(_state_path(root, parts).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(
    root: Path,
    parts: tuple[str, ...],
    repo_id: str,
    subfolder: str | None,
    scope: str,
    sha: str,
) -> None:
    destination = _state_path(root, parts)
    previous = read_state(root, parts)
    if scope == "all":
        previous.update({"fullSha": sha, "metaSha": sha, "fullConsistency": "current"})
    else:
        previous.update({"metaSha": sha, "fullSha": None, "fullConsistency": "unknown"})
    previous.update(
        {
            "source": "/".join(parts),
            "repoId": repo_id,
            "subfolder": subfolder,
            "lastScope": scope,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(previous, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, destination)


def build_check_result(
    source: Any,
    destination_root: Any,
    scope: str,
    revision_sha: str,
    siblings: Iterable[Any],
) -> dict[str, Any]:
    repo_id, subfolder, parts = parse_source(source)
    root = normalize_root(destination_root)
    target = target_for(root, parts)
    files = selected_files(siblings, subfolder, scope)
    if not files:
        raise ValueError("No files match the selected download scope.")
    known_sizes = [entry["size"] for entry in files if entry["size"] is not None]
    unknown = len(files) - len(known_sizes)
    state = read_state(root, parts)
    local_sha = state.get("metaSha" if scope == "meta" else "fullSha")
    scope_target = target / "meta" if scope == "meta" else target
    return {
        "source": "/".join(parts),
        "repoId": repo_id,
        "subfolder": subfolder,
        "revisionSha": revision_sha,
        "destinationRoot": str(root),
        "targetPath": str(target),
        "fileCount": len(files),
        "sizeBytes": sum(known_sizes),
        "unknownSizeFiles": unknown,
        "targetExists": target.exists(),
        "scopeExists": scope_target.exists(),
        "localScopeSha": local_sha if isinstance(local_sha, str) else None,
        "matchesRevision": local_sha == revision_sha and scope_target.exists(),
    }


def _backup_target(root: Path, parts: tuple[str, ...], scope: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    base = (root / CONTROL_DIR / BACKUP_DIR / stamp / Path(*parts)).resolve(
        strict=False
    )
    candidate = base / "meta" if scope == "meta" else base
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("The backup path escapes the selected root.") from exc
    return candidate


def promote_download(
    staged: Path,
    target: Path,
    root: Path,
    parts: tuple[str, ...],
    scope: str,
    *,
    fail_after_backup: bool = False,
) -> Path | None:
    """Atomically-ish replace the selected tree, restoring it on any failure."""
    existing = target / "meta" if scope == "meta" else target
    incoming = staged / "meta" if scope == "meta" else staged
    backup = _backup_target(root, parts, scope) if existing.exists() else None
    created_target = scope == "meta" and not target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    if scope == "meta":
        target.mkdir(parents=True, exist_ok=True)
    try:
        if backup:
            backup.parent.mkdir(parents=True, exist_ok=True)
            os.replace(existing, backup)
        if fail_after_backup:
            raise OSError("injected promotion failure")
        os.replace(incoming, existing)
        return backup
    except BaseException:
        if existing.exists():
            if existing.is_dir():
                shutil.rmtree(existing)
            else:
                existing.unlink()
        if backup and backup.exists():
            existing.parent.mkdir(parents=True, exist_ok=True)
            os.replace(backup, existing)
        elif created_target:
            try:
                target.rmdir()
            except OSError:
                pass
        raise


def rollback_promoted(target: Path, backup: Path | None, scope: str) -> None:
    """Remove the installed tree and restore its backup after a late failure."""
    installed = target / "meta" if scope == "meta" else target
    if installed.exists() or installed.is_symlink():
        if installed.is_dir() and not installed.is_symlink():
            shutil.rmtree(installed)
        else:
            installed.unlink()
    if backup and backup.exists():
        installed.parent.mkdir(parents=True, exist_ok=True)
        os.replace(backup, installed)
    elif scope == "meta":
        try:
            target.rmdir()
        except OSError:
            pass


def _api_and_info(repo_id: str, token: str | None) -> tuple[Any, Any]:
    from huggingface_hub import HfApi

    api = HfApi(endpoint=os.environ.get("HF_ENDPOINT") or "https://huggingface.co")
    info = api.dataset_info(repo_id=repo_id, files_metadata=True, token=token)
    return api, info


def check(request: dict[str, Any], token: str | None) -> dict[str, Any]:
    repo_id, _subfolder, _parts = parse_source(request.get("source"))
    _api, info = _api_and_info(repo_id, token)
    sha = str(getattr(info, "sha", "") or "")
    if not sha:
        raise RuntimeError("The repository did not report an immutable revision SHA.")
    return build_check_result(
        request.get("source"),
        request.get("destinationRoot"),
        request.get("scope"),
        sha,
        list(getattr(info, "siblings", None) or []),
    )


def download(request: dict[str, Any], token: str | None) -> dict[str, Any]:

    repo_id, subfolder, parts = parse_source(request.get("source"))
    root = normalize_root(request.get("destinationRoot"))
    target = target_for(root, parts)
    scope = request.get("scope")
    expected_sha = request.get("revisionSha")
    if not isinstance(expected_sha, str) or not expected_sha.strip():
        raise ValueError("revisionSha from Check download is required.")

    _api, info = _api_and_info(repo_id, token)
    actual_sha = str(getattr(info, "sha", "") or "")
    if actual_sha != expected_sha:
        raise DownloadConflict("The repository changed after it was checked. Check the download again.")
    from huggingface_hub import hf_hub_download

    files = selected_files(list(getattr(info, "siblings", None) or []), subfolder, scope)
    if not files:
        raise ValueError("No files match the selected download scope.")

    staging_parent = (root / CONTROL_DIR / STAGING_DIR).resolve(strict=False)
    try:
        staging_parent.relative_to(root)
    except ValueError as exc:
        raise ValueError("The staging path escapes the selected root.") from exc
    staging_parent.mkdir(parents=True, exist_ok=True)
    job = Path(tempfile.mkdtemp(prefix="download-", dir=staging_parent))
    snapshot = job / "snapshot"
    snapshot.mkdir()
    total_known = sum(entry["size"] or 0 for entry in files)
    processed = 0
    started = time.monotonic()
    try:
        for index, entry in enumerate(files, start=1):
            if _cancelled:
                raise DownloadCancelled("Download cancelled.")
            expected_size = entry["size"]
            file_downloaded = 0
            last_report = 0.0

            def report_file_progress(delta: int, *, force: bool = False) -> None:
                nonlocal file_downloaded, last_report
                file_downloaded = max(0, file_downloaded + delta)
                now = time.monotonic()
                if not force and now - last_report < PROGRESS_REPORT_INTERVAL:
                    return
                last_report = now
                elapsed = max(now - started, 0.001)
                emit(
                    {
                        "type": "progress",
                        "progress": {
                            "phase": "downloading",
                            "currentFile": entry["remotePath"],
                            "filesDone": index - 1,
                            "filesTotal": len(files),
                            "bytes": processed + file_downloaded,
                            "totalBytes": total_known,
                            "currentFileBytes": file_downloaded,
                            "currentFileTotalBytes": expected_size,
                            "bytesPerSecond": round((processed + file_downloaded) / elapsed),
                            "percent": round((index - 1) / len(files) * 100, 1),
                        },
                    }
                )

            emit(
                {
                    "type": "progress",
                    "progress": {
                        "phase": "downloading",
                        "currentFile": entry["remotePath"],
                        "filesDone": index - 1,
                        "filesTotal": len(files),
                        "bytes": processed,
                        "totalBytes": total_known,
                        "currentFileBytes": 0,
                        "currentFileTotalBytes": expected_size,
                        "percent": round((index - 1) / len(files) * 100, 1),
                    },
                }
            )
            progress_class = _progress_tqdm_class(report_file_progress)
            download_kwargs: dict[str, Any] = {
                "repo_id": repo_id,
                "filename": entry["remotePath"],
                "repo_type": "dataset",
                "revision": expected_sha,
                "token": token,
            }
            if progress_class is not None:
                download_kwargs["tqdm_class"] = progress_class
            cached = hf_hub_download(**download_kwargs)
            local = snapshot.joinpath(*entry["localPath"].split("/"))
            local.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cached, local)
            actual_size = local.stat().st_size
            if expected_size is not None and actual_size != expected_size:
                raise IOError(f"Size verification failed for {entry['remotePath']}.")
            report_file_progress(actual_size - file_downloaded, force=True)
            processed += actual_size
            elapsed = max(time.monotonic() - started, 0.001)
            emit(
                {
                    "type": "progress",
                    "progress": {
                        "phase": "downloading",
                        "currentFile": entry["remotePath"],
                        "filesDone": index,
                        "filesTotal": len(files),
                        "bytes": processed,
                        "totalBytes": total_known,
                        "currentFileBytes": actual_size,
                        "currentFileTotalBytes": expected_size,
                        "bytesPerSecond": round(processed / elapsed),
                        "percent": round(index / len(files) * 100, 1),
                    },
                }
            )

        if _cancelled:
            raise DownloadCancelled("Download cancelled.")
        emit({"type": "progress", "progress": {"phase": "promoting", "percent": 100}})
        backup = promote_download(snapshot, target, root, parts, scope)
        try:
            if _cancelled:
                raise DownloadCancelled("Download cancelled.")
            write_state(root, parts, repo_id, subfolder, scope, expected_sha)
        except BaseException:
            rollback_promoted(target, backup, scope)
            raise
        return {
            "source": "/".join(parts),
            "repoId": repo_id,
            "subfolder": subfolder,
            "lastScope": scope,
            "scope": scope,
            "revisionSha": expected_sha,
            "targetPath": str(target),
            "backupPath": str(backup) if backup else None,
            "fileCount": len(files),
            "sizeBytes": processed,
            "metaOnly": scope == "meta",
        }
    finally:
        shutil.rmtree(job, ignore_errors=True)


def main() -> int:
    token = os.environ.get("XENSE_HF_TOKEN", "").strip() or None
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("Request must be a JSON object.")
        action = request.get("action")
        if action == "check":
            emit({"ok": True, "result": check(request, token)})
        elif action == "download":
            result = download(request, token)
            emit({"type": "result", "result": result})
        else:
            raise ValueError("action must be check or download.")
        return 0
    except DownloadConflict as exc:
        emit({"type": "error", "code": "REVISION_CONFLICT", "error": safe_error(exc, token)})
        return 3
    except DownloadCancelled as exc:
        emit({"type": "error", "code": "CANCELLED", "error": safe_error(exc, token)})
        return 130
    except KeyboardInterrupt:
        emit({"type": "error", "code": "CANCELLED", "error": "Download cancelled."})
        return 130
    except BaseException as exc:
        emit({"type": "error", "code": "HF_DOWNLOAD_FAILED", "error": safe_error(exc, token)})
        return 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _cancel)
    raise SystemExit(main())
