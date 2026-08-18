import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";

describe("same-origin protection for local mutating routes", () => {
  test("allows requests without Origin for curl and server-side clients", () => {
    const request = new NextRequest("http://localhost/api/hf/account", {
      method: "DELETE",
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });

  test("accepts the request origin and rejects another origin", () => {
    const same = new NextRequest("http://localhost/api/hf/account", {
      headers: { origin: "http://localhost" },
    });
    const cross = new NextRequest("http://localhost/api/hf/account", {
      headers: { origin: "https://attacker.example" },
    });
    expect(isSameOriginRequest(same)).toBe(true);
    expect(isSameOriginRequest(cross)).toBe(false);
  });

  test("accepts the public Host when Next sees an internal proxy URL", () => {
    const request = new NextRequest("http://127.0.0.1:3000/api/hf/account", {
      headers: {
        host: "viewer.example:8443",
        origin: "https://viewer.example:8443",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });

  test("accepts the browser same-origin signal through an opaque tunnel", () => {
    const request = new NextRequest(
      "http://127.0.0.1:3000/api/local-datasets/sync",
      {
        headers: {
          host: "127.0.0.1:3000",
          origin: "https://remote-tunnel.example",
          "sec-fetch-site": "same-origin",
        },
      },
    );
    expect(isSameOriginRequest(request)).toBe(true);
  });

  test("normalizes default HTTPS ports from the Host header", () => {
    const request = new NextRequest("http://127.0.0.1:3000/api/hf/catalog", {
      headers: {
        host: "viewer.example:443",
        origin: "https://viewer.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });

  test("does not trust a forged X-Forwarded-Host without browser metadata", () => {
    const request = new NextRequest("http://localhost/api/hf/account", {
      headers: {
        host: "localhost",
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(false);
  });

  test("rejects a browser cross-site request even with forged proxy headers", () => {
    const request = new NextRequest("http://localhost/api/hf/account", {
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(false);
  });
});

test("noStoreHeaders prevents token/account responses from being cached", () => {
  const headers = noStoreHeaders();
  expect(headers.get("cache-control")).toBe("no-store, no-transform");
  expect(headers.get("content-type")).toBe("application/json");
});
