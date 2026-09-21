/**
 * Smoke test for a running testnet (docker compose up, or three local
 * processes): every node answers /health, node 1 mines a block, and the
 * others converge on it. Exit 0 on success, 1 otherwise.
 *
 *   npm run testnet:check
 *   L1_TESTNET_RPC_URLS=https://127.0.0.1:9001,... L1_RPC_CA=testnet/tls/node1/rpc-cert.pem npm run testnet:check
 */
import { JsonRpcClient } from "../src/cli/rpcClient.js";
import { probeHealth } from "../src/ops/healthProbe.js";
import { readFileSync } from "node:fs";

const urls = (process.env.L1_TESTNET_RPC_URLS ?? "http://127.0.0.1:9001,http://127.0.0.1:9002,http://127.0.0.1:9003")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const token = process.env.L1_RPC_TOKEN ?? "testnet-rpc-token";
const caPath = process.env.L1_RPC_CA;
const ca = caPath ? readFileSync(caPath, "utf8") : undefined;

interface Tip {
  hash: string;
  height: number;
}

async function waitForTip(client: JsonRpcClient, hash: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tip = await client.call<Tip | null>("getTip");
    if (tip?.hash === hash) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`did not converge to ${hash} within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  if (urls.length < 2) throw new Error("need at least two node URLs");
  for (const url of urls) {
    const health = await probeHealth(`${url}/health`, { caPath });
    if (!health.ok) throw new Error(`${url}/health: ${health.detail}`);
    console.log(`[check] ${url} healthy: ${health.detail}`);
  }

  const clients = urls.map((url) => new JsonRpcClient(url, { token, ca }));
  const info = await clients[0]!.call<{ peerCount: number }>("getInfo");
  console.log(`[check] ${urls[0]} has ${info.peerCount} peer(s)`);
  if (info.peerCount === 0) throw new Error("node 1 has no peers; the mesh did not form");

  const mined = await clients[0]!.call<{ hash: string; height: number }>("mine");
  console.log(`[check] mined ${mined.hash} at height ${mined.height} on ${urls[0]}`);
  for (const [i, client] of clients.slice(1).entries()) {
    await waitForTip(client, mined.hash, 15_000);
    console.log(`[check] ${urls[i + 1]} converged`);
  }
  console.log(`\n✅ SUCCESS: ${urls.length} nodes converged on ${mined.hash}\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
