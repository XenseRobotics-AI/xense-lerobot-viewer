import { describe, expect, test } from "bun:test";
import { addHfMirrorProxyBypass, mergeNoProxyValues } from "@/lib/proxy-bypass";

describe("proxy bypass helpers", () => {
  test("merges, trims, and de-duplicates NO_PROXY values", () => {
    expect(
      mergeNoProxyValues(
        "localhost, 127.0.0.1",
        "LOCALHOST,10.0.0.0/8",
        undefined,
      ),
    ).toBe("localhost,127.0.0.1,10.0.0.0/8");
  });

  test("adds mirror hosts to both proxy-bypass spellings", () => {
    const env = {
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "10.0.0.0/8",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    } as NodeJS.ProcessEnv;

    expect(addHfMirrorProxyBypass(env, "https://hf-mirror.com")).toEqual({
      NO_PROXY: "localhost,127.0.0.1,10.0.0.0/8,hf-mirror.com,.hf-mirror.com",
      no_proxy: "localhost,127.0.0.1,10.0.0.0/8,hf-mirror.com,.hf-mirror.com",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    });
  });

  test("does not bypass the proxy for the official Hub", () => {
    const env = {
      NO_PROXY: "localhost",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    } as NodeJS.ProcessEnv;

    expect(addHfMirrorProxyBypass(env, "https://huggingface.co")).toEqual({
      NO_PROXY: "localhost",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    });
  });
});
