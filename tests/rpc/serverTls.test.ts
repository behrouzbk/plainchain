import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { Node } from "../../src/node/node.js";
import { createRpcServer, listenRpc, type RpcListener } from "../../src/rpc/server.js";
import { generateSelfSignedCertificate } from "../../src/rpc/tls.js";

const EASY_TARGET = "f".repeat(64);
const TEST_TOKEN = "test-rpc-token";
const TEST_RPC_OPTIONS = { authToken: TEST_TOKEN, rateLimit: { maxRequests: 10_000, windowMs: 60_000 } };

interface Reply {
  status: number;
  body: string;
}

/** One HTTPS (or HTTP) request; TLS failures reject with the socket error. */
function get(url: string, options: RequestOptions = {}): Promise<Reply> {
  const target = new URL(url);
  const req = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(target, { method: "GET", ...options }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

describe("RPC over TLS", () => {
  let dir: string;
  let node: Node;
  let listener: RpcListener | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-rpc-tls-test-"));
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    node = new Node({
      nodeId: "rpc-tls-test-node",
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
    });
    await node.start();
  });

  afterEach(async () => {
    if (listener) await listener.close();
    listener = undefined;
    await node.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("listenRpc without TLS serves plain HTTP (unchanged devnet behaviour)", async () => {
    listener = await listenRpc(createRpcServer(node, TEST_RPC_OPTIONS), { port: 0, bind: "127.0.0.1" });
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await get(`${listener.url}/chain/tip`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).height).toBe(0);
  });

  it("serves HTTPS with the given certificate; a client that trusts it gets the same API", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["localhost", "127.0.0.1"] });
    listener = await listenRpc(createRpcServer(node, TEST_RPC_OPTIONS), { port: 0, bind: "127.0.0.1", tls });
    expect(listener.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);

    const reply = await get(`${listener.url}/chain/tip`, { ca: tls.cert });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).height).toBe(0);

    // Protected method still works, now with the token encrypted in transit.
    const mined = await new Promise<Reply>((resolve, reject) => {
      const r = httpsRequest(
        new URL(`${listener!.url}/mine`),
        { method: "POST", ca: tls.cert, headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      r.on("error", reject);
      r.end();
    });
    expect(mined.status).toBe(200);
    expect(JSON.parse(mined.body).height).toBe(1);
  });

  it("a client with the default trust store refuses the self-signed certificate (no silent downgrade)", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    listener = await listenRpc(createRpcServer(node, TEST_RPC_OPTIONS), { port: 0, bind: "127.0.0.1", tls });
    await expect(get(`${listener.url}/chain/tip`)).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  });

  it("attack: a man-in-the-middle presenting its own certificate for the same host is rejected", async () => {
    // The operator pinned the real node's cert; the client sees an impostor
    // server whose cert has the same CN and SAN but a different key.
    const real = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const impostor = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    listener = await listenRpc(createRpcServer(node, TEST_RPC_OPTIONS), { port: 0, bind: "127.0.0.1", tls: impostor });
    await expect(get(`${listener.url}/chain/tip`, { ca: real.cert })).rejects.toMatchObject({
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  });

  it("attack: a certificate for a different host is rejected even when it is trusted", async () => {
    // A leaked cert for some other node in the operator's fleet must not
    // authenticate this address.
    const tls = generateSelfSignedCertificate({ hosts: ["other-node.example"] });
    listener = await listenRpc(createRpcServer(node, TEST_RPC_OPTIONS), { port: 0, bind: "127.0.0.1", tls });
    await expect(get(`${listener.url}/chain/tip`, { ca: tls.cert })).rejects.toMatchObject({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });

  it("plain HTTP against the TLS port is not served", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    listener = await listenRpc(createRpcServer(node, TEST_RPC_OPTIONS), { port: 0, bind: "127.0.0.1", tls });
    await expect(get(listener.url.replace("https:", "http:") + "/chain/tip")).rejects.toBeInstanceOf(Error);
  });
});
