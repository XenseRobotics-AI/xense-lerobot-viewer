/**
 * Focus rules for the viewer's global keyboard shortcuts.
 *
 * The decisions live here as pure functions over a small description of the
 * focused element, with the DOM reading isolated in `describeShortcutTarget`.
 * These rules are subtle — Space has to reach the player without stealing
 * activation from buttons, and without letting a focused episode link scroll
 * the sidebar instead — and they are exactly the kind of thing that regresses
 * silently. Splitting them out is what makes them testable in a suite that
 * has no DOM.
 */

/** Everything the shortcut layer needs to know about the focused element. */
export type ShortcutFocusTarget = {
  /** Uppercase tag name, e.g. `"BUTTON"`. */
  tagName: string;
  /** The `role` attribute, or null when absent. */
  role: string | null;
  /** True for `<a href>` — a link the browser will treat as activatable. */
  hasHref: boolean;
  /** True when the element or an ancestor is contenteditable. */
  isContentEditable: boolean;
  /** `type` of an `<input>`, else null. */
  inputType: string | null;
  /** True when the element sits inside a `[data-episode-link]` anchor. */
  insideEpisodeLink: boolean;
};

/**
 * Read the parts of a focus target the rules below need. Returns null for
 * anything that is not an element (window, document, a detached node).
 */
export function describeShortcutTarget(
  target: EventTarget | null,
): ShortcutFocusTarget | null {
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    role: target.getAttribute("role"),
    hasHref: target.tagName === "A" && target.hasAttribute("href"),
    isContentEditable:
      target.isContentEditable ||
      target.closest('[contenteditable="true"]') !== null,
    inputType:
      target.tagName === "INPUT" ? (target as HTMLInputElement).type : null,
    insideEpisodeLink: target.closest("[data-episode-link]") !== null,
  };
}

/**
 * Skip every global shortcut while typing in a field.
 *
 * The playback slider is an `<input>`, but it is *the* thing the shortcuts
 * drive — keep them global while it has focus so clicking the scrubber
 * doesn't disable Space/arrows.
 */
export function blocksAllShortcuts(
  target: ShortcutFocusTarget | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.inputType !== null) return target.inputType !== "range";
  return target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * Space activates buttons, but it does not activate a native link: on a
 * focused `<a>` the browser scrolls instead. Episode selection leaves its
 * link focused, so yielding to that link made the next Space scroll the
 * sidebar rather than toggle playback. Keep the native behavior for every
 * other activatable element; episode links opt into the viewer shortcut.
 *
 * The arrow shortcuts deliberately do *not* consult this — buttons and links
 * don't consume arrow keys, and that is what keeps ↑/↓/←/→ alive after a
 * click on a sidebar episode or a 3D control.
 */
export function yieldsSpaceShortcut(
  target: ShortcutFocusTarget | null,
): boolean {
  if (!target) return false;
  if (target.insideEpisodeLink) return false;
  return (
    target.tagName === "BUTTON" || target.role === "button" || target.hasHref
  );
}
