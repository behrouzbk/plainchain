import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractBearerToken, resolveRpcToken, tokensMatch } from "../../src/rpc/auth.js";

describe("resolveRpcToken", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-rpc-auth-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses an explicitly provided token and does not write a cookie", () => {
    const result = resolveRpcToken({ explicitToken: "s3cret", dataDir: dir });
    expect(result).toEqual({ token: "s3cret", source: "explicit" });
    expect(existsSync(join(dir, "rpc-token"))).toBe(false);
  });

  it("generates a random token and persists it as a cookie file when none is provided", () => {
    const result = resolveRpcToken({ dataDir: dir });
    expect(result.source).toBe("cookie");
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cookiePath).toBe(join(dir, "rpc-token"));
    expect(readFileSync(join(dir, "rpc-token"), "utf8").trim()).toBe(result.token);
  });

  it("reuses an existing cookie on subsequent starts", () => {
    const first = resolveRpcToken({ dataDir: dir });
    const second = resolveRpcToken({ dataDir: dir });
    expect(second.token).toBe(first.token);
  });

  it("restricts the cookie file to the owner where the platform supports it", () => {
    resolveRpcToken({ dataDir: dir });
    const mode = statSync(join(dir, "rpc-token")).mode & 0o777;
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("rejects an empty explicit token rather than silently disabling auth", () => {
    expect(() => resolveRpcToken({ explicitToken: "", dataDir: dir })).toThrow(/empty/i);
  });
});

describe("extractBearerToken", () => {
  it("parses a Bearer authorization header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns undefined for missing or non-bearer headers", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic xyz")).toBeUndefined();
    expect(extractBearerToken("Bearer")).toBeUndefined();
  });
});

describe("tokensMatch", () => {
  it("compares in constant time and only matches identical tokens", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("abc", undefined)).toBe(false);
  });
});
