/**
 * Generates the key a node pays anchor fees with (`--anchor-key`).
 *
 *   npm run gen-anchor-key -- --out data/n1/anchor.key
 *   (from PowerShell: npx tsx scripts/genAnchorKey.ts --out ...)
 *
 * Writes the private key (PKCS#8 DER hex, mode 0600) to --out and prints
 * the address to fund. It is a hot key: the node reads it unencrypted at
 * startup, so keep only what fees need on that address.
 * `--from <file>` prints the address of an existing key file instead.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "../src/config/args.js";
import { generateKeyPair } from "../src/crypto/keypair.js";
import { deriveAddress, encodeAddress } from "../src/ledger/address.js";
import { readSignerKey } from "../src/node/signerKey.js";

function printAddress(publicKey: string): void {
  const address = deriveAddress(publicKey);
  console.log(`anchor address: ${encodeAddress(address)}`);
  console.log(`          (raw) ${address}`);
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.from !== undefined) {
    printAddress(readSignerKey(flags.from).publicKey);
    return;
  }
  const out = flags.out;
  if (!out) throw new Error("usage: gen-anchor-key --out <file> | --from <file>");
  if (existsSync(out)) throw new Error(`${out} already exists (refusing to overwrite)`);
  const keyPair = generateKeyPair();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, keyPair.privateKey + "\n", { mode: 0o600, flag: "wx" });
  console.log(`anchor key written: ${out} (keep it private; start the node with --anchor-key ${out})`);
  printAddress(keyPair.publicKey);
  console.log("send coins to this address: the node pays each anchor's fee from it");
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
