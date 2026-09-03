#!/usr/bin/env python3
"""Sync every dataset of a Hugging Face org into the local dataset root.

This is the one outbound network path in an otherwise local-only viewer, and it
only ever runs when someone presses Sync. Downloads go through **hf-mirror.com**
unless HF_ENDPOINT is already set in the environment.

Why Python rather than the JS side: `huggingface_hub.snapshot_download` gives
resumable, incremental, parallel transfers of multi-GB repos for free, and
already picks up the cached CLI token (`~/.cache/huggingface/token`) so private
org repos work with no extra secret handling. The same reasoning put
`export_subtasks.py` here.

Protocol: one JSON object per line on stdout, matching the viewer's other
streaming route:

    {"type":"progress","progress":{...}}
    {"type":"result","result":{...}}
    {"type":"error","error":"..."}

Only repos that actually differ are transferred: the org listing carries each
repo's commit sha, and a local copy already sitting at that commit — with every
file its tree lists present at the right size — is left alone. `--force`
overrides that and re-fetches everything.

Usage:
    sync_hf_dataset.py --org TacVerse --root /path/to/lerobot [--list-only]
                       [--limit N] [--force]

    # one dataset, no org listing; the org is derived from the id
    sync_hf_dataset.py --repo lerobot/svla_so101_pickplace --root /path/to/lerobot
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

# Both must precede any huggingface_hub import — they are read at module load.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# huggingface_hub 1.x prefers Xet-backed transfers, which hf-mirror does not
# proxy: every download fails with "cannot find the requested files in the local
# cache". Falling back to plain HTTP resolution is what makes the mirror usable.
# Only forced when we are actually pointed at a mirror, so a direct-to-Hub run
# (HF_ENDPOINT overridden) keeps the faster Xet path.
if "hf-mirror" in os.environ.get("HF_ENDPOINT", ""):
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def emit(obj: dict) -> None:
    """Write one NDJSON event and flush — the reader streams these live."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(**fields) -> None:
    emit({"type": "progress", "progress": fields})


def fail(message: str) -> int:
    emit({"type": "error", "error": message})
    return 1


def missing_dependency() -> str | None:
    """Name the interpreter when the dependency is absent.

    Without this the ImportError is swallowed by the listing handler and
    reported as "Could not list datasets for <org>: No module named
    'huggingface_hub'", which points at the org instead of at the Python that
    actually ran — the one detail needed to fix it.
    """
    from importlib.util import find_spec

    if find_spec("huggingface_hub") is not None:
        return None
    return (
        f"huggingface_hub is not installed for {sys.executable}.\n"
        f"  Install it there ({sys.executable} -m pip install huggingface_hub), "
        "or set PYTHON_BIN in .env.local to an interpreter that already has it "
        "(e.g. a conda env: PYTHON_BIN=/path/to/envs/<name>/bin/python)."
    )


def list_org_repos(
    org: str,
    limit: int | None,
    token: str | None = None,
) -> list[tuple[str, str | None]]:
    """Every dataset in the org as `(repo_id, remote_commit_sha)`.

    `expand=["sha"]` costs nothing extra on the listing call and is what lets
    the caller skip repos that are already at that commit locally. A repo whose
    sha does not come back is reported as None and always counts as work — the
    conservative direction, since re-downloading is merely slow while wrongly
    skipping leaves the user without data they asked for.
    """
    from huggingface_hub import list_datasets

    # `direction=` was dropped in huggingface_hub 1.x; `sort` alone already
    # returns newest-first. Passing it would raise on the installed version.
    repos = [
        (d.id, getattr(d, "sha", None))
        for d in list_datasets(
            author=org,
            sort="lastModified",
            expand=["sha"],
            token=token,
        )
    ]
    return repos[:limit] if limit else repos


def fetch_repo_details(
    repo_ids: list[str],
    token: str | None = None,
) -> list[dict]:
    """Per-repo commit and size, for the explicit `--repo` path that never lists.

    `files_metadata=True` costs one extra round trip per repo but returns the
    size of every file, which is the whole point of the single-dataset flow:
    the confirmation step can say "12.4 GB across 340 files" instead of the
    useless "1 dataset pending". Deliberately not used on the org path — that
    would be ~188 metadata calls before anything is shown.

    The resolution error is kept rather than swallowed. On the org path an
    unresolvable repo is conservatively treated as work, but here the repo id
    was typed by hand, so "no such dataset" is the answer the caller needs and
    the caller (`main`) turns it into a failure instead of a download attempt.
    """
    from huggingface_hub import HfApi

    api = HfApi()
    out: list[dict] = []
    for repo_id in repo_ids:
        try:
            info = api.dataset_info(repo_id, files_metadata=True, token=token)
            siblings = list(getattr(info, "siblings", None) or [])
            sizes = [getattr(s, "size", None) for s in siblings]
            out.append({
                "id": repo_id,
                "sha": info.sha,
                # None rather than 0 when the Hub reports no sizes: "unknown"
                # and "empty" must not render as the same thing.
                "sizeBytes": (
                    sum(s for s in sizes if s) if any(s for s in sizes) else None
                ),
                "files": len(siblings) or None,
                "error": None,
            })
        except Exception as exc:
            out.append({
                "id": repo_id,
                "sha": None,
                "sizeBytes": None,
                "files": None,
                "error": str(exc),
            })
    return out


MOVED_CORPUS_CONTAINER = "TacVerse"
MOVED_CORPUS_BUCKETS = (
    "merged",
    "raw",
    "failed",
    "released",
    "in-processing",
)
MOVED_ORG_DEFAULT_BUCKET = {
    "TacVerse": "merged",
    "TacVerse-RAW": "raw",
    "TacVerse-Failed": "failed",
}


def repo_target(root: str, org: str, repo_id: str) -> str:
    """Return the local directory for a Hub dataset.

    Most organizations retain the historical ``<root>/<org>/<name>`` layout.
    The TacVerse corpus is different: its former sibling organizations now
    live below one container as ``TacVerse/<bucket>/<name>``.

    An existing dataset wins over the source's default bucket so a dataset
    moved to ``released`` or ``in-processing`` keeps being refreshed in place.
    If several copies exist, the source's default wins; an otherwise ambiguous
    target is refused instead of overwriting an arbitrary copy.
    """
    name = repo_id.rsplit("/", 1)[-1]
    default_bucket = MOVED_ORG_DEFAULT_BUCKET.get(org)
    if default_bucket is None:
        return os.path.join(root, org, name)

    container = os.path.join(root, MOVED_CORPUS_CONTAINER)
    default_target = os.path.join(container, default_bucket, name)
    existing = [
        os.path.join(container, bucket, name)
        for bucket in MOVED_CORPUS_BUCKETS
        if os.path.isdir(os.path.join(container, bucket, name))
    ]
    if default_target in existing:
        return default_target
    if len(existing) == 1:
        return existing[0]
    if len(existing) > 1:
        relative = ", ".join(os.path.relpath(target, root) for target in existing)
        raise RuntimeError(
            f"Ambiguous local target for {repo_id}: found {relative}. "
            "Keep only the intended corpus copy before syncing."
        )
    return default_target


def local_snapshot_shas(target: str) -> set[str]:
    """Commits `snapshot_download` has already materialised in this directory.

    It records one `.cache/huggingface/trees/<commit>.json` per snapshot it
    wrote, so the filenames alone answer "which commit is this copy at".
    """
    trees = os.path.join(target, ".cache", "huggingface", "trees")
    try:
        names = os.listdir(trees)
    except OSError:
        return set()
    return {n[:-5] for n in names if n.endswith(".json")}


def tree_is_intact(target: str, sha: str) -> bool:
    """Every file the commit's tree lists is present at the size it lists.

    The commit marker alone is not enough: it stays behind when files are later
    deleted, truncated by an interrupted move, or rewritten in place (which is
    exactly what `export_subtasks.py` does to the data parquets). Sizes are a
    cheap stand-in for content — the tree carries ~10 entries for a v3 dataset,
    so this is a handful of stat calls, not a hash.
    """
    path = os.path.join(target, ".cache", "huggingface", "trees", f"{sha}.json")
    try:
        with open(path, encoding="utf-8") as handle:
            files = json.load(handle).get("files") or {}
    except (OSError, ValueError):
        return False
    if not files:
        return False

    for relative, meta in files.items():
        try:
            size = os.stat(os.path.join(target, *relative.split("/"))).st_size
        except OSError:
            return False
        expected = meta.get("size")
        if isinstance(expected, int) and size != expected:
            return False
    return True


def is_up_to_date(root: str, org: str, repo_id: str, remote_sha: str | None) -> bool:
    if not remote_sha:
        return False
    target = repo_target(root, org, repo_id)
    if remote_sha not in local_snapshot_shas(target):
        return False
    return tree_is_intact(target, remote_sha)


MIRROR_HINT = (
    "The endpoint answers requests with a 308 redirect to huggingface.co "
    "instead of serving files, and huggingface_hub refuses the redirect "
    "because it carries no X-Repo-Commit header. Listing works; downloading "
    "does not.\n"
    "  A China-facing mirror commonly does this when the request arrives from "
    "a foreign IP — check whether a VPN or transparent proxy is capturing the "
    "mirror's own hostname, and add it to the proxy's direct/bypass rules if "
    "so. While it redirects, the mirror also saves no proxy bandwidth: every "
    "byte still comes from huggingface.co.\n"
    "  To download now: HF_ENDPOINT=https://huggingface.co"
)


def make_reporter(repo_id: str, index: int, total: int):
    """A tqdm stand-in that emits NDJSON instead of drawing bars.

    Repo-level counting alone is useless here: a 313-repo org advances 0.3% per
    repo, and a single multi-GB repo can sit at the same number for minutes with
    no sign of life. `snapshot_download` drives one bar for the file count and
    one per file for bytes, so subclassing gives both without touching its
    internals.
    """
    from huggingface_hub.utils import tqdm as hf_tqdm

    state = {"bytes": 0, "files_done": 0, "files_total": 0, "last_emit": 0.0}

    class Reporter(hf_tqdm):  # type: ignore[misc]
        def __init__(self, *a, **kw):
            self._is_file_counter = "Fetching" in str(kw.get("desc") or "")
            if self._is_file_counter:
                state["files_total"] = kw.get("total") or 0
                state["files_done"] = 0
            super().__init__(*a, **kw)

        def update(self, n=1):
            if self._is_file_counter:
                state["files_done"] += n or 0
            else:
                # Byte-level bar for one file in flight.
                state["bytes"] += n or 0
            self._emit()
            return super().update(n)

        def _emit(self, force: bool = False) -> None:
            now = time.time()
            # Two updates a second is enough to look alive without flooding the
            # stream with thousands of events on a large transfer.
            if not force and now - state["last_emit"] < 0.5:
                return
            state["last_emit"] = now
            files_total = state["files_total"] or 0
            within = (state["files_done"] / files_total) if files_total else 0.0
            progress(
                phase="downloading",
                repo=repo_id,
                index=index,
                total=total,
                # Overall percent blends completed repos with progress inside
                # the current one, so the number always moves.
                percent=round(((index - 1) + within) / total * 100, 1),
                repoPercent=round(within * 100, 1),
                filesDone=state["files_done"],
                filesTotal=files_total,
                bytes=state["bytes"],
            )

        def close(self):
            if self._is_file_counter:
                self._emit(force=True)
            return super().close()

    return Reporter


def preflight(repo_id: str, token: str | None = None) -> str | None:
    """Resolve one small file before committing to the whole org.

    Without this the endpoint problem only surfaces after the first repo has
    already been attempted, once per repo, with an error that says nothing
    actionable. Returns None when downloads work, or a diagnostic message.
    """
    from huggingface_hub import hf_hub_download
    import tempfile

    endpoint = os.environ.get("HF_ENDPOINT", "")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            hf_hub_download(
                repo_id=repo_id,
                filename="meta/info.json",
                repo_type="dataset",
                token=token,
                local_dir=tmp,
            )
        return None
    except Exception as exc:
        name = type(exc).__name__
        if name in ("LocalEntryNotFoundError", "FileMetadataError"):
            if "hf-mirror" in endpoint or endpoint not in ("", "https://huggingface.co"):
                return f"{endpoint} cannot serve downloads. {MIRROR_HINT}"
            return f"Could not reach the Hub: {exc}"
        # Anything else (auth, missing repo) is reported as-is by the caller.
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--org",
        default=None,
        help="Hugging Face org / author; derived from --repo when omitted",
    )
    parser.add_argument("--root", required=True, help="local dataset root")
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="report what would be downloaded, transfer nothing",
    )
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        help="restrict to these repo ids (repeatable); default is the whole org",
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-fetch every repo, including ones already at the remote commit",
    )
    args = parser.parse_args()

    blocker = missing_dependency()
    if blocker:
        return fail(blocker)

    token = os.environ.get("HF_TOKEN") or None

    # The org is a directory under the root (`repo_target`), so with explicit
    # repos it comes from the repo ids rather than being asked for twice and
    # allowed to disagree with them.
    owners = {r.split("/")[0] for r in args.repo if "/" in r}
    if args.repo:
        if len(owners) != 1 or any("/" not in r for r in args.repo):
            return fail("--repo takes `owner/name` ids sharing a single owner.")
        derived = next(iter(owners))
        if args.org and args.org != derived:
            return fail(f"--org {args.org} does not match --repo owner {derived}.")
        org = derived
    elif args.org:
        org = args.org
    else:
        return parser.error("one of --org or --repo is required") or 1

    endpoint = os.environ.get("HF_ENDPOINT", "")
    progress(phase="listing", endpoint=endpoint, org=org, percent=0)

    details: list[dict] | None = None
    try:
        if args.repo:
            details = fetch_repo_details(args.repo, token)
            listed = [(d["id"], d["sha"]) for d in details]
        else:
            listed = list_org_repos(org, args.limit, token)
    except Exception as exc:  # network down, bad token, unknown org
        return fail(f"Could not list datasets for {org}: {exc}")

    # A hand-typed id that does not resolve is the answer, not a download to
    # attempt: report it now rather than after a pointless transfer attempt.
    unresolved = [d for d in (details or []) if d["error"]]
    if unresolved:
        first = unresolved[0]
        return fail(f"Could not read {first['id']} from the Hub: {first['error']}")

    repos = [repo_id for repo_id, _ in listed]
    # The work list is the diff, not the org. Without this every run walks all
    # ~200 repos and pays a per-file metadata round trip to confirm each one is
    # unchanged, which is where "it starts from 1 again every time" came from.
    pending = [
        repo_id
        for repo_id, sha in listed
        if not is_up_to_date(args.root, org, repo_id, sha)
    ]

    def emit_result(downloaded: int, failed: list[dict], work: list[str]) -> int:
        emit({
            "type": "result",
            "result": {
                "org": org,
                "endpoint": endpoint,
                "repos": repos,
                "pending": pending,
                "downloaded": downloaded,
                "skipped": len(repos) - len(work),
                "failed": failed,
                "listOnly": args.list_only,
                # Only populated on the explicit --repo path; the org path does
                # not pay for per-repo metadata.
                **({"details": details} if details is not None else {}),
            },
        })
        return 0

    if not repos:
        return emit_result(0, [], [])

    if args.list_only:
        # The gate the UI uses to show a confirmation before pulling anything.
        return emit_result(0, [], pending)

    work = repos if args.force else pending
    if not work:
        # Nothing to do — say so rather than spending a metadata round trip per
        # file to rediscover it.
        progress(phase="complete", total=0, percent=100)
        return emit_result(0, [], work)

    # Fail fast and legibly rather than once per repo with a library message
    # that names neither the endpoint nor the fix.
    progress(phase="preflight", percent=0)
    blocker = preflight(work[0], token)
    if blocker:
        return fail(blocker)

    from huggingface_hub import snapshot_download

    total = len(work)
    downloaded = 0
    failed: list[dict] = []

    for i, repo_id in enumerate(work):
        target = repo_target(args.root, org, repo_id)
        progress(
            phase="downloading",
            repo=repo_id,
            index=i + 1,
            total=total,
            percent=round(i / total * 100),
        )
        try:
            snapshot_download(
                repo_id=repo_id,
                repo_type="dataset",
                token=token,
                local_dir=target,
                # Resumes partial transfers and skips files already identical,
                # so re-running after an interruption is cheap.
                max_workers=4,
                tqdm_class=make_reporter(repo_id, i + 1, total),
            )
            downloaded += 1
        except Exception as exc:
            # One bad repo must not abandon the rest of the org.
            failed.append({"repo": repo_id, "error": str(exc)})
            progress(phase="failed", repo=repo_id, index=i + 1, total=total)

    progress(phase="complete", total=total, percent=100)
    return emit_result(downloaded, failed, work)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(fail("Sync cancelled"))
    except Exception:
        sys.exit(fail(traceback.format_exc(limit=3)))
