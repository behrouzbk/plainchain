import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbstractSublevel } from "abstract-level";
import { Level } from "level";
import WebSocket from "ws";
import { MiningAbortedError, type BlockMiner } from "../../src/consensus/miner.js";
import { nextTarget, retargetWindow } from "../../src/consensus/difficulty.js";
import { mineBlockHeader, type MinedHeader } from "../../src/consensus/pow.js";
import { verifyHeaderChain } from "../../src/wallet/spv.js";
import { PoaEngine } from "../../src/consensus/engine.js";
import { computeBlockHash } from "../../src/ledger/block.js";
import { sha256 } from "../../src/crypto/hash.js";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { merkleRoot } from "../../src/crypto/merkle.js";
import { sign } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { computeTransactionId, getSigningPayload } from "../../src/ledger/transaction.js";
import type { Block, BlockHeader, Transaction, UnsignedTransactionBody } from "../../src/ledger/types.js";
import { AddressIndexDisabledError, Node, type NodeOptions } from "../../src/node/node.js";
import { P2PServer } from "../../src/network/p2pServer.js";
import type { Message } from "../../src/network/protocol.js";
import { serializeBlock } from "../../src/ledger/serialize.js";
import { UtxoSet } from "../../src/state/utxoSet.js";
import { closeStateDb, openStateDb } from "../../src/state/db.js";
import { verifyMerkleProof } from "../../src/crypto/merkle.js";

const EASY_TARGET = "f".repeat(64);

const REWARD = 5000000000n;
const silentLogger = { warn: () => {} };

function testGenesisConfig(genesisAddress: string, difficultyTarget = EASY_TARGET) {
  return {
    timestamp: 1700000000000,
    difficultyTarget,
    reward: REWARD,
    genesisAddress,
  };
}

function testConsensusConfig() {
  return {
    targetBlockTimeMs: 10_000,
    difficultyRetargetInterval: 10,
    maxDifficultyAdjustmentFactor: 4,
    coinbaseMaturity: 0,
    maxFutureDriftMs: 2 * 60 * 60 * 1000,
  };
}

async function makeNode(
  nodeId: string,
  dirs: string[],
  genesisAddress: string,
  overrides: {
    coinbaseMaturity?: number;
    mempoolMaxSize?: number;
    difficultyTarget?: string;
    networkId?: string;
    logger?: { warn: (message: string) => void };
    minerAddress?: string;
    network?: NodeOptions["network"];
    checkpoints?: { height: number; hash: string }[];
    /** Reuse a data dir and listen port (restart scenarios). */
    dataDir?: string;
    port?: number;
    miner?: NodeOptions["miner"];
    monetary?: NodeOptions["monetary"];
    consensus?: Partial<NodeOptions["consensus"]>;
    addressIndex?: NodeOptions["addressIndex"];
    signerKey?: NodeOptions["signerKey"];
  } = {},
): Promise<Node> {
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), `l1-node-test-${nodeId}-`));
  if (!overrides.dataDir) dirs.push(dataDir);
  const miner = generateKeyPair();
  const node = new Node({
    nodeId,
    networkId: overrides.networkId ?? "test-net",
    dataDir,
    port: overrides.port ?? 0,
    genesis: testGenesisConfig(genesisAddress, overrides.difficultyTarget),
    consensus: { ...testConsensusConfig(), coinbaseMaturity: overrides.coinbaseMaturity ?? 0, checkpoints: overrides.checkpoints, ...overrides.consensus },
    mempool: { maxSize: overrides.mempoolMaxSize ?? Infinity, minFee: 1n },
    minerAddress: overrides.minerAddress ?? deriveAddress(miner.publicKey),
    blockReward: REWARD,
    logger: overrides.logger ?? silentLogger,
    network: overrides.network,
    miner: overrides.miner,
    monetary: overrides.monetary,
    addressIndex: overrides.addressIndex,
    signerKey: overrides.signerKey,
  });
  await node.start();
  return node;
}

/** A raw transport peer that presents the same chain identity as `node`. */
async function makeInjector(node: Node): Promise<P2PServer> {
  const genesis = await node.getBlockByHeight(0);
  const injector = new P2PServer("injector", 0, () => 0, {
    networkId: "test-net",
    rulesHash: node.rulesHash,
    genesisHash: genesis!.hash,
  });
  await injector.start();
  return injector;
}

function spendGenesisTx(genesisMiner: { publicKey: string; privateKey: string }, coinbaseTxId: string, to: string): Transaction {
  const body: UnsignedTransactionBody = {
    inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
    outputs: [{ address: to, amount: 1000n }],
    timestamp: 1700000000500,
    fee: 10n,
  };
  body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
  return { ...body, id: computeTransactionId(body) };
}

describe("Node integration", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two connected nodes agree on genesis and converge after node 1 mines a block", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);

    const node1 = await makeNode("node-1", dirs, genesisAddress);
    const node2 = await makeNode("node-2", dirs, genesisAddress);
    nodes.push(node1, node2);

    const genesisTip1 = await node1.getTip();
    const genesisTip2 = await node2.getTip();
    expect(genesisTip1).toEqual(genesisTip2);

    await Promise.all([
      once(node1.p2pServer, "peer:connected"),
      node1.connectToPeer(`ws://localhost:${node2.getBoundPort()}`),
    ]);

    const minedBlock = await node1.mineBlock();

    // The miner must be able to retrieve its own just-mined block, not just
    // advance its cached tip pointer.
    const selfLookup = await node1.getBlockByHash(minedBlock.hash);
    expect(selfLookup).toEqual(minedBlock);
    const selfLookupByHeight = await node1.getBlockByHeight(1);
    expect(selfLookupByHeight).toEqual(minedBlock);

    // Wait for node2 to observe the new block via gossip.
    await vi_waitFor(async () => (await node2.getTip())?.hash === minedBlock.hash);

    const tip1 = await node1.getTip();
    const tip2 = await node2.getTip();
    expect(tip2).toEqual(tip1);
    expect(tip2?.height).toBe(1);

    const block2 = await node2.getBlockByHash(minedBlock.hash);
    expect(block2).toEqual(minedBlock);
  });

  it("a transaction submitted on node 1 propagates to node 2's mempool", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);

    const node1 = await makeNode("node-1", dirs, genesisAddress);
    const node2 = await makeNode("node-2", dirs, genesisAddress);
    nodes.push(node1, node2);

    await Promise.all([
      once(node1.p2pServer, "peer:connected"),
      node1.connectToPeer(`ws://localhost:${node2.getBoundPort()}`),
    ]);

    const genesis = await node1.getBlockByHash((await node1.getTip())!.hash);
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

    const submitResult = await node1.submitTransaction(tx);
    expect(submitResult.valid).toBe(true);

    await vi_waitFor(() => node2.getMempoolTransactions().some((t) => t.id === tx.id));
    expect(node2.getMempoolTransactions().map((t) => t.id)).toContain(tx.id);
  });

  it("a replace-by-fee bump propagates: peers drop the original and keep only the replacement", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node1 = await makeNode("node-1", dirs, genesisAddress);
    const node2 = await makeNode("node-2", dirs, genesisAddress);
    nodes.push(node1, node2);
    await Promise.all([once(node1.p2pServer, "peer:connected"), node1.connectToPeer(`ws://localhost:${node2.getBoundPort()}`)]);
    const coinbaseTxId = (await node1.getBlockByHeight(0))!.transactions[0]!.id;
    const bob = deriveAddress(generateKeyPair().publicKey);

    const pay = (amount: bigint, fee: bigint, ts: number): Transaction => {
      const body: UnsignedTransactionBody = {
        inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
        outputs: [{ address: bob, amount }],
        timestamp: ts,
        fee,
      };
      body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
      return { ...body, id: computeTransactionId(body) };
    };
    const original = pay(1000n, 10n, 1700000000500);
    const underpaid = pay(1000n, 10n, 1700000000501); // same fee: not a valid replacement
    const bump = pay(1000n, 25n, 1700000000502);

    expect((await node1.submitTransaction(original)).valid).toBe(true);
    await vi_waitFor(() => node2.getMempoolTransactions().some((t) => t.id === original.id));

    // Submitted on node 2 this time: it must be refused locally and not relayed.
    expect((await node2.submitTransaction(underpaid)).valid).toBe(false);
    const bumped = await node1.submitTransaction(bump);
    expect(bumped).toEqual({ valid: true, replaced: [original.id] });

    await vi_waitFor(() => node2.getMempoolTransactions().some((t) => t.id === bump.id));
    expect(node2.getMempoolTransactions().map((t) => t.id)).toEqual([bump.id]);
    expect(node1.getMempoolTransactions().map((t) => t.id)).toEqual([bump.id]);
    const replaced = node1.metrics.render().split("\n").find((l) => l.startsWith("l1_transactions_replaced_total "));
    expect(replaced).toBe("l1_transactions_replaced_total 1");

    // Mining takes the replacement, never the original.
    const block = await node1.mineBlock();
    expect(block.transactions.map((t) => t.id)).toContain(bump.id);
    expect(block.transactions.map((t) => t.id)).not.toContain(original.id);
  });

  it("three nodes in a full mesh all converge on the same tip after one mines a block", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);

    const node1 = await makeNode("node-1", dirs, genesisAddress);
    const node2 = await makeNode("node-2", dirs, genesisAddress);
    const node3 = await makeNode("node-3", dirs, genesisAddress);
    nodes.push(node1, node2, node3);

    await Promise.all([
      once(node1.p2pServer, "peer:connected"),
      node1.connectToPeer(`ws://localhost:${node2.getBoundPort()}`),
    ]);
    await Promise.all([
      once(node1.p2pServer, "peer:connected"),
      node1.connectToPeer(`ws://localhost:${node3.getBoundPort()}`),
    ]);
    await Promise.all([
      once(node2.p2pServer, "peer:connected"),
      node2.connectToPeer(`ws://localhost:${node3.getBoundPort()}`),
    ]);

    const minedBlock = await node1.mineBlock();

    await vi_waitFor(async () => (await node2.getTip())?.hash === minedBlock.hash);
    await vi_waitFor(async () => (await node3.getTip())?.hash === minedBlock.hash);

    const [tip1, tip2, tip3] = await Promise.all([node1.getTip(), node2.getTip(), node3.getTip()]);
    expect(tip1).toEqual(tip2);
    expect(tip2).toEqual(tip3);
  });

  it("rejects spending the genesis coinbase before it matures, then accepts it once the chain advances far enough", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node1 = await makeNode("node-1", dirs, genesisAddress, { coinbaseMaturity: 2 });
    nodes.push(node1);

    const genesis = await node1.getBlockByHeight(0);
    const coinbaseTxId = genesis!.transactions[0]!.id;
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const spendGenesis = (timestamp: number): Transaction => {
      const body: UnsignedTransactionBody = {
        inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
        outputs: [{ address: bobAddress, amount: 1000n }],
        timestamp,
        fee: 10n,
      };
      const payload = getSigningPayload(body);
      body.inputs[0]!.signature = sign(genesisMiner.privateKey, payload);
      return { ...body, id: computeTransactionId(body) };
    };

    // Tip is at height 0; this tx would be mined at height 1. Maturity
    // requires height >= 0 + 2, so it must be rejected.
    const tooEarly = await node1.submitTransaction(spendGenesis(1700000000500));
    expect(tooEarly.valid).toBe(false);
    expect(tooEarly.reason).toMatch(/matur/i);

    // Mine two empty blocks to reach tip height 2.
    await node1.mineBlock();
    await node1.mineBlock();
    expect((await node1.getTip())?.height).toBe(2);

    // Now the spend would be mined at height 3 >= 0 + 2: matured.
    const nowMature = await node1.submitTransaction(spendGenesis(1700000000600));
    expect(nowMature.valid).toBe(true);
  });

  it("wires the configured mempool maxSize through: a zero-capacity mempool rejects even a first, otherwise-valid submission", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node1 = await makeNode("node-1", dirs, genesisAddress, { mempoolMaxSize: 0 });
    nodes.push(node1);

    const genesis = await node1.getBlockByHeight(0);
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

    // If NodeOptions.mempool.maxSize weren't actually reaching the Mempool
    // constructor (e.g. silently defaulting to Infinity), this otherwise
    // perfectly valid transaction would be accepted.
    const result = await node1.submitTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/full|capacity/i);
    expect(node1.getMempoolTransactions()).toHaveLength(0);
  });
});

async function vi_waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("vi_waitFor: condition not met within timeout");
}

/** Waits for the next "message" event of a specific type, ignoring others
 *  (e.g. an interleaved GET_PEERS while waiting for a GET_BLOCKS). */
function waitForMessageOfType(
  emitter: P2PServer,
  type: Message["type"],
): Promise<{ message: Message; fromNodeId: string }> {
  return new Promise((resolve) => {
    const handler = (message: Message, fromNodeId: string) => {
      if (message.type === type) {
        emitter.off("message", handler);
        resolve({ message, fromNodeId });
      }
    };
    emitter.on("message", handler);
  });
}

describe("Node orphan-block handling", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues an out-of-order block, requests the missing ancestor, and connects both once it arrives", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);

    const node1 = await makeNode("node-1", dirs, genesisAddress);
    nodes.push(node1);
    await node1.mineBlock();
    const block1 = await node1.getBlockByHeight(1);
    await node1.mineBlock();
    const block2 = await node1.getBlockByHeight(2);
    expect(block1).toBeDefined();
    expect(block2).toBeDefined();

    const node2 = await makeNode("node-2", dirs, genesisAddress);
    nodes.push(node2);

    const injector = await makeInjector(node2);
    injectors.push(injector);
    const initialGetHeaders = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([
      once(node2.p2pServer, "peer:connected"),
      injector.connect(`ws://localhost:${node2.getBoundPort()}`),
    ]);
    // Drain the connect-time catch-up GET_HEADERS before testing the
    // orphan-specific one below (they're otherwise indistinguishable).
    await initialGetHeaders;

    const orphanGetHeaders = waitForMessageOfType(injector, "GET_HEADERS");
    // Send the CHILD block first -- node2 has no idea block1 exists yet.
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: block2! } });

    // An orphan means we're behind: ask for the peer's headers (header-first),
    // not for bodies. The locator lets the peer find a shared ancestor even
    // across a fork; at genesis it's just the genesis hash.
    const { message } = await orphanGetHeaders;
    const genesis = await node2.getBlockByHeight(0);
    expect(message).toEqual({ type: "GET_HEADERS", payload: { locator: [genesis!.hash] } });

    // It must not adopt the orphan before its ancestor arrives.
    await new Promise((r) => setTimeout(r, 150));
    expect((await node2.getTip())?.height).toBe(0);

    // Deliver the missing parent; both blocks should now connect.
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: block1! } });

    await vi_waitFor(async () => (await node2.getTip())?.hash === block2!.hash);
    expect((await node2.getTip())?.height).toBe(2);
    expect(await node2.getBlockByHeight(1)).toEqual(block1);
    expect(await node2.getBlockByHeight(2)).toEqual(block2);
  });

  it("never adopts an orphan whose parent never arrives", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);

    const node1 = await makeNode("node-1", dirs, genesisAddress);
    nodes.push(node1);
    await node1.mineBlock();
    await node1.mineBlock();
    const block2 = await node1.getBlockByHeight(2);

    const node2 = await makeNode("node-2", dirs, genesisAddress);
    nodes.push(node2);

    const injector = await makeInjector(node2);
    injectors.push(injector);
    await Promise.all([
      once(node2.p2pServer, "peer:connected"),
      injector.connect(`ws://localhost:${node2.getBoundPort()}`),
    ]);

    injector.broadcast({ type: "NEW_BLOCK", payload: { block: block2! } });
    await new Promise((r) => setTimeout(r, 300));

    expect((await node2.getTip())?.height).toBe(0);
  });
});

describe("Node peer discovery", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers and auto-connects peers-of-peers, converging a chain topology into a full mesh", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);

    const node1 = await makeNode("node-1", dirs, genesisAddress);
    const node2 = await makeNode("node-2", dirs, genesisAddress);
    const node3 = await makeNode("node-3", dirs, genesisAddress);
    nodes.push(node1, node2, node3);

    // Chain topology only: 1-2 and 2-3. node1 and node3 are never told
    // about each other directly.
    await Promise.all([
      once(node1.p2pServer, "peer:connected"),
      once(node2.p2pServer, "peer:connected"),
      node1.connectToPeer(`ws://localhost:${node2.getBoundPort()}`),
    ]);
    await Promise.all([
      once(node2.p2pServer, "peer:connected"),
      once(node3.p2pServer, "peer:connected"),
      node2.connectToPeer(`ws://localhost:${node3.getBoundPort()}`),
    ]);

    await vi_waitFor(() => node1.getConnectedPeerIds().includes("node-3"));
    await vi_waitFor(() => node3.getConnectedPeerIds().includes("node-1"));

    expect(node1.getConnectedPeerIds().sort()).toEqual(["node-2", "node-3"]);
    expect(node2.getConnectedPeerIds().sort()).toEqual(["node-1", "node-3"]);
    expect(node3.getConnectedPeerIds().sort()).toEqual(["node-1", "node-2"]);
  });
});

describe("Node reorg", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("switches from a 1-block fork to a heavier 2-block fork, unwinding the abandoned block's state", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const minerA = "miner-a";
    const minerB = "miner-b";
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: minerA });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: minerB });
    nodes.push(a, b);

    // Diverge while disconnected.
    const a1 = await a.mineBlock();
    await b.mineBlock();
    const b2 = await b.mineBlock();
    expect(await a.getBalance(minerA)).toBe(REWARD);

    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);

    // A abandoned a1: its coinbase must be gone, B's two rewards present.
    expect(await a.getBalance(minerA)).toBe(0n);
    expect(await a.listUnspent(minerA)).toEqual([]);
    expect(await a.getBalance(minerB)).toBe(REWARD * 2n);
    expect(await a.getBalance(genesisAddress)).toBe(REWARD);
    expect((await a.getBlockByHeight(1))?.hash).not.toBe(a1.hash);
    expect((await a.getBlockByHeight(2))?.hash).toBe(b2.hash);

    // B had the heavier chain and must not have moved.
    expect((await b.getTip())?.hash).toBe(b2.hash);
    expect(await b.getBalance(minerB)).toBe(REWARD * 2n);
  });

  it("returns transactions from an abandoned fork to the mempool, so they can be re-mined on the new chain", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);

    const genesis = (await a.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    expect((await a.submitTransaction(tx)).valid).toBe(true);
    const a1 = await a.mineBlock();
    expect(a1.transactions.map((t) => t.id)).toContain(tx.id);
    expect(await a.getBalance("bob")).toBe(1000n);
    expect(a.getMempoolTransactions()).toEqual([]);

    await b.mineBlock();
    const b2 = await b.mineBlock();

    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);

    // The spend was undone and is pending again.
    expect(await a.getBalance("bob")).toBe(0n);
    expect(await a.getBalance(genesisAddress)).toBe(REWARD);
    expect(a.getMempoolTransactions().map((t) => t.id)).toEqual([tx.id]);

    // Mining on the new chain includes it again.
    const a3 = await a.mineBlock();
    expect(a3.header.previousHash).toBe(b2.hash);
    expect(a3.transactions.map((t) => t.id)).toContain(tx.id);
    expect(await a.getBalance("bob")).toBe(1000n);
    await vi_waitFor(async () => (await b.getTip())?.hash === a3.hash);
    expect(await b.getBalance("bob")).toBe(1000n);
  });

  it("is incremental: a 1-deep reorg on a 6-block shared prefix touches only the fork's transactions", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);

    // Shared prefix of 6 blocks, synced to B.
    let a6: Block | undefined;
    for (let i = 0; i < 6; i++) a6 = await a.mineBlock();
    await Promise.all([once(a.p2pServer, "peer:connected"), b.connectToPeer(`ws://localhost:${a.getBoundPort()}`)]);
    await vi_waitFor(async () => (await b.getTip())?.hash === a6!.hash);

    // Sever the link so the two can diverge, then fork: A +1, B +2.
    await b.p2pServer.stop();
    await vi_waitFor(() => a.getConnectedPeerIds().length === 0);
    await a.mineBlock();
    await b.mineBlock();
    const b8 = await b.mineBlock();

    const applySpy = vi.spyOn(UtxoSet.prototype, "applyTransaction");
    try {
      await Promise.all([once(a.p2pServer, "peer:connected"), b.connectToPeer(`ws://localhost:${a.getBoundPort()}`)]);
      await vi_waitFor(async () => (await a.getTip())?.hash === b8.hash);

      // A connected exactly two blocks (one coinbase each). A full replay
      // from genesis would have re-applied all 9 blocks' transactions.
      expect(applySpy).toHaveBeenCalledTimes(2);
    } finally {
      applySpy.mockRestore();
    }
    expect(await a.getBalance("miner-a")).toBe(REWARD * 6n);
    expect(await a.getBalance("miner-b")).toBe(REWARD * 2n);
  });

  it("handles a deeper reorg (3 blocks abandoned for 4) and leaves both nodes in identical state", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);

    for (let i = 0; i < 3; i++) await a.mineBlock();
    let b4: Block | undefined;
    for (let i = 0; i < 4; i++) b4 = await b.mineBlock();

    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b4!.hash);

    for (let h = 0; h <= 4; h++) {
      expect((await a.getBlockByHeight(h))?.hash).toBe((await b.getBlockByHeight(h))?.hash);
    }
    expect(await a.getBlockByHeight(5)).toBeUndefined();
    expect(await a.getBalance("miner-a")).toBe(0n);
    expect(await a.getBalance("miner-b")).toBe(REWARD * 4n);
    expect(await a.listUnspent("miner-b")).toEqual(await b.listUnspent("miner-b"));
  });
});

describe("Node reorg atomicity", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function forgeBlock(parent: Block, transactions: Transaction[]): Block {
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot(transactions.map((t) => t.id)),
      timestamp: Math.max(Date.now(), parent.header.timestamp + 1),
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: parent.header.height + 1,
    };
    const mined = mineBlockHeader(header);
    return { header: mined.header, transactions, hash: mined.hash };
  }

  it("commits a reorg as exactly one root-level batch, with no direct writes to utxo/undo/meta", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);

    let a3: Block | undefined;
    for (let i = 0; i < 3; i++) a3 = await a.mineBlock();
    await Promise.all([once(a.p2pServer, "peer:connected"), b.connectToPeer(`ws://localhost:${a.getBoundPort()}`)]);
    await vi_waitFor(async () => (await b.getTip())?.hash === a3!.hash);
    await b.p2pServer.stop();
    await vi_waitFor(() => a.getConnectedPeerIds().length === 0);
    await a.mineBlock();
    await b.mineBlock();
    const b5 = await b.mineBlock();

    const rootBatch = vi.spyOn(Level.prototype, "batch");
    const subPut = vi.spyOn(AbstractSublevel.prototype, "put");
    const subDel = vi.spyOn(AbstractSublevel.prototype, "del");
    const subBatch = vi.spyOn(AbstractSublevel.prototype, "batch");

    await Promise.all([once(a.p2pServer, "peer:connected"), b.connectToPeer(`ws://localhost:${a.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b5.hash);

    expect(rootBatch).toHaveBeenCalledTimes(1);
    // Storing received blocks is fine outside the batch (harmless if we
    // crash), as is the peer address book (not chain state); state that
    // must move together must not be.
    const touched = [...subPut.mock.contexts, ...subDel.mock.contexts, ...subBatch.mock.contexts].map(
      (ctx) => String((ctx as { prefix?: string }).prefix),
    );
    expect(touched.filter((p) => !p.includes("blocks") && !p.includes("headers") && !p.includes("peers"))).toEqual([]);
  });

  it("leaves state untouched when the commit fails, and adopts the block on retry", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const warnings: string[] = [];
    const node = await makeNode("victim", dirs, genesisAddress, { logger: { warn: (m) => warnings.push(m) } });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;

    const block = forgeBlock(genesis, [
      { id: "", inputs: [], outputs: [{ address: "miner-x", amount: REWARD }], timestamp: Date.now(), fee: 0n },
    ].map((t) => ({ ...t, id: computeTransactionId(t) })));

    vi.spyOn(Level.prototype, "batch").mockRejectedValueOnce(new Error("disk full"));
    injector.broadcast({ type: "NEW_BLOCK", payload: { block } });
    await vi_waitFor(() => warnings.some((w) => /disk full/.test(w)));

    expect((await node.getTip())?.height).toBe(0);
    expect(await node.getBalance("miner-x")).toBe(0n);
    expect(await node.getBalance(genesisAddress)).toBe(REWARD);

    // Not marked invalid: a transient IO failure is not the block's fault.
    injector.broadcast({ type: "NEW_BLOCK", payload: { block } });
    await vi_waitFor(async () => (await node.getTip())?.hash === block.hash);
    expect(await node.getBalance("miner-x")).toBe(REWARD);
  });
});

describe("Node adversarial block handling", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function finalize(body: UnsignedTransactionBody): Transaction {
    return { ...body, id: computeTransactionId(body) };
  }

  /** Mines a structurally valid block on `parent` containing `transactions`. */
  function forgeBlock(parent: Block, transactions: Transaction[], target = EASY_TARGET): Block {
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot(transactions.map((t) => t.id)),
      timestamp: Math.max(Date.now(), parent.header.timestamp + 1),
      difficultyTarget: target,
      nonce: 0,
      height: parent.header.height + 1,
    };
    const mined = mineBlockHeader(header);
    return { header: mined.header, transactions, hash: mined.hash };
  }

  async function connectedInjector(node: Node): Promise<P2PServer> {
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;
    return injector;
  }

  it("rejects a block with an inflated coinbase and keeps its state intact", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await connectedInjector(node);

    const inflated = forgeBlock(genesis, [
      finalize({ inputs: [], outputs: [{ address: "attacker", amount: REWARD * 1000n }], timestamp: Date.now(), fee: 0n }),
    ]);
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: inflated } });
    await new Promise((r) => setTimeout(r, 300));

    expect((await node.getTip())?.height).toBe(0);
    expect(await node.getBalance("attacker")).toBe(0n);
  });

  it("rejects a block claiming an easier difficulty target than the rules dictate", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const harder = "0" + "f".repeat(63);
    const node = await makeNode("victim", dirs, genesisAddress, { difficultyTarget: harder });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await connectedInjector(node);

    const cheating = forgeBlock(
      genesis,
      [finalize({ inputs: [], outputs: [{ address: "attacker", amount: REWARD }], timestamp: Date.now(), fee: 0n })],
      EASY_TARGET, // claims f...f while the chain requires 0f...f
    );
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: cheating } });
    await new Promise((r) => setTimeout(r, 300));

    expect((await node.getTip())?.height).toBe(0);
  });

  it("rolls back cleanly when a block fails mid-replay, leaving UTXO state consistent and the node usable", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const warnings: string[] = [];
    const node = await makeNode("victim", dirs, genesisAddress, { logger: { warn: (m) => warnings.push(m) } });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await connectedInjector(node);

    // Passes every context-free check, but spends an outpoint that doesn't
    // exist -- only detectable against UTXO state during replay.
    const phantomSpend: UnsignedTransactionBody = {
      inputs: [{ txId: "0".repeat(64), outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
      outputs: [{ address: "bob", amount: 1n }],
      timestamp: Date.now(),
      fee: 1n,
    };
    phantomSpend.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(phantomSpend));
    const bad = forgeBlock(genesis, [
      finalize({ inputs: [], outputs: [{ address: "attacker", amount: REWARD + 1n }], timestamp: Date.now(), fee: 0n }),
      finalize(phantomSpend),
    ]);

    injector.broadcast({ type: "NEW_BLOCK", payload: { block: bad } });
    await new Promise((r) => setTimeout(r, 400));

    // Prove it got past context-free validation and failed during replay
    // (i.e. this test really exercises the rollback path).
    expect(warnings.some((w) => /failed state replay/.test(w))).toBe(true);

    // Tip unchanged, genesis funds intact (the UTXO set was cleared for
    // replay and must have been restored), and the node still works.
    expect((await node.getTip())?.height).toBe(0);
    expect(await node.getBalance(genesisAddress)).toBe(REWARD);
    expect(await node.getBalance("attacker")).toBe(0n);

    const mined = await node.mineBlock();
    expect((await node.getTip())?.hash).toBe(mined.hash);
    expect(await node.getBalance(genesisAddress)).toBe(REWARD);
  });

  it("survives a peer that sends garbage and keeps serving good peers", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);

    const raw = new WebSocket(`ws://localhost:${node.getBoundPort()}`);
    await once(raw, "open");
    const closed = once(raw, "close");
    raw.send("}} definitely not a message {{");
    await closed;

    // Still alive: a legitimate peer can connect and sync.
    const good = await makeNode("good", dirs, genesisAddress);
    nodes.push(good);
    await Promise.all([once(node.p2pServer, "peer:connected"), good.connectToPeer(`ws://localhost:${node.getBoundPort()}`)]);
    const mined = await node.mineBlock();
    await vi_waitFor(async () => (await good.getTip())?.hash === mined.hash);
  });

  it("refuses to peer with a node on a different network", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("net-a", dirs, genesisAddress, { networkId: "alpha" });
    const b = await makeNode("net-b", dirs, genesisAddress, { networkId: "beta" });
    nodes.push(a, b);

    const rejected = Promise.race([once(a.p2pServer, "peer:rejected"), once(b.p2pServer, "peer:rejected")]);
    await a.connectToPeer(`ws://localhost:${b.getBoundPort()}`);
    await rejected;
    await new Promise((r) => setTimeout(r, 200));

    expect(a.getConnectedPeerIds()).toEqual([]);
    expect(b.getConnectedPeerIds()).toEqual([]);
  });
});

describe("Node P2P hardening", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function finalize(body: UnsignedTransactionBody): Transaction {
    return { ...body, id: computeTransactionId(body) };
  }

  function forgeBlock(parent: Block, transactions: Transaction[], timestamp?: number): Block {
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot(transactions.map((t) => t.id)),
      timestamp: timestamp ?? Math.max(Date.now(), parent.header.timestamp + 1),
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: parent.header.height + 1,
    };
    const mined = mineBlockHeader(header);
    return { header: mined.header, transactions, hash: mined.hash };
  }

  async function connectedInjector(node: Node): Promise<P2PServer> {
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;
    return injector;
  }

  /** Collects messages from `emitter` until one of type `until` arrives (inclusive). */
  function collectUntil(emitter: P2PServer, until: Message["type"]): Promise<Message[]> {
    return new Promise((resolve) => {
      const seen: Message[] = [];
      const handler = (message: Message) => {
        seen.push(message);
        if (message.type === until) {
          emitter.off("message", handler);
          resolve(seen);
        }
      };
      emitter.on("message", handler);
    });
  }

  it("caps a GET_BLOCKS response at maxBlocksPerResponse and points at the continuation with INV_BLOCKS", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("server", dirs, genesisAddress, { network: { maxBlocksPerResponse: 5 } });
    nodes.push(node);
    for (let i = 0; i < 12; i++) await node.mineBlock();
    const injector = await connectedInjector(node);

    const reply = collectUntil(injector, "INV_BLOCKS");
    injector.broadcast({ type: "GET_BLOCKS", payload: { fromHeight: 0 } });
    const messages = await reply;

    const heights = messages.filter((m) => m.type === "NEW_BLOCK").map((m) => (m.type === "NEW_BLOCK" ? m.payload.block.header.height : -1));
    expect(heights).toEqual([1, 2, 3, 4, 5]);
    const sixth = (await node.getBlockByHeight(6))!;
    expect(messages.at(-1)).toEqual({ type: "INV_BLOCKS", payload: { hashes: [sixth.hash] } });

    // Nothing else is pushed after the cap: the requester has to ask again.
    let extra = 0;
    injector.on("message", () => extra++);
    await new Promise((r) => setTimeout(r, 200));
    expect(extra).toBe(0);
  });

  it("still fully syncs a chain longer than maxBlocksPerResponse by following INV_BLOCKS continuations", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node1 = await makeNode("node-1", dirs, genesisAddress, { network: { maxBlocksPerResponse: 5 } });
    const node2 = await makeNode("node-2", dirs, genesisAddress, { network: { maxBlocksPerResponse: 5 } });
    nodes.push(node1, node2);
    let tip1: Block | undefined;
    for (let i = 0; i < 12; i++) tip1 = await node1.mineBlock();

    await Promise.all([once(node2.p2pServer, "peer:connected"), node2.connectToPeer(`ws://localhost:${node1.getBoundPort()}`)]);
    await vi_waitFor(async () => (await node2.getTip())?.hash === tip1!.hash);
    expect((await node2.getTip())?.height).toBe(12);
  });

  it("bounds the work a huge junk locator can cause: only the first entries are looked up", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("server", dirs, genesisAddress, { network: { maxBlocksPerResponse: 2 } });
    nodes.push(node);
    for (let i = 0; i < 3; i++) await node.mineBlock();
    const injector = await connectedInjector(node);

    const chainState = (node as unknown as { chainState: { getBlock: (h: string) => Promise<unknown> } }).chainState;
    const getBlockSpy = vi.spyOn(chainState, "getBlock");
    const junk = Array.from({ length: 10_000 }, (_, i) => `deadbeef${i}`);

    const reply = collectUntil(injector, "INV_BLOCKS");
    injector.broadcast({ type: "GET_BLOCKS", payload: { fromHeight: 0, locator: junk } });
    const messages = await reply;

    // Nothing shared -> answered from genesis, still capped.
    expect(messages.filter((m) => m.type === "NEW_BLOCK").length).toBe(2);
    expect(getBlockSpy.mock.calls.length).toBeLessThan(200);
  });

  it("bans a peer that sends an invalid block, and refuses it when it reconnects", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await connectedInjector(node);

    const banned = once(node.p2pServer, "peer:banned");
    const injectorSawClose = once(injector, "peer:disconnected");
    // The node drops the peer from its list on its own socket's close
    // event, which can land after the remote observes the close.
    const nodeSawClose = once(node.p2pServer, "peer:disconnected");
    const inflated = forgeBlock(genesis, [
      finalize({ inputs: [], outputs: [{ address: "attacker", amount: REWARD * 1000n }], timestamp: Date.now(), fee: 0n }),
    ]);
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: inflated } });

    expect((await banned)[0]).toBe("injector");
    await Promise.all([injectorSawClose, nodeSawClose]);
    expect(node.getConnectedPeerIds()).toEqual([]);

    const rejected = once(node.p2pServer, "peer:rejected");
    await injector.connect(`ws://localhost:${node.getBoundPort()}`);
    expect(await rejected).toEqual(["injector", "banned"]);
  });

  it("attack: a junk block claiming a legitimate block's hash cannot poison that hash (the real block still adopts)", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const victim = await makeNode("victim", dirs, genesisAddress);
    const honest = await makeNode("honest", dirs, genesisAddress, { minerAddress: "honest-miner" });
    nodes.push(victim, honest);
    const real = await honest.mineBlock();
    const injector = await connectedInjector(victim);

    // A header that is not the preimage of the claimed hash; sent raw so the
    // injector's own encoder cannot "fix" it.
    const junk = { ...real, header: { ...real.header, nonce: real.header.nonce + 1 } };
    const dropped = once(victim.p2pServer, "peer:disconnected");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: junk } });
    await dropped; // malformed at the boundary: the sender is dropped, nothing is recorded

    await Promise.all([once(victim.p2pServer, "peer:connected"), victim.connectToPeer(`ws://localhost:${honest.getBoundPort()}`)]);
    await vi_waitFor(async () => (await victim.getTip())?.hash === real.hash);
    expect(await victim.getBalance("honest-miner")).toBe(REWARD);
  });

  it("attack: a header with a numeric-string timestamp (same hash) is refused at the boundary, so it cannot corrupt the next block template", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const victim = await makeNode("victim", dirs, genesisAddress);
    const honest = await makeNode("honest", dirs, genesisAddress);
    nodes.push(victim, honest);
    const real = await honest.mineBlock();
    const injector = await connectedInjector(victim);
    const dropped = once(victim.p2pServer, "peer:disconnected");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: { ...real, header: { ...real.header, timestamp: String(real.header.timestamp) as unknown as number } } } });
    await dropped;
    expect((await victim.getTip())?.height).toBe(0);
    const mined = await victim.mineBlock();
    expect(mined.header.timestamp).toBeLessThan(Date.now() + 60_000);
  });

  it("does not penalize a peer for a block that is merely too far in the future (clock skew is not malice)", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await connectedInjector(node);

    let bans = 0;
    node.p2pServer.on("peer:banned", () => bans++);
    const future = forgeBlock(
      genesis,
      [finalize({ inputs: [], outputs: [{ address: "miner", amount: REWARD }], timestamp: Date.now(), fee: 0n })],
      Date.now() + 3 * 60 * 60 * 1000,
    );
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: future } });
    await new Promise((r) => setTimeout(r, 300));

    expect((await node.getTip())?.height).toBe(0);
    expect(bans).toBe(0);
    expect(node.getConnectedPeerIds()).toEqual(["injector"]);
  });

  it("bans a peer that keeps relaying structurally invalid transactions", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);
    const injector = await connectedInjector(node);

    const banned = once(node.p2pServer, "peer:banned");
    for (let i = 0; i < 10; i++) {
      // Negative output amount: fails the context-free structural rules.
      const tx = finalize({
        inputs: [{ txId: "a".repeat(64), outputIndex: 0, publicKey: "9b", signature: "5169" }],
        outputs: [{ address: "attacker", amount: -1n }],
        timestamp: Date.now() + i,
        fee: 1n,
      });
      injector.broadcast({ type: "NEW_TX", payload: { transaction: tx } });
    }
    expect((await banned)[0]).toBe("injector");
  });

  it("does not penalize a peer for a transaction that is only rejected by local policy or state", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);
    const injector = await connectedInjector(node);

    let bans = 0;
    node.p2pServer.on("peer:banned", () => bans++);
    for (let i = 0; i < 10; i++) {
      // Well-formed, but spends an outpoint that doesn't exist.
      const tx = finalize({
        inputs: [{ txId: "b".repeat(64), outputIndex: i, publicKey: "9b", signature: "5169" }],
        outputs: [{ address: "someone", amount: 1n }],
        timestamp: Date.now() + i,
        fee: 1n,
      });
      injector.broadcast({ type: "NEW_TX", payload: { transaction: tx } });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(bans).toBe(0);
    expect(node.getConnectedPeerIds()).toEqual(["injector"]);
  });
});

describe("Node header-first sync", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function coinbaseTx(amount = REWARD): Transaction {
    const body = { inputs: [], outputs: [{ address: "someone", amount }], timestamp: Date.now(), fee: 0n };
    return { ...body, id: computeTransactionId(body) };
  }

  /** A valid chain of `n` blocks on `parent` (each with just a coinbase). */
  function forgeChain(parent: Block, n: number, target = EASY_TARGET): Block[] {
    const chain: Block[] = [];
    let prev = parent;
    for (let i = 0; i < n; i++) {
      const tx = coinbaseTx();
      const header: BlockHeader = {
        version: 1,
        previousHash: prev.hash,
        merkleRoot: merkleRoot([tx.id]),
        timestamp: Math.max(Date.now(), prev.header.timestamp + 1) + i,
        difficultyTarget: target,
        nonce: 0,
        height: prev.header.height + 1,
      };
      const mined = mineBlockHeader(header);
      const block: Block = { header: mined.header, transactions: [tx], hash: mined.hash };
      chain.push(block);
      prev = block;
    }
    return chain;
  }

  async function connectedInjector(node: Node): Promise<{ injector: P2PServer; firstGetHeaders: Message }> {
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    return { injector, firstGetHeaders: (await initial).message };
  }

  function messagesOfType(emitter: P2PServer, type: Message["type"]): Message[] {
    const seen: Message[] = [];
    emitter.on("message", (m: Message) => {
      if (m.type === type) seen.push(m);
    });
    return seen;
  }

  it("asks a new peer for headers (with a locator), not for block bodies", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const { injector, firstGetHeaders } = await connectedInjector(node);
    const getBlocks = messagesOfType(injector, "GET_BLOCKS");
    expect(firstGetHeaders).toEqual({ type: "GET_HEADERS", payload: { locator: [genesis.hash] } });
    await new Promise((r) => setTimeout(r, 200));
    expect(getBlocks).toEqual([]);
  });

  it("serves GET_HEADERS from the highest shared locator entry, capped at maxHeadersPerResponse", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey), { network: { maxHeadersPerResponse: 4 } });
    nodes.push(node);
    for (let i = 0; i < 6; i++) await node.mineBlock();
    const { injector } = await connectedInjector(node);
    const block2 = (await node.getBlockByHeight(2))!;

    const reply = waitForMessageOfType(injector, "HEADERS");
    injector.broadcast({ type: "GET_HEADERS", payload: { locator: [block2.hash] } });
    const { message } = await reply;
    const heights = (message as { payload: { headers: BlockHeader[] } }).payload.headers.map((h) => h.height);
    expect(heights).toEqual([3, 4, 5, 6]);
  });

  it("downloads bodies only after the peer's headers prove a heavier valid chain, then adopts them", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const chain = forgeChain(genesis, 3);
    const { injector } = await connectedInjector(node);

    const getBlocks = waitForMessageOfType(injector, "GET_BLOCKS");
    injector.broadcast({ type: "HEADERS", payload: { headers: chain.map((b) => b.header) } });
    const { message } = await getBlocks;
    expect((message as { payload: { locator?: string[] } }).payload.locator).toEqual([genesis.hash]);

    for (const block of chain) injector.broadcast({ type: "NEW_BLOCK", payload: { block } });
    await vi_waitFor(async () => (await node.getTip())?.hash === chain[2]!.hash);
  });

  it("does not download bodies for a header chain that is not heavier than ours", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    for (let i = 0; i < 5; i++) await node.mineBlock();
    const tip = (await node.getTip())!;
    const { injector } = await connectedInjector(node);
    const getBlocks = messagesOfType(injector, "GET_BLOCKS");
    let bans = 0;
    node.p2pServer.on("peer:banned", () => bans++);

    // A valid but shorter fork off genesis: not heavier, so not worth bodies.
    const fork = forgeChain(genesis, 2);
    injector.broadcast({ type: "HEADERS", payload: { headers: fork.map((b) => b.header) } });
    await new Promise((r) => setTimeout(r, 300));

    expect(getBlocks).toEqual([]);
    expect(bans).toBe(0); // valid headers are not misbehavior
    expect((await node.getTip())).toEqual(tip);
  });

  it("bans a peer whose headers fail consensus (wrong target) without downloading anything", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const { injector } = await connectedInjector(node);
    const getBlocks = messagesOfType(injector, "GET_BLOCKS");

    // Claims a harder target than the rules dictate (and would fail PoW for
    // it too): a chain that looks heavy but isn't.
    const bogus = forgeChain(genesis, 3, "0".repeat(2) + "f".repeat(62));
    const banned = once(node.p2pServer, "peer:banned");
    injector.broadcast({ type: "HEADERS", payload: { headers: bogus.map((b) => b.header) } });
    expect((await banned)[0]).toBe("injector");
    expect(getBlocks).toEqual([]);
    expect((await node.getTip())?.height).toBe(0);
  });

  it("ignores headers that don't connect to anything it knows", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey));
    nodes.push(node);
    const { injector } = await connectedInjector(node);
    const getBlocks = messagesOfType(injector, "GET_BLOCKS");
    const unknownParent: Block = { ...(await node.getBlockByHeight(0))!, hash: "9".repeat(64) };
    const dangling = forgeChain(unknownParent, 2);
    injector.broadcast({ type: "HEADERS", payload: { headers: dangling.map((b) => b.header) } });
    await new Promise((r) => setTimeout(r, 300));
    expect(getBlocks).toEqual([]);
    expect((await node.getTip())?.height).toBe(0);
  });

  it("syncs a chain longer than maxHeadersPerResponse by following header continuations", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const net = { maxHeadersPerResponse: 4, maxBlocksPerResponse: 3 };
    const node1 = await makeNode("node-1", dirs, genesisAddress, { network: net });
    const node2 = await makeNode("node-2", dirs, genesisAddress, { network: net });
    nodes.push(node1, node2);
    let tip1: Block | undefined;
    for (let i = 0; i < 11; i++) tip1 = await node1.mineBlock();

    await Promise.all([once(node2.p2pServer, "peer:connected"), node2.connectToPeer(`ws://localhost:${node1.getBoundPort()}`)]);
    await vi_waitFor(async () => (await node2.getTip())?.hash === tip1!.hash);
    expect((await node2.getTip())?.height).toBe(11);
  });

  it("syncing N blocks costs O(N) block reads, not O(N^2)", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node1 = await makeNode("node-1", dirs, genesisAddress);
    const node2 = await makeNode("node-2", dirs, genesisAddress);
    nodes.push(node1, node2);
    const N = 30;
    let tip1: Block | undefined;
    for (let i = 0; i < N; i++) tip1 = await node1.mineBlock();

    const chainState = (node2 as unknown as { chainState: { getBlock: (h: string) => Promise<unknown> } }).chainState;
    const getBlockSpy = vi.spyOn(chainState, "getBlock");
    await Promise.all([once(node2.p2pServer, "peer:connected"), node2.connectToPeer(`ws://localhost:${node1.getBoundPort()}`)]);
    await vi_waitFor(async () => (await node2.getTip())?.hash === tip1!.hash, 10_000);

    // Walking back to genesis for every block would be ~N^2/2 = 450 reads
    // here (plus the same again for the current tip's work).
    expect(getBlockSpy.mock.calls.length).toBeLessThan(10 * N);
  });
});

describe("Node checkpoints", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function forgeChain(parent: Block, n: number): Block[] {
    const chain: Block[] = [];
    let prev = parent;
    for (let i = 0; i < n; i++) {
      const body = { inputs: [], outputs: [{ address: "forger", amount: REWARD }], timestamp: Date.now() + i, fee: 0n };
      const tx: Transaction = { ...body, id: computeTransactionId(body) };
      const header: BlockHeader = {
        version: 1,
        previousHash: prev.hash,
        merkleRoot: merkleRoot([tx.id]),
        timestamp: Math.max(Date.now(), prev.header.timestamp + 1) + i,
        difficultyTarget: EASY_TARGET,
        nonce: 0,
        height: prev.header.height + 1,
      };
      const mined = mineBlockHeader(header);
      const block: Block = { header: mined.header, transactions: [tx], hash: mined.hash };
      chain.push(block);
      prev = block;
    }
    return chain;
  }

  async function connectedInjector(node: Node): Promise<P2PServer> {
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;
    return injector;
  }

  it("rejects and bans a peer whose block at a checkpointed height has a different hash", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey), {
      checkpoints: [{ height: 1, hash: "c".repeat(64) }],
    });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const [wrong] = forgeChain(genesis, 1);
    const injector = await connectedInjector(node);

    const banned = once(node.p2pServer, "peer:banned");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: wrong! } });
    const [, reason] = await banned;
    expect(reason).toMatch(/checkpoint/);
    expect((await node.getTip())?.height).toBe(0);
  });

  it("rejects a header chain that conflicts with a checkpoint before downloading any bodies", async () => {
    const node = await makeNode("n", dirs, deriveAddress(generateKeyPair().publicKey), {
      checkpoints: [{ height: 2, hash: "c".repeat(64) }],
    });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const chain = forgeChain(genesis, 3);
    const injector = await connectedInjector(node);
    let getBlocks = 0;
    injector.on("message", (m: Message) => m.type === "GET_BLOCKS" && getBlocks++);

    const banned = once(node.p2pServer, "peer:banned");
    injector.broadcast({ type: "HEADERS", payload: { headers: chain.map((b) => b.header) } });
    expect((await banned)[1]).toMatch(/checkpoint/);
    expect(getBlocks).toBe(0);
  });

  it("accepts the checkpointed chain and refuses a heavier fork that would reorg below a verified checkpoint", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const honest = await makeNode("honest", dirs, genesisAddress);
    nodes.push(honest);
    const b1 = await honest.mineBlock();
    const b2 = await honest.mineBlock();

    const node = await makeNode("n", dirs, genesisAddress, { checkpoints: [{ height: 1, hash: b1.hash }] });
    nodes.push(node);
    await Promise.all([once(node.p2pServer, "peer:connected"), node.connectToPeer(`ws://localhost:${honest.getBoundPort()}`)]);
    await vi_waitFor(async () => (await node.getTip())?.hash === b2.hash);

    // A 3-block fork from genesis: heavier than our 2 blocks, so without
    // the checkpoint it would win.
    const genesis = (await node.getBlockByHeight(0))!;
    const fork = forgeChain(genesis, 3);
    const injector = await connectedInjector(node);
    const banned = once(node.p2pServer, "peer:banned");
    for (const block of fork) injector.broadcast({ type: "NEW_BLOCK", payload: { block } });
    expect((await banned)[1]).toMatch(/checkpoint/);
    await new Promise((r) => setTimeout(r, 200));
    expect((await node.getTip())?.hash).toBe(b2.hash);
  });

  it("a checkpoint beyond the current tip does not stop a shorter valid chain from syncing", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const honest = await makeNode("honest", dirs, genesisAddress);
    nodes.push(honest);
    let tip: Block | undefined;
    for (let i = 0; i < 3; i++) tip = await honest.mineBlock();

    const node = await makeNode("n", dirs, genesisAddress, { checkpoints: [{ height: 50, hash: "c".repeat(64) }] });
    nodes.push(node);
    await Promise.all([once(node.p2pServer, "peer:connected"), node.connectToPeer(`ws://localhost:${honest.getBoundPort()}`)]);
    await vi_waitFor(async () => (await node.getTip())?.hash === tip!.hash);
  });
});

describe("Node transaction index (SPV support)", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves an inclusion proof for a mined transaction that verifies against its block header", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress);
    nodes.push(a);
    const genesis = (await a.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    expect((await a.submitTransaction(tx)).valid).toBe(true);
    const block = await a.mineBlock();

    const proof = (await a.getTransactionProof(tx.id))!;
    expect(proof).toMatchObject({ txId: tx.id, blockHash: block.hash, blockHeight: 1, index: 1 });
    expect(verifyMerkleProof(tx.id, proof.siblings, block.header.merkleRoot)).toBe(true);
    expect(await a.getTransactionProof("f".repeat(64))).toBeUndefined();
  });

  it("follows reorgs: a transaction in an abandoned block loses its proof, and regains one when re-mined", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);

    const genesis = (await a.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await a.submitTransaction(tx);
    const a1 = await a.mineBlock();
    expect((await a.getTransactionProof(tx.id))?.blockHash).toBe(a1.hash);
    expect((await a.getTransactionProof(a1.transactions[0]!.id))?.blockHash).toBe(a1.hash);

    await b.mineBlock();
    const b2 = await b.mineBlock();
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);

    // a1 was abandoned: neither its coinbase nor the payment is provable.
    expect(await a.getTransactionProof(a1.transactions[0]!.id)).toBeUndefined();
    expect(await a.getTransactionProof(tx.id)).toBeUndefined();
    expect((await a.getTransactionProof(b2.transactions[0]!.id))?.blockHash).toBe(b2.hash);

    // The payment went back to the mempool; mining it again restores a proof.
    const a3 = await a.mineBlock();
    expect(a3.transactions.map((t) => t.id)).toContain(tx.id);
    expect((await a.getTransactionProof(tx.id))?.blockHash).toBe(a3.hash);
  });

  it("backfills the index once for a database created before it existed", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress);
    const block = await a.mineBlock();
    const dataDir = dirs[dirs.length - 1]!;
    await a.stop();

    // Simulate a pre-index database: wipe the index and its "built" flag.
    const db = openStateDb(dataDir);
    await db.txIndex.clear();
    await db.meta.del("txIndexBuilt");
    await closeStateDb(db);

    const reopened = new Node({
      nodeId: "node-a",
      networkId: "test-net",
      dataDir,
      port: 0,
      genesis: testGenesisConfig(genesisAddress),
      consensus: testConsensusConfig(),
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress: genesisAddress,
      blockReward: REWARD,
      logger: silentLogger,
    });
    nodes.push(reopened);
    await reopened.start();
    expect((await reopened.getTransactionProof(block.transactions[0]!.id))?.blockHash).toBe(block.hash);
  });
});

describe("Node metrics", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Parses rendered Prometheus text into "name{labels}" -> value. */
  function samples(node: Node): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of node.metrics.render().split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const space = line.lastIndexOf(" ");
      out.set(line.slice(0, space), Number(line.slice(space + 1)));
    }
    return out;
  }

  it("tracks height, adopted blocks, mempool size and accepted/rejected transactions", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node = await makeNode("m", dirs, genesisAddress);
    nodes.push(node);
    await node.mineBlock();
    const genesis = (await node.getBlockByHeight(0))!;
    const good = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "someone");
    expect((await node.submitTransaction(good)).valid).toBe(true);
    // Same outpoint again: a conflicting spend is rejected by the mempool.
    const conflict = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "someone-else");
    expect((await node.submitTransaction(conflict)).valid).toBe(false);

    let s = samples(node);
    expect(s.get("l1_chain_height")).toBe(1);
    expect(s.get("l1_blocks_adopted_total")).toBe(1);
    expect(s.get("l1_mempool_transactions")).toBe(1);
    expect(s.get("l1_transactions_accepted_total")).toBe(1);
    expect(s.get("l1_transactions_rejected_total")).toBe(1);

    await node.mineBlock();
    s = samples(node);
    expect(s.get("l1_chain_height")).toBe(2);
    expect(s.get("l1_mempool_transactions")).toBe(0);
  });

  it("counts a reorg and the blocks it disconnected", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await makeNode("a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);
    await a.mineBlock();
    await b.mineBlock();
    const b2 = await b.mineBlock();
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);

    const s = samples(a);
    expect(s.get("l1_reorgs_total")).toBe(1);
    expect(s.get("l1_blocks_disconnected_total")).toBe(1);
    expect(s.get("l1_blocks_adopted_total")).toBe(2); // own block + the fork tip
    expect(samples(b).get("l1_reorgs_total")).toBe(0);
  });

  it("counts peers by direction, P2P messages by type, and rejected blocks", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("victim", dirs, genesisAddress);
    nodes.push(node);
    const injector = await makeInjector(node);
    injectors.push(injector);
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);

    let s = samples(node);
    expect(s.get('l1_peers_connected{direction="inbound"}')).toBe(1);
    expect(s.get('l1_peers_connected{direction="outbound"}')).toBe(0);
    // Inbound HANDSHAKE is consumed by the transport and never reaches the
    // node, so only the outbound one is visible here.
    expect(s.get('l1_p2p_messages_total{direction="out",type="HANDSHAKE"}')).toBe(1);
    // The header request is sent asynchronously after the handshake.
    await vi_waitFor(() => samples(node).get('l1_p2p_messages_total{direction="out",type="GET_HEADERS"}') === 1);

    const genesis = (await node.getBlockByHeight(0))!;
    const header: BlockHeader = {
      version: 1,
      previousHash: genesis.hash,
      merkleRoot: merkleRoot(["de".repeat(32)]),
      timestamp: Date.now(),
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: 1,
    };
    const mined = mineBlockHeader(header);
    // No coinbase at all: structurally invalid, sender gets banned.
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: { header: mined.header, transactions: [], hash: mined.hash } } });
    await vi_waitFor(() => samples(node).get("l1_blocks_rejected_total") === 1);

    s = samples(node);
    expect(s.get('l1_p2p_messages_total{direction="in",type="NEW_BLOCK"}')).toBe(1);
    expect(s.get("l1_peers_banned_total")).toBe(1);
    await vi_waitFor(() => samples(node).get('l1_peers_connected{direction="inbound"}') === 0);
  });
});

describe("Node peer maintenance (periodic re-discovery and reconnection)", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];
  /** Fast ticks so the tests finish quickly; production default is 30 s. */
  const FAST = { peerMaintenanceIntervalMs: 150, maxDialsPerTick: 2, peerDialBackoffMs: 100 };

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function metric(node: Node, name: string): number {
    const line = node.metrics.render().split("\n").find((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));
    return line ? Number(line.split(" ")[1]) : 0;
  }

  it("reconnects on its own after a peer goes away and comes back on the same address", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { network: FAST });
    let b = await makeNode("node-b", dirs, genesisAddress, { network: FAST });
    nodes.push(a, b);
    const bPort = b.getBoundPort();
    const bDir = dirs[dirs.length - 1]!;
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${bPort}`)]);
    expect(a.getConnectedPeerIds()).toEqual(["node-b"]);

    // B dies: A is alone, and nobody tells it what to do.
    await b.stop();
    nodes.splice(nodes.indexOf(b), 1);
    await vi_waitFor(() => a.getConnectedPeerIds().length === 0);

    // B comes back on the same port; A re-dials it from its address book.
    b = await makeNode("node-b", dirs, genesisAddress, { network: FAST, dataDir: bDir, port: bPort });
    nodes.push(b);
    await vi_waitFor(() => a.getConnectedPeerIds().includes("node-b"), 5000);
    expect(metric(a, 'l1_peer_dials_total{outcome="failed"}')).toBeGreaterThanOrEqual(0); // may have raced a dial while B was down
    expect(metric(a, 'l1_peer_dials_total{outcome="ok"}')).toBeGreaterThanOrEqual(2);
  });

  it("late joiner that can only dial one peer is discovered by the rest of the mesh over time", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { network: FAST });
    const b = await makeNode("node-b", dirs, genesisAddress, { network: FAST });
    nodes.push(a, b);
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);

    // D joins later and may keep only one outbound link (to B). A never
    // hears about D at connect time; only B's periodic PEERS refresh tells it.
    const d = await makeNode("node-d", dirs, genesisAddress, { network: { ...FAST, maxOutboundPeers: 1 } });
    nodes.push(d);
    await Promise.all([once(d.p2pServer, "peer:connected"), d.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);

    await vi_waitFor(() => a.getConnectedPeerIds().includes("node-d"), 5000);
    // D sees A once A's handshake lands on D's side (a moment after A saw D's).
    await vi_waitFor(() => d.getConnectedPeerIds().includes("node-a"));
    expect(d.getConnectedPeerIds().sort()).toEqual(["node-a", "node-b"]);
  });

  it("persists learned addresses: a restarted node reconnects without a --peers list", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const b = await makeNode("node-b", dirs, genesisAddress, { network: FAST });
    const c = await makeNode("node-c", dirs, genesisAddress, { network: FAST });
    nodes.push(b, c);
    await Promise.all([once(b.p2pServer, "peer:connected"), b.connectToPeer(`ws://localhost:${c.getBoundPort()}`)]);

    // A dials only B and learns C through discovery.
    let a = await makeNode("node-a", dirs, genesisAddress, { network: FAST });
    nodes.push(a);
    const aDir = dirs[dirs.length - 1]!;
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(() => a.getConnectedPeerIds().length === 2);
    await a.stop();
    nodes.splice(nodes.indexOf(a), 1);

    // Restart A from its data dir with no peers given at all.
    a = await makeNode("node-a", dirs, genesisAddress, { network: FAST, dataDir: aDir });
    nodes.push(a);
    await vi_waitFor(() => a.getConnectedPeerIds().length === 2, 5000);
    expect(a.getConnectedPeerIds().sort()).toEqual(["node-b", "node-c"]);
  });

  it("attack: a PEERS flood of bogus addresses is bounded in memory and in dials per tick", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const victim = await makeNode("victim", dirs, genesisAddress, {
      network: { ...FAST, peerMaintenanceIntervalMs: 60_000, maxAddressBookSize: 50 },
    });
    nodes.push(victim);
    const injector = await makeInjector(victim);
    injectors.push(injector);
    await Promise.all([once(victim.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${victim.getBoundPort()}`)]);

    // 5000 addresses that will never answer (RFC 5737 TEST-NET, closed ports).
    const bogus = Array.from({ length: 5000 }, (_, i) => `ws://192.0.2.${i % 250}:${10000 + i}`);
    injector.broadcast({ type: "PEERS", payload: { addresses: bogus } });
    await new Promise((r) => setTimeout(r, 500));

    expect(victim.getAddressBookSize()).toBeLessThanOrEqual(50);
    const dials = metric(victim, 'l1_peer_dials_total{outcome="ok"}') + metric(victim, 'l1_peer_dials_total{outcome="failed"}') + victim.getDialsInFlight();
    expect(dials).toBeLessThanOrEqual(FAST.maxDialsPerTick);
  });
});

describe("Node mining (worker thread)", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function metric(node: Node, name: string): number {
    const line = node.metrics.render().split("\n").find((l) => l.startsWith(name + " "));
    return line ? Number(line.split(" ")[1]) : 0;
  }

  /**
   * A miner the test drives by hand: every search is recorded and parked
   * until `release()` (or the abort signal, unless `ignoreAbort`).
   */
  function scriptedMiner(opts: { ignoreAbort?: boolean } = {}): BlockMiner & { searches: BlockHeader[]; release: () => void } {
    let pending: { header: BlockHeader; resolve: (m: MinedHeader) => void; reject: (e: Error) => void } | undefined;
    return {
      searches: [],
      release() {
        const p = pending!;
        pending = undefined;
        p.resolve(mineBlockHeader(p.header));
      },
      mine(header, signal) {
        this.searches.push(header);
        return new Promise<MinedHeader>((resolve, reject) => {
          pending = { header, resolve, reject };
          if (!opts.ignoreAbort) {
            signal?.addEventListener("abort", () => {
              pending = undefined;
              reject(new MiningAbortedError());
            });
          }
        });
      },
      async close() {},
    };
  }

  /** A structurally valid block on `parent` with one coinbase, mined synchronously. */
  function forgeOnto(parent: Block, minerAddress: string): Block {
    const cb: Transaction = (() => {
      const body = { inputs: [], outputs: [{ address: minerAddress, amount: REWARD }], timestamp: parent.header.timestamp + 1, fee: 0n };
      return { ...body, id: computeTransactionId(body) };
    })();
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot([cb.id]),
      timestamp: Math.max(Date.now(), parent.header.timestamp + 1),
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: parent.header.height + 1,
    };
    const mined = mineBlockHeader(header);
    return { header: mined.header, transactions: [cb], hash: mined.hash };
  }

  async function injectorFor(node: Node): Promise<P2PServer> {
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;
    return injector;
  }

  it("keeps serving reads and timers while a hard block is being mined", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    // ~2^18 hashes: long enough to observe, short enough for a test.
    const node = await makeNode("miner", dirs, genesisAddress, { difficultyTarget: "00003fff" + "f".repeat(56) });
    nodes.push(node);
    const mining = node.mineBlock();
    let done = false;
    void mining.then(() => (done = true));

    // Reads answer and timers fire while the search is running.
    const t0 = Date.now();
    const tip = await node.getTip();
    expect(tip?.height).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(done).toBe(false);

    const block = await mining;
    expect(block.header.height).toBe(1);
    expect((await node.getTip())?.hash).toBe(block.hash);
    expect(metric(node, 'l1_mining_attempts_total{outcome="mined"}')).toBe(1);
  }, 60_000);

  it("aborts the search when a peer's block arrives and re-mines on top of it", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const miner = scriptedMiner();
    const node = await makeNode("miner", dirs, genesisAddress, { miner });
    nodes.push(node);
    const injector = await injectorFor(node);
    const genesis = (await node.getBlockByHeight(0))!;

    const mining = node.mineBlock();
    await vi_waitFor(() => miner.searches.length === 1);
    expect(miner.searches[0]!.previousHash).toBe(genesis.hash);

    // A competing block at height 1 arrives while we search.
    const rival = forgeOnto(genesis, "rival");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: rival } });
    await vi_waitFor(() => miner.searches.length === 2);
    expect(miner.searches[1]!.previousHash).toBe(rival.hash); // re-templated on the new tip
    expect(miner.searches[1]!.height).toBe(2);

    miner.release();
    const block = await mining;
    expect(block.header.height).toBe(2);
    expect(block.header.previousHash).toBe(rival.hash);
    expect(metric(node, 'l1_mining_attempts_total{outcome="aborted"}')).toBe(1);
    expect(metric(node, 'l1_mining_attempts_total{outcome="mined"}')).toBe(1);
  });

  it("discards a solution whose parent is no longer the tip (found just as a rival block landed) and retries", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const miner = scriptedMiner({ ignoreAbort: true }); // the worker had already found a nonce
    const node = await makeNode("miner", dirs, genesisAddress, { miner });
    nodes.push(node);
    const injector = await injectorFor(node);
    const genesis = (await node.getBlockByHeight(0))!;

    const mining = node.mineBlock();
    await vi_waitFor(() => miner.searches.length === 1);
    const rival = forgeOnto(genesis, "rival");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: rival } });
    await vi_waitFor(async () => (await node.getTip())?.hash === rival.hash);

    miner.release(); // solution for a template on genesis: stale
    await vi_waitFor(() => miner.searches.length === 2);
    miner.release();
    const block = await mining;
    expect(block.header.height).toBe(2);
    expect(block.header.previousHash).toBe(rival.hash);
    // Genesis has exactly one child: our stale block was never adopted.
    expect((await node.getBlockByHeight(1))?.hash).toBe(rival.hash);
    expect(metric(node, 'l1_mining_attempts_total{outcome="stale"}')).toBe(1);
  });

  it("gives up with a clear error if the chain keeps moving under it", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const miner = scriptedMiner({ ignoreAbort: true });
    const node = await makeNode("miner", dirs, genesisAddress, { miner });
    nodes.push(node);
    const injector = await injectorFor(node);
    let tip = (await node.getBlockByHeight(0))!;

    const mining = node.mineBlock();
    const rejected = expect(mining).rejects.toThrow(/chain advanced/);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await vi_waitFor(() => miner.searches.length === attempt);
      tip = forgeOnto(tip, "rival");
      injector.broadcast({ type: "NEW_BLOCK", payload: { block: tip } });
      await vi_waitFor(async () => (await node.getTip())?.hash === tip.hash);
      miner.release();
    }
    await rejected;
  });

  it("purges mempool transactions made invalid by an adopted block (a stale RBF bump cannot poison the next template)", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node = await makeNode("miner", dirs, genesisAddress);
    nodes.push(node);
    const injector = await injectorFor(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const coinbaseTxId = genesis.transactions[0]!.id;
    const bob = deriveAddress(generateKeyPair().publicKey);
    const pay = (fee: bigint, ts: number): Transaction => {
      const body: UnsignedTransactionBody = {
        inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
        outputs: [{ address: bob, amount: 1000n }],
        timestamp: ts,
        fee,
      };
      body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
      return { ...body, id: computeTransactionId(body) };
    };
    const original = pay(10n, 1700000000500);
    const bump = pay(30n, 1700000000501);
    expect((await node.submitTransaction(original)).valid).toBe(true);
    expect((await node.submitTransaction(bump)).valid).toBe(true);
    expect(node.getMempoolTransactions().map((t) => t.id)).toEqual([bump.id]);

    // A peer mines the ORIGINAL: the bump now spends a spent outpoint.
    const rivalBlock = (() => {
      const cbBody = { inputs: [], outputs: [{ address: "rival", amount: REWARD + 10n }], timestamp: genesis.header.timestamp + 1, fee: 0n };
      const cb: Transaction = { ...cbBody, id: computeTransactionId(cbBody) };
      const header: BlockHeader = {
        version: 1,
        previousHash: genesis.hash,
        merkleRoot: merkleRoot([cb.id, original.id]),
        timestamp: Math.max(Date.now(), genesis.header.timestamp + 1),
        difficultyTarget: EASY_TARGET,
        nonce: 0,
        height: 1,
      };
      const mined = mineBlockHeader(header);
      return { header: mined.header, transactions: [cb, original], hash: mined.hash } as Block;
    })();
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: rivalBlock } });
    await vi_waitFor(async () => (await node.getTip())?.hash === rivalBlock.hash);

    expect(node.getMempoolTransactions()).toEqual([]);
    const next = await node.mineBlock();
    expect(next.header.height).toBe(2);
    expect(next.transactions).toHaveLength(1); // coinbase only
  });
});

describe("Node monetary policy", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];
  const HALVING = { initialReward: REWARD, halvingInterval: 3, tailEmission: 0n };

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function forge(parent: Block, coinbaseAmount: bigint): Block {
    const body = { inputs: [], outputs: [{ address: "rival", amount: coinbaseAmount }], timestamp: parent.header.timestamp + 1, fee: 0n };
    const cb: Transaction = { ...body, id: computeTransactionId(body) };
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot([cb.id]),
      timestamp: Math.max(Date.now(), parent.header.timestamp + 1),
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: parent.header.height + 1,
    };
    const mined = mineBlockHeader(header);
    return { header: mined.header, transactions: [cb], hash: mined.hash };
  }

  it("mines according to the schedule and reports supply", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("halving", dirs, genesisAddress, { monetary: HALVING });
    nodes.push(node);
    const rewards: bigint[] = [];
    for (let i = 0; i < 5; i++) rewards.push((await node.mineBlock()).transactions[0]!.outputs[0]!.amount);
    expect(rewards).toEqual([REWARD, REWARD, REWARD / 2n, REWARD / 2n, REWARD / 2n]);

    const supply = await node.getSupply();
    expect(supply).toEqual({
      height: 5,
      genesisAllocation: REWARD,
      circulating: REWARD + REWARD * 2n + (REWARD / 2n) * 3n,
      maxSupply: expect.any(BigInt),
      currentReward: REWARD / 4n, // the next block, height 6, opens era 2
      nextHalvingHeight: 9,
      halvingInterval: 3,
      tailEmission: 0n,
    });
    expect((await node.getInfo()).blockReward).toBe(REWARD / 4n);
  });

  it("attack: a block paying the pre-halving reward after the halving is rejected", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await makeNode("halving", dirs, genesisAddress, { monetary: HALVING });
    nodes.push(node);
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;

    let tip = (await node.getBlockByHeight(0))!;
    for (let h = 1; h <= 2; h++) {
      tip = forge(tip, REWARD);
      injector.broadcast({ type: "NEW_BLOCK", payload: { block: tip } });
      await vi_waitFor(async () => (await node.getTip())?.hash === tip.hash);
    }
    // Height 3 is the first halved block: the full reward is inflation.
    const greedy = forge(tip, REWARD);
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: greedy } });
    await vi_waitFor(() => !node.getConnectedPeerIds().includes("injector")); // an invalid block is an instant ban
    expect((await node.getTip())?.height).toBe(2);
    expect(await node.getBalance("rival")).toBe(REWARD * 2n);

    // The honest halved block, from a peer that is not banned.
    const honestPeer = new P2PServer("honest", 0, () => 0, { networkId: "test-net", genesisHash: (await node.getBlockByHeight(0))!.hash, rulesHash: node.rulesHash });
    await honestPeer.start();
    injectors.push(honestPeer);
    await Promise.all([once(node.p2pServer, "peer:connected"), honestPeer.connect(`ws://localhost:${node.getBoundPort()}`)]);
    const honest = forge(tip, REWARD / 2n);
    honestPeer.broadcast({ type: "NEW_BLOCK", payload: { block: honest } });
    await vi_waitFor(async () => (await node.getTip())?.hash === honest.hash);
    expect(await node.getBalance("rival")).toBe(REWARD * 2n + REWARD / 2n);
  });

  it("refuses to peer with a node whose emission schedule differs, even on the same network and genesis", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await makeNode("rules-a", dirs, genesisAddress, { monetary: HALVING });
    const b = await makeNode("rules-b", dirs, genesisAddress, { monetary: { ...HALVING, halvingInterval: 4 } });
    nodes.push(a, b);
    expect(a.rulesHash).not.toBe(b.rulesHash);

    const rejected = Promise.race([once(a.p2pServer, "peer:rejected"), once(b.p2pServer, "peer:rejected")]);
    await a.connectToPeer(`ws://localhost:${b.getBoundPort()}`).catch(() => undefined);
    const [, reason] = (await rejected) as [string, string];
    expect(reason).toMatch(/rules/i);
    await new Promise((r) => setTimeout(r, 200));
    expect(a.getConnectedPeerIds()).toEqual([]);
    expect(b.getConnectedPeerIds()).toEqual([]);
  });
});

describe("Node block size limits", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Funds `count` outputs to `owner` in one mined block, returns spends of them with distinct fees. */
  async function fundedSpends(node: Node, owner: { publicKey: string; privateKey: string }, count: number): Promise<Transaction[]> {
    const genesisMiner = generateKeyPair();
    const genesis = (await node.getBlockByHeight(0))!;
    const body: UnsignedTransactionBody = {
      inputs: [{ txId: genesis.transactions[0]!.id, outputIndex: 0, signature: "", publicKey: owner.publicKey }],
      outputs: Array.from({ length: count }, () => ({ address: deriveAddress(owner.publicKey), amount: 1000n })),
      timestamp: 1700000000500,
      fee: 1n,
    };
    body.inputs[0]!.signature = sign(owner.privateKey, getSigningPayload(body));
    const split: Transaction = { ...body, id: computeTransactionId(body) };
    expect((await node.submitTransaction(split)).valid).toBe(true);
    await node.mineBlock();
    return Array.from({ length: count }, (_, i) => {
      const b: UnsignedTransactionBody = {
        inputs: [{ txId: split.id, outputIndex: i, signature: "", publicKey: owner.publicKey }],
        outputs: [{ address: "someone", amount: 900n }],
        timestamp: 1700000001000 + i,
        fee: 10n + BigInt(i), // later ones pay more
      };
      b.inputs[0]!.signature = sign(owner.privateKey, getSigningPayload(b));
      return { ...b, id: computeTransactionId(b) };
    });
  }

  it("mines within maxTransactionsPerBlock, taking the highest fees, and leaves the rest pending", async () => {
    const owner = generateKeyPair();
    const node = await makeNode("limited", dirs, deriveAddress(owner.publicKey), { consensus: { maxTransactionsPerBlock: 4 } });
    nodes.push(node);
    const spends = await fundedSpends(node, owner, 6);
    for (const tx of spends) expect((await node.submitTransaction(tx)).valid).toBe(true);

    const block = await node.mineBlock();
    expect(block.transactions).toHaveLength(4); // coinbase + 3
    const fees = block.transactions.slice(1).map((t) => t.fee).sort();
    expect(fees).toEqual([13n, 14n, 15n]); // the three highest
    expect(node.getMempoolTransactions()).toHaveLength(3);
    expect((await node.mineBlock()).transactions).toHaveLength(4);
    expect(node.getMempoolTransactions()).toHaveLength(0);
  });

  it("mines within maxBlockBytes: the template is trimmed to fit and the block it produces validates", async () => {
    const owner = generateKeyPair();
    // Measured: a coinbase-only block is ~620 bytes, each spend ~500. 2200
    // bytes fits the coinbase plus three spends but not four.
    const node = await makeNode("limited", dirs, deriveAddress(owner.publicKey), { consensus: { maxBlockBytes: 2200 } });
    nodes.push(node);
    const spends = await fundedSpends(node, owner, 6);
    for (const tx of spends) expect((await node.submitTransaction(tx)).valid).toBe(true);

    const block = await node.mineBlock();
    const size = Buffer.byteLength(serializeBlock(block), "utf8");
    expect(size).toBeLessThanOrEqual(2200);
    expect(block.transactions).toHaveLength(4); // coinbase + 3 highest-fee spends
    expect(block.transactions.slice(1).map((t) => t.fee).sort()).toEqual([13n, 14n, 15n]);
    expect(node.getMempoolTransactions()).toHaveLength(3);
    expect((await node.getTip())?.hash).toBe(block.hash);
  });

  it("attack: a peer's block over the limits is rejected and the peer banned", async () => {
    const owner = generateKeyPair();
    const node = await makeNode("victim", dirs, deriveAddress(owner.publicKey), { consensus: { maxTransactionsPerBlock: 2 } });
    nodes.push(node);
    const spends = await fundedSpends(node, owner, 3);
    const tip = (await node.getBlockByHeight(1))!;
    const injector = await makeInjector(node);
    injectors.push(injector);
    const initial = waitForMessageOfType(injector, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await initial;

    const cbBody = { inputs: [], outputs: [{ address: "rival", amount: REWARD + 33n }], timestamp: tip.header.timestamp + 1, fee: 0n };
    const cb: Transaction = { ...cbBody, id: computeTransactionId(cbBody) };
    const txs = [cb, ...spends]; // 4 transactions, limit 2
    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot: merkleRoot(txs.map((t) => t.id)),
      timestamp: Math.max(Date.now(), tip.header.timestamp + 1),
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: 2,
    };
    const mined = mineBlockHeader(header);
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: { header: mined.header, transactions: txs, hash: mined.hash } } });
    await vi_waitFor(() => !node.getConnectedPeerIds().includes("injector"));
    expect((await node.getTip())?.height).toBe(1);
  });
});

describe("Node retarget rule agrees with the light client", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((s) => s.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a 35-header chain built with the shared rule across three retargets, and rejects the old off-by-one window", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const warnings: string[] = [];
    const node = await makeNode("retarget", dirs, genesisAddress, { difficultyTarget: "0fff" + "f".repeat(60), logger: { warn: (m) => warnings.push(m) } });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const rules = testConsensusConfig();

    // Varied spacing so the retargets actually move: fast, slow, on time.
    const gapForHeight = (h: number): number => (h <= 10 ? 5_000 : h <= 20 ? 20_000 : 10_000);
    const build = (offByOne: boolean): BlockHeader[] => {
      const chain: { header: BlockHeader; hash: string }[] = [{ header: genesis.header, hash: genesis.hash }];
      for (let h = 1; h <= 35; h++) {
        const parent = chain[h - 1]!;
        let target = parent.header.difficultyTarget;
        if (h % rules.difficultyRetargetInterval === 0) {
          const start = offByOne ? chain[h - rules.difficultyRetargetInterval]! : chain[retargetWindow(h, rules.difficultyRetargetInterval).startHeight]!;
          target = nextTarget(parent.header, start.header, rules);
        }
        const mined = mineBlockHeader({
          version: 1,
          previousHash: parent.hash,
          merkleRoot: merkleRoot([sha256(`cb-${h}`)]),
          timestamp: parent.header.timestamp + gapForHeight(h),
          difficultyTarget: target,
          nonce: 0,
          height: h,
        });
        chain.push({ header: mined.header, hash: mined.hash });
      }
      return chain.slice(1).map((c) => c.header);
    };

    const good = build(false);
    expect(verifyHeaderChain([{ header: genesis.header, hash: genesis.hash }, ...good.map((h) => ({ header: h, hash: computeBlockHash(h) }))], {
      genesisHash: genesis.hash,
      consensus: rules,
      now: genesis.header.timestamp + 100 * 20_000,
    }).valid).toBe(true);

    // The node validates every header of the correct chain and, finding it
    // heavier, asks for the bodies -- no rejection, no ban.
    const honest = await makeInjector(node);
    injectors.push(honest);
    const honestUp = waitForMessageOfType(honest, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), honest.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await honestUp; // both directions handshaked: the node has asked us for headers
    const wantsBodies = waitForMessageOfType(honest, "GET_BLOCKS");
    honest.broadcast({ type: "HEADERS", payload: { headers: good } });
    await wantsBodies;
    expect(warnings).toEqual([]);

    // ...and bans a peer whose chain used the old window (a different target at height 20).
    const stale = build(true);
    expect(stale[19]!.difficultyTarget).not.toBe(good[19]!.difficultyTarget);
    // A second peer needs its own nodeId: the node collapses duplicate identities.
    const legacy = new P2PServer("legacy-rules", 0, () => 0, { networkId: "test-net", genesisHash: genesis.hash, rulesHash: node.rulesHash });
    await legacy.start();
    injectors.push(legacy);
    const legacyUp = waitForMessageOfType(legacy, "GET_HEADERS");
    await Promise.all([once(node.p2pServer, "peer:connected"), legacy.connect(`ws://localhost:${node.getBoundPort()}`)]);
    await legacyUp;
    const banned = once(node.p2pServer, "peer:banned");
    legacy.broadcast({ type: "HEADERS", payload: { headers: stale } });
    const [, reason] = (await banned) as [string, string];
    expect(reason).toMatch(/difficulty target/);
  });
});

describe("Node address index (wallet history)", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records what each address received and sent per transaction, newest first", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node = await makeNode("hist", dirs, genesisAddress, { minerAddress: "miner" });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob"); // 1000 to bob, fee 10, no change
    await node.submitTransaction(tx);
    const b1 = await node.mineBlock();

    const bob = await node.getAddressHistory("bob");
    expect(bob).toEqual([{ txId: tx.id, height: 1, blockHash: b1.hash, timestamp: tx.timestamp, received: 1000n, sent: 0n }]);

    const payer = await node.getAddressHistory(genesisAddress);
    expect(payer).toEqual([
      { txId: tx.id, height: 1, blockHash: b1.hash, timestamp: tx.timestamp, received: 0n, sent: REWARD },
      { txId: genesis.transactions[0]!.id, height: 0, blockHash: genesis.hash, timestamp: genesis.transactions[0]!.timestamp, received: REWARD, sent: 0n },
    ]);

    const miner = await node.getAddressHistory("miner");
    expect(miner).toEqual([{ txId: b1.transactions[0]!.id, height: 1, blockHash: b1.hash, timestamp: b1.transactions[0]!.timestamp, received: REWARD + 10n, sent: 0n }]);

    expect(await node.getAddressHistory("nobody")).toEqual([]);
    expect((await node.getAddressHistory(genesisAddress, 1)).map((e) => e.height)).toEqual([1]); // limit keeps the newest
  });

  it("follows reorgs: history from an abandoned block disappears and returns when the payment is re-mined", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress, { minerAddress: "miner-a" });
    const b = await makeNode("node-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);
    const genesis = (await a.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await a.submitTransaction(tx);
    const a1 = await a.mineBlock();
    expect((await a.getAddressHistory("bob")).map((e) => e.blockHash)).toEqual([a1.hash]);
    expect((await a.getAddressHistory("miner-a")).length).toBe(1);

    await b.mineBlock();
    const b2 = await b.mineBlock();
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);

    expect(await a.getAddressHistory("bob")).toEqual([]);
    expect(await a.getAddressHistory("miner-a")).toEqual([]);
    expect((await a.getAddressHistory("miner-b")).map((e) => e.height).sort()).toEqual([1, 2]);

    const a3 = await a.mineBlock();
    expect((await a.getAddressHistory("bob")).map((e) => e.blockHash)).toEqual([a3.hash]);
  });

  it("backfills the index once for a database created before it existed", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress);
    const genesis = (await a.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await a.submitTransaction(tx);
    await a.mineBlock();
    const before = await a.getAddressHistory(genesisAddress);
    const dataDir = dirs[dirs.length - 1]!;
    await a.stop();

    const db = openStateDb(dataDir);
    await db.addrIndex.clear();
    await db.meta.del("addrIndexBuilt");
    await closeStateDb(db);

    const reopened = new Node({
      nodeId: "node-a",
      networkId: "test-net",
      dataDir,
      port: 0,
      genesis: testGenesisConfig(genesisAddress),
      consensus: testConsensusConfig(),
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress: genesisAddress,
      blockReward: REWARD,
      logger: silentLogger,
    });
    nodes.push(reopened);
    await reopened.start();
    expect(await reopened.getAddressHistory(genesisAddress)).toEqual(before);
    expect((await reopened.getAddressHistory("bob")).map((e) => e.received)).toEqual([1000n]);
  });
});

describe("Node address index pruning (--addrindex-depth / --no-addrindex)", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Every key in the addrindex sublevel of a stopped node's database, as [address, height]. */
  async function indexedHeights(dataDir: string): Promise<{ address: string; height: number }[]> {
    const db = openStateDb(dataDir);
    const out: { address: string; height: number }[] = [];
    for await (const key of db.addrIndex.keys()) {
      const [address, height] = key.split(":");
      out.push({ address: address!, height: Number(height) });
    }
    await closeStateDb(db);
    return out;
  }

  it("keeps only the last `depth` blocks of history: older entries are deleted as the chain grows, and getInfo says where history starts", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const node = await makeNode("prune", dirs, genesisAddress, { minerAddress: "miner", addressIndex: { depth: 3 } });
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await node.submitTransaction(tx);
    await node.mineBlock(); // height 1: bob paid
    expect((await node.getAddressHistory("bob")).map((e) => e.height)).toEqual([1]);
    expect((await node.getInfo()).addressIndex).toEqual({ depth: 3, fromHeight: 0 });

    for (let h = 2; h <= 5; h++) await node.mineBlock();
    // Window is [3, 5]: bob's height-1 payment and the genesis allocation are gone.
    expect((await node.getInfo()).addressIndex).toEqual({ depth: 3, fromHeight: 3 });
    expect(await node.getAddressHistory("bob")).toEqual([]);
    expect(await node.getAddressHistory(genesisAddress)).toEqual([]);
    expect((await node.getAddressHistory("miner")).map((e) => e.height)).toEqual([5, 4, 3]);

    // Resource bound: nothing at all below the window survives in the database.
    const dataDir = dirs[dirs.length - 1]!;
    await nodes.splice(0)[0]!.stop();
    const keys = await indexedHeights(dataDir);
    expect(keys.length).toBe(3);
    expect(keys.every((k) => k.height >= 3)).toBe(true);
  });

  it("reorg with pruning: the window follows the new tip, abandoned entries never come back, and pruned entries are not needed to disconnect", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("prune-a", dirs, genesisAddress, { minerAddress: "miner-a", addressIndex: { depth: 2 } });
    const b = await makeNode("prune-b", dirs, genesisAddress, { minerAddress: "miner-b" });
    nodes.push(a, b);
    const genesis = (await a.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await a.submitTransaction(tx);
    for (let h = 1; h <= 3; h++) await a.mineBlock(); // a: heights 1-3, bob paid at 1 (already pruned: window [2,3])
    expect(await a.getAddressHistory("bob")).toEqual([]);
    expect((await a.getAddressHistory("miner-a")).map((e) => e.height)).toEqual([3, 2]);

    let tipB: Block | undefined;
    for (let h = 1; h <= 5; h++) tipB = await b.mineBlock(); // b: a heavier chain, 5 blocks, deeper than a's window
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === tipB!.hash);

    // Disconnecting a's blocks 1-3 (1 and 2 already pruned) must not fail, and
    // the new window is b's last two blocks only.
    expect(await a.getAddressHistory("miner-a")).toEqual([]);
    expect(await a.getAddressHistory("bob")).toEqual([]);
    expect((await a.getAddressHistory("miner-b")).map((e) => e.height)).toEqual([5, 4]);
    expect((await a.getInfo()).addressIndex).toEqual({ depth: 2, fromHeight: 4 });

    // bob's payment returns to a's mempool and is re-mined at 6: visible again while inside the window.
    const a6 = await a.mineBlock();
    expect((await a.getAddressHistory("bob")).map((e) => e.blockHash)).toEqual([a6.hash]);
    expect((await a.getAddressHistory("miner-b")).map((e) => e.height)).toEqual([5]);
  });

  it("changing the depth on an existing database: tightening sweeps old entries at startup, loosening rebuilds them from the tx index", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const full = await makeNode("depth", dirs, genesisAddress, { minerAddress: "miner" });
    const dataDir = dirs[dirs.length - 1]!;
    const genesis = (await full.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await full.submitTransaction(tx);
    for (let h = 1; h <= 6; h++) await full.mineBlock();
    const fullHistory = { miner: await full.getAddressHistory("miner"), bob: await full.getAddressHistory("bob"), payer: await full.getAddressHistory(genesisAddress) };
    expect(fullHistory.miner).toHaveLength(6);
    await full.stop();

    const pruned = await makeNode("depth", dirs, genesisAddress, { dataDir, minerAddress: "miner", addressIndex: { depth: 2 } });
    expect((await pruned.getAddressHistory("miner")).map((e) => e.height)).toEqual([6, 5]);
    expect(await pruned.getAddressHistory("bob")).toEqual([]);
    await pruned.stop();
    expect((await indexedHeights(dataDir)).every((k) => k.height >= 5)).toBe(true);

    const restored = await makeNode("depth", dirs, genesisAddress, { dataDir, minerAddress: "miner" });
    nodes.push(restored);
    expect(await restored.getAddressHistory("miner")).toEqual(fullHistory.miner);
    expect(await restored.getAddressHistory("bob")).toEqual(fullHistory.bob);
    expect(await restored.getAddressHistory(genesisAddress)).toEqual(fullHistory.payer);
    expect((await restored.getInfo()).addressIndex).toEqual({ depth: 0, fromHeight: 0 });
  });

  it("--no-addrindex: no index is kept, history requests are refused with a clear error, and enabling it again rebuilds the index", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const off = await makeNode("noindex", dirs, genesisAddress, { minerAddress: "miner", addressIndex: { enabled: false } });
    const dataDir = dirs[dirs.length - 1]!;
    const genesis = (await off.getBlockByHeight(0))!;
    const tx = spendGenesisTx(genesisMiner, genesis.transactions[0]!.id, "bob");
    await off.submitTransaction(tx);
    for (let h = 1; h <= 3; h++) await off.mineBlock();
    await expect(off.getAddressHistory("bob")).rejects.toThrow(AddressIndexDisabledError);
    expect((await off.getInfo()).addressIndex).toBeNull();
    await off.stop();
    expect(await indexedHeights(dataDir)).toEqual([]);

    const on = await makeNode("noindex", dirs, genesisAddress, { dataDir, minerAddress: "miner" });
    nodes.push(on);
    expect((await on.getAddressHistory("bob")).map((e) => e.received)).toEqual([1000n]);
    expect((await on.getAddressHistory("miner")).map((e) => e.height)).toEqual([3, 2, 1]);

    // Turning it off again drops the index rather than leaving a stale one behind.
    await on.stop();
    nodes.splice(0);
    const offAgain = await makeNode("noindex", dirs, genesisAddress, { dataDir, minerAddress: "miner", addressIndex: { enabled: false } });
    await offAgain.mineBlock();
    await offAgain.stop();
    expect(await indexedHeights(dataDir)).toEqual([]);
  });
});

describe("Node proof of authority (consensus.mode = poa)", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const injectors: P2PServer[] = [];
  /** A target no real proof of work could meet in a test: proves PoA does no hash search. */
  const HARD_TARGET = "0000000000000001" + "0".repeat(48);
  const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
  const authorities = keys.map((k) => k.publicKey);
  const POA = { mode: "poa" as const, authorities };

  afterEach(async () => {
    await Promise.all(injectors.splice(0).map((i) => i.stop()));
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function authorityNode(id: string, index: number, genesisAddress: string, extra: { consensus?: Partial<NodeOptions["consensus"]> } = {}): Promise<Node> {
    const node = await makeNode(id, dirs, genesisAddress, {
      difficultyTarget: HARD_TARGET,
      minerAddress: `miner-${id}`,
      consensus: { ...POA, ...extra.consensus },
      signerKey: keys[index],
    });
    nodes.push(node);
    return node;
  }

  async function connect(from: Node, to: Node): Promise<void> {
    await Promise.all([once(from.p2pServer, "peer:connected"), from.connectToPeer(`ws://localhost:${to.getBoundPort()}`)]);
  }

  it("authorities take turns: blocks are signed, not mined; the same authority cannot sign twice in a row (n = 3); everyone converges", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await authorityNode("auth-a", 0, genesisAddress);
    const b = await authorityNode("auth-b", 1, genesisAddress);
    const c = await authorityNode("auth-c", 2, genesisAddress);
    await connect(a, b);
    await connect(b, c);

    const b1 = await a.mineBlock(); // height 1 is B's turn; A fills in out of turn (allowed)
    expect(b1.header.signer).toBe(authorities[0]);
    expect(typeof b1.header.signature).toBe("string");
    expect(BigInt(`0x${b1.hash}`) > BigInt(`0x${HARD_TARGET}`)).toBe(true); // no proof of work
    expect(b1.header.difficultyTarget).toBe(HARD_TARGET);

    await expect(a.mineBlock()).rejects.toThrow(/signed too recently/);

    await vi_waitFor(async () => (await c.getTip())?.hash === b1.hash);
    const b2 = await c.mineBlock(); // C signs 2 (its own turn: 2 mod 3 = 2)
    expect(b2.header.signer).toBe(authorities[2]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash && (await b.getTip())?.hash === b2.hash);
    expect(await a.getBalance("miner-auth-c")).toBe(REWARD);
    // A signed 1 and C signed 2: A may sign again at 3 (window of 1).
    const b3 = await a.mineBlock();
    expect(b3.header.height).toBe(3);
    await vi_waitFor(async () => (await b.getTip())?.hash === b3.hash);
  });

  it("attack: a block sealed by a key outside the authority set is rejected and the sender banned", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const node = await authorityNode("victim", 0, genesisAddress);
    const genesis = (await node.getBlockByHeight(0))!;
    const injector = await makeInjector(node);
    injectors.push(injector);
    await Promise.all([once(node.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${node.getBoundPort()}`)]);

    const outsider = generateKeyPair();
    const rogue = new PoaEngine({ authorities: [...authorities, outsider.publicKey], signerKey: outsider });
    const coinbase = { inputs: [], outputs: [{ address: "attacker", amount: REWARD }], timestamp: Date.now(), fee: 0n };
    const tx = { ...coinbase, id: computeTransactionId(coinbase) };
    const sealed = await rogue.seal({
      version: 1,
      previousHash: genesis.hash,
      merkleRoot: merkleRoot([tx.id]),
      timestamp: Math.max(Date.now(), genesis.header.timestamp + 1),
      difficultyTarget: HARD_TARGET,
      nonce: 0,
      height: 1,
    });
    const banned = once(node.p2pServer, "peer:banned");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: { header: sealed.header, transactions: [tx], hash: sealed.hash } } });
    expect((await banned)[0]).toBe("injector");
    expect((await node.getTip())?.height).toBe(0);
    expect(await node.getBalance("attacker")).toBe(0n);
  });

  it("attack: an authority's block with its body altered after signing is rejected (the signature covers the hash)", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await authorityNode("auth-a", 0, genesisAddress);
    const victim = await authorityNode("victim", 1, genesisAddress);
    const b1 = await a.mineBlock();
    const injector = await makeInjector(victim);
    injectors.push(injector);
    await Promise.all([once(victim.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${victim.getBoundPort()}`)]);

    // Keep A's signer + signature, but pay the reward elsewhere (new merkle root, new hash).
    const coinbase = { inputs: [], outputs: [{ address: "thief", amount: REWARD }], timestamp: b1.transactions[0]!.timestamp, fee: 0n };
    const tx = { ...coinbase, id: computeTransactionId(coinbase) };
    const header = { ...b1.header, merkleRoot: merkleRoot([tx.id]) };
    const banned = once(victim.p2pServer, "peer:banned");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: { header, transactions: [tx], hash: computeBlockHash(header) } } });
    expect((await banned)[0]).toBe("injector");
    expect((await victim.getTip())?.height).toBe(0);
  });

  it("attack: a copy of an authority's block with a mangled signature is a different block and cannot poison the real one", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await authorityNode("auth-a", 0, genesisAddress);
    const victim = await authorityNode("victim", 1, genesisAddress);
    const b1 = await a.mineBlock();
    const injector = await makeInjector(victim);
    injectors.push(injector);
    await Promise.all([once(victim.p2pServer, "peer:connected"), injector.connect(`ws://localhost:${victim.getBoundPort()}`)]);

    // Same header, garbage signature, hash recomputed honestly: a different block that fails its seal.
    const header = { ...b1.header, signature: "00".repeat(64) };
    const mangled = { header, transactions: b1.transactions, hash: computeBlockHash(header) };
    expect(mangled.hash).not.toBe(b1.hash); // the signature is part of the block's identity
    const banned = once(victim.p2pServer, "peer:banned");
    injector.broadcast({ type: "NEW_BLOCK", payload: { block: mangled } });
    expect((await banned)[0]).toBe("injector");

    // The authority's real block is unaffected.
    await connect(victim, a);
    await vi_waitFor(async () => (await victim.getTip())?.hash === b1.hash);
  });

  it("fork choice: the in-turn authority's block beats an out-of-turn block at the same height", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await authorityNode("auth-a", 0, genesisAddress);
    const b = await authorityNode("auth-b", 1, genesisAddress); // height 1 is B's turn
    const aBlock = await a.mineBlock();
    const bBlock = await b.mineBlock();
    expect(aBlock.hash).not.toBe(bBlock.hash);

    await connect(a, b);
    await vi_waitFor(async () => (await a.getTip())?.hash === bBlock.hash);
    await new Promise((r) => setTimeout(r, 200));
    expect((await b.getTip())?.hash).toBe(bBlock.hash); // B never switched to the lighter block
    expect(await a.getBalance("miner-auth-b")).toBe(REWARD);
    expect(await a.getBalance("miner-auth-a")).toBe(0n);
  });

  it("a node without a signer key follows the chain but cannot produce blocks; a key outside the set is refused at startup", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await authorityNode("auth-a", 0, genesisAddress);
    const follower = await makeNode("follower", dirs, genesisAddress, { difficultyTarget: HARD_TARGET, consensus: POA });
    nodes.push(follower);
    await connect(follower, a);
    const b1 = await a.mineBlock();
    await vi_waitFor(async () => (await follower.getTip())?.hash === b1.hash);
    await expect(follower.mineBlock()).rejects.toThrow(/signer key/);
    expect((await follower.getInfo()).consensusMode).toBe("poa");

    const outsider = generateKeyPair();
    await expect(makeNode("outsider", dirs, genesisAddress, { difficultyTarget: HARD_TARGET, consensus: POA, signerKey: outsider })).rejects.toThrow(/not in the authority set/);
  });

  it("refuses to peer with a proof-of-work node, and with a proof-of-authority node whose authority set differs", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const poa = await authorityNode("poa", 0, genesisAddress);
    const pow = await makeNode("pow", dirs, genesisAddress, { difficultyTarget: HARD_TARGET });
    const other = await makeNode("poa-other", dirs, genesisAddress, { difficultyTarget: HARD_TARGET, consensus: { mode: "poa", authorities: authorities.slice(0, 2) } });
    nodes.push(pow, other);
    expect(poa.rulesHash).not.toBe(pow.rulesHash);
    expect(poa.rulesHash).not.toBe(other.rulesHash);

    for (const peer of [pow, other]) {
      const rejected = Promise.race([once(poa.p2pServer, "peer:rejected"), once(peer.p2pServer, "peer:rejected")]);
      await poa.connectToPeer(`ws://localhost:${peer.getBoundPort()}`).catch(() => undefined);
      const [, reason] = (await rejected) as [string, string];
      expect(reason).toMatch(/rules/i);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(poa.getConnectedPeerIds()).toEqual([]);
  });

  it("SPV: a light client verifies a proof-of-authority header chain from the authority set it trusts, and rejects a forged signer", async () => {
    const genesisAddress = deriveAddress(generateKeyPair().publicKey);
    const a = await authorityNode("auth-a", 0, genesisAddress);
    const b = await authorityNode("auth-b", 1, genesisAddress);
    await connect(a, b);
    const b1 = await a.mineBlock();
    await vi_waitFor(async () => (await b.getTip())?.hash === b1.hash);
    const b2 = await b.mineBlock();
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);

    const chain = await a.getHeaders(0, 10);
    const genesisHash = chain[0]!.hash;
    const consensus = { ...testConsensusConfig(), ...POA };
    const verdict = verifyHeaderChain(chain, { genesisHash, consensus });
    expect(verdict).toMatchObject({ valid: true, tipHeight: 2 });
    expect(verdict.totalWork).toBe(1n + 1n + 1n); // unsigned genesis; A at height 1 and B at height 2 are both out of turn (turns: B, C)
    // A light client that does not know the authority set judges the chain as proof of work and refuses it.
    expect(verifyHeaderChain(chain, { genesisHash, consensus: testConsensusConfig() }).valid).toBe(false);
    // Forged signer: same headers, but height 1 claims another authority.
    const forged = chain.map((h, i) => (i === 1 ? { ...h, header: { ...h.header, signer: authorities[2] } } : h));
    expect(verifyHeaderChain(forged, { genesisHash, consensus }).valid).toBe(false);
    // A swapped signature with an honestly recomputed hash (the signature is part of the hash) fails the seal check;
    // the following header then fails linkage, but the first failure is what is reported.
    const swapped = { ...chain[1]!.header, signature: chain[2]!.header.signature! };
    const tamperedSignature = chain.map((h, i) => (i === 1 ? { hash: computeBlockHash(swapped), header: swapped } : h));
    expect(verifyHeaderChain(tamperedSignature, { genesisHash, consensus }).reason).toMatch(/signature/);
  });
});

describe("Node record anchoring", () => {
  const dirs: string[] = [];
  const nodes: Node[] = [];
  const record = sha256("contract v3, signed 2026-09-25");

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function anchorTx(genesisMiner: { publicKey: string; privateKey: string }, coinbaseTxId: string, data: string): Transaction {
    const body: UnsignedTransactionBody = {
      inputs: [{ txId: coinbaseTxId, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
      outputs: [{ address: deriveAddress(genesisMiner.publicKey), amount: REWARD - 10n }],
      timestamp: 1700000000500,
      fee: 10n,
      data,
    };
    body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
    return { ...body, id: computeTransactionId(body) };
  }

  it("indexes a confirmed record with its block, height, block time and confirmations; a pending one is not listed", async () => {
    const genesisMiner = generateKeyPair();
    const node = await makeNode("anchor", dirs, deriveAddress(genesisMiner.publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const tx = anchorTx(genesisMiner, genesis.transactions[0]!.id, record);
    expect(await node.submitTransaction(tx)).toMatchObject({ valid: true });
    expect(await node.getAnchors(record)).toEqual([]);

    const b1 = await node.mineBlock();
    expect(await node.getAnchors(record)).toEqual([{ txId: tx.id, height: 1, blockHash: b1.hash, blockTimestamp: b1.header.timestamp, confirmations: 1 }]);
    await node.mineBlock();
    expect((await node.getAnchors(record))[0]!.confirmations).toBe(2);
    expect(await node.getAnchors(sha256("some other document"))).toEqual([]);
    // The anchor's merkle proof is the ordinary transaction proof.
    expect((await node.getTransactionProof(tx.id))?.blockHash).toBe(b1.hash);
  });

  it("a record reaches peers intact and is indexed there too", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress);
    const b = await makeNode("node-b", dirs, genesisAddress);
    nodes.push(a, b);
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    const genesis = (await a.getBlockByHeight(0))!;
    const tx = anchorTx(genesisMiner, genesis.transactions[0]!.id, record);
    await a.submitTransaction(tx);
    await vi_waitFor(() => b.getMempoolTransactions().some((t) => t.id === tx.id));
    const a1 = await a.mineBlock();
    await vi_waitFor(async () => (await b.getTip())?.hash === a1.hash);
    expect((await b.getAnchors(record)).map((x) => x.blockHash)).toEqual([a1.hash]);
  });

  it("follows reorgs: an anchor in an abandoned block disappears and returns when re-mined", async () => {
    const genesisMiner = generateKeyPair();
    const genesisAddress = deriveAddress(genesisMiner.publicKey);
    const a = await makeNode("node-a", dirs, genesisAddress);
    const b = await makeNode("node-b", dirs, genesisAddress);
    nodes.push(a, b);
    const genesis = (await a.getBlockByHeight(0))!;
    const tx = anchorTx(genesisMiner, genesis.transactions[0]!.id, record);
    await a.submitTransaction(tx);
    const a1 = await a.mineBlock();
    expect((await a.getAnchors(record)).map((x) => x.blockHash)).toEqual([a1.hash]);

    await b.mineBlock();
    const b2 = await b.mineBlock();
    await Promise.all([once(a.p2pServer, "peer:connected"), a.connectToPeer(`ws://localhost:${b.getBoundPort()}`)]);
    await vi_waitFor(async () => (await a.getTip())?.hash === b2.hash);
    expect(await a.getAnchors(record)).toEqual([]);

    const a3 = await a.mineBlock(); // the displaced anchor went back to the mempool
    expect((await a.getAnchors(record)).map((x) => [x.blockHash, x.height])).toEqual([[a3.hash, 3]]);
  });

  it("attack: a record swapped after signing (id recomputed to match) is refused and nothing is indexed", async () => {
    const genesisMiner = generateKeyPair();
    const node = await makeNode("anchor", dirs, deriveAddress(genesisMiner.publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const honest = anchorTx(genesisMiner, genesis.transactions[0]!.id, record);
    const forgedRecord = sha256("a document the signer never saw");
    const { id: _id, ...body } = { ...honest, data: forgedRecord };
    const forged = { ...body, id: computeTransactionId(body) };
    const result = await node.submitTransaction(forged);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/);
    await node.mineBlock();
    expect(await node.getAnchors(forgedRecord)).toEqual([]);
  });

  it("attack: a record over the size limit is refused by the node", async () => {
    const genesisMiner = generateKeyPair();
    const node = await makeNode("anchor", dirs, deriveAddress(genesisMiner.publicKey));
    nodes.push(node);
    const genesis = (await node.getBlockByHeight(0))!;
    const result = await node.submitTransaction(anchorTx(genesisMiner, genesis.transactions[0]!.id, "00".repeat(81)));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/data/);
  });
});
