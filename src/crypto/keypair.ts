import { generateKeyPairSync } from "node:crypto";

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  return {
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("hex"),
    privateKey: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("hex"),
  };
}
