import { describe, it, expect } from "bun:test";
import {
  blocksAllShortcuts,
  yieldsSpaceShortcut,
  type ShortcutFocusTarget,
} from "../viewerShortcuts";

function focus(
  overrides: Partial<ShortcutFocusTarget> = {},
): ShortcutFocusTarget {
  return {
    tagName: "DIV",
    role: null,
    hasHref: false,
    isContentEditable: false,
    inputType: null,
    insideEpisodeLink: false,
    ...overrides,
  };
}

describe("blocksAllShortcuts", () => {
  it("blocks while typing in a text field", () => {
    expect(blocksAllShortcuts(focus({ tagName: "TEXTAREA" }))).toBe(true);
    expect(blocksAllShortcuts(focus({ tagName: "SELECT" }))).toBe(true);
    expect(
      blocksAllShortcuts(focus({ tagName: "INPUT", inputType: "text" })),
    ).toBe(true);
    expect(blocksAllShortcuts(focus({ isContentEditable: true }))).toBe(true);
  });

  it("exempts the playback scrubber, which the shortcuts drive", () => {
    expect(
      blocksAllShortcuts(focus({ tagName: "INPUT", inputType: "range" })),
    ).toBe(false);
  });

  it("does not block on ordinary elements or a missing target", () => {
    expect(blocksAllShortcuts(focus({ tagName: "BUTTON" }))).toBe(false);
    expect(blocksAllShortcuts(focus({ tagName: "A", hasHref: true }))).toBe(
      false,
    );
    expect(blocksAllShortcuts(null)).toBe(false);
  });
});

describe("yieldsSpaceShortcut", () => {
  it("yields Space to activatable elements", () => {
    expect(yieldsSpaceShortcut(focus({ tagName: "BUTTON" }))).toBe(true);
    expect(yieldsSpaceShortcut(focus({ tagName: "A", hasHref: true }))).toBe(
      true,
    );
    expect(yieldsSpaceShortcut(focus({ tagName: "DIV", role: "button" }))).toBe(
      true,
    );
  });

  it("keeps Space for the viewer on a focused episode link", () => {
    // The regression this guards: an episode link keeps focus after a click,
    // and Space on a native <a> scrolls rather than activates — so yielding
    // scrolled the sidebar instead of toggling playback.
    expect(
      yieldsSpaceShortcut(
        focus({ tagName: "A", hasHref: true, insideEpisodeLink: true }),
      ),
    ).toBe(false);
  });

  it("also covers a child element inside an episode link", () => {
    expect(
      yieldsSpaceShortcut(focus({ tagName: "SPAN", insideEpisodeLink: true })),
    ).toBe(false);
  });

  it("does not yield on a plain anchor with no href", () => {
    expect(yieldsSpaceShortcut(focus({ tagName: "A", hasHref: false }))).toBe(
      false,
    );
  });

  it("does not yield on a non-element target", () => {
    expect(yieldsSpaceShortcut(null)).toBe(false);
  });
});
