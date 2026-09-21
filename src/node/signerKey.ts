import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { KeyPair } from "../crypto/keypair.js";

/**
 * Loads a proof-of-authority signer key (`--signer-key <file>`): the
 * private key as PKCS#8 DER hex, as `npm run gen-authority` writes it. The
 * public half is derived rather than trusted from anywhere, so the node
 * cannot be misconfigured into claiming an authority it does not hold.
 */
export function readSignerKey(path: string): KeyPair {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read signer key ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSignerKey(text, path);
}

export function parseSignerKey(text: string, source = "signer key"): KeyPair {
  const hex = text.trim();
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error(`${source}: expected the private key as hex (as written by gen-authority)`);
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(hex, "hex"), format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`not an Ed25519 key (${privateKey.asymmetricKeyType})`);
    return {
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
      publicKey: createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("hex"),
    };
  } catch (err) {
    throw new Error(`${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
