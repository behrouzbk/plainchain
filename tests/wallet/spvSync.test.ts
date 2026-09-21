import { describe, expect, it } from "vitest";
import { mineBlockHeader } from "../../src/consensus/pow.js";
import { nextTarget, retargetWindow } from "../../src/consensus/difficulty.js";
import { merkleRoot } from "../../src/crypto/merkle.js";
import { sha256 } from "../../src/crypto/hash.js";
import { createGenesisBlock } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";
import {
  chainWork,
  extendHeaderChain,
  syncHeaders,
  type ChainHeader,
  type HeaderSource,
  type SpvParams,
} from "../../src/wallet/spv.js";

const EASY_TARGET = "f".repeat(64);
const genesis = createGenesisBlock({ timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: 5000000000n, genesisAddress: "genesis" });

const params: SpvParams = {
  genesisHash: genesis.hash,
  consensus: { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, maxFutureDriftMs: 2 * 60 * 60 * 1000 },
  now: 1700000000000 + 1000 * 10_000,
};

/** Extends `base` by `n` valid headers; `salt` makes forks differ in content. */
function extend(base: ChainHeader[], n: number, salt = ""): ChainHeader[] {
  const chain = [...base];
  for (let i = 0; i < n; i++) {
    const parent = chain[chain.length - 1]!;
    const h = parent.header.height + 1;
    let target = parent.header.difficultyTarget;
    if (h % params.consensus.difficultyRetargetInterval === 0) {
      const periodStart = chain[retargetWindow(h, params.consensus.difficultyRetargetInterval).startHeight]!;
      target = nextTarget(parent.header, periodStart.header, params.consensus);
    }
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot([sha256(`coinbase-${salt}-${h}`)]),
      timestamp: parent.header.timestamp + 10_000,
      difficultyTarget: target,
      nonce: 0,
      height: h,
    };
    const mined = mineBlockHeader(header);
    chain.push({ hash: mined.hash, header: mined.header });
  }
  return chain;
}

const GENESIS: ChainHeader[] = [{ hash: genesis.hash, header: genesis.header }];

/** A node that serves `chain` and records every getHeaders call. */
function source(chain: ChainHeader[]): HeaderSource & { calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    getHeaders: async (fromHeight, count) => {
      calls.push([fromHeight, count]);
      return chain.slice(fromHeight, fromHeight + count);
    },
  };
}

describe("extendHeaderChain", () => {
  it("validates only the new headers against an already-verified prefix, across a retarget boundary", () => {
    const full = extend(GENESIS, 15);
    const prefix = full.slice(0, 8);
    const result = extendHeaderChain(prefix, full.slice(8), params);
    expect(result.valid).toBe(true);
    expect(result.chain).toEqual(full);
    expect(result.totalWork).toBe(chainWork(full));
  });

  it("rejects additions that don't link to the prefix tip or that fail consensus", () => {
    const full = extend(GENESIS, 5);
    const other = extend(GENESIS, 5, "other");
    expect(extendHeaderChain(full.slice(0, 3), other.slice(3), params).reason).toMatch(/link|previousHash/i);
    const tampered = { ...full[4]!, hash: "0".repeat(64) };
    expect(extendHeaderChain(full.slice(0, 4), [tampered], params).reason).toMatch(/hash/i);
  });
});

describe("syncHeaders", () => {
  it("with no stored headers, downloads from genesis in pages", async () => {
    const node = source(extend(GENESIS, 25));
    const result = await syncHeaders([], node, params, 10);
    expect(result.chain.length).toBe(26);
    expect(result.fetched).toBe(26);
    expect(result.discarded).toBe(0);
    expect(node.calls).toEqual([[0, 10], [10, 10], [20, 10]]);
  });

  it("with stored headers, fetches only what's above the stored tip", async () => {
    const chain = extend(GENESIS, 30);
    const stored = chain.slice(0, 21);
    const node = source(chain);
    const result = await syncHeaders(stored, node, params, 2000);
    expect(result.chain).toEqual(chain);
    expect(result.fetched).toBe(10);
    expect(result.discarded).toBe(0);
    // One call to fetch the tail; the first returned header links to our tip, so no probing needed.
    expect(node.calls).toEqual([[21, 2000]]);
  });

  it("keeps the stored chain when the node is behind it, and when it is exactly in sync", async () => {
    const chain = extend(GENESIS, 30);
    const behind = await syncHeaders(chain, source(chain.slice(0, 20)), params);
    expect(behind.chain).toEqual(chain);
    expect(behind.fetched).toBe(0);
    const same = await syncHeaders(chain, source(chain), params);
    expect(same.chain).toEqual(chain);
    expect(same.fetched).toBe(0);
  });

  it("follows a heavier fork: discards the abandoned headers and extends from the fork point", async () => {
    const shared = extend(GENESIS, 20);
    const stored = extend(shared, 3, "a"); // our view: 23 headers
    const heavier = extend(shared, 5, "b"); // node reorged: 25 headers
    const node = source(heavier);
    const result = await syncHeaders(stored, node, params);
    expect(result.chain).toEqual(heavier);
    expect(result.discarded).toBe(3);
    expect(result.fetched).toBe(5);
    expect(result.forkHeight).toBe(20);
  });

  it("attack: refuses a fork that is not heavier than the chain already verified", async () => {
    // A node (or a man in the middle serving stale/forged headers) offers a
    // competing chain with less work. The wallet must keep its own view --
    // otherwise an attacker could 'confirm' a transaction on a cheap fork.
    const shared = extend(GENESIS, 20);
    const stored = extend(shared, 5, "a");
    const lighter = extend(shared, 3, "b");
    const result = await syncHeaders(stored, source(lighter), params);
    expect(result.chain).toEqual(stored);
    expect(result.fetched).toBe(0);
    expect(result.discarded).toBe(0);
    expect(result.rejectedFork).toMatch(/lighter|less work/i);
  });

  it("attack: rejects a node whose headers fail consensus even when they extend our tip", async () => {
    const chain = extend(GENESIS, 10);
    const bad = [...chain, { ...extend(chain, 1)[11]!, hash: "f".repeat(64) }];
    await expect(syncHeaders(chain, source(bad), params)).rejects.toThrow(/hash/i);
  });

  it("finds a deep fork point with a bounded number of probes", async () => {
    const shared = extend(GENESIS, 100);
    const stored = extend(shared, 50, "a");
    const heavier = extend(shared, 60, "b");
    const node = source(heavier);
    const result = await syncHeaders(stored, node, params, 2000);
    expect(result.forkHeight).toBe(100);
    expect(result.chain).toEqual(heavier);
    // Exponential back-off + binary search: far fewer than the 50 single-height probes a linear walk would need.
    const probes = node.calls.filter(([, count]) => count === 1).length;
    expect(probes).toBeLessThan(16);
  });

  it("rejects a node that does not share our genesis", async () => {
    const other = createGenesisBlock({ timestamp: 1, difficultyTarget: EASY_TARGET, reward: 1n, genesisAddress: "x" });
    const foreign = extend([{ hash: other.hash, header: other.header }], 3);
    await expect(syncHeaders([], source(foreign), params)).rejects.toThrow(/genesis/);
    await expect(syncHeaders(extend(GENESIS, 3), source(foreign), params)).rejects.toThrow(/genesis/);
  });
});
