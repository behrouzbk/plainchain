/**
 * Generates one self-signed RPC certificate per compose node into
 * testnet/tls/<node>/, plus testnet/tls/ca-bundle.pem (all certs, for
 * `--ca` / L1_RPC_CA on the host). Keys are written world-readable so the
 * container user can read the bind mount: testnet only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSelfSignedCertificate } from "../src/rpc/tls.js";

const root = join("testnet", "tls");
const nodes = ["node1", "node2", "node3"];
const bundle: string[] = [];
for (const node of nodes) {
  const dir = join(root, node);
  const certPath = join(dir, "rpc-cert.pem");
  const keyPath = join(dir, "rpc-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    console.log(`kept ${certPath}`);
  } else {
    mkdirSync(dir, { recursive: true });
    const { cert, key } = generateSelfSignedCertificate({ hosts: ["localhost", "127.0.0.1", node], commonName: node, validDays: 365 });
    writeFileSync(certPath, cert);
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o644);
    console.log(`wrote ${certPath} and ${keyPath}`);
  }
  bundle.push(readFileSync(certPath, "utf8"));
}
writeFileSync(join(root, "ca-bundle.pem"), bundle.join(""));
console.log(`wrote ${join(root, "ca-bundle.pem")} (trust it with --ca / L1_RPC_CA)`);

