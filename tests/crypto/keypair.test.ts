import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";

describe("generateKeyPair", () => {
  it("returns hex-encoded public and private keys", () => {
    const { publicKey, privateKey } = generateKeyPair();
    expect(typeof publicKey).toBe("string");
    expect(typeof privateKey).toBe("string");
    expect(publicKey).toMatch(/^[0-9a-f]+$/);
    expect(privateKey).toMatch(/^[0-9a-f]+$/);
  });

  it("generates distinct key pairs on each call", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});
