import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAfterCutoff } from "@/lib/dataset-facets";
import { computeFacets, readCaptureDates } from "@/lib/dataset-facets-server";

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "facets-"));
}

async function writeMeta(dir: string, rel: string, body: unknown) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body));
}

describe("readCaptureDates", () => {
  test("prefers hardware.json recorded_at — the only real measurement", async () => {
    const dir = path.join(await scratch(), "taccap-g1-x-0704");
    await writeMeta(dir, "meta/hardware.json", {
      epochs: [
        { recorded_at: "2026-08-29T09:24:40+08:00" },
        { recorded_at: "2026-08-27T10:22:13+08:00" },
      ],
    });
    // sessions.json and the -0704 name both disagree; the manifest wins.
    await writeMeta(dir, "meta/tacflow/sessions.json", {
      sessions: [{ source: "taccap-g1-x-0704" }],
    });
    const got = await readCaptureDates(dir);
    expect(got.dateEvidence).toBe("manifest");
    expect(got.capturedFrom).toBe("2026-08-27");
    expect(got.capturedTo).toBe("2026-08-29");
  });

  test("falls back to sessions.json source names", async () => {
    const dir = path.join(await scratch(), "taccap-g1-x");
    await writeMeta(dir, "meta/tacflow/sessions.json", {
      sessions: [
        { source: "taccap-g1-x-0815" },
        { source: "taccap-g1-x-0822" },
      ],
    });
    const got = await readCaptureDates(dir);
    expect(got.dateEvidence).toBe("sessions");
    expect(got.capturedFrom).toBe("2026-08-15");
    expect(got.capturedTo).toBe("2026-08-22");
  });

  test("falls back to the directory name last", async () => {
    const dir = path.join(await scratch(), "taccap-g1-x-0817");
    await fs.mkdir(dir, { recursive: true });
    const got = await readCaptureDates(dir);
    expect(got.dateEvidence).toBe("name");
    expect(got.capturedFrom).toBe("2026-08-17");
  });

  test("reports `none` instead of assuming an old capture", async () => {
    // 13.8% of the corpus lands here. Filing them as "before the cutoff" would
    // hide any genuinely new data among them, and hide it silently.
    const dir = path.join(await scratch(), "taccap-g1-no-date");
    await fs.mkdir(dir, { recursive: true });
    const got = await readCaptureDates(dir);
    expect(got.dateEvidence).toBe("none");
    expect(got.capturedFrom).toBeNull();
    expect(
      isAfterCutoff({
        ...got,
        bucket: null,
        shapeAnomaly: null,
        stateDim: null,
        videoStreams: 0,
        headStreams: 0,
      }),
    ).toBe(false);
  });
});

describe("computeFacets", () => {
  test("counts video streams and head streams from features", async () => {
    const dir = path.join(await scratch(), "taccap-g1-x-0822");
    await fs.mkdir(dir, { recursive: true });
    const facets = await computeFacets(
      dir,
      "TacVerse/raw/taccap-g1-x-0822",
      {
        "observation.state": { shape: [20] },
        "observation.images.left_wrist": {},
        "observation.images.right_wrist": {},
        "observation.images.left_head": {},
        "observation.images.right_head": {},
        "observation.images.left_tactile_left": {},
        "observation.images.left_tactile_right": {},
        "observation.images.right_tactile_left": {},
        "observation.images.right_tactile_right": {},
      },
      "bi_taccap_gripper",
    );
    expect(facets.bucket).toBe("raw");
    expect(facets.videoStreams).toBe(8);
    expect(facets.headStreams).toBe(2);
    expect(facets.stateDim).toBe(20);
    expect(facets.shapeAnomaly).toBe(true);
    expect(isAfterCutoff(facets)).toBe(true);
  });

  test("survives a dataset with no features block", async () => {
    const dir = path.join(await scratch(), "taccap-g1-x");
    await fs.mkdir(dir, { recursive: true });
    const facets = await computeFacets(dir, "TacVerse/merged/x", undefined);
    expect(facets.stateDim).toBeNull();
    expect(facets.videoStreams).toBe(0);
    // 0 streams differs from the norm, so it is flagged rather than passed over.
    expect(facets.shapeAnomaly).toBe(true);
  });

  test("recognises the XTac-UMI 29-dim + 8-stream shape", async () => {
    const dir = path.join(await scratch(), "xtac-umi-g1-0822");
    await fs.mkdir(dir, { recursive: true });
    const features: Record<string, { shape?: number[] }> = {
      "observation.state": { shape: [29] },
    };
    for (const key of [
      "left_wrist",
      "right_wrist",
      "left_head",
      "right_head",
      "left_tactile_left",
      "left_tactile_right",
      "right_tactile_left",
      "right_tactile_right",
    ]) {
      features[`observation.images.${key}`] = {};
    }
    const facets = await computeFacets(
      dir,
      "TacVerse/raw/xtac-umi-g1-0822",
      features,
      "xtac-umi-g1",
    );
    expect(facets.videoStreams).toBe(8);
    expect(facets.stateDim).toBe(29);
    expect(facets.shapeAnomaly).toBe(false);
  });
});
