import { describe, expect, test } from "bun:test";
import {
  resolveHfCatalogEndpoint,
  resolveHfSyncEndpoint,
} from "@/lib/hf-endpoints";

describe("hf endpoint resolution", () => {
  test("defaults sync downloads to the mirror", () => {
    expect(resolveHfSyncEndpoint({} as NodeJS.ProcessEnv)).toBe(
      "https://hf-mirror.com",
    );
  });

  test("sync honors an explicit HF_ENDPOINT", () => {
    expect(
      resolveHfSyncEndpoint({
        HF_ENDPOINT: "https://huggingface.co",
      } as NodeJS.ProcessEnv),
    ).toBe("https://huggingface.co");
  });

  test("catalog reuses the sync endpoint unless overridden", () => {
    expect(
      resolveHfCatalogEndpoint({
        HF_ENDPOINT: "https://huggingface.co",
      } as NodeJS.ProcessEnv),
    ).toBe("https://huggingface.co");
    expect(
      resolveHfCatalogEndpoint({
        HF_ENDPOINT: "https://huggingface.co",
        HF_CATALOG_ENDPOINT: "https://custom.example",
      } as NodeJS.ProcessEnv),
    ).toBe("https://custom.example");
  });
});
