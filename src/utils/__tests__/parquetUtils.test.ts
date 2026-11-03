import { describe, expect, test } from "bun:test";
import {
  formatStringWithVars,
  arrayToCSV,
  getRows,
  readParquetAsObjects,
  readParquetColumn,
} from "@/utils/parquetUtils";
import { PADDING } from "@/utils/constants";

test("parallel parquet readers share footer setup and failed metadata remains retryable", async () => {
  let reads = 0;
  const file = {
    byteLength: 64,
    slice: async () => {
      reads++;
      throw new Error("Read failed");
    },
  };
  const result = await Promise.allSettled([
    readParquetAsObjects(file),
    readParquetColumn(file, []),
  ]);
  expect(result.every((r) => r.status === "rejected")).toBe(true);
  expect(reads).toBe(1);
  await expect(readParquetColumn(file, [])).rejects.toThrow("Read failed");
  expect(reads).toBe(2);
});

// Three uncompressed float64 rows generated with PyArrow; tests need no Python.
const parquetFixture = Uint8Array.from(
  Buffer.from(
    "UEFSMRUAFTwVPCwVBhUAFQYVBhwYCAAAAAAAAAhAGAgAAAAAAADwPxYAKAgAAAAAAAAIQBgIAAAAAAAA8D8REQAAAAIAAAAGAQAAAAAAAPA/AAAAAAAAAEAAAAAAAAAIQBUEGSw1ABgGc2NoZW1hFQIAFQolAhgBeAAWBhkcGRwmABwVChklBgAZGAF4FQAWBha6ARa6ASYIPBgIAAAAAAAACEAYCAAAAAAAAPA/FgAoCAAAAAAAAAhAGAgAAAAAAADwPxERABkcFQAVABUCADwpBhkmAAYAAAAWugEWBiYIFroBABkcGAxBUlJPVzpzY2hlbWEYoAEvLy8vLzNBQUFBQVFBQUFBQUFBS0FBd0FCZ0FGQUFnQUNnQUFBQUFCQkFBTUFBQUFDQUFJQUFBQUJBQUlBQUFBQkFBQUFBRUFBQUFVQUFBQUVBQVVBQWdBQmdBSEFBd0FBQUFRQUJBQUFBQUFBQUVERUFBQUFCZ0FBQUFFQUFBQUFBQUFBQUVBQUFCNEFBWUFDQUFHQUFZQUFBQUFBQUlBABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZHBwAAABgAQAAUEFSMQ==",
    "base64",
  ),
).buffer;

test("parallel column and object reads reuse one valid footer", async () => {
  let footers = 0;
  const file = {
    byteLength: parquetFixture.byteLength,
    slice: async (start: number, end?: number) => {
      if (start === 0 && end === parquetFixture.byteLength) footers++;
      return parquetFixture.slice(start, end);
    },
  };
  const [objects, columns] = await Promise.all([
    readParquetAsObjects(file),
    readParquetColumn(file, ["x"]),
  ]);
  expect(objects).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  expect(columns).toEqual([[1], [2], [3]]);
  expect(footers).toBe(1);
});

test("column data-page failure after valid metadata rejects and can be retried", async () => {
  let fail = true;
  let footers = 0;
  const file = {
    byteLength: parquetFixture.byteLength,
    slice: async (start: number, end?: number) => {
      if (start === 0 && end === parquetFixture.byteLength) footers++;
      else if (fail) throw new Error("Data page unavailable");
      return parquetFixture.slice(start, end);
    },
  };
  await expect(readParquetColumn(file, ["x"])).rejects.toThrow(
    "Data page unavailable",
  );
  fail = false;
  expect(await readParquetColumn(file, ["x"])).toEqual([[1], [2], [3]]);
  expect(footers).toBe(1);
});

// ---------------------------------------------------------------------------
// formatStringWithVars — used to build v2.x data / video paths at runtime
// ---------------------------------------------------------------------------
describe("formatStringWithVars", () => {
  // v2.0 dataset path templates (real format from rabhishek100/so100_train_dataset)
  test("v2.0 data_path template with pre-padded vars", () => {
    const template =
      "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
    const episodeId = 42;
    const chunkSize = 1000;
    const episode_chunk = Math.floor(episodeId / chunkSize)
      .toString()
      .padStart(PADDING.CHUNK_INDEX, "0");
    const episode_index = episodeId
      .toString()
      .padStart(PADDING.EPISODE_INDEX, "0");
    expect(
      formatStringWithVars(template, { episode_chunk, episode_index }),
    ).toBe("data/000/episode_000042.parquet");
  });

  // v2.1 dataset path templates (same format as v2.0)
  test("v2.1 data_path template — identical format to v2.0", () => {
    const template =
      "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
    const episode_chunk = (1).toString().padStart(PADDING.CHUNK_INDEX, "0");
    const episode_index = (1500)
      .toString()
      .padStart(PADDING.EPISODE_INDEX, "0");
    expect(
      formatStringWithVars(template, { episode_chunk, episode_index }),
    ).toBe("data/001/episode_001500.parquet");
  });

  // v2.x video_path template
  test("v2.x video_path template with video_key, chunk, episode", () => {
    const template =
      "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4";
    const episode_chunk = (0).toString().padStart(PADDING.CHUNK_INDEX, "0");
    const episode_index = (7).toString().padStart(PADDING.EPISODE_INDEX, "0");
    expect(
      formatStringWithVars(template, {
        video_key: "observation.images.top",
        episode_chunk,
        episode_index,
      }),
    ).toBe("videos/observation.images.top/chunk-000/episode_000007.mp4");
  });

  test("leaves unmatched placeholders as 'undefined'", () => {
    // When a variable is missing the replacement returns "undefined" (String(undefined))
    const result = formatStringWithVars("data/{missing_key}.parquet", {});
    expect(result).toBe("data/undefined.parquet");
  });

  test("handles template without format specifier", () => {
    expect(formatStringWithVars("{a}/{b}", { a: "foo", b: "bar" })).toBe(
      "foo/bar",
    );
  });

  test("strips :Nd format specifier, uses pre-padded string value", () => {
    // The function does NOT zero-pad; the caller is responsible for padding
    expect(formatStringWithVars("{x:06d}", { x: "000042" })).toBe("000042");
  });
});

// ---------------------------------------------------------------------------
// arrayToCSV
// ---------------------------------------------------------------------------
describe("arrayToCSV", () => {
  test("converts 2D array to CSV string", () => {
    const data = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(arrayToCSV(data)).toBe("1,2,3\n4,5,6");
  });

  test("handles single row", () => {
    expect(arrayToCSV([[10, 20]])).toBe("10,20");
  });

  test("handles string values", () => {
    expect(
      arrayToCSV([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe("a,b\nc,d");
  });

  test("handles empty array", () => {
    expect(arrayToCSV([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getRows — used to build the data table view from flat parquet column data
// ---------------------------------------------------------------------------
describe("getRows", () => {
  test("returns empty array when currentFrameData is empty", () => {
    const cols = [{ key: "state", value: ["s0", "s1"] }];
    expect(getRows([], cols)).toEqual([]);
  });

  test("constructs rows from flat data with equal-length columns", () => {
    // state: [0.1, 0.2], action: [0.5, 0.6] — flat layout: [s0, s1, a0, a1]
    const cols = [
      { key: "observation.state", value: ["s0", "s1"] },
      { key: "action", value: ["a0", "a1"] },
    ];
    const flat = [0.1, 0.2, 0.5, 0.6];
    const rows = getRows(flat, cols);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual([0.1, 0.5]);
    expect(rows[1]).toEqual([0.2, 0.6]);
  });

  test("null-pads shorter columns (action has fewer dims than state)", () => {
    // state: 3 dims, action: 2 dims — row 2 should have null for action
    const cols = [
      { key: "state", value: ["s0", "s1", "s2"] },
      { key: "action", value: ["a0", "a1"] },
    ];
    const flat = [0.1, 0.2, 0.3, 0.5, 0.6]; // s0,s1,s2,a0,a1
    const rows = getRows(flat, cols);
    expect(rows.length).toBe(3);
    expect(rows[2][1]).toEqual({ isNull: true });
  });

  test("handles single-column data (v2.x progress series)", () => {
    const cols = [{ key: "progress", value: ["p0"] }];
    const flat = [0.75];
    const rows = getRows(flat, cols);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual([0.75]);
  });
});
