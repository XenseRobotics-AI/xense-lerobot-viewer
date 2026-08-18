import { describe, expect, test } from "bun:test";
import {
  HF_DEFAULT_ENDPOINT,
  hfIdentityEnv,
  parseHfIdentityOutput,
  redactHfSecrets,
} from "@/lib/hf-identity";

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
          endpoint: "https://huggingface.co",
          tokenPresent: true,
          tokenValid: true,
          username: "alice",
          visibleDatasets: 3,
        },
      }),
    ].join("\n");
    expect(parseHfIdentityOutput(output)).toEqual({
      endpoint: "https://huggingface.co",
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

  test("uses the official Hub and isolates an explicit token from HF_TOKEN", () => {
    const previousToken = process.env.HF_TOKEN;
    const previousEndpoint = process.env.HF_IDENTITY_ENDPOINT;
    process.env.HF_TOKEN = "hf_inherited";
    delete process.env.HF_IDENTITY_ENDPOINT;
    try {
      const env = hfIdentityEnv("hf_submitted");
      expect(HF_DEFAULT_ENDPOINT).toBe("https://huggingface.co");
      expect(env.HF_ENDPOINT).toBe("https://huggingface.co");
      expect(env.HF_TOKEN).toBeUndefined();
      expect(env.XENSE_HF_TOKEN).toBe("hf_submitted");
    } finally {
      if (previousToken === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = previousToken;
      if (previousEndpoint === undefined)
        delete process.env.HF_IDENTITY_ENDPOINT;
      else process.env.HF_IDENTITY_ENDPOINT = previousEndpoint;
    }
  });
});
