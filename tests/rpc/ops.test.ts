import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageVersion } from "../../src/config/index.js";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { Node } from "../../src/node/node.js";
import { createRpcServer, type RpcServerOptions } from "../../src/rpc/server.js";

const EASY_TARGET = "f".repeat(64);
const TOKEN = "ops-test-token";
const OPTIONS: RpcServerOptions = { authToken: TOKEN, rateLimit: { maxRequests: 10_000, windowMs: 60_000 } };

/** Parses the samples of a Prometheus text body into a map of "name{labels}" -> value. */
function samples(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const space = line.lastIndexOf(" ");
    out.set(line.slice(0, space), Number(line.slice(space + 1)));
  }
  return out;
}

describe("operator endpoints", () => {
  let dir: string;
  let node: Node;
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-ops-test-"));
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    node = new Node({
      nodeId: "ops-node",
      networkId: "test-net",
      dataDir: dir,
      port: 0,
      genesis: { timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: 5000000000n, genesisAddress },
      consensus: {
        targetBlockTimeMs: 10_000,
        difficultyRetargetInterval: 10,
        maxDifficultyAdjustmentFactor: 4,
        coinbaseMaturity: 0,
        maxFutureDriftMs: 2 * 60 * 60 * 1000,
      },
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress: genesisAddress,
      blockReward: 5000000000n,
      logger: { warn: () => {} },
    });
    await node.start();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await node.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve(options: RpcServerOptions = OPTIONS): Promise<void> {
    const app = createRpcServer(node, options);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }

  it("GET /health reports ok with identity, tip and peer count", async () => {
    await serve();
    await node.mineBlock();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", nodeId: "ops-node", networkId: "test-net", height: 1, peers: 0 });
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.tipHash).toBe("string");
  });

  it("GET /health is not rate limited, so a probe never flaps under load", async () => {
    await serve({ ...OPTIONS, rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    expect((await fetch(`${baseUrl}/chain/tip`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/chain/tip`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/chain/tip`)).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("GET /metrics exposes chain, mempool, peer and process gauges in Prometheus format", async () => {
    await serve();
    await node.mineBlock();
    await node.mineBlock();
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain;.*version=0\.0\.4/);
    const text = await res.text();
    expect(text).toContain("# TYPE l1_chain_height gauge");
    const s = samples(text);
    expect(s.get("l1_chain_height")).toBe(2);
    expect(s.get("l1_blocks_adopted_total")).toBe(2);
    expect(s.get("l1_mempool_transactions")).toBe(0);
    expect(s.get('l1_peers_connected{direction="inbound"}')).toBe(0);
    expect(s.get('l1_peers_connected{direction="outbound"}')).toBe(0);
    expect(s.get("l1_orphan_blocks")).toBe(0);
    expect(s.get("process_resident_memory_bytes")).toBeGreaterThan(0);
    expect(s.get("process_uptime_seconds")).toBeGreaterThanOrEqual(0);
    expect(s.get(`l1_build_info{network_id="test-net",node_id="ops-node",version="${packageVersion()}"}`)).toBe(1);
  });

  it("counts JSON-RPC calls by method and outcome", async () => {
    await serve();
    const post = (body: unknown, auth = false): Promise<Response> =>
      fetch(`${baseUrl}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
    await post({ jsonrpc: "2.0", id: 1, method: "getTip" });
    await post([
      { jsonrpc: "2.0", id: 2, method: "getTip" },
      { jsonrpc: "2.0", id: 3, method: "getBlockByHeight", params: [99] },
    ]);
    await post({ jsonrpc: "2.0", id: 4, method: "mine" });
    await post({ jsonrpc: "2.0", id: 5, method: "mine" }, true);

    const s = samples(await (await fetch(`${baseUrl}/metrics`)).text());
    expect(s.get('l1_rpc_calls_total{method="getTip",outcome="ok"}')).toBe(2);
    expect(s.get('l1_rpc_calls_total{method="getBlockByHeight",outcome="error"}')).toBe(1);
    expect(s.get('l1_rpc_calls_total{method="mine",outcome="unauthorized"}')).toBe(1);
    expect(s.get('l1_rpc_calls_total{method="mine",outcome="ok"}')).toBe(1);
  });

  it("attack: unknown method names do not become metric labels (bounded cardinality)", async () => {
    await serve();
    for (let i = 0; i < 20; i++) {
      await fetch(`${baseUrl}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: `probe_${i}` }),
      });
    }
    await fetch(`${baseUrl}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
    const text = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(text).not.toContain("probe_");
    const s = samples(text);
    expect(s.get('l1_rpc_calls_total{method="unknown",outcome="not_found"}')).toBe(20);
    expect(s.get('l1_rpc_calls_total{method="unknown",outcome="invalid"}')).toBe(1);
  });

  it("ignores X-Forwarded-For unless trustProxy is set: all requests through one socket share a bucket", async () => {
    await serve({ ...OPTIONS, rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    const get = (xff: string): Promise<Response> => fetch(`${baseUrl}/chain/tip`, { headers: { "X-Forwarded-For": xff } });
    expect((await get("203.0.113.1")).status).toBe(200);
    expect((await get("203.0.113.2")).status).toBe(200);
    // A direct client cannot mint new buckets by inventing forwarded addresses.
    expect((await get("203.0.113.3")).status).toBe(429);
  });

  it("with trustProxy hops, rate limits per forwarded client behind a reverse proxy", async () => {
    await serve({ ...OPTIONS, rateLimit: { maxRequests: 2, windowMs: 60_000 }, trustProxy: 1 });
    const get = (xff: string): Promise<Response> => fetch(`${baseUrl}/chain/tip`, { headers: { "X-Forwarded-For": xff } });
    expect((await get("203.0.113.1")).status).toBe(200);
    expect((await get("203.0.113.1")).status).toBe(200);
    expect((await get("203.0.113.1")).status).toBe(429); // client 1 exhausted
    expect((await get("203.0.113.2")).status).toBe(200); // client 2 has its own budget
  });

  it("attack: with trustProxy hops, a client cannot spoof its address by prepending entries the proxy did not add", async () => {
    await serve({ ...OPTIONS, rateLimit: { maxRequests: 2, windowMs: 60_000 }, trustProxy: 1 });
    // The proxy (our socket peer) appends the real client last; anything
    // the client put in front of it is untrusted and must be ignored.
    const get = (xff: string): Promise<Response> => fetch(`${baseUrl}/chain/tip`, { headers: { "X-Forwarded-For": xff } });
    expect((await get("spoof-a, 203.0.113.9")).status).toBe(200);
    expect((await get("spoof-b, 203.0.113.9")).status).toBe(200);
    expect((await get("spoof-c, 203.0.113.9")).status).toBe(429); // still one bucket: 203.0.113.9
  });

  it("counts rate-limited requests", async () => {
    await serve({ ...OPTIONS, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    await fetch(`${baseUrl}/chain/tip`);
    await fetch(`${baseUrl}/chain/tip`);
    await fetch(`${baseUrl}/chain/tip`);
    // /metrics is rate limited too, so read it through the node's registry.
    expect(samples(node.metrics.render()).get("l1_rpc_rate_limited_total")).toBe(2);
  });
});
