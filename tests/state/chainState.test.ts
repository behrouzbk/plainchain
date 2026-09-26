import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGenesisBlock } from "../../src/ledger/block.js";
import type { Block } from "../../src/ledger/types.js";
import { ChainState } from "../../src/state/chainState.js";
import { closeStateDb, openStateDb, type StateDb } from "../../src/state/db.js";

function nextBlock(parent: Block, nonce: number): Block {
  return {
    header: {
      ...parent.header,
      previousHash: parent.hash,
      height: parent.header.height + 1,
      nonce,
      timestamp: parent.header.timestamp + 1,
    },
    transactions: [],
    hash: `hash-at-height-${parent.header.height + 1}-nonce-${nonce}`,
  };
}

describe("ChainState", () => {
  let dir: string;
  let db: StateDb;
  let chainState: ChainState;
  let genesis: Block;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-chainstate-test-"));
    db = openStateDb(dir);
    chainState = new ChainState(db.blocks, db.meta, db.undo, db.headers, db.txIndex, db.addrIndex, db.anchors);
    genesis = createGenesisBlock({
      timestamp: 1700000000000,
      difficultyTarget: "f".repeat(64),
      reward: 5000000000n,
      genesisAddress: "genesis",
    });
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no tip before any block is stored", async () => {
    expect(await chainState.getTip()).toBeUndefined();
  });

  it("stores and retrieves a block by hash", async () => {
    await chainState.putBlock(genesis);
    const retrieved = await chainState.getBlock(genesis.hash);
    expect(retrieved).toEqual(genesis);
  });

  it("returns undefined for a block hash that was never stored", async () => {
    expect(await chainState.getBlock("nonexistent")).toBeUndefined();
  });

  it("sets and retrieves the chain tip", async () => {
    await chainState.putBlock(genesis);
    await chainState.setTip(genesis.hash, genesis.header.height);

    const tip = await chainState.getTip();
    expect(tip).toEqual({ hash: genesis.hash, height: 0 });
  });

  it("indexes blocks by height for canonical-chain lookups", async () => {
    const block1 = nextBlock(genesis, 1);
    await chainState.putBlock(genesis);
    await chainState.putBlock(block1);
    await chainState.setTip(genesis.hash, 0);
    await chainState.setCanonicalHashAtHeight(0, genesis.hash);
    await chainState.setCanonicalHashAtHeight(1, block1.hash);

    expect(await chainState.getCanonicalHashAtHeight(0)).toBe(genesis.hash);
    expect(await chainState.getCanonicalHashAtHeight(1)).toBe(block1.hash);
    expect(await chainState.getCanonicalHashAtHeight(2)).toBeUndefined();
  });

  it("clears canonical height entries above a new (shorter) tip so stale forks aren't served by height", async () => {
    await chainState.setCanonicalHashAtHeight(0, genesis.hash);
    await chainState.setCanonicalHashAtHeight(1, "old-fork-1");
    await chainState.setCanonicalHashAtHeight(2, "old-fork-2");
    await chainState.setCanonicalHashAtHeight(3, "old-fork-3");

    await chainState.clearCanonicalHashesAbove(1, 3);

    expect(await chainState.getCanonicalHashAtHeight(0)).toBe(genesis.hash);
    expect(await chainState.getCanonicalHashAtHeight(1)).toBe("old-fork-1");
    expect(await chainState.getCanonicalHashAtHeight(2)).toBeUndefined();
    expect(await chainState.getCanonicalHashAtHeight(3)).toBeUndefined();
  });

  it("stores and retrieves a block's undo record with bigint amounts intact, and deletes it", async () => {
    const undo = [
      { spent: [], created: [{ txId: "cb", outputIndex: 0 }] },
      {
        spent: [{ txId: "cb", outputIndex: 0, entry: { address: "alice", amount: 123456789012345n, blockHeight: 1, isCoinbase: true } }],
        created: [{ txId: "t1", outputIndex: 0 }, { txId: "t1", outputIndex: 1 }],
      },
    ];
    await chainState.putUndo("block-hash", undo);
    expect(await chainState.getUndo("block-hash")).toEqual(undo);
    expect(typeof (await chainState.getUndo("block-hash"))![1]!.spent[0]!.entry.amount).toBe("bigint");

    await chainState.deleteUndo("block-hash");
    expect(await chainState.getUndo("block-hash")).toBeUndefined();
  });

  it("persists blocks and tip across close/reopen", async () => {
    await chainState.putBlock(genesis);
    await chainState.setTip(genesis.hash, genesis.header.height);
    await closeStateDb(db);

    const reopenedDb = openStateDb(dir);
    const reopenedChainState = new ChainState(reopenedDb.blocks, reopenedDb.meta, reopenedDb.undo, reopenedDb.headers, reopenedDb.txIndex, reopenedDb.addrIndex, reopenedDb.anchors);

    expect(await reopenedChainState.getBlock(genesis.hash)).toEqual(genesis);
    expect(await reopenedChainState.getTip()).toEqual({
      hash: genesis.hash,
      height: 0,
    });

    await closeStateDb(reopenedDb);
    db = openStateDb(dir); // hand back an open db for afterEach to close
  });

  describe("header index", () => {
    it("stores a header with its cumulative chain work and reads it back (work as bigint)", async () => {
      const work = 2n ** 70n + 12345n;
      await chainState.putHeader(genesis.hash, genesis.header, work);
      expect(await chainState.getHeader(genesis.hash)).toEqual({ header: genesis.header, work });
      expect(await chainState.getHeader("nope")).toBeUndefined();
    });

    it("exposes a batch-op variant so headers commit atomically with the rest of an adoption", async () => {
      const op = chainState.putHeaderOp(genesis.hash, genesis.header, 7n);
      await db.root.batch([op]);
      expect((await chainState.getHeader(genesis.hash))?.work).toBe(7n);
    });

    it("persists headers across close/reopen", async () => {
      await chainState.putHeader(genesis.hash, genesis.header, 99n);
      await closeStateDb(db);
      db = openStateDb(dir);
      const reopened = new ChainState(db.blocks, db.meta, db.undo, db.headers, db.txIndex, db.addrIndex, db.anchors);
      expect((await reopened.getHeader(genesis.hash))?.work).toBe(99n);
    });
  });

  describe("transaction index", () => {
    it("maps a confirmed txId to its block via batch ops, and forgets it on delete", async () => {
      await db.root.batch([chainState.putTxLocationOp("tx-1", genesis.hash)]);
      expect(await chainState.getTxLocation("tx-1")).toEqual({ blockHash: genesis.hash });
      expect(await chainState.getTxLocation("tx-2")).toBeUndefined();
      await db.root.batch([chainState.deleteTxLocationOp("tx-1")]);
      expect(await chainState.getTxLocation("tx-1")).toBeUndefined();
    });

    it("tracks whether the index has been built, so old databases get a one-time backfill", async () => {
      expect(await chainState.isTxIndexBuilt()).toBe(false);
      await chainState.markTxIndexBuilt();
      expect(await chainState.isTxIndexBuilt()).toBe(true);
    });
  });

  describe("anchor index", () => {
    const record = "ab".repeat(32);
    const entry = (height: number, txId: string) => ({ data: record, height, txId, blockHash: `block-${height}`, blockTimestamp: 1700000000000 + height });

    it("lists every confirmed anchor of a record, oldest first (the earliest is the proof of existence)", async () => {
      await db.root.batch([chainState.putAnchorOp(entry(12, "tx-b")), chainState.putAnchorOp(entry(3, "tx-a")), chainState.putAnchorOp(entry(100, "tx-c"))]);
      const anchors = await chainState.listAnchors(record, 10);
      expect(anchors.map((a) => [a.height, a.txId, a.blockHash, a.blockTimestamp])).toEqual([
        [3, "tx-a", "block-3", 1700000000003],
        [12, "tx-b", "block-12", 1700000000012],
        [100, "tx-c", "block-100", 1700000000100],
      ]);
      expect((await chainState.listAnchors(record, 2)).map((a) => a.txId)).toEqual(["tx-a", "tx-b"]);
    });

    it("forgets an anchor on delete (the disconnect path of a reorg)", async () => {
      await db.root.batch([chainState.putAnchorOp(entry(3, "tx-a"))]);
      await db.root.batch([chainState.deleteAnchorOp(record, 3, "tx-a")]);
      expect(await chainState.listAnchors(record, 10)).toEqual([]);
    });

    it("a record that is a prefix of another does not match it", async () => {
      await db.root.batch([chainState.putAnchorOp({ ...entry(1, "tx-long"), data: `${record}cd` })]);
      expect(await chainState.listAnchors(record, 10)).toEqual([]);
      expect((await chainState.listAnchors(`${record}cd`, 10)).map((a) => a.txId)).toEqual(["tx-long"]);
    });
  });
});
