import { describe, expect, it } from "vitest";
import { sha256, doubleSha256 } from "../../src/crypto/hash.js";

describe("sha256", () => {
  it("hashes a string to the known SHA-256 hex digest", () => {
    // echo -n "hello" | sha256sum
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("is deterministic for identical input", () => {
    expect(sha256("l1-node-engine")).toBe(sha256("l1-node-engine"));
  });

  it("produces different digests for different input", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("accepts Buffer input", () => {
    expect(sha256(Buffer.from("hello"))).toBe(sha256("hello"));
  });
});

describe("doubleSha256", () => {
  it("equals sha256(sha256(x))", () => {
    expect(doubleSha256("hello")).toBe(sha256(sha256("hello")));
  });

  it("differs from a single sha256 pass", () => {
    expect(doubleSha256("hello")).not.toBe(sha256("hello"));
  });
});
