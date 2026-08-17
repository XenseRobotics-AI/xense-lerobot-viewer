import { describe, expect, test } from "bun:test";
import { parseHfIdentityOutput, redactHfSecrets } from "@/lib/hf-identity";

describe("Hugging Face identity response handling", () => {
  test("redacts credentials from diagnostics", () => {
    expect(redactHfSecrets("request failed for hf_secret", ["hf_secret"])).toBe(
      "request failed for [REDACTED]",
    );
  });

  test("finds the final result event after Python warnings", () => {
    const output = [
      "warning: cache migration",
      JSON.stringify({
        type: "result",
        result: {
          endpoint: "https://hf-mirror.com",
          tokenPresent: true,
          tokenValid: true,
          username: "alice",
          visibleDatasets: 3,
        },
      }),
    ].join("\n");
    expect(parseHfIdentityOutput(output)).toEqual({
      endpoint: "https://hf-mirror.com",
      tokenPresent: true,
      tokenValid: true,
      username: "alice",
      visibleDatasets: 3,
    });
  });

  test("returns null when no valid result event exists", () => {
    expect(parseHfIdentityOutput("Traceback\nnot-json\n")).toBeNull();
    expect(
      parseHfIdentityOutput(
        JSON.stringify({ type: "error", error: "offline" }),
      ),
    ).toBeNull();
  });
});
