import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mineBlockHeader } from "../../src/consensus/pow.js";
import { merkleRoot } from "../../src/crypto/merkle.js";
import { sha256 } from "../../src/crypto/hash.js";
import { createGenesisBlock } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";
import { loadVerifiedHeaders, saveHeaders } from "../../src/wallet/headerStore.js";
import type { ChainHeader, SpvParams } from "../../src/wallet/spv.js";

const EASY_TARGET = "f".repeat(64);
const genesis = createGenesisBlock({ timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: 5000000000n, genesisAddress: "genesis" });
const params: SpvParams = {
  genesisHash: genesis.hash,
  consensus: { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, maxFutureDriftMs: 2 * 60 * 60 * 1000 },
  now: 1700000000000 + 1000 * 10_000,
};

function chainOf(n: number): ChainHeader[] {
  const chain: ChainHeader[] = [{ hash: genesis.hash, header: genesis.header }];
  for (let h = 1; h <= n; h++) {
    const parent = chain[h - 1]!;
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot([sha256(`cb-${h}`)]),
      timestamp: parent.header.timestamp + 10_000,
      difficultyTarget: EASY_TARGET,
      nonce: 0,
      height: h,
    };
    const mined = mineBlockHeader(header);
    chain.push({ hash: mined.hash, header: mined.header });
  }
  return chain;
}

describe("header store", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-header-store-test-"));
    path = join(dir, "nested", "headers.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a verified chain, creating parent directories", () => {
    const chain = chainOf(5);
    saveHeaders(path, chain);
    expect(existsSync(path)).toBe(true);
    const loaded = loadVerifiedHeaders(path, params);
    expect(loaded.headers).toEqual(chain);
    expect(loaded.discardedReason).toBeUndefined();
  });

  it("returns an empty chain when the file does not exist", () => {
    const loaded = loadVerifiedHeaders(path, params);
    expect(loaded.headers).toEqual([]);
    expect(loaded.discardedReason).toBeUndefined();
  });

  it("attack: a tampered store is discarded rather than trusted (the file is a cache, not a root of trust)", () => {
    const chain = chainOf(5);
    saveHeaders(path, chain);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { headers: ChainHeader[] };
    // Swap the merkle root of block 3 without re-mining: the hash no longer matches.
    raw.headers[3]!.header.merkleRoot = "0".repeat(64);
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadVerifiedHeaders(path, params);
    expect(loaded.headers).toEqual([]);
    expect(loaded.discardedReason).toMatch(/height 3/);
  });

  it("discards a store for a different genesis", () => {
    const other = createGenesisBlock({ timestamp: 1, difficultyTarget: EASY_TARGET, reward: 1n, genesisAddress: "x" });
    saveHeaders(path, [{ hash: other.hash, header: other.header }]);
    const loaded = loadVerifiedHeaders(path, params);
    expect(loaded.headers).toEqual([]);
    expect(loaded.discardedReason).toMatch(/genesis/);
  });

  it("discards unparsable or wrongly shaped files", () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(loadVerifiedHeaders(path, params).discardedReason).toMatch(/parse|JSON/i);
    writeFileSync(path, JSON.stringify({ headers: "nope" }));
    expect(loadVerifiedHeaders(path, params).discardedReason).toMatch(/shape|format/i);
  });

  it("saves atomically: a crash mid-write cannot leave a truncated file behind", () => {
    const chain = chainOf(3);
    saveHeaders(path, chain);
    // The temp file used for the atomic rename must not linger.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    saveHeaders(path, chainOf(4));
    expect(loadVerifiedHeaders(path, params).headers.length).toBe(5);
  });
});
