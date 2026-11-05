import fs from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { reviewTimestamp } from "../src/utils/reviewTime";
import { readReviewCollection } from "../src/lib/episode-reviews-store";
import { recoverLegacyReviewLock } from "../src/lib/review-write-lock";

const [browsePath, confirmation] = process.argv.slice(2);
if (!browsePath || confirmation !== "--no-legacy-writers") {
  console.error(
    "First pause saves on ALL old-version viewer servers and wait for in-flight writes to finish. Browsing may continue. Then run: bun scripts/recover-review-lock.ts <browse-directory> --no-legacy-writers",
  );
  process.exitCode = 1;
} else {
  let auditPath: string | undefined;
  try {
    const root = await fs.realpath(browsePath);
    await readReviewCollection(root);
    const auditDirectory = path.join(
      root,
      ".xense-viewer",
      "review-diagnostics",
    );
    const created = await fs.mkdir(auditDirectory, {
      recursive: true,
      mode: 0o2775,
    });
    const realAudit = await fs.realpath(auditDirectory);
    if (!realAudit.startsWith(root + path.sep))
      throw new Error("Recovery audit directory escapes browse directory");
    if (created) await fs.chmod(auditDirectory, 0o2775);
    auditPath = path.join(
      auditDirectory,
      "recovery-" + randomUUID() + ".jsonl",
    );
    await fs.writeFile(
      auditPath,
      JSON.stringify({
        at: reviewTimestamp(),
        event: "empty_lock_recovery_requested",
        host: hostname(),
        pid: process.pid,
      }) + "\n",
      { flag: "wx", mode: 0o664 },
    );
    await fs.chmod(auditPath, 0o664);
    const backup = await recoverLegacyReviewLock(
      path.join(root, ".xense-viewer", "episode-reviews.json"),
    );
    await fs.appendFile(
      auditPath,
      JSON.stringify({
        at: reviewTimestamp(),
        event: "empty_lock_recovered",
        backup: backup ? path.basename(backup) : null,
      }) + "\n",
    );
    console.log(
      backup
        ? "Empty legacy lock recovered. Records backed up to: " + backup
        : "Empty legacy lock recovered. No review file existed; no review file or backup was created.",
    );
    console.log(
      "Existing records and unfinished temporary files were not changed. Retry the manual mark in the viewer.",
    );
  } catch (error) {
    if (auditPath)
      await fs
        .appendFile(
          auditPath,
          JSON.stringify({
            at: reviewTimestamp(),
            event: "empty_lock_recovery_failed",
            error_code:
              (error as NodeJS.ErrnoException).code ?? "RECOVERY_FAILED",
          }) + "\n",
        )
        .catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
