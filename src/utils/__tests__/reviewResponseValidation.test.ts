import { describe, expect, test } from "bun:test";
import { readEpisodeReviewState } from "../reviewDiagnosticsClient";
const valid = () => ({
  file: { version: 1, episodes: {} },
  reviewers: ["Alice"],
  profiles: [{ name: "Alice", role: "inspector" }],
  dataset_key: "nested/sample",
  storage_path: "/fixture/.xense-viewer/episode-reviews.json",
});
describe("review response metadata boundaries", () => {
  test("valid empty data retains a valid selectable roster", async () => {
    expect(
      await readEpisodeReviewState("/reviews", {
        fetcher: (async () => Response.json(valid())) as typeof fetch,
      }),
    ).toMatchObject(valid());
  });
  test("rejects malformed metadata before any React state can be updated", async () => {
    for (const patch of [
      { reviewers: undefined },
      { reviewers: "Alice" },
      { reviewers: [null] },
      { reviewers: ["Alice", "Alice"] },
      { profiles: undefined },
      { profiles: [{ name: "Alice", role: "owner" }] },
      { profiles: [{ name: "Bob", role: "inspector" }] },
      { storage_path: null },
      { dataset_key: undefined },
    ]) {
      await expect(
        readEpisodeReviewState("/reviews", {
          fetcher: (async () =>
            Response.json({ ...valid(), ...patch })) as typeof fetch,
        }),
      ).rejects.toThrow();
    }
  });
});
