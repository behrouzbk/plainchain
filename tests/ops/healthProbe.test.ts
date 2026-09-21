import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { Node } from "../../src/node/node.js";
import { probeHealth } from "../../src/ops/healthProbe.js";
import { createRpcServer, listenRpc, type RpcListener } from "../../src/rpc/server.js";
import { generateSelfSignedCertificate } from "../../src/rpc/tls.js";

const EASY_TARGET = "f".repeat(64);

describe("probeHealth", () => {
  let dir: string;
  let node: Node;
  let listener: RpcListener | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-health-probe-test-"));
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    node = new Node({
      nodeId: "probe-node",
      networkId: "test-net",
      dataDir: dir,
      port: 0,
      genesis: { timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: 5000000000n, genesisAddress },
      consensus: { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, coinbaseMaturity: 0, maxFutureDriftMs: 7200000 },
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress: genesisAddress,
      blockReward: 5000000000n,
      logger: { warn: () => {} },
    });
    await node.start();
  });

  afterEach(async () => {
    if (listener) await listener.close();
    listener = undefined;
    await node.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports healthy for a live node over HTTP", async () => {
    listener = await listenRpc(createRpcServer(node, { authToken: "t", rateLimit: { maxRequests: 100, windowMs: 1000 } }), { port: 0, bind: "127.0.0.1" });
    const result = await probeHealth(`${listener.url}/health`, {});
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/probe-node/);
  });

  it("reports healthy over HTTPS when given the node's certificate, and unhealthy without it", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, tls.cert);
    listener = await listenRpc(createRpcServer(node, { authToken: "t", rateLimit: { maxRequests: 100, windowMs: 1000 } }), { port: 0, bind: "127.0.0.1", tls });
    expect((await probeHealth(`${listener.url}/health`, { caPath })).ok).toBe(true);
    const untrusted = await probeHealth(`${listener.url}/health`, {});
    expect(untrusted.ok).toBe(false);
    expect(untrusted.detail).toMatch(/self-signed|certificate/i);
  });

  it("reports unhealthy when nothing answers or the status is not ok", async () => {
    const dead = await probeHealth("http://127.0.0.1:1/health", { timeoutMs: 500 });
    expect(dead.ok).toBe(false);
    listener = await listenRpc(createRpcServer(node, { authToken: "t", rateLimit: { maxRequests: 100, windowMs: 1000 } }), { port: 0, bind: "127.0.0.1" });
    const wrongPath = await probeHealth(`${listener.url}/nope`, {});
    expect(wrongPath.ok).toBe(false);
    expect(wrongPath.detail).toMatch(/404/);
  });
});
