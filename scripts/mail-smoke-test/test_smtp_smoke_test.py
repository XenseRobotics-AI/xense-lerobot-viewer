from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).with_name("smtp_smoke_test.py")
SPEC = importlib.util.spec_from_file_location("smtp_smoke_test", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT_PATH}")
SMTP_SMOKE_TEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMTP_SMOKE_TEST)


class BuildMessageTest(unittest.TestCase):
    def test_builds_multipart_alternative_message(self) -> None:
        message = SMTP_SMOKE_TEST.build_message(
            "sender@example.com",
            "one@example.com, two@example.com",
            "Workbench dashboard",
            "Plain fallback with readable labels.",
            "<!doctype html><html><body><h1>Workbench</h1></body></html>",
        )

        self.assertEqual(message.get_content_type(), "multipart/alternative")
        self.assertEqual(
            str(message["To"]),
            "one@example.com, two@example.com",
        )
        parts = list(message.iter_parts())
        self.assertEqual(
            [part.get_content_type() for part in parts],
            ["text/plain", "text/html"],
        )
        self.assertEqual(
            parts[0].get_content().strip(),
            "Plain fallback with readable labels.",
        )
        self.assertIn("<h1>Workbench</h1>", parts[1].get_content())

    def test_parses_and_deduplicates_multiple_recipients(self) -> None:
        self.assertEqual(
            SMTP_SMOKE_TEST.parse_recipient_addresses(
                "one@example.com；two@example.com,ONE@example.com"
            ),
            ["one@example.com", "two@example.com"],
        )

        with self.assertRaises(SMTP_SMOKE_TEST.ConfigError):
            SMTP_SMOKE_TEST.parse_recipient_addresses("invalid")

    def test_loads_qq_preset_without_extra_provider_settings(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SMTP_PASSWORD": "qq-auth-code",
                "SMTP_TO_ADDRESS": "one@example.com",
            },
            clear=True,
        ):
            config = SMTP_SMOKE_TEST.load_config()

        self.assertEqual(config["provider"], "qq")
        self.assertEqual(config["host"], "smtp.qq.com")
        self.assertEqual(config["port"], 465)
        self.assertTrue(config["use_ssl"])
        self.assertEqual(config["from_address"], "1796262052@qq.com")

    def test_loads_163_preset_with_mailbox_and_authorization_code(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SMTP_PROVIDER": "163",
                "SMTP_PASSWORD": "163-auth-code",
                "SMTP_FROM_ADDRESS": "operator@163.com",
                "SMTP_TO_ADDRESS": "one@example.com",
            },
            clear=True,
        ):
            config = SMTP_SMOKE_TEST.load_config()

        self.assertEqual(config["provider"], "163")
        self.assertEqual(config["host"], "smtp.163.com")
        self.assertEqual(config["port"], 465)
        self.assertTrue(config["use_ssl"])
        self.assertEqual(config["username"], "operator@163.com")

    def test_requires_a_sender_for_163(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SMTP_PROVIDER": "163",
                "SMTP_PASSWORD": "163-auth-code",
                "SMTP_TO_ADDRESS": "one@example.com",
            },
            clear=True,
        ):
            with self.assertRaises(SMTP_SMOKE_TEST.ConfigError):
                SMTP_SMOKE_TEST.load_config()

    def test_keeps_custom_submission_ports_non_ssl_by_default(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SMTP_PROVIDER": "163",
                "SMTP_PASSWORD": "163-auth-code",
                "SMTP_FROM_ADDRESS": "operator@163.com",
                "SMTP_TO_ADDRESS": "one@example.com",
                "SMTP_PORT": "587",
            },
            clear=True,
        ):
            config = SMTP_SMOKE_TEST.load_config()

        self.assertEqual(config["port"], 587)
        self.assertFalse(config["use_ssl"])


if __name__ == "__main__":
    unittest.main()
