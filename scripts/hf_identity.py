#!/usr/bin/env python3
"""Resolve the Hugging Face identity used by the Viewer.

The token is intentionally read from the private child-process environment or
the standard huggingface-cli cache. It is never printed and never included in
the JSON response. The Node route uses ``XENSE_HF_TOKEN`` for an explicitly
resolved credential, then this script removes it before calling the Hub.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

# Account verification deliberately uses the official Hub. A download mirror
# is a transfer optimization, not the authority that issued the token.
os.environ.setdefault("HF_ENDPOINT", "https://huggingface.co")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True)
    parser.add_argument(
        "--whoami-only",
        action="store_true",
        help="verify the credential without listing organization datasets",
    )
    args = parser.parse_args()

    try:
        from huggingface_hub import HfApi, get_token, list_datasets
    except Exception as exc:
        emit({
            "type": "result",
            "result": {
                "endpoint": os.environ.get("HF_ENDPOINT", ""),
                "tokenPresent": False,
                "tokenValid": None,
                "username": None,
                "visibleDatasets": None,
                "identityError": f"huggingface_hub is unavailable: {exc}",
            },
        })
        return 0

    token = os.environ.pop("XENSE_HF_TOKEN", None) or get_token()
    token_present = bool(token)
    username = None
    token_valid = None
    identity_error = None

    if token:
        try:
            who = HfApi().whoami(token=token)
            username = who.get("name") or who.get("user", {}).get("name")
            token_valid = bool(username)
            if not token_valid:
                identity_error = "Hugging Face did not return an account name."
        except Exception as exc:
            token_valid = False
            identity_error = f"Hugging Face token verification failed: {exc}"

    visible = None
    listing_error = None
    if not args.whoami_only:
        try:
            visible = sum(
                1
                for _ in list_datasets(
                    author=args.org,
                    token=token,
                    sort="lastModified",
                )
            )
        except Exception as exc:
            listing_error = f"Could not list datasets for {args.org}: {exc}"

    result = {
        "endpoint": os.environ.get("HF_ENDPOINT", ""),
        "tokenPresent": token_present,
        "tokenValid": token_valid,
        "username": username,
        "visibleDatasets": visible,
    }
    if identity_error:
        result["identityError"] = identity_error
    if listing_error:
        result["listingError"] = listing_error
    emit({"type": "result", "result": result})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        emit({"type": "error", "error": traceback.format_exc(limit=3)})
        raise SystemExit(1)
