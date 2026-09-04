import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findDialogTool,
  hasDisplay,
  isDialogOpen,
  pickFolder,
} from "@/lib/native-folder-dialog";

const saved = {
  PATH: process.env.PATH,
  DISPLAY: process.env.DISPLAY,
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("display and tool detection", () => {
  test("hasDisplay follows DISPLAY / WAYLAND_DISPLAY", () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(hasDisplay()).toBe(false);
    process.env.DISPLAY = ":0";
    expect(hasDisplay()).toBe(true);
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(hasDisplay()).toBe(true);
  });

  test("findDialogTool picks an executable off PATH and ignores the rest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dialog-tool-"));
    try {
      process.env.PATH = dir;
      expect(await findDialogTool()).toBeNull();

      // Present but not executable is not usable.
      await fs.writeFile(path.join(dir, "zenity"), "#!/bin/sh\n", {
        mode: 0o644,
      });
      expect(await findDialogTool()).toBeNull();

      await fs.chmod(path.join(dir, "zenity"), 0o755);
      expect((await findDialogTool())?.command).toBe("zenity");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pickFolder", () => {
  test("reports unavailable without a display, and without a tool", async () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const noDisplay = await pickFolder("/tmp", "t");
    expect(noDisplay.kind).toBe("unavailable");
    expect(noDisplay).toHaveProperty(
      "reason",
      expect.stringContaining("DISPLAY"),
    );

    process.env.DISPLAY = ":0";
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "no-tools-"));
    try {
      process.env.PATH = empty;
      const noTool = await pickFolder("/tmp", "t");
      expect(noTool.kind).toBe("unavailable");
      expect(noTool).toHaveProperty(
        "reason",
        expect.stringContaining("No folder dialog"),
      );
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  test("returns the path a tool prints, and cancelled when it prints nothing", async () => {
    process.env.DISPLAY = ":0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-zenity-"));
    try {
      const tool = path.join(dir, "zenity");
      await fs.writeFile(tool, "#!/bin/sh\necho /archive/TacVerse\n", {
        mode: 0o755,
      });
      process.env.PATH = dir;
      expect(await pickFolder("/tmp", "t")).toEqual({
        kind: "picked",
        path: "/archive/TacVerse",
      });

      // Dismissed: no output, non-zero exit, nothing on stderr.
      await fs.writeFile(tool, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      expect(await pickFolder("/tmp", "t")).toEqual({ kind: "cancelled" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("one dialog at a time", () => {
  test("a second request is refused while the first is open, and the lock clears", async () => {
    process.env.DISPLAY = ":0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slow-zenity-"));
    try {
      await fs.writeFile(
        path.join(dir, "zenity"),
        "#!/bin/sh\nsleep 0.4\necho /archive/TacVerse\n",
        { mode: 0o755 },
      );
      // The fake tool comes first, but the rest of PATH has to stay: the
      // script itself needs `sleep`, and without it the "slow" dialog would
      // finish before the assertion below.
      process.env.PATH = `${dir}${path.delimiter}${saved.PATH ?? ""}`;

      const first = pickFolder("/tmp", "t");
      // Let the child start so the lock is really held.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(isDialogOpen()).toBe(true);
      const second = await pickFolder("/tmp", "t");
      expect(second).toEqual({
        kind: "unavailable",
        reason: "A folder dialog is already open on the server's desktop.",
      });

      expect(await first).toEqual({
        kind: "picked",
        path: "/archive/TacVerse",
      });
      // The lock is released, so the next request gets a dialog again.
      expect(isDialogOpen()).toBe(false);
      expect((await pickFolder("/tmp", "t")).kind).toBe("picked");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
