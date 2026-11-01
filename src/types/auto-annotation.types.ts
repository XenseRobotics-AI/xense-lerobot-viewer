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

// --- dataset-level summary (homepage dashboard) -------------------------------

/** One data issue or operator mistake, located — the homepage's cross-dataset list. */
export interface AutoFindingRow extends AutoFinding {
  episode_index: number;
}

/** What the homepage shows about one dataset's ④ annotation. */
export interface AutoAnnotationDatasetSummary {
  models: string[];
  annotated_at: string | null;
  episodes_total: number;
  episodes_usable: number;
  spent_usd: number;
  /** completion.task_completed of each usable episode → count; "unknown" when a usable episode names none */
  outcomes: Record<string, number>;
  /** episodes whose labels carry at least one data issue or operator mistake */
  episodes_with_findings: number;
  findings: AutoFindingRow[];
}

/** Summarise a `tacflow.annotate.dataset/1` report (already schema-checked) for the homepage. */
export function summarizeReport(
  report: Record<string, unknown>,
  annotatedAt: string | null,
): AutoAnnotationDatasetSummary {
  const entries = Array.isArray(report.episodes) ? report.episodes : [];
  const outcomes: Record<string, number> = {};
  const findings: AutoFindingRow[] = [];
  let usable = 0;
  let withFindings = 0;
  for (const raw of entries) {
    const ep = normalizeEpisode(raw);
    if (!ep || !ep.usable) continue;
    usable += 1;
    const key = ep.outcome ?? "unknown";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (ep.findings.length) withFindings += 1;
    for (const f of ep.findings)
      findings.push({ ...f, episode_index: ep.episode_index });
  }
  findings.sort(
    (a, b) =>
      a.episode_index - b.episode_index ||
      (a.t_s ?? Infinity) - (b.t_s ?? Infinity),
  );
  const spent = num(report.spent_usd);
  return {
    models: Array.isArray(report.models) ? report.models.map(String) : [],
    annotated_at: annotatedAt,
    episodes_total: num(report.episodes_total) ?? entries.length,
    episodes_usable: usable,
    spent_usd: spent ?? 0,
    outcomes,
    episodes_with_findings: withFindings,
    findings,
  };
}

/** Totals across datasets: how many are annotated, episode counts, outcome mix, findings by category. */
export function totalSummaries(summaries: AutoAnnotationDatasetSummary[]) {
  const outcomes: Record<string, number> = {};
  const categories: Record<string, number> = {};
  let episodes = 0;
  let usable = 0;
  let spent = 0;
  let findings = 0;
  for (const s of summaries) {
    episodes += s.episodes_total;
    usable += s.episodes_usable;
    spent += s.spent_usd;
    findings += s.findings.length;
    for (const [k, v] of Object.entries(s.outcomes))
      outcomes[k] = (outcomes[k] ?? 0) + v;
    for (const f of s.findings) {
      const c = f.category ?? f.kind;
      categories[c] = (categories[c] ?? 0) + 1;
    }
  }
  return {
    datasets: summaries.length,
    episodes,
    usable,
    spent,
    findings,
    outcomes,
    categories,
  };
}
