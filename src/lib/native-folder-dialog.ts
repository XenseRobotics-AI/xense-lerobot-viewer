/**
 * The desktop's own "choose a folder" dialog, opened by the server.
 *
 * A browser cannot hand a web page an absolute path: `webkitdirectory` reports
 * relative names and the File System Access API only a handle, both by design.
 * This app is served from the machine that holds the datasets, though, so the
 * server can pop the desktop's real dialog (`zenity`, or `kdialog` on KDE) and
 * read back the path the person picked.
 *
 * That only makes sense when the browser and the server share a screen, so the
 * route in front of this refuses non-loopback requests: on a LAN the dialog
 * would appear on somebody else's desktop. When no tool or no display is
 * available the caller is told so and the path can still be typed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Long enough to find a folder, short enough not to pin a handler forever. */
const DIALOG_TIMEOUT_MS = 3 * 60 * 1000;

export type FolderDialogResult =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: string };

type DialogTool = {
  command: string;
  args: (startDir: string, title: string) => string[];
};

const TOOLS: DialogTool[] = [
  {
    command: "zenity",
    args: (startDir, title) => [
      "--file-selection",
      "--directory",
      `--title=${title}`,
      // The trailing separator is what makes zenity open *inside* the
      // directory rather than selecting it in its parent.
      `--filename=${startDir.endsWith(path.sep) ? startDir : `${startDir}${path.sep}`}`,
    ],
  },
  {
    command: "kdialog",
    args: (startDir, title) => [
      "--getexistingdirectory",
      startDir,
      "--title",
      title,
    ],
  },
];

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first dialog tool present on `PATH`, or null. */
export async function findDialogTool(): Promise<DialogTool | null> {
  const searchPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const tool of TOOLS) {
    for (const dir of searchPath) {
      if (await isExecutable(path.join(dir, tool.command))) return tool;
    }
  }
  return null;
}

/**
 * True when the `Host` header names this machine. The dialog opens on the
 * server's desktop, so anyone reaching the app across a LAN must not be able
 * to make windows appear on someone else's screen.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  const hostname = (host ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

export function hasDisplay(): boolean {
  return Boolean(
    process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim(),
  );
}

/**
 * Open the desktop folder dialog and resolve with what was chosen.
 *
 * Never rejects: a missing tool, no display, a crash or a timeout all come
 * back as `unavailable`, because the caller's fallback (type the path) is the
 * same in every one of those cases.
 */
export async function pickFolder(
  startDir: string,
  title: string,
): Promise<FolderDialogResult> {
  if (!hasDisplay()) {
    return {
      kind: "unavailable",
      reason: "The server has no desktop session (DISPLAY is not set).",
    };
  }
  const tool = await findDialogTool();
  if (!tool) {
    return {
      kind: "unavailable",
      reason: "No folder dialog is installed on the server (zenity, kdialog).",
    };
  }

  return new Promise<FolderDialogResult>((resolve) => {
    const child = spawn(tool.command, tool.args(startDir, title), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: FolderDialogResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        kind: "unavailable",
        reason: "The folder dialog was left open too long.",
      });
    }, DIALOG_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) =>
      finish({ kind: "unavailable", reason: error.message }),
    );
    child.on("close", (code) => {
      const picked = stdout.trim().split("\n")[0]?.trim() ?? "";
      if (picked) return finish({ kind: "picked", path: picked });
      // Both tools exit non-zero with no output when the dialog is dismissed;
      // anything the tool complained about is worth passing on instead.
      if (code !== 0 && stderr.trim()) {
        return finish({ kind: "unavailable", reason: stderr.trim() });
      }
      finish({ kind: "cancelled" });
    });
  });
}
