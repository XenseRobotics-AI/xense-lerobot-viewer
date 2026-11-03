import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// bun dev launches Next through its node shebang. Bun's stream adapters alone
// cannot catch the Node 18 toWeb/Response cancellation regression.
test("stream lifecycle boundaries pass under the actual Node runtime", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "viewer-node-streams-"),
  );
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const source of [
      "file-response",
      "task-stream-response",
      "shared-abortable-task",
      "background-process-response",
    ]) {
      const input = await fs.readFile(
        new URL(`../${source}.ts`, import.meta.url),
        "utf8",
      );
      await fs.writeFile(
        path.join(directory, `${source}.mjs`),
        transpiler.transformSync(input),
      );
    }
    const result = spawnSync(
      "node",
      [
        "--test",
        fileURLToPath(
          new URL(
            "../../../scripts/test-stream-lifecycle.mjs",
            import.meta.url,
          ),
        ),
      ],
      {
        env: { ...process.env, XENSE_STREAM_TEST_DIR: directory },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `${result.error ?? "Node regression failed"}\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# fail 0");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 25_000);
