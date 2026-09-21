import { afterEach, describe, expect, it } from "vitest";
import { MiningAbortedError, WorkerMiner } from "../../src/consensus/miner.js";
import { meetsTarget, mineBlockHeader } from "../../src/consensus/pow.js";
import { computeBlockHash } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";

const EASY = "0fff" + "f".repeat(60); // ~1 in 16 hashes
const IMPOSSIBLE = "0".repeat(64);

function header(overrides: Partial<BlockHeader> = {}): BlockHeader {
  return {
    version: 1,
    previousHash: "a".repeat(64),
    merkleRoot: "b".repeat(64),
    timestamp: 1700000000000,
    difficultyTarget: EASY,
    nonce: 0,
    height: 1,
    ...overrides,
  };
}

describe("WorkerMiner", () => {
  let miner: WorkerMiner | undefined;
  afterEach(async () => {
    await miner?.close();
    miner = undefined;
  });

  it("finds the same nonce as the synchronous search, off the main thread", async () => {
    miner = new WorkerMiner();
    const h = header();
    const mined = await miner.mine(h);
    expect(mined).toEqual(mineBlockHeader(h));
    expect(mined.hash).toBe(computeBlockHash(mined.header));
    expect(meetsTarget(mined.hash, EASY)).toBe(true);
  });

  it("reuses one worker across searches and stays deterministic", async () => {
    miner = new WorkerMiner();
    const a = await miner.mine(header({ merkleRoot: "c".repeat(64) }));
    const b = await miner.mine(header({ merkleRoot: "d".repeat(64) }));
    expect(a).toEqual(mineBlockHeader(header({ merkleRoot: "c".repeat(64) })));
    expect(b).toEqual(mineBlockHeader(header({ merkleRoot: "d".repeat(64) })));
  });

  it("aborts a running search promptly and can search again afterwards", async () => {
    miner = new WorkerMiner();
    const abort = new AbortController();
    const started = Date.now();
    const search = miner.mine(header({ difficultyTarget: IMPOSSIBLE }), abort.signal);
    setTimeout(() => abort.abort(), 100);
    await expect(search).rejects.toBeInstanceOf(MiningAbortedError);
    expect(Date.now() - started).toBeLessThan(2000);

    const again = await miner.mine(header());
    expect(again).toEqual(mineBlockHeader(header()));
  });

  it("rejects immediately when the signal is already aborted, without touching the worker", async () => {
    miner = new WorkerMiner();
    const abort = new AbortController();
    abort.abort();
    await expect(miner.mine(header(), abort.signal)).rejects.toBeInstanceOf(MiningAbortedError);
  });

  it("refuses overlapping searches (the node serializes mining; a second call is a bug)", async () => {
    miner = new WorkerMiner();
    const abort = new AbortController();
    const first = miner.mine(header({ difficultyTarget: IMPOSSIBLE }), abort.signal);
    await expect(miner.mine(header())).rejects.toThrow(/busy/);
    abort.abort();
    await expect(first).rejects.toBeInstanceOf(MiningAbortedError);
  });

  it("does not block the event loop: a timer fires while a hard search runs", async () => {
    miner = new WorkerMiner();
    const abort = new AbortController();
    const search = miner.mine(header({ difficultyTarget: IMPOSSIBLE }), abort.signal);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    const lag = Date.now() - t0 - 50;
    expect(lag).toBeLessThan(100);
    abort.abort();
    await expect(search).rejects.toBeInstanceOf(MiningAbortedError);
  });

  it("close() while searching rejects the pending search", async () => {
    miner = new WorkerMiner();
    const search = miner.mine(header({ difficultyTarget: IMPOSSIBLE }));
    const rejected = expect(search).rejects.toBeInstanceOf(MiningAbortedError);
    await miner.close();
    await rejected;
    miner = undefined;
  });
});
