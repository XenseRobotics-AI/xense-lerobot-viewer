#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { discoverLocalDatasets } from "../src/lib/local-datasets-discovery";

const WORKBENCH_ORG = "TacVerse";
const WORKBENCH_URL = "http://192.168.200.11:3000";

const child = spawn(
  process.execPath,
  ["x", "next", "dev", ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  },
);

let announced = false;
const workbenchLinkPromise = discoverWorkbenchLink();

async function discoverWorkbenchLink(): Promise<string | null> {
  try {
    const { datasets } = await discoverLocalDatasets();
    if (datasets.length === 0) return null;
    return `${WORKBENCH_URL}/?org=${encodeURIComponent(WORKBENCH_ORG)}`;
  } catch {
    return null;
  }
}

function maybeAnnounce(text: string): void {
  if (announced || !/(Ready in|Local:)/.test(text)) return;
  announced = true;
  void workbenchLinkPromise.then((link) => {
    if (link) {
      console.log(`TacVerse: ${link}`);
    } else {
      console.log("TacVerse: no local dataset found.");
    }
  });
}

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  maybeAnnounce(text);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  maybeAnnounce(text);
});

const forwardSignal = (signal: NodeJS.Signals) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
