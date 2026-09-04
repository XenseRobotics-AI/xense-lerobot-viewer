import { describe, expect, test } from "bun:test";
import {
  WORKBENCH_REVIEW_TASKS_STORAGE_KEY,
  createWorkbenchReviewTask,
  readWorkbenchReviewTasks,
  workbenchCsv,
} from "@/utils/workbenchActions";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

describe("Workbench dashboard actions", () => {
  test("persists a review task with its dataset episode and frame target", () => {
    const storage = memoryStorage();
    const task = createWorkbenchReviewTask(
      {
        organization: "TacVerse",
        source: "tacflow",
        title: "Action jump finding",
        detail: "action_jump / ep 4 / frame 22",
        datasetPath: "TacVerse/task-0902",
        episodeId: 4,
        frame: 22,
      },
      storage,
    );

    expect(task).toEqual(
      expect.objectContaining({
        organization: "TacVerse",
        datasetPath: "TacVerse/task-0902",
        episodeId: 4,
        frame: 22,
      }),
    );
    expect(readWorkbenchReviewTasks(storage)).toHaveLength(1);
    expect(storage.getItem(WORKBENCH_REVIEW_TASKS_STORAGE_KEY)).toContain(
      "Action jump finding",
    );
  });

  test("escapes CSV cells and keeps rows rectangular", () => {
    expect(
      workbenchCsv(["section", "detail"], [["finding", "frame 2, bad"]]),
    ).toBe('section,detail\r\nfinding,"frame 2, bad"');
  });
});
