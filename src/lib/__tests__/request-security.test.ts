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
});

test("noStoreHeaders prevents token/account responses from being cached", () => {
  const headers = noStoreHeaders();
  expect(headers.get("cache-control")).toBe("no-store, no-transform");
  expect(headers.get("content-type")).toBe("application/json");
});
