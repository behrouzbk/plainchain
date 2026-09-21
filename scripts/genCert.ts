/**
 * Generates a self-signed TLS certificate for the RPC server, using only
 * node:crypto (no openssl needed).
 *
 *   npm run gen-cert -- --hosts localhost,127.0.0.1 --out data/n1/tls
 *   (from PowerShell: npx tsx scripts/genCert.ts --hosts ... --out ...)
 *
 * Writes <out>/rpc-cert.pem and <out>/rpc-key.pem. Start the node with
 * --rpc-tls-cert/--rpc-tls-key pointing at them, and give wallets the cert
 * via --ca (or $L1_RPC_CA). Every host a client will connect *by* must be
 * in --hosts, or hostname verification fails.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/config/args.js";
import { generateSelfSignedCertificate, TlsConfigError } from "../src/rpc/tls.js";

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const hosts = (flags.hosts ?? "localhost,127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean);
  const outDir = flags.out ?? "data/tls";
  const validDays = Number(flags.days ?? 3650);
  if (!Number.isInteger(validDays) || validDays <= 0) throw new TlsConfigError(`--days must be a positive integer, got "${flags.days}"`);

  const certPath = join(outDir, "rpc-cert.pem");
  const keyPath = join(outDir, "rpc-key.pem");
  if (existsSync(certPath) || existsSync(keyPath)) {
    throw new TlsConfigError(`${certPath} or ${keyPath} already exists; remove them or pick another --out (refusing to overwrite)`);
  }

  const { cert, key } = generateSelfSignedCertificate({ hosts, validDays, commonName: flags.cn });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key, { mode: 0o600 });

  console.log(`wrote ${certPath} (hosts: ${hosts.join(", ")}; valid ${validDays} days)`);
  console.log(`wrote ${keyPath} (keep private)`);
  console.log(`node:   --rpc-tls-cert ${certPath} --rpc-tls-key ${keyPath}`);
  console.log(`wallet: --ca ${certPath}  (or L1_RPC_CA=${certPath})`);
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof TlsConfigError ? 2 : 1;
}
