import { describe, expect, it, vi } from "vitest";

/**
 * `ship.fetch` origin allowlist. A deployed function may call other Appgen functions and nothing
 * else: this is the guest's only outbound network capability, so it doubles as the SSRF boundary
 * (metadata endpoints, localhost services, the API's own admin routes). `APP_DOMAIN` is
 * `apps.appgen.test` and `API_ORIGIN` is `https://api.appgen.test` for this run.
 *
 * Redis, prisma and the chain package are faked because `fn.ts` opens a live ioredis connection
 * at import time; nothing here performs I/O.
 */

vi.mock("../src/lib/redis.js", () => ({
  redis: { set: async () => "OK", del: async () => 1, get: async () => null },
  subscribeChannel: () => () => undefined,
  closeRedis: async () => undefined,
}));
vi.mock("@appgen/db", () => ({
  Prisma: { JsonNull: null },
  prisma: { appKv: { findUnique: async () => null } },
}));
vi.mock("@appgen/chain", () => ({}));
vi.mock("../src/lib/treasury.js", () => ({ TREASURY_WALLET: "0x2222222222222222222222222222222222222222" }));

import type { Request } from "express";
import { DEPTH_HEADER, allowedTarget, callDepth, signDepth } from "../src/host/routes/fn.js";

describe("allowedTarget accepts", () => {
  it("a path-routed function on the API origin, naming the target app and function", () => {
    const t = allowedTarget("https://api.appgen.test/a/inboxzero/_appgen/fn/summarize");
    expect(t.url.toString()).toBe("https://api.appgen.test/a/inboxzero/_appgen/fn/summarize");
    expect(t).toMatchObject({ slug: "inboxzero", name: "summarize" });
    expect(allowedTarget("https://api.appgen.test/a/demo/_appgen/fn/hello").url.pathname).toBe("/a/demo/_appgen/fn/hello");
  });

  it("a host-routed function on an app subdomain over TLS", () => {
    const t = allowedTarget("https://inboxzero.apps.appgen.test/_appgen/fn/summarize");
    expect(t.url.host).toBe("inboxzero.apps.appgen.test");
    expect(t).toMatchObject({ slug: "inboxzero", name: "summarize" });
    expect(allowedTarget("https://INBOXZERO.APPS.APPGEN.TEST/_appgen/fn/summarize").url.hostname).toBe("inboxzero.apps.appgen.test");
  });

  it("function names with underscores and digits", () => {
    expect(allowedTarget("https://demo.apps.appgen.test/_appgen/fn/do_thing_2").url.pathname).toBe("/_appgen/fn/do_thing_2");
  });
});

describe("callDepth (signed x-appgen-fn-depth)", () => {
  const withHeader = (value?: string): Request => ({ headers: value === undefined ? {} : { [DEPTH_HEADER]: value } }) as unknown as Request;

  it("is 0 for a browser call that carries no header", () => {
    expect(callDepth(withHeader(), "demo", "hello")).toBe(0);
  });

  it("trusts a depth the platform signed for exactly this app and function", () => {
    expect(callDepth(withHeader(signDepth(1, "demo", "hello")), "demo", "hello")).toBe(1);
    expect(callDepth(withHeader(signDepth(2, "demo", "hello")), "demo", "hello")).toBe(2);
  });

  it("refuses a bare depth a browser could send, so it cannot pose as an internal hop", () => {
    expect(() => callDepth(withHeader("1"), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => callDepth(withHeader("0"), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses a signature minted for another target or a tampered depth", () => {
    expect(() => callDepth(withHeader(signDepth(1, "other", "hello")), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => callDepth(withHeader(signDepth(1, "demo", "bye")), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    const [, issued, mac] = signDepth(1, "demo", "hello").split(".");
    expect(() => callDepth(withHeader(`2.${issued}.${mac}`), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses a depth past the app-to-app ceiling even when signed", () => {
    expect(() => callDepth(withHeader(signDepth(3, "demo", "hello")), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses a stale signature", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      const header = signDepth(1, "demo", "hello");
      vi.setSystemTime(now + 61_000);
      expect(() => callDepth(withHeader(header), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("allowedTarget rejects", () => {
  const reject = (url: string): void => {
    expect(() => allowedTarget(url)).toThrow(/ship\.fetch/);
  };

  it("anything that is not a Appgen function path", () => {
    for (const url of [
      "https://inboxzero.apps.appgen.test/",
      "https://inboxzero.apps.appgen.test/admin",
      "https://inboxzero.apps.appgen.test/_appgen/kv/secret",
      "https://api.appgen.test/a/inboxzero/_appgen/kv/secret",
      "https://api.appgen.test/admin/apps",
      "https://api.appgen.test/_appgen/fn/summarize", // the API origin itself is not an app host
      "https://api.appgen.test/a/inboxzero/_appgen/fn/summarize/extra",
    ]) {
      reject(url);
    }
  });

  it("foreign origins, including SSRF favourites", () => {
    for (const url of [
      "https://evil.test/_appgen/fn/steal",
      "https://apps.appgen.test/_appgen/fn/x", // bare app domain, no slug
      "https://inboxzero.apps.appgen.test.evil.test/_appgen/fn/x",
      "http://169.254.169.254/_appgen/fn/x",
      "https://169.254.169.254/latest/meta-data/",
      "http://localhost:6379/_appgen/fn/x",
      "http://127.0.0.1/_appgen/fn/x",
      "https://metadata.google.internal/_appgen/fn/x",
    ]) {
      reject(url);
    }
  });

  it("non-TLS app hosts, so a function cannot be downgraded onto plaintext", () => {
    reject("http://inboxzero.apps.appgen.test/_appgen/fn/summarize");
  });

  it("non-http schemes and malformed URLs", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://apps.appgen.test/_appgen/fn/x",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "not a url",
      "",
      "//inboxzero.apps.appgen.test/_appgen/fn/x",
      "/a/inboxzero/_appgen/fn/summarize",
    ]) {
      reject(url);
    }
  });

  it("query strings, fragments and credentials smuggled into the URL", () => {
    for (const url of [
      "https://inboxzero.apps.appgen.test/_appgen/fn/summarize?x=1",
      "https://inboxzero.apps.appgen.test/_appgen/fn/summarize#frag",
      "https://api.appgen.test/a/demo/_appgen/fn/hello?redirect=https://evil.test",
      "https://user:pass@evil.test/_appgen/fn/x",
    ]) {
      reject(url);
    }
  });

  it("slugs and function names outside the allowed character sets", () => {
    for (const url of [
      "https://UPPER_SLUG.apps.appgen.test/_appgen/fn/x",
      "https://bad_slug.apps.appgen.test/_appgen/fn/x",
      "https://deep.nested.apps.appgen.test/_appgen/fn/x",
      `https://${"x".repeat(41)}.apps.appgen.test/_appgen/fn/y`,
      "https://demo.apps.appgen.test/_appgen/fn/Bad-Name-With-Caps",
      "https://demo.apps.appgen.test/_appgen/fn/",
      `https://demo.apps.appgen.test/_appgen/fn/${"n".repeat(41)}`,
      "https://api.appgen.test/a/BAD/_appgen/fn/x",
      "https://api.appgen.test/a//_appgen/fn/x",
    ]) {
      reject(url);
    }
  });

  it("path traversal aimed at escaping the function prefix", () => {
    for (const url of [
      "https://demo.apps.appgen.test/_appgen/fn/../kv/secret",
      "https://demo.apps.appgen.test/_appgen/fn/%2e%2e/kv",
      "https://api.appgen.test/a/demo/_appgen/fn/..%2f..%2fadmin",
    ]) {
      reject(url);
    }
  });
});
