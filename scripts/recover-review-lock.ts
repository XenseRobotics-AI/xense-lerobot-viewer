import fs from "node:fs/promises";
import path from "node:path";
import { readReviewCollection } from "../src/lib/episode-reviews-store";
import { recoverLegacyReviewLock } from "../src/lib/review-write-lock";

const [browsePath, confirmation] = process.argv.slice(2);
if (!browsePath || confirmation !== "--no-legacy-writers") {
  console.error(
    "First pause saves on ALL old-version viewer servers and wait for in-flight writes to finish. Browsing may continue. Then run: bun scripts/recover-review-lock.ts <browse-directory> --no-legacy-writers",
  );
  process.exitCode = 1;
} else {
  try {
    const root = await fs.realpath(browsePath);
    await readReviewCollection(root);
    const backup = await recoverLegacyReviewLock(
      path.join(root, ".xense-viewer", "episode-reviews.json"),
    );
    console.log("Empty legacy lock recovered. Records backed up to: " + backup);
    console.log(
      "Existing records and unfinished temporary files were not changed. Retry the manual mark in the viewer.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
