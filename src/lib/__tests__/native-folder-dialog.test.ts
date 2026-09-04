import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findDialogTool,
  hasDisplay,
  isLoopbackHost,
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

describe("isLoopbackHost", () => {
  test("accepts this machine, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "app.localhost:3000",
      "LOCALHOST:3000",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("refuses anything a LAN browser would send", () => {
    for (const host of [
      "192.168.110.20:3000",
      "viewer.internal",
      "127.0.0.1.example.com",
      "",
      null,
      undefined,
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
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
