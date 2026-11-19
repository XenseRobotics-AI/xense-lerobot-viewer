/**
 * Keep camera visibility state valid when an episode exposes a different set
 * of streams. Hidden names that disappeared are dropped, and one stream is
 * always left visible so a dataset change cannot produce an empty player.
 */
export function normalizeHiddenVideoNames(
  videoNames: string[],
  hiddenNames: string[],
): string[] {
  const available = new Set(videoNames);
  const seen = new Set<string>();
  const hidden = hiddenNames.filter(
    (name) => available.has(name) && !seen.has(name) && seen.add(name),
  );
  if (available.size > 0 && hidden.length >= available.size) hidden.pop();
  return hidden;
}
