export type WorkbenchReviewTask = Readonly<{
  id: string;
  createdAt: string;
  organization: string;
  source: "workbench" | "doctor" | "tacflow";
  title: string;
  detail: string;
  datasetPath: string | null;
  episodeId: number | null;
  frame: number | null;
}>;

export type WorkbenchReviewTaskInput = Omit<
  WorkbenchReviewTask,
  "id" | "createdAt"
>;

export const WORKBENCH_REVIEW_TASKS_STORAGE_KEY =
  "xense.workbench.review-tasks.v1";

function isReviewTask(value: unknown): value is WorkbenchReviewTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<WorkbenchReviewTask>;
  return (
    typeof task.id === "string" &&
    typeof task.createdAt === "string" &&
    typeof task.organization === "string" &&
    (task.source === "workbench" ||
      task.source === "doctor" ||
      task.source === "tacflow") &&
    typeof task.title === "string" &&
    typeof task.detail === "string" &&
    (typeof task.datasetPath === "string" || task.datasetPath === null) &&
    (typeof task.episodeId === "number" || task.episodeId === null) &&
    (typeof task.frame === "number" || task.frame === null)
  );
}

function reviewTaskStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function readWorkbenchReviewTasks(
  storage?: Storage,
): WorkbenchReviewTask[] {
  const target = reviewTaskStorage(storage);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(
      target.getItem(WORKBENCH_REVIEW_TASKS_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.filter(isReviewTask) : [];
  } catch {
    return [];
  }
}

export function createWorkbenchReviewTask(
  input: WorkbenchReviewTaskInput,
  storage?: Storage,
): WorkbenchReviewTask | null {
  const target = reviewTaskStorage(storage);
  if (!target) return null;
  const now = new Date().toISOString();
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const task: WorkbenchReviewTask = Object.freeze({
    ...input,
    id,
    createdAt: now,
  });
  const tasks = [task, ...readWorkbenchReviewTasks(target)].slice(0, 500);
  target.setItem(WORKBENCH_REVIEW_TASKS_STORAGE_KEY, JSON.stringify(tasks));
  return task;
}

export function workbenchCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function workbenchCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [headers, ...rows]
    .map((row) => row.map(workbenchCsvCell).join(","))
    .join("\r\n");
}
