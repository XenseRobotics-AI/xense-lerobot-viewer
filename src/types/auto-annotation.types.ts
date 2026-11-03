/**
 * TacFlow ④ automatic annotations (read-only).
 *
 * TacFlow writes one report per dataset, schema `tacflow.annotate.dataset/1`, into the corpus registry
 * (`<corpus>/.registry/reports/<dataset>/annotate-*\/annotations.json`) — never into the dataset itself.
 * This module normalises one episode of that report for display. The labels are a vision-language model's
 * reading of the head-camera footage: claims to check against the video, not ground truth.
 *
 * All helpers are pure and unit-tested (`__tests__/auto-annotation.types.test.ts`).
 */

export const AUTO_ANNOTATION_SCHEMA = "tacflow.annotate.dataset/1";

export interface AutoTimelineRow {
  start_s: number;
  end_s: number;
  arm: string | null;
  action: string | null;
  object: string | null;
  destination: string | null;
  contribution: string | null;
  notes: string | null;
}

export interface AutoFinding {
  kind: "data_issue" | "operator_mistake";
  category: string | null;
  severity: string | null;
  t_s: number | null;
  end_s: number | null;
  issue: string;
  evidence: string | null;
}

export interface AutoEpisodeAnnotation {
  episode_index: number;
  usable: boolean;
  problems: string[];
  outcome: string | null;
  outcome_reason: string | null;
  summary: string | null;
  performance_review: string | null;
  timeline: AutoTimelineRow[];
  findings: AutoFinding[];
}

export interface AutoAnnotationResponse {
  dataset: string;
  models: string[];
  annotated_at: string | null;
  episodes_total: number;
  episodes_usable: number;
  /** null when the report has no entry for the requested episode */
  episode: AutoEpisodeAnnotation | null;
}

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function normalizeTimeline(raw: unknown): AutoTimelineRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: AutoTimelineRow[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const start = num(r.start_s);
    const end = num(r.end_s);
    if (start === null || end === null || end < start) continue;
    rows.push({
      start_s: start,
      end_s: end,
      arm: str(r.arm),
      action: str(r.action),
      object: str(r.object),
      destination: str(r.destination),
      contribution: str(r.contribution),
      notes: str(r.notes),
    });
  }
  return rows.sort((a, b) => a.start_s - b.start_s);
}

function normalizeFindings(
  raw: unknown,
  kind: AutoFinding["kind"],
): AutoFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((f) => ({
    kind,
    category: str(f.category),
    severity: str(f.severity),
    t_s: num(f.t_s),
    end_s: num(f.end_s),
    issue: str(f.issue) ?? "",
    evidence: str(f.evidence),
  }));
}

/** One episode entry of a `tacflow.annotate.dataset/1` report, normalised; null for a malformed entry. */
export function normalizeEpisode(entry: unknown): AutoEpisodeAnnotation | null {
  if (!isRecord(entry)) return null;
  const index = num(entry.episode_index);
  if (index === null) return null;
  const labels = isRecord(entry.labels) ? entry.labels : {};
  const completion = isRecord(labels.completion) ? labels.completion : {};
  return {
    episode_index: index,
    usable: entry.usable === true,
    problems: Array.isArray(entry.problems) ? entry.problems.map(String) : [],
    outcome: str(completion.task_completed),
    outcome_reason: str(completion.reason),
    summary: str(labels.task_summary),
    performance_review: str(labels.performance_review),
    timeline: normalizeTimeline(labels.timeline),
    findings: [
      ...normalizeFindings(labels.data_issues, "data_issue"),
      ...normalizeFindings(labels.operator_mistakes, "operator_mistake"),
    ].sort((a, b) => (a.t_s ?? Infinity) - (b.t_s ?? Infinity)),
  };
}

/**
 * Index of the timeline row covering time `t`; the latest-starting row wins when rows overlap
 * (they share boundaries, so a boundary instant belongs to the step that begins there). -1 when none.
 */
export function activeRowAt(rows: AutoTimelineRow[], t: number): number {
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].start_s <= t && t <= rows[i].end_s) found = i;
  }
  return found;
}
