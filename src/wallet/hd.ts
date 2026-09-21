import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import type { KeyPair } from "../crypto/keypair.js";

/**
 * Hierarchical deterministic keys for Ed25519, per SLIP-0010: one secret
 * seed yields any number of accounts, so a wallet backs up one value and
 * can recreate every key. Ed25519 supports hardened derivation only (no
 * public-key-only child derivation), which is all a wallet needs.
 */
export interface ExtendedKey {
  /** 32-byte private key seed for this node. */
  key: Buffer;
  chainCode: Buffer;
}

const HARDENED = 0x80000000;

/** BIP-44 style: m / 44' / coin' / account'. The coin type is this chain's own constant. */
export const COIN_TYPE = 7331;

export function masterKeyFromSeed(seed: Buffer): ExtendedKey {
  const I = createHmac("sha512", "ed25519 seed").update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

export function deriveHardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error(`child index must be in [0, 2^31), got ${index}`);
  const data = Buffer.alloc(1 + 32 + 4);
  data[0] = 0x00;
  parent.key.copy(data, 1);
  data.writeUInt32BE((index + HARDENED) >>> 0, 33);
  const I = createHmac("sha512", parent.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** `m/44'/7331'/0'` or with `h` suffixes. Every segment must be hardened. */
export function derivePath(seed: Buffer, path: string): ExtendedKey {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error(`derivation path must start with "m", got "${path}"`);
  let node = masterKeyFromSeed(seed);
  for (const part of parts.slice(1)) {
    const match = /^(\d+)(['h])$/.exec(part);
    if (!match) throw new Error(`path segment "${part}" must be hardened (e.g. 0'): ed25519 has no non-hardened derivation`);
    node = deriveHardenedChild(node, Number(match[1]));
  }
  return node;
}

/** PKCS#8 DER prefix for an Ed25519 private key (RFC 8410): the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The project's KeyPair (PKCS#8 / SPKI DER hex) from a raw 32-byte Ed25519 seed. */
export function keyPairFromSeed32(seed32: Buffer): KeyPair {
  if (seed32.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed32.length}`);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
  };
}

export function accountPath(account: number): string {
  return `m/44'/${COIN_TYPE}'/${account}'`;
}

export function accountKeyPair(seed: Buffer, account: number): KeyPair {
  return keyPairFromSeed32(derivePath(seed, accountPath(account)).key);
}
