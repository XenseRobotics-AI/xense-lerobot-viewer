/**
 * Picking the gripper open/close series out of an episode's chart groups.
 *
 * The Episodes tab spreads every feature across several charts grouped by
 * scale, which is the right default for reading a whole episode and the wrong
 * one for the single question "did the gripper close when the video shows it
 * closing". The chart toolbar's gripper filter answers that by collapsing the
 * grid to one chart carrying nothing but the opening series, video left in
 * place above it.
 */
import { CHART_CONFIG } from "./constants";
import type { ChartSeriesRow } from "@/types/chart.types";

const DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER;

/**
 * The feature a chart key names. `groupRowBySuffix` emits two shapes: a flat
 * `action | left_gripper.pos` for a dimension only one source records, and a
 * bare `left_gripper.pos` holding `{action, observation.state}` when several
 * record it. The feature is the last delimited part either way.
 */
export function chartSeriesFeature(key: string): string {
  return key.split(DELIM).at(-1)?.trim() || key;
}

/**
 * Feature names are dotted/underscored paths — `gripper`, `gripper.pos`,
 * `left_gripper.pos`, `right_gripper.position`. Matching a whole token rather
 * than a substring reads all of them without enumerating the value suffixes
 * (`.pos` / `.position` / `.q`) that `autoMatchJoints` and `findGripperKey`
 * tolerate separately, and without matching a name that merely contains the
 * letters.
 */
export function isGripperFeature(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes("gripper");
}

function gripperKeysOf(group: ChartSeriesRow[]): string[] {
  // Keys are uniform within a group, so the first row is the schema — the same
  // assumption `SingleDataGraph` makes when it derives `dataKeys`.
  const sample = group.find((row) => row != null);
  if (!sample) return [];
  return Object.keys(sample).filter(
    (key) => key !== "timestamp" && isGripperFeature(chartSeriesFeature(key)),
  );
}

/**
 * Every gripper series across the given chart groups, in group order. Empty
 * means this episode has no gripper feature to focus on — datasets whose
 * features are numbered rather than named land here, since `observation.state
 * | 7` says nothing about what dimension 7 is.
 */
export function gripperSeriesKeys(groups: ChartSeriesRow[][]): string[] {
  const keys: string[] = [];
  for (const group of groups) {
    for (const key of gripperKeysOf(group)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * One merged group holding only the gripper series, index-aligned across the
 * source groups the way `mergeGroups` is — they are all sampled from the same
 * rows. Every row keeps its timestamp so the x-axis still spans the whole
 * episode; callers gate the view on `gripperSeriesKeys` being non-empty.
 */
export function selectGripperSeriesRows(
  groups: ChartSeriesRow[][],
): ChartSeriesRow[] {
  const selected = groups
    .map((group) => [group, gripperKeysOf(group)] as const)
    .filter(([, keys]) => keys.length > 0);
  if (selected.length === 0) return [];

  const length = Math.max(...selected.map(([group]) => group.length));
  const rows: ChartSeriesRow[] = [];
  for (let i = 0; i < length; i++) {
    const row: ChartSeriesRow = {};
    for (const [group, keys] of selected) {
      const source = group[i];
      if (!source) continue;
      if (typeof source.timestamp === "number")
        row.timestamp = source.timestamp;
      for (const key of keys) {
        const value = source[key];
        if (value !== undefined) row[key] = value;
      }
    }
    rows.push(row);
  }
  return rows;
}
