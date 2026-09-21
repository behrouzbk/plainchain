import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sign, verify } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { accountKeyPair, accountPath, deriveHardenedChild, derivePath, keyPairFromSeed32, masterKeyFromSeed } from "../../src/wallet/hd.js";

/** SLIP-0010 test vector 1 for ed25519 (seed 000102…0f). Public keys there carry a 0x00 prefix. */
const SEED = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const VECTOR = {
  m: {
    chainCode: "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
    key: "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
    publicKey: "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed",
  },
  "m/0'": {
    chainCode: "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
    key: "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    publicKey: "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c",
  },
  "m/0'/1'": {
    chainCode: "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
    key: "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
    publicKey: "1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187",
  },
};

/** Raw 32-byte ed25519 public key out of our SPKI-DER hex encoding. */
function rawPublic(spkiHex: string): string {
  return spkiHex.slice(-64);
}

describe("SLIP-0010 ed25519 derivation", () => {
  it("derives the master key and chain code from a seed", () => {
    const m = masterKeyFromSeed(SEED);
    expect(m.key.toString("hex")).toBe(VECTOR.m.key);
    expect(m.chainCode.toString("hex")).toBe(VECTOR.m.chainCode);
    expect(rawPublic(keyPairFromSeed32(m.key).publicKey)).toBe(VECTOR.m.publicKey);
  });

  it("derives hardened children matching the published vectors", () => {
    const m = masterKeyFromSeed(SEED);
    const c0 = deriveHardenedChild(m, 0);
    expect(c0.key.toString("hex")).toBe(VECTOR["m/0'"].key);
    expect(c0.chainCode.toString("hex")).toBe(VECTOR["m/0'"].chainCode);
    expect(rawPublic(keyPairFromSeed32(c0.key).publicKey)).toBe(VECTOR["m/0'"].publicKey);
    const c01 = deriveHardenedChild(c0, 1);
    expect(c01.key.toString("hex")).toBe(VECTOR["m/0'/1'"].key);
    expect(rawPublic(keyPairFromSeed32(c01.key).publicKey)).toBe(VECTOR["m/0'/1'"].publicKey);
  });

  it("derivePath parses m/…' paths and refuses non-hardened segments (ed25519 has no public derivation)", () => {
    expect(derivePath(SEED, "m/0'/1'").key.toString("hex")).toBe(VECTOR["m/0'/1'"].key);
    expect(derivePath(SEED, "m/0h/1h").key.toString("hex")).toBe(VECTOR["m/0'/1'"].key);
    expect(() => derivePath(SEED, "m/0/1'")).toThrow(/hardened/);
    expect(() => derivePath(SEED, "x/0'")).toThrow(/path/);
  });

  it("produces working key pairs: derived keys sign and verify, addresses differ per account", () => {
    const seed = randomBytes(32);
    const a0 = accountKeyPair(seed, 0);
    const a1 = accountKeyPair(seed, 1);
    expect(deriveAddress(a0.publicKey)).not.toBe(deriveAddress(a1.publicKey));
    const sig = sign(a0.privateKey, "hello");
    expect(verify(a0.publicKey, "hello", sig)).toBe(true);
    expect(verify(a1.publicKey, "hello", sig)).toBe(false);
    // Deterministic: the same seed always yields the same accounts.
    expect(accountKeyPair(seed, 1)).toEqual(a1);
    expect(accountPath(3)).toBe("m/44'/7331'/3'");
  });
});
