import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { parseSignerKey, readSignerKey } from "../../src/node/signerKey.js";

describe("proof-of-authority signer key file", () => {
  it("round-trips a generated key and derives the public key from the private one", () => {
    const kp = generateKeyPair();
    expect(parseSignerKey(`${kp.privateKey}\n`)).toEqual(kp);
    const dir = mkdtempSync(join(tmpdir(), "l1-signer-key-"));
    try {
      const path = join(dir, "authority.key");
      writeFileSync(path, kp.privateKey + "\n");
      expect(readSignerKey(path)).toEqual(kp);
      expect(() => readSignerKey(join(dir, "missing.key"))).toThrow(/cannot read signer key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses garbage and keys of another type", () => {
    expect(() => parseSignerKey("not hex")).toThrow(/hex/);
    expect(() => parseSignerKey("abc")).toThrow(/hex/);
    expect(() => parseSignerKey("00".repeat(48))).toThrow(/signer key/);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
    expect(() => parseSignerKey(ec)).toThrow(/Ed25519/);
  });
});
