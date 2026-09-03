#!/usr/bin/env python3
"""Send one multipart plain-text and HTML SMTP smoke-test message.

Run this from a Python interpreter inside the `lerobot` mamba environment.

Required environment variables:
  SMTP_PASSWORD or SMTP_PASSWORD_FILE

Optional environment variables:
  SMTP_HOST=smtp.qq.com
  SMTP_PORT=465
  SMTP_FROM_ADDRESS=1796262052@qq.com
  SMTP_TO_ADDRESS=frank@xenserobotics.com
  SMTP_USERNAME=<defaults to SMTP_FROM_ADDRESS>
  SMTP_SUBJECT=SMTP smoketest
  SMTP_TEXT_BODY=SMTP smoke test from xense-lerobot-viewer.
  SMTP_HTML_BODY=<p>SMTP smoke test from xense-lerobot-viewer.</p>
  SMTP_USE_SSL=1
  SMTP_TIMEOUT_SECONDS=15

For QQ Mail, SMTP_PASSWORD must be the IMAP/SMTP authorization code, not the
login password. If SMTP_PASSWORD_FILE is set, the script reads the password from
that file instead.
"""

from __future__ import annotations

import json
import os
import socket
import smtplib
import ssl
import sys
import traceback
from email.message import EmailMessage
from email.utils import formatdate, getaddresses, make_msgid
from pathlib import Path
from typing import Any

DEFAULT_SMTP_HOST = "smtp.qq.com"
DEFAULT_SMTP_PORT = 465
DEFAULT_FROM_ADDRESS = "1796262052@qq.com"
DEFAULT_TO_ADDRESS = "frank@xenserobotics.com"
DEFAULT_SUBJECT = "SMTP smoketest"
DEFAULT_TEXT_BODY = "SMTP smoke test from xense-lerobot-viewer."
DEFAULT_HTML_BODY = (
    "<!doctype html><html><body>"
    "<p>SMTP smoke test from xense-lerobot-viewer.</p>"
    "</body></html>"
)
DEFAULT_TIMEOUT_SECONDS = 15.0

TRUE_VALUES = {"1", "true", "yes", "on"}
FALSE_VALUES = {"0", "false", "no", "off"}


class ConfigError(Exception):
    """Raised when the environment does not describe a usable SMTP config."""


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def get_required_env(name: str, hint: str | None = None) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        message = f"missing required env var: {name}"
        if hint:
            message = f"{message} ({hint})"
        raise ConfigError(message)
    return value.strip()


def get_optional_env(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip()


def get_password() -> str:
    inline = os.environ.get("SMTP_PASSWORD")
    if inline and inline.strip():
        return inline.strip()

    password_file = os.environ.get("SMTP_PASSWORD_FILE")
    if password_file and password_file.strip():
        try:
            value = Path(password_file.strip()).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ConfigError(f"could not read SMTP_PASSWORD_FILE: {exc}") from exc
        if not value:
            raise ConfigError("SMTP_PASSWORD_FILE is empty")
        return value

    raise ConfigError("missing required env var: SMTP_PASSWORD or SMTP_PASSWORD_FILE")


def parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default

    value = raw.strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    raise ConfigError(f"{name} must be one of 1/0, true/false, yes/no, on/off")


def parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError as exc:
        raise ConfigError("SMTP_PORT must be an integer") from exc
    if not 1 <= port <= 65535:
        raise ConfigError("SMTP_PORT must be between 1 and 65535")
    return port


def parse_timeout() -> float:
    raw = os.environ.get("SMTP_TIMEOUT_SECONDS")
    if raw is None or not raw.strip():
        return DEFAULT_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError as exc:
        raise ConfigError("SMTP_TIMEOUT_SECONDS must be a number") from exc
    if timeout <= 0:
        raise ConfigError("SMTP_TIMEOUT_SECONDS must be greater than 0")
    return timeout


def parse_recipient_addresses(raw: str) -> list[str]:
    normalized_raw = raw.replace(";", ",").replace("；", ",").replace("，", ",")
    parsed = getaddresses([normalized_raw])
    recipients: list[str] = []
    seen: set[str] = set()
    for _, address in parsed:
        normalized = address.strip()
        if (
            not normalized
            or "@" not in normalized
            or normalized.startswith("@")
            or normalized.endswith("@")
        ):
            raise ConfigError("SMTP_TO_ADDRESS must contain valid email addresses")
        key = normalized.lower()
        if key not in seen:
            recipients.append(normalized)
            seen.add(key)
    if not recipients:
        raise ConfigError("SMTP_TO_ADDRESS must contain at least one email address")
    return recipients


def build_message(
    from_address: str,
    to_address: str,
    subject: str,
    text_body: str,
    html_body: str,
) -> EmailMessage:
    message_domain = from_address.rsplit("@", 1)[-1] if "@" in from_address else "qq.com"
    message_id = make_msgid(domain=message_domain)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_address
    msg["To"] = to_address
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = message_id
    msg["X-Mailer"] = "xense-lerobot-viewer smtp-smoke-test"
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    return msg


def load_config() -> dict[str, Any]:
    from_address = get_optional_env("SMTP_FROM_ADDRESS", DEFAULT_FROM_ADDRESS)
    to_addresses = parse_recipient_addresses(
        get_optional_env("SMTP_TO_ADDRESS", DEFAULT_TO_ADDRESS)
    )
    to_address = ", ".join(to_addresses)
    subject = get_optional_env("SMTP_SUBJECT", DEFAULT_SUBJECT)
    text_body = get_optional_env("SMTP_TEXT_BODY", DEFAULT_TEXT_BODY)
    html_body = get_optional_env("SMTP_HTML_BODY", DEFAULT_HTML_BODY)
    host = get_optional_env("SMTP_HOST", DEFAULT_SMTP_HOST)
    port = parse_port(get_optional_env("SMTP_PORT", str(DEFAULT_SMTP_PORT)))
    username = get_optional_env("SMTP_USERNAME", from_address)
    password = get_password()
    timeout = parse_timeout()
    use_ssl = parse_bool_env("SMTP_USE_SSL", default=port == 465)

    return {
        "from_address": from_address,
        "to_address": to_address,
        "to_addresses": to_addresses,
        "subject": subject,
        "text_body": text_body,
        "html_body": html_body,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "timeout": timeout,
        "use_ssl": use_ssl,
    }


def open_smtp(config: dict[str, Any]) -> smtplib.SMTP:
    if config["use_ssl"]:
        context = ssl.create_default_context()
        return smtplib.SMTP_SSL(
            config["host"],
            config["port"],
            timeout=config["timeout"],
            context=context,
        )
    return smtplib.SMTP(
        config["host"],
        config["port"],
        timeout=config["timeout"],
    )


def emit_error(stage: str, code: str, exc: BaseException) -> int:
    emit(
        {
            "type": "error",
            "stage": stage,
            "code": code,
            "error": str(exc),
        }
    )
    return {
        "config": 2,
        "auth": 3,
        "connect": 4,
        "send": 5,
    }[stage]


def main() -> int:
    try:
        config = load_config()
    except ConfigError as exc:
        emit({"type": "error", "stage": "config", "code": "config_error", "error": str(exc)})
        return 2

    message = build_message(
        config["from_address"],
        config["to_address"],
        config["subject"],
        config["text_body"],
        config["html_body"],
    )

    try:
        smtp = open_smtp(config)
    except (OSError, socket.timeout, smtplib.SMTPException) as exc:
        return emit_error("connect", "connect_error", exc)

    transport = "ssl" if config["use_ssl"] else "plain"

    try:
        with smtp:
            try:
                smtp.ehlo_or_helo_if_needed()
                if not config["use_ssl"] and smtp.has_extn("starttls"):
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                    transport = "starttls"
            except (OSError, socket.timeout, smtplib.SMTPException) as exc:
                return emit_error("connect", "connect_error", exc)

            try:
                smtp.login(config["username"], config["password"])
            except (smtplib.SMTPAuthenticationError, smtplib.SMTPNotSupportedError) as exc:
                return emit_error("auth", "auth_error", exc)

            try:
                refused = smtp.send_message(message, to_addrs=config["to_addresses"])
            except (OSError, socket.timeout, smtplib.SMTPException) as exc:
                return emit_error("send", "send_error", exc)

    except (OSError, socket.timeout, smtplib.SMTPException) as exc:
        return emit_error("send", "send_error", exc)

    if refused:
        emit(
            {
                "type": "error",
                "stage": "send",
                "code": "recipient_refused",
                "error": "server refused one or more recipients",
                "refusedRecipients": refused,
            }
        )
        return 5

    emit(
        {
            "type": "result",
            "result": {
                "status": "ok",
                "message": "SMTP smoke test sent.",
                "from": config["from_address"],
                "to": config["to_address"],
                "recipients": config["to_addresses"],
                "subject": config["subject"],
                "textBody": config["text_body"],
                "htmlBody": config["html_body"],
                "host": config["host"],
                "port": config["port"],
                "transport": transport,
                "username": config["username"],
                "messageId": message["Message-ID"],
                "refusedRecipients": {},
            },
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        emit(
            {
                "type": "error",
                "stage": "unexpected",
                "code": "unexpected_error",
                "error": traceback.format_exc(limit=3),
            }
        )
        raise SystemExit(1)
