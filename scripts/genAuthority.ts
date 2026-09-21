/**
 * Generates a proof-of-authority signer key for one node.
 *
 *   npm run gen-authority -- --out data/n1/authority.key
 *   (from PowerShell: npx tsx scripts/genAuthority.ts --out ...)
 *
 * Writes the private key (PKCS#8 DER hex, mode 0600) to --out and prints
 * the public key to add to `consensus.authorities` in every node's config.
 * The private key is not encrypted: it belongs on the authority's own host,
 * like a TLS key, and the node reads it at startup via --signer-key.
 * `--from <file>` prints the public key of an existing key file instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "../src/config/args.js";
import { generateKeyPair } from "../src/crypto/keypair.js";
import { readSignerKey } from "../src/node/signerKey.js";

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.from !== undefined) {
    const key = readSignerKey(flags.from);
    console.log(`authority public key: ${key.publicKey}`);
    return;
  }
  const out = flags.out;
  if (!out) throw new Error("usage: gen-authority --out <file> | --from <file>");
  if (existsSync(out)) throw new Error(`${out} already exists (refusing to overwrite)`);
  const keyPair = generateKeyPair();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, keyPair.privateKey + "\n", { mode: 0o600, flag: "wx" });
  console.log(`signer key written: ${out} (keep it private; start the node with --signer-key ${out})`);
  console.log(`authority public key: ${keyPair.publicKey}`);
  console.log(`add it to "consensus.authorities" (in turn order) in every node's config, with "consensus.mode": "poa"`);
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
