from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
