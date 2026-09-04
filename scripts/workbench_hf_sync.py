#!/usr/bin/env python3
"""Read and commit Workbench shared state in a Hugging Face dataset repo.

Requests are JSON on stdin. Credentials are supplied only through
XENSE_HF_TOKEN and are never echoed in results or errors.
"""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_ENDPOINT", "https://huggingface.co")

MAX_FILES = 300
MAX_FILE_BYTES = 5_000_000


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def safe_error(exc: Exception, token: str | None) -> str:
    message = str(exc)
    return message.replace(token, "[REDACTED]") if token else message


def valid_repo_path(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    path = value.strip().replace("\\", "/")
    if (
        not path
        or path.startswith("/")
        or "//" in path
        or any(segment in ("", ".", "..") for segment in path.split("/"))
    ):
        return None
    return path


def username_for(api: Any, token: str | bool) -> str | None:
    if not token:
        return None
    try:
        result = api.whoami(token=token)
        if isinstance(result, dict):
            name = result.get("name") or result.get("fullname")
            if isinstance(name, str) and name.strip():
                return name.strip()
    except Exception:
        return None
    return None


def status_code(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None


def read_request() -> dict[str, Any]:
    raw = sys.stdin.read(MAX_FILE_BYTES * 2)
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Request must be a JSON object.")
    return value


def read_files(
    api: Any,
    repo_id: str,
    paths: list[Any],
    token: str | bool,
) -> dict[str, Any]:
    from huggingface_hub import hf_hub_download

    info = api.dataset_info(repo_id=repo_id, token=token)
    head = str(getattr(info, "sha", "") or "")
    if not head:
        raise RuntimeError("Hugging Face dataset repository has no head commit.")

    output: dict[str, Any] = {}
    for raw_path in paths[:MAX_FILES]:
        repo_path = valid_repo_path(raw_path)
        if not repo_path:
            raise ValueError("Invalid path requested from the shared repository.")
        try:
            downloaded = hf_hub_download(
                repo_id=repo_id,
                filename=repo_path,
                repo_type="dataset",
                revision=head,
                token=token,
            )
            output[repo_path] = json.loads(
                Path(downloaded).read_text(encoding="utf-8")
            )
        except Exception as exc:
            if status_code(exc) == 404:
                output[repo_path] = None
                continue
            raise

    return {
        "action": "read",
        "head": head,
        "username": username_for(api, token),
        "files": output,
    }


def commit_files(
    api: Any,
    repo_id: str,
    expected_head: Any,
    message: Any,
    files: list[Any],
    token: str | bool,
) -> dict[str, Any]:
    from huggingface_hub import CommitOperationAdd

    if not token:
        raise PermissionError(
            "A Hugging Face token with write access is required to publish shared state."
        )
    if not isinstance(expected_head, str) or not expected_head.strip():
        raise ValueError("expectedHead is required for an optimistic commit.")
    if not isinstance(message, str) or not message.strip():
        raise ValueError("A commit message is required.")
    if not files or len(files) > MAX_FILES:
        raise ValueError("A commit must contain between 1 and 300 files.")

    operations = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("Each commit file must be an object.")
        repo_path = valid_repo_path(item.get("path"))
        content = item.get("content")
        if not repo_path or not isinstance(content, str):
            raise ValueError("Each commit file needs a safe path and string content.")
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise ValueError("A shared state file exceeds the 5 MB limit.")
        operations.append(
            CommitOperationAdd(
                path_in_repo=repo_path,
                path_or_fileobj=io.BytesIO(encoded),
            )
        )

    try:
        result = api.create_commit(
            repo_id=repo_id,
            repo_type="dataset",
            revision="main",
            parent_commit=expected_head.strip(),
            operations=operations,
            commit_message=message.strip(),
            token=token,
        )
    except Exception as exc:
        if status_code(exc) in (409, 412):
            emit(
                {
                    "ok": False,
                    "code": "CONFLICT",
                    "error": "The shared repository changed during sync.",
                }
            )
            raise SystemExit(3)
        raise

    commit = str(getattr(result, "oid", "") or "")
    commit_url = getattr(result, "commit_url", None)
    return {
        "action": "commit",
        "commit": commit,
        "commitUrl": str(commit_url) if commit_url else None,
        "username": username_for(api, token),
    }


def main() -> int:
    token_value = os.environ.get("XENSE_HF_TOKEN", "").strip()
    token: str | bool = token_value or False
    try:
        from huggingface_hub import HfApi
    except Exception as exc:
        emit(
            {
                "ok": False,
                "code": "MISSING_DEPENDENCY",
                "error": "huggingface_hub is unavailable: "
                + safe_error(exc, token_value or None),
            }
        )
        return 1

    try:
        request = read_request()
        action = request.get("action")
        repo_id = request.get("repoId")
        if not isinstance(repo_id, str) or repo_id.count("/") != 1:
            raise ValueError("A valid Hugging Face dataset repoId is required.")
        api = HfApi(endpoint="https://huggingface.co")
        if action == "read":
            result = read_files(api, repo_id, request.get("paths") or [], token)
        elif action == "commit":
            result = commit_files(
                api,
                repo_id,
                request.get("expectedHead"),
                request.get("message"),
                request.get("files") or [],
                token,
            )
        else:
            raise ValueError("action must be read or commit.")
        emit({"ok": True, "result": result})
        return 0
    except SystemExit:
        raise
    except Exception as exc:
        emit(
            {
                "ok": False,
                "code": "HF_SYNC_FAILED",
                "error": safe_error(exc, token_value or None),
            }
        )
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
