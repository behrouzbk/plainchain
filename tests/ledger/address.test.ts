import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";

describe("deriveAddress", () => {
  it("is deterministic for the same public key", () => {
    const { publicKey } = generateKeyPair();
    expect(deriveAddress(publicKey)).toBe(deriveAddress(publicKey));
  });

  it("differs for different public keys", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(deriveAddress(a.publicKey)).not.toBe(deriveAddress(b.publicKey));
  });

  it("returns a hex string", () => {
    const { publicKey } = generateKeyPair();
    expect(deriveAddress(publicKey)).toMatch(/^[0-9a-f]+$/);
  });
});
