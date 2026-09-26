import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { serializeTransaction } from "../../src/ledger/serialize.js";
import { computeTransactionId, getSigningPayload } from "../../src/ledger/transaction.js";
import type { Transaction, UnsignedTransactionBody } from "../../src/ledger/types.js";
import { Node } from "../../src/node/node.js";
import { createRpcServer } from "../../src/rpc/server.js";
import { verifyMerkleProof } from "../../src/crypto/merkle.js";
import { encodeAddress } from "../../src/ledger/address.js";

const EASY_TARGET = "f".repeat(64);
const TEST_TOKEN = "test-rpc-token";
const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };
const TEST_RPC_OPTIONS = { authToken: TEST_TOKEN, rateLimit: { maxRequests: 10_000, windowMs: 60_000 } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: globalThis.Response): Promise<any> {
  return res.json();
}

describe("RPC server", () => {
  let dir: string;
  let node: Node;
  let server: Server;
  let baseUrl: string;
  let genesisMiner: { publicKey: string; privateKey: string };
  let genesisAddress: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-rpc-test-"));
    genesisMiner = generateKeyPair();
    genesisAddress = deriveAddress(genesisMiner.publicKey);

    node = new Node({
      nodeId: "rpc-test-node",
      networkId: "test-net",
      dataDir: dir,
      port: 0,
      genesis: {
        timestamp: 1700000000000,
        difficultyTarget: EASY_TARGET,
        reward: 5000000000n,
        genesisAddress,
      },
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

    const app = createRpcServer(node, TEST_RPC_OPTIONS);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await node.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /chain/tip returns the genesis tip", async () => {
    const res = await fetch(`${baseUrl}/chain/tip`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.height).toBe(0);
  });

  it("GET /balance/:address returns the genesis reward for the genesis address", async () => {
    const res = await fetch(`${baseUrl}/balance/${genesisAddress}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.balance).toBe("5000000000");
  });

  it("GET /balance/:address returns 0 for an unknown address, in either address form", async () => {
    const unknown = "0".repeat(64);
    expect((await json(await fetch(`${baseUrl}/balance/${unknown}`))).balance).toBe("0");
    expect((await json(await fetch(`${baseUrl}/balance/${encodeAddress(unknown)}`))).balance).toBe("0");
  });

  it("GET /balance/:address rejects a malformed address instead of reporting an empty balance", async () => {
    const res = await fetch(`${baseUrl}/balance/nobody`);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/address/);
  });

  it("GET /block/height/0 returns the genesis block with amounts as strings", async () => {
    const res = await fetch(`${baseUrl}/block/height/0`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.header.height).toBe(0);
    expect(body.transactions[0].outputs[0].amount).toBe("5000000000");
  });

  it("GET /block/height/:height returns 404 for a height beyond the tip", async () => {
    const res = await fetch(`${baseUrl}/block/height/99`);
    expect(res.status).toBe(404);
  });

  it("GET /block/hash/:hash returns the matching block", async () => {
    const tip = await node.getTip();
    const res = await fetch(`${baseUrl}/block/hash/${tip!.hash}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.hash).toBe(tip!.hash);
  });

  it("POST /mine mines a block and advances the chain tip", async () => {
    const res = await fetch(`${baseUrl}/mine`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.height).toBe(1);

    const tipRes = await fetch(`${baseUrl}/chain/tip`);
    const tip = await json(tipRes);
    expect(tip.height).toBe(1);
    expect(tip.hash).toBe(body.hash);
  });

  it("GET /utxos/:address lists unspent outpoints with amounts as strings", async () => {
    const res = await fetch(`${baseUrl}/utxos/${genesisAddress}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ outputIndex: 0, address: genesisAddress, amount: "5000000000", isCoinbase: true });
  });

  it("GET /mempool returns an empty array initially", async () => {
    const res = await fetch(`${baseUrl}/mempool`);
    const body = await json(res);
    expect(body).toEqual([]);
  });

  it("POST /tx accepts a valid signed transaction and it shows up in /mempool", async () => {
    const genesis = await node.getBlockByHeight(0);
    const coinbaseTxId = genesis!.transactions[0]!.id;
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const body: UnsignedTransactionBody = {
      inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
      outputs: [{ address: bobAddress, amount: 1000n }],
      timestamp: 1700000000500,
      fee: 10n,
    };
    const payload = getSigningPayload(body);
    body.inputs[0]!.signature = sign(genesisMiner.privateKey, payload);
    const tx: Transaction = { ...body, id: computeTransactionId(body) };

    const postRes = await fetch(`${baseUrl}/tx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeTransaction(tx),
    });
    expect(postRes.status).toBe(200);
    const postBody = await json(postRes);
    expect(postBody.txId).toBe(tx.id);

    const mempoolRes = await fetch(`${baseUrl}/mempool`);
    const mempoolBody = await json(mempoolRes);
    expect(mempoolBody.map((t: { id: string }) => t.id)).toContain(tx.id);
  });

  it("POST /tx rejects an invalid transaction with a 400 and reason", async () => {
    const bobAddress = deriveAddress(generateKeyPair().publicKey);
    const body: UnsignedTransactionBody = {
      inputs: [{ txId: "nonexistent", outputIndex: 0, signature: "bad", publicKey: "bad" }],
      outputs: [{ address: bobAddress, amount: 1n }],
      timestamp: 1700000000600,
      fee: 1n,
    };
    const tx: Transaction = { ...body, id: computeTransactionId(body) };

    const res = await fetch(`${baseUrl}/tx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeTransaction(tx),
    });
    expect(res.status).toBe(400);
    const respBody = await json(res);
    expect(respBody.error).toBeTruthy();
  });
});

describe("JSON-RPC 2.0 endpoint (POST /rpc)", () => {
  let dir: string;
  let node: Node;
  let server: Server;
  let baseUrl: string;
  let genesisMiner: { publicKey: string; privateKey: string };
  let genesisAddress: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-jsonrpc-test-"));
    genesisMiner = generateKeyPair();
    genesisAddress = deriveAddress(genesisMiner.publicKey);
    node = new Node({
      nodeId: "jsonrpc-test-node",
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
    const app = createRpcServer(node, TEST_RPC_OPTIONS);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await node.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function rpc(
    body: unknown,
    raw = false,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  function signedSpend(bobAddress: string, coinbaseTxId: string, amount: bigint, fee: bigint): Transaction {
    const body: UnsignedTransactionBody = {
      inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
      outputs: [{ address: bobAddress, amount }],
      timestamp: 1700000000500,
      fee,
    };
    body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
    return { ...body, id: computeTransactionId(body) };
  }

  it("getTip returns a spec-shaped success response echoing the id", async () => {
    const { status, body } = await rpc({ jsonrpc: "2.0", method: "getTip", id: 7 });
    expect(status).toBe(200);
    expect(body).toEqual({ jsonrpc: "2.0", id: 7, result: { hash: expect.any(String), height: 0 } });
  });

  it("supports positional and named params", async () => {
    const positional = await rpc({ jsonrpc: "2.0", method: "getBalance", params: [genesisAddress], id: 1 });
    const named = await rpc({ jsonrpc: "2.0", method: "getBalance", params: { address: genesisAddress }, id: 2 });
    expect(positional.body.result).toEqual({ address: genesisAddress, balance: "5000000000" });
    expect(named.body.result).toEqual({ address: genesisAddress, balance: "5000000000" });
  });

  it("getBlockByHeight / getBlockByHash return the block with bigints as strings", async () => {
    const byHeight = await rpc({ jsonrpc: "2.0", method: "getBlockByHeight", params: [0], id: 1 });
    expect(byHeight.body.result.header.height).toBe(0);
    expect(byHeight.body.result.transactions[0].outputs[0].amount).toBe("5000000000");
    const byHash = await rpc({ jsonrpc: "2.0", method: "getBlockByHash", params: [byHeight.body.result.hash], id: 2 });
    expect(byHash.body.result.hash).toBe(byHeight.body.result.hash);
  });

  it("getBlockByHeight returns a spec error for a missing block", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", method: "getBlockByHeight", params: [99], id: 1 });
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/not found/i);
  });

  it("listUnspent returns the genesis outpoint a wallet needs to build a spend", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", method: "listUnspent", params: [genesisAddress], id: 1 });
    const genesis = await node.getBlockByHeight(0);
    expect(body.result).toEqual([
      {
        txId: genesis!.transactions[0]!.id,
        outputIndex: 0,
        address: genesisAddress,
        amount: "5000000000",
        blockHeight: 0,
        isCoinbase: true,
      },
    ]);
  });

  it("sendRawTransaction accepts a valid wire-format transaction and it appears in getMempool", async () => {
    const genesis = await node.getBlockByHeight(0);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);
    const tx = signedSpend(bobAddress, genesis!.transactions[0]!.id, 1000n, 10n);

    const wire = JSON.parse(serializeTransaction(tx));
    const { body } = await rpc({ jsonrpc: "2.0", method: "sendRawTransaction", params: [wire], id: 1 });
    expect(body.result).toEqual({ txId: tx.id });

    const mempool = await rpc({ jsonrpc: "2.0", method: "getMempool", id: 2 });
    expect(mempool.body.result.map((t: { id: string }) => t.id)).toEqual([tx.id]);
  });

  it("sendRawTransaction reports a rejected transaction as an application error with the reason", async () => {
    const bobAddress = deriveAddress(generateKeyPair().publicKey);
    const tx = signedSpend(bobAddress, "0".repeat(64), 1n, 1n); // nonexistent input
    const wire = JSON.parse(serializeTransaction(tx));
    const { body } = await rpc({ jsonrpc: "2.0", method: "sendRawTransaction", params: [wire], id: 1 });
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toMatch(/not found/i);
  });

  it("sendRawTransaction with a malformed transaction object is an invalid-params error", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", method: "sendRawTransaction", params: [{ nope: true }], id: 1 });
    expect(body.error.code).toBe(-32602);
  });

  it("mine mines a block and getTip reflects it", async () => {
    const mined = await rpc({ jsonrpc: "2.0", method: "mine", id: 1 }, false, AUTH);
    expect(mined.body.result.height).toBe(1);
    const tip = await rpc({ jsonrpc: "2.0", method: "getTip", id: 2 });
    expect(tip.body.result).toEqual({ hash: mined.body.result.hash, height: 1 });
  });

  it("getInfo tells a wallet what it needs to build a spend: network, tip, maturity, min fee, reward", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "getInfo", id: 1 });
    expect(res.body.result).toEqual({
      networkId: "test-net",
      genesisHash: (await node.getBlockByHeight(0))!.hash,
      tip: { hash: expect.any(String), height: 0 },
      coinbaseMaturity: 0,
      minFee: "1",
      blockReward: "5000000000",
      peerCount: 0,
      consensusMode: "pow",
      addressIndex: { depth: 0, fromHeight: 0 },
      anchoring: null,
    });
  });

  it("listTransactions on a node without an address index answers -32005, not a silently empty list", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await node.stop();
    node = new Node({
      nodeId: "jsonrpc-test-node",
      networkId: "test-net",
      dataDir: dir,
      port: 0,
      genesis: { timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: 5000000000n, genesisAddress },
      consensus: { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, coinbaseMaturity: 0, maxFutureDriftMs: 2 * 60 * 60 * 1000 },
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress: genesisAddress,
      blockReward: 5000000000n,
      logger: { warn: () => {} },
      addressIndex: { enabled: false },
    });
    await node.start();
    const app = createRpcServer(node, TEST_RPC_OPTIONS);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;

    const res = await rpc({ jsonrpc: "2.0", method: "listTransactions", params: [genesisAddress], id: 1 });
    expect(res.body.error).toMatchObject({ code: -32005, message: expect.stringMatching(/address index/) });
    const info = await rpc({ jsonrpc: "2.0", method: "getInfo", id: 2 });
    expect(info.body.result.addressIndex).toBeNull();
  });

  it("getSupply reports circulating supply, the current reward and the schedule", async () => {
    await rpc({ jsonrpc: "2.0", method: "mine", id: 1 }, false, AUTH);
    const res = await rpc({ jsonrpc: "2.0", method: "getSupply", id: 2 });
    expect(res.body.result).toEqual({
      height: 1,
      genesisAllocation: "5000000000",
      circulating: "10000000000",
      maxSupply: null, // constant reward: unbounded
      currentReward: "5000000000",
      nextHalvingHeight: null,
      halvingInterval: 0,
      tailEmission: "0",
    });
  });

  it("getMerkleProof returns a proof for a confirmed transaction that verifies against the block's merkle root", async () => {
    await rpc({ jsonrpc: "2.0", method: "mine", id: 1 }, false, AUTH);
    const block = (await node.getBlockByHeight(1))!;
    const coinbaseId = block.transactions[0]!.id;
    const res = await rpc({ jsonrpc: "2.0", method: "getMerkleProof", params: [coinbaseId], id: 2 });
    expect(res.body.result).toEqual({
      txId: coinbaseId,
      blockHash: block.hash,
      blockHeight: 1,
      index: 0,
      siblings: [],
      merkleRoot: block.header.merkleRoot,
    });
    expect(verifyMerkleProof(coinbaseId, res.body.result.siblings, block.header.merkleRoot)).toBe(true);
  });

  it("getMerkleProof is -32001 for an unknown or still-unconfirmed transaction", async () => {
    const unknown = await rpc({ jsonrpc: "2.0", method: "getMerkleProof", params: ["f".repeat(64)], id: 1 });
    expect(unknown.body.error.code).toBe(-32001);

    const genesisCoinbaseId = (await node.getBlockByHeight(0))!.transactions[0]!.id;
    const tx = signedSpend(deriveAddress(generateKeyPair().publicKey), genesisCoinbaseId, 5n, 1n);
    await rpc({ jsonrpc: "2.0", method: "sendRawTransaction", params: [JSON.parse(serializeTransaction(tx))], id: 2 });
    const pending = await rpc({ jsonrpc: "2.0", method: "getMerkleProof", params: [tx.id], id: 3 });
    expect(pending.body.error.code).toBe(-32001);
    expect(pending.body.error.message).toMatch(/not confirmed|not found/i);
  });

  it("getAnchors finds a record sent with sendRawTransaction once it is mined, and accepts the record in upper case", async () => {
    const record = "ab".repeat(32);
    const genesisCoinbaseId = (await node.getBlockByHeight(0))!.transactions[0]!.id;
    const body: UnsignedTransactionBody = {
      inputs: [{ txId: genesisCoinbaseId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
      outputs: [{ address: genesisAddress, amount: 4999999990n }],
      timestamp: 1700000000500,
      fee: 10n,
      data: record,
    };
    body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
    const tx = { ...body, id: computeTransactionId(body) };
    const sent = await rpc({ jsonrpc: "2.0", method: "sendRawTransaction", params: [JSON.parse(serializeTransaction(tx))], id: 1 });
    expect(sent.body.result).toEqual({ txId: tx.id });
    expect((await rpc({ jsonrpc: "2.0", method: "getAnchors", params: [record], id: 2 })).body.result).toEqual([]);

    await rpc({ jsonrpc: "2.0", method: "mine", id: 3 }, false, AUTH);
    const block = (await node.getBlockByHeight(1))!;
    const expected = [{ txId: tx.id, height: 1, blockHash: block.hash, blockTimestamp: block.header.timestamp, confirmations: 1 }];
    expect((await rpc({ jsonrpc: "2.0", method: "getAnchors", params: [record], id: 4 })).body.result).toEqual(expected);
    expect((await rpc({ jsonrpc: "2.0", method: "getAnchors", params: { data: record.toUpperCase(), limit: 1 }, id: 5 })).body.result).toEqual(expected);
    // The mined block carries the record for anyone to check against the tx id.
    expect((await rpc({ jsonrpc: "2.0", method: "getBlockByHeight", params: [1], id: 6 })).body.result.transactions[1].data).toBe(record);
  });

  it("getAnchors refuses a record that could never be anchored (not hex, or over the size limit) with -32602", async () => {
    for (const data of ["not hex", "abc", "00".repeat(81), ""]) {
      const res = await rpc({ jsonrpc: "2.0", method: "getAnchors", params: [data], id: 1 });
      expect(res.body.error?.code, data).toBe(-32602);
    }
    const badLimit = await rpc({ jsonrpc: "2.0", method: "getAnchors", params: ["ab", 0], id: 2 });
    expect(badLimit.body.error.code).toBe(-32602);
  });

  it("getHeaders pages canonical headers with their hashes, and validates its params", async () => {
    await rpc({ jsonrpc: "2.0", method: "mine", id: 1 }, false, AUTH);
    await rpc({ jsonrpc: "2.0", method: "mine", id: 2 }, false, AUTH);
    const res = await rpc({ jsonrpc: "2.0", method: "getHeaders", params: { fromHeight: 1, count: 5 }, id: 3 });
    const block1 = (await node.getBlockByHeight(1))!;
    expect(res.body.result.map((h: { hash: string; header: { height: number } }) => [h.header.height, h.hash])).toEqual([
      [1, block1.hash],
      [2, (await node.getBlockByHeight(2))!.hash],
    ]);
    expect(res.body.result[0].header).toEqual(block1.header);

    const bad = await rpc({ jsonrpc: "2.0", method: "getHeaders", params: { fromHeight: 0, count: 0 }, id: 4 });
    expect(bad.body.error.code).toBe(-32602);
  });

  it("returns -32601 for an unknown method", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", method: "launchMissiles", id: 1 });
    expect(body).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: expect.stringMatching(/method/i) } });
  });

  it("returns -32600 for a request that is not JSON-RPC 2.0", async () => {
    const { body } = await rpc({ method: "getTip", id: 1 }); // missing jsonrpc
    expect(body.error.code).toBe(-32600);
    expect(body.id).toBe(1);
  });

  it("returns -32700 with a null id for unparseable JSON", async () => {
    const { status, body } = await rpc("{ this is not json", true);
    expect(status).toBe(200);
    expect(body).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.stringMatching(/parse/i) } });
  });

  it("returns -32602 for wrong params", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", method: "getBalance", params: [], id: 1 });
    expect(body.error.code).toBe(-32602);
  });

  it("handles a batch request, returning one response per call in order", async () => {
    const { body } = await rpc([
      { jsonrpc: "2.0", method: "getTip", id: "a" },
      { jsonrpc: "2.0", method: "nope", id: "b" },
      { jsonrpc: "2.0", method: "getBalance", params: ["0".repeat(64)], id: "c" },
    ]);
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({ id: "a", result: { height: 0 } });
    expect(body[1]).toMatchObject({ id: "b", error: { code: -32601 } });
    expect(body[2]).toMatchObject({ id: "c", result: { balance: "0" } });
  });

  it("sends no body for a notification (request without id)", async () => {
    const { status, body } = await rpc({ jsonrpc: "2.0", method: "getTip" });
    expect(status).toBe(204);
    expect(body).toBeUndefined();
  });

  it("mine requires a bearer token: missing or wrong token is an unauthorized error, public methods still work", async () => {
    const missing = await rpc({ jsonrpc: "2.0", method: "mine", id: 1 });
    expect(missing.status).toBe(200);
    expect(missing.body.error.code).toBe(-32004);
    expect(missing.body.error.message).toMatch(/unauthorized/i);

    const wrong = await rpc({ jsonrpc: "2.0", method: "mine", id: 2 }, false, { Authorization: "Bearer nope" });
    expect(wrong.body.error.code).toBe(-32004);

    expect((await node.getTip())?.height).toBe(0);

    const pub = await rpc({ jsonrpc: "2.0", method: "getTip", id: 3 });
    expect(pub.body.result.height).toBe(0);
  });

  it("a batch mixing public and protected methods only rejects the protected ones", async () => {
    const { body } = await rpc([
      { jsonrpc: "2.0", method: "getTip", id: "a" },
      { jsonrpc: "2.0", method: "mine", id: "b" },
    ]);
    expect(body[0]).toMatchObject({ id: "a", result: { height: 0 } });
    expect(body[1]).toMatchObject({ id: "b", error: { code: -32004 } });
  });
});

describe("RPC auth (REST) and rate limiting", () => {
  let dir: string;
  let node: Node;
  let server: Server;
  let baseUrl: string;

  async function startServer(options: Parameters<typeof createRpcServer>[1]): Promise<void> {
    const app = createRpcServer(node, options);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-rpc-limit-test-"));
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    node = new Node({
      nodeId: "limit-test-node",
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await node.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("POST /mine returns 401 without a valid bearer token and 200 with one", async () => {
    await startServer(TEST_RPC_OPTIONS);
    expect((await fetch(`${baseUrl}/mine`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/mine`, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await node.getTip())?.height).toBe(0);
    expect((await fetch(`${baseUrl}/mine`, { method: "POST", headers: AUTH })).status).toBe(200);
    expect((await node.getTip())?.height).toBe(1);
  });

  it("public REST routes need no token", async () => {
    await startServer(TEST_RPC_OPTIONS);
    expect((await fetch(`${baseUrl}/chain/tip`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/mempool`)).status).toBe(200);
  });

  it("rate-limits a client to maxRequests per window with a Retry-After, then recovers", async () => {
    await startServer({ authToken: TEST_TOKEN, rateLimit: { maxRequests: 3, windowMs: 300 } });
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${baseUrl}/chain/tip`)).status).toBe(200);
    }
    const limited = await fetch(`${baseUrl}/chain/tip`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await json(limited)).toMatchObject({ error: expect.stringMatching(/rate limit/i) });

    await new Promise((r) => setTimeout(r, 350));
    expect((await fetch(`${baseUrl}/chain/tip`)).status).toBe(200);
  });

  it("a JSON-RPC batch counts as one request per call, so batching cannot bypass the limit", async () => {
    await startServer({ authToken: TEST_TOKEN, rateLimit: { maxRequests: 3, windowMs: 60_000 } });
    const batch = Array.from({ length: 4 }, (_, i) => ({ jsonrpc: "2.0", method: "getTip", id: i }));
    const res = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(429);

    const smaller = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch.slice(0, 3)),
    });
    expect(smaller.status).toBe(200);
  });
});

describe("JSON-RPC anchorRecord (node-paid anchoring)", () => {
  const dirs: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function start(withAnchorKey: boolean): Promise<{ node: Node; call: (body: unknown, headers?: Record<string, string>) => Promise<any> }> {
    const dir = mkdtempSync(join(tmpdir(), "l1-node-anchor-rpc-test-"));
    dirs.push(dir);
    const anchorKey = generateKeyPair();
    const node = new Node({
      nodeId: "anchor-rpc",
      networkId: "test-net",
      dataDir: dir,
      port: 0,
      genesis: { timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: 5000000000n, genesisAddress: deriveAddress(anchorKey.publicKey) },
      consensus: { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, coinbaseMaturity: 0, maxFutureDriftMs: 2 * 60 * 60 * 1000 },
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress: deriveAddress(generateKeyPair().publicKey),
      blockReward: 5000000000n,
      logger: { warn: () => {} },
      anchorKey: withAnchorKey ? anchorKey : undefined,
    });
    await node.start();
    const server = await new Promise<Server>((resolve) => {
      const s = createRpcServer(node, TEST_RPC_OPTIONS).listen(0, () => resolve(s));
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await node.stop();
    });
    const port = (server.address() as { port: number }).port;
    const call = async (body: unknown, headers: Record<string, string> = {}) =>
      (await fetch(`http://localhost:${port}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })).json();
    return { node, call };
  }

  it("needs the bearer token: it spends the operator's coins", async () => {
    const { node, call } = await start(true);
    const res = await call({ jsonrpc: "2.0", method: "anchorRecord", params: ["ab".repeat(32)], id: 1 });
    expect(res.error.code).toBe(-32004);
    expect(node.getMempoolTransactions()).toEqual([]);
  });

  it("anchors a record (any hex case), then reports it pending, then confirmed with its block", async () => {
    const { node, call } = await start(true);
    const record = "AB".repeat(32);
    const first = await call({ jsonrpc: "2.0", method: "anchorRecord", params: [record], id: 1 }, AUTH);
    expect(first.result).toEqual({ status: "pending", txId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(node.getMempoolTransactions()[0]!.data).toBe(record.toLowerCase());
    const again = await call({ jsonrpc: "2.0", method: "anchorRecord", params: { data: record.toLowerCase() }, id: 2 }, AUTH);
    expect(again.result).toEqual(first.result);

    const block = await node.mineBlock();
    const done = await call({ jsonrpc: "2.0", method: "anchorRecord", params: [record], id: 3 }, AUTH);
    expect(done.result).toEqual({ status: "confirmed", txId: first.result.txId, height: 1, blockHash: block.hash, blockTimestamp: block.header.timestamp, confirmations: 1 });
  });

  it("errors: no anchor key is -32005, a bad record is -32602, no free coins is -32000 naming the address", async () => {
    const plain = await start(false);
    expect((await plain.call({ jsonrpc: "2.0", method: "anchorRecord", params: ["ab"], id: 1 }, AUTH)).error.code).toBe(-32005);
    expect((await plain.call({ jsonrpc: "2.0", method: "getInfo", id: 2 })).result.anchoring).toBeNull();

    const { call } = await start(true);
    expect((await call({ jsonrpc: "2.0", method: "anchorRecord", params: ["xyz"], id: 1 }, AUTH)).error.code).toBe(-32602);
    await call({ jsonrpc: "2.0", method: "anchorRecord", params: ["01"], id: 2 }, AUTH);
    const broke = await call({ jsonrpc: "2.0", method: "anchorRecord", params: ["02"], id: 3 }, AUTH);
    const info = await call({ jsonrpc: "2.0", method: "getInfo", id: 4 });
    expect(broke.error.code).toBe(-32000);
    expect(broke.error.message).toContain(info.result.anchoring.address);
  });
});
