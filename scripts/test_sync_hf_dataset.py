import tempfile
import unittest
from pathlib import Path

from scripts.sync_hf_dataset import repo_target, stats_repo_target


class RepoTargetTest(unittest.TestCase):
    def test_defaults_moved_organizations_to_their_new_buckets(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(
                Path(repo_target(root, "TacVerse", "TacVerse/example")),
                Path(root, "TacVerse", "merged", "example"),
            )
            self.assertEqual(
                Path(repo_target(root, "TacVerse-RAW", "TacVerse-RAW/example")),
                Path(root, "TacVerse", "raw", "example"),
            )
            self.assertEqual(
                Path(
                    repo_target(
                        root,
                        "TacVerse-Failed",
                        "TacVerse-Failed/example",
                    )
                ),
                Path(root, "TacVerse", "failed", "example"),
            )

    def test_stats_target_keeps_tacverse_repos_out_of_buckets(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = Path(
                stats_repo_target(
                    root,
                    "TacVerse",
                    "TacVerse/taccap-g1-remove-o-ring-0904",
                )
            )
            self.assertEqual(
                target,
                Path(root, "TacVerse", "taccap-g1-remove-o-ring-0904"),
            )
            self.assertNotIn("merged", target.parts)

    def test_keeps_an_existing_dataset_in_its_current_bucket(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            released = Path(root, "TacVerse", "released", "example")
            released.mkdir(parents=True)
            self.assertEqual(
                Path(repo_target(root, "TacVerse", "TacVerse/example")),
                released,
            )

    def test_prefers_the_source_default_when_multiple_copies_exist(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            merged = Path(root, "TacVerse", "merged", "example")
            merged.mkdir(parents=True)
            Path(root, "TacVerse", "released", "example").mkdir(parents=True)
            self.assertEqual(
                Path(repo_target(root, "TacVerse", "TacVerse/example")),
                merged,
            )

    def test_preserves_other_organizations_layout(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(
                Path(repo_target(root, "lerobot", "lerobot/example")),
                Path(root, "lerobot", "example"),
            )


if __name__ == "__main__":
    unittest.main()
