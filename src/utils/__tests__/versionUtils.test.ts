import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import { buildVersionedUrl } from "@/utils/versionUtils";
import {
  DEFAULT_LOCAL_DATASET_ROOT_SUFFIX,
  getDisplayNameForRepoId,
  getLinkedHubDatasetRepoId,
  getLocalDatasetRelativePath,
  encodeLocalDatasetPath,
  makeLocalRepoId,
  normalizeRelativeLocalDatasetPath,
  repoIdFromRouteParams,
  resolveLocalDatasetInput,
  resolveServerLocalDatasetPath,
  routePathFromRepoId,
} from "@/utils/datasetRoute";

// ---------------------------------------------------------------------------
// buildVersionedUrl — pure function, no mocking needed
// ---------------------------------------------------------------------------
describe("buildVersionedUrl", () => {
  test("builds URL for v2.0 dataset data path", () => {
    const repoId = makeLocalRepoId("rabhishek100/so100_train_dataset");
    const encoded = encodeLocalDatasetPath("rabhishek100/so100_train_dataset");
    const url = buildVersionedUrl(
      repoId,
      "v2.0",
      "data/000/episode_000000.parquet",
    );
    expect(url).toBe(
      `/api/local-datasets/${encoded}/data/000/episode_000000.parquet`,
    );
  });

  test("builds URL for v2.1 dataset video path", () => {
    const repoId = makeLocalRepoId("youliangtan/so101-table-cleanup");
    const encoded = encodeLocalDatasetPath("youliangtan/so101-table-cleanup");
    const url = buildVersionedUrl(
      repoId,
      "v2.1",
      "videos/observation.images.top/chunk-000/episode_000007.mp4",
    );
    expect(url).toBe(
      `/api/local-datasets/${encoded}/videos/observation.images.top/chunk-000/episode_000007.mp4`,
    );
  });

  test("builds URL for v3.0 episode metadata", () => {
    const datasetPath = "lerobot-data-collection/level12_rac_2_2026-02-07";
    const repoId = makeLocalRepoId(datasetPath);
    const encoded = encodeLocalDatasetPath(datasetPath);
    const url = buildVersionedUrl(
      repoId,
      "v3.0",
      "meta/episodes/chunk-000/file-000.parquet",
    );
    expect(url).toBe(
      `/api/local-datasets/${encoded}/meta/episodes/chunk-000/file-000.parquet`,
    );
  });

  test("builds URL for v3.0 data chunk", () => {
    const datasetPath = "lerobot-data-collection/level12_rac_2_2026-02-07";
    const repoId = makeLocalRepoId(datasetPath);
    const encoded = encodeLocalDatasetPath(datasetPath);
    const url = buildVersionedUrl(
      repoId,
      "v3.0",
      "data/chunk-001/file-003.parquet",
    );
    expect(url).toBe(
      `/api/local-datasets/${encoded}/data/chunk-001/file-003.parquet`,
    );
  });

  test("builds URL for meta/info.json", () => {
    const repoId = makeLocalRepoId("myorg/mydataset");
    const encoded = encodeLocalDatasetPath("myorg/mydataset");
    const url = buildVersionedUrl(repoId, "v3.0", "meta/info.json");
    expect(url).toBe(`/api/local-datasets/${encoded}/meta/info.json`);
  });

  test("builds URL for absolute local dataset paths", () => {
    const repoId = makeLocalRepoId("/tmp/lerobot/local-dataset");
    const url = buildVersionedUrl(repoId, "v3.0", "meta/info.json");
    expect(url).toBe(
      `/api/local-datasets/${encodeLocalDatasetPath("/tmp/lerobot/local-dataset")}/meta/info.json`,
    );
  });

  test("throws when given a non-local repoId", () => {
    expect(() =>
      buildVersionedUrl("foo/bar", "v3.0", "meta/info.json"),
    ).toThrow(/local datasets/);
  });
});

describe("local dataset route helpers", () => {
  const originalLocalRoot = process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT = "/tmp/lerobot-root";
    process.env.HOME = "/home/test-user";
  });

  afterEach(() => {
    if (originalLocalRoot === undefined) {
      delete process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT;
    } else {
      process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT = originalLocalRoot;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = originalHome;
  });

  test("maps local route params to local repo id", () => {
    const encodedPath = encodeLocalDatasetPath("/tmp/lerobot/local-dataset");
    expect(repoIdFromRouteParams("_local", encodedPath)).toBe(
      makeLocalRepoId("/tmp/lerobot/local-dataset"),
    );
  });

  test("builds local episode route from local repo id", () => {
    const repoId = makeLocalRepoId("/tmp/lerobot/local-dataset");
    expect(routePathFromRepoId(repoId, 12)).toBe(
      `/_local/${encodeLocalDatasetPath("/tmp/lerobot/local-dataset")}/episode_12`,
    );
  });

  test("resolves local relative input against the configured root", () => {
    expect(
      resolveLocalDatasetInput(
        "Xense/assemble_box_with_phone_stand0410_merged_fixed",
        process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT!,
      ),
    ).toBe(
      "/tmp/lerobot-root/Xense/assemble_box_with_phone_stand0410_merged_fixed",
    );
  });

  test("normalizes a relative local dataset path without making it absolute", () => {
    expect(
      normalizeRelativeLocalDatasetPath(
        "./Xense/assemble_box_with_phone_stand0410_merged_fixed",
      ),
    ).toBe("Xense/assemble_box_with_phone_stand0410_merged_fixed");
  });

  test("resolves server local dataset path via current HOME when input is relative", () => {
    delete process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT;
    expect(
      resolveServerLocalDatasetPath(
        "Xense/assemble_box_with_phone_stand0410_merged_fixed",
      ),
    ).toBe(
      "/home/test-user/.cache/huggingface/lerobot/Xense/assemble_box_with_phone_stand0410_merged_fixed",
    );
  });

  test("extracts relative display path for datasets under the local root", () => {
    expect(
      getLocalDatasetRelativePath(
        "/tmp/lerobot-root/Xense/assemble_box_with_phone_stand0410_merged_fixed",
      ),
    ).toBe("Xense/assemble_box_with_phone_stand0410_merged_fixed");
  });

  test("extracts relative display path from the default local-root suffix", () => {
    expect(
      getLocalDatasetRelativePath(
        `/home/another-user${DEFAULT_LOCAL_DATASET_ROOT_SUFFIX}/Xense/assemble_box_with_phone_stand0410_merged_fixed`,
        undefined,
      ),
    ).toBe("Xense/assemble_box_with_phone_stand0410_merged_fixed");
  });

  test("prefers relative display name for local repo ids under the local root", () => {
    expect(
      getDisplayNameForRepoId(
        makeLocalRepoId(
          "/tmp/lerobot-root/Xense/assemble_box_with_phone_stand0410_merged_fixed",
        ),
      ),
    ).toBe("Xense/assemble_box_with_phone_stand0410_merged_fixed");
  });

  test("maps a local dataset under the local root to a matching hub repo id", () => {
    expect(
      getLinkedHubDatasetRepoId(
        makeLocalRepoId(
          "/tmp/lerobot-root/Xense/assemble_box_with_phone_stand0410_merged_fixed",
        ),
      ),
    ).toBe("Xense/assemble_box_with_phone_stand0410_merged_fixed");
  });

  test("returns null when a local dataset path does not look like a hub repo id", () => {
    expect(
      getLinkedHubDatasetRepoId(makeLocalRepoId("/tmp/lerobot-root")),
    ).toBe(null);
  });

  test("skips the bucket segment for a corpus dataset", () => {
    // Since 2026-09-01 TacVerse is stored as `TacVerse/<bucket>/<name>`. The
    // bucket is local bookkeeping with no counterpart on the Hub, so the repo
    // id is first + last. A strict two-segment rule would return null for the
    // whole corpus — and null is also the legitimate "not from the Hub"
    // answer, so every back-link would vanish with nothing to notice.
    expect(
      getLinkedHubDatasetRepoId(
        makeLocalRepoId(
          "/tmp/lerobot-root/TacVerse/merged/taccap-g1-wipe-mirror",
        ),
      ),
    ).toBe("TacVerse/taccap-g1-wipe-mirror");
    expect(
      getLinkedHubDatasetRepoId(
        makeLocalRepoId(
          "/tmp/lerobot-root/TacVerse/raw/taccap-g1-wipe-mirror-0822",
        ),
      ),
    ).toBe("TacVerse/taccap-g1-wipe-mirror-0822");
  });
});

// ---------------------------------------------------------------------------
// getDatasetVersionAndInfo — tested with mocked fetch
// ---------------------------------------------------------------------------
describe("getDatasetVersionAndInfo", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("accepts v2.0 codebase_version", async () => {
    const infoV20 = {
      codebase_version: "v2.0",
      robot_type: "so100",
      total_episodes: 50,
      total_frames: 5000,
      total_tasks: 1,
      chunks_size: 1000,
      data_files_size_in_mb: 10,
      video_files_size_in_mb: 500,
      fps: 30,
      splits: { train: "0:50" },
      data_path: "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      video_path:
        "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
      features: {
        "observation.images.top": {
          dtype: "video",
          shape: [480, 640, 3],
          names: null,
        },
        "observation.state": {
          dtype: "float32",
          shape: [1, 6],
          names: ["j0", "j1", "j2", "j3", "j4", "j5"],
        },
        action: {
          dtype: "float32",
          shape: [1, 6],
          names: ["j0", "j1", "j2", "j3", "j4", "j5"],
        },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(infoV20), { status: 200 })),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    const result = await getDatasetVersionAndInfo(
      makeLocalRepoId("rabhishek100/so100_train_dataset"),
    );
    expect(result.version).toBe("v2.0");
    expect(result.info.total_episodes).toBe(50);
  });

  test("accepts v2.1 codebase_version", async () => {
    const infoV21 = {
      codebase_version: "v2.1",
      robot_type: "so101",
      total_episodes: 100,
      total_frames: 10000,
      total_tasks: 1,
      chunks_size: 1000,
      data_files_size_in_mb: 20,
      video_files_size_in_mb: 1000,
      fps: 30,
      splits: { train: "0:100" },
      data_path: "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      video_path:
        "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
      features: {
        "observation.images.top": {
          dtype: "video",
          shape: [480, 640, 3],
          names: null,
        },
        "observation.state": { dtype: "float32", shape: [1, 6], names: null },
        action: { dtype: "float32", shape: [1, 6], names: null },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(infoV21), { status: 200 })),
    ) as unknown as typeof fetch;

    // Use fresh import to bypass cache — or just call with a different repoId
    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    const result = await getDatasetVersionAndInfo(
      makeLocalRepoId("youliangtan/so101-table-cleanup"),
    );
    expect(result.version).toBe("v2.1");
  });

  test("accepts v3.0 codebase_version", async () => {
    const infoV30 = {
      codebase_version: "v3.0",
      robot_type: "openarm",
      total_episodes: 200,
      total_frames: 40000,
      total_tasks: 1,
      chunks_size: 100,
      data_files_size_in_mb: 50,
      video_files_size_in_mb: 2000,
      fps: 50,
      splits: { train: "0:200" },
      data_path: null,
      video_path: null,
      features: {
        "observation.images.top": {
          dtype: "video",
          shape: [480, 640, 3],
          names: null,
        },
        "observation.state": { dtype: "float32", shape: [1, 14], names: null },
        action: { dtype: "float32", shape: [1, 14], names: null },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(infoV30), { status: 200 })),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    const result = await getDatasetVersionAndInfo(
      makeLocalRepoId("lerobot-data-collection/level12_rac_2_2026-02-07"),
    );
    expect(result.version).toBe("v3.0");
    expect(result.info.total_episodes).toBe(200);
  });

  test("throws for unsupported version", async () => {
    const infoUnsupported = {
      codebase_version: "v1.0",
      features: { dummy: { dtype: "float32", shape: [1], names: null } },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(infoUnsupported), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    await expect(
      getDatasetVersionAndInfo(makeLocalRepoId("old/dataset")),
    ).rejects.toThrow("not supported");
  });

  test("throws when info.json has no features field", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ codebase_version: "v3.0" }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    await expect(
      getDatasetVersionAndInfo(makeLocalRepoId("broken/dataset")),
    ).rejects.toThrow();
  });

  test("throws when fetch fails (network error)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    await expect(
      getDatasetVersionAndInfo(makeLocalRepoId("nonexistent/repo")),
    ).rejects.toThrow();
  });
});
