import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonRpcClient, RpcError, RpcTransportError } from "../../src/cli/rpcClient.js";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { Node } from "../../src/node/node.js";
import { createRpcServer, listenRpc, type RpcListener } from "../../src/rpc/server.js";
import { generateSelfSignedCertificate, type TlsCredentials } from "../../src/rpc/tls.js";

const EASY_TARGET = "f".repeat(64);
const TOKEN = "client-test-token";
const RPC_OPTIONS = { authToken: TOKEN, rateLimit: { maxRequests: 10_000, windowMs: 60_000 } };

describe("JsonRpcClient", () => {
  let dir: string;
  let node: Node;
  let listener: RpcListener | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-rpc-client-test-"));
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    node = new Node({
      nodeId: "rpc-client-test-node",
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

  async function serve(tls?: TlsCredentials): Promise<string> {
    listener = await listenRpc(createRpcServer(node, RPC_OPTIONS), { port: 0, bind: "127.0.0.1", tls });
    return listener.url;
  }

  it("calls a method over plain HTTP and returns the result", async () => {
    const client = new JsonRpcClient(await serve());
    const info = await client.call<{ networkId: string; tip: { height: number } }>("getInfo");
    expect(info.networkId).toBe("test-net");
    expect(info.tip.height).toBe(0);
  });

  it("surfaces JSON-RPC errors as RpcError with the server's code", async () => {
    const client = new JsonRpcClient(await serve());
    await expect(client.call("noSuchMethod")).rejects.toMatchObject({ code: -32601 });
    await expect(client.call("noSuchMethod")).rejects.toBeInstanceOf(RpcError);
  });

  it("sends the bearer token so protected methods work", async () => {
    const url = await serve();
    await expect(new JsonRpcClient(url).call("mine")).rejects.toMatchObject({ code: -32004 });
    const mined = await new JsonRpcClient(url, { token: TOKEN }).call<{ height: number }>("mine");
    expect(mined.height).toBe(1);
  });

  it("talks HTTPS when given the node's certificate as a trust anchor", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const url = await serve(tls);
    expect(url.startsWith("https://")).toBe(true);
    const client = new JsonRpcClient(url, { token: TOKEN, ca: tls.cert });
    const info = await client.call<{ networkId: string }>("getInfo");
    expect(info.networkId).toBe("test-net");
    const mined = await client.call<{ height: number }>("mine");
    expect(mined.height).toBe(1);
  });

  it("refuses an untrusted (self-signed) certificate and tells the operator how to trust it", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const client = new JsonRpcClient(await serve(tls));
    const failure = await client.call("getInfo").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcTransportError);
    expect((failure as Error).message).toMatch(/self-signed/i);
    expect((failure as Error).message).toMatch(/--ca/);
  });

  it("attack: an impostor certificate for the same host is refused even with the same name", async () => {
    const real = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const impostor = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const client = new JsonRpcClient(await serve(impostor), { ca: real.cert });
    await expect(client.call("getInfo")).rejects.toBeInstanceOf(RpcTransportError);
  });

  it("attack: a trusted certificate issued for a different host is refused", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["some-other-node.example"] });
    const client = new JsonRpcClient(await serve(tls), { ca: tls.cert });
    const failure = await client.call("getInfo").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcTransportError);
    expect((failure as Error).message).toMatch(/altname|does not match/i);
  });

  it("rejects URLs that are not http(s)", async () => {
    await expect(new JsonRpcClient("ftp://127.0.0.1:1").call("getInfo")).rejects.toThrow(/http/);
    await expect(new JsonRpcClient("not a url").call("getInfo")).rejects.toBeInstanceOf(RpcTransportError);
  });

  it("reports an unreachable node as a transport error", async () => {
    const url = await serve();
    await listener!.close();
    listener = undefined;
    await expect(new JsonRpcClient(url).call("getInfo")).rejects.toBeInstanceOf(RpcTransportError);
  });
});
