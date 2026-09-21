import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign, verify } from "../../src/crypto/signature.js";

describe("sign / verify", () => {
  it("verifies a signature produced with the matching private key", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const message = "transfer 10 coins to alice";

    const signature = sign(privateKey, message);

    expect(verify(publicKey, message, signature)).toBe(true);
  });

  it("rejects a signature if the message was tampered with", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const signature = sign(privateKey, "original message");

    expect(verify(publicKey, "tampered message", signature)).toBe(false);
  });

  it("rejects a signature checked against the wrong public key", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const signature = sign(a.privateKey, "message");

    expect(verify(b.publicKey, "message", signature)).toBe(false);
  });

  it("produces a hex-encoded signature", () => {
    const { privateKey } = generateKeyPair();
    const signature = sign(privateKey, "message");
    expect(signature).toMatch(/^[0-9a-f]+$/);
  });
});
