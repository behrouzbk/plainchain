import { describe, expect, it } from "vitest";
import { computeBlockHash } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";
import { meetsTarget, mineBlockHeader } from "../../src/consensus/pow.js";

function baseHeader(difficultyTarget: string): BlockHeader {
  return {
    version: 1,
    previousHash: "0".repeat(64),
    merkleRoot: "a".repeat(64),
    timestamp: 1700000000000,
    difficultyTarget,
    nonce: 0,
    height: 1,
  };
}

describe("meetsTarget", () => {
  it("is true when the hash (as a number) is less than or equal to the target", () => {
    expect(meetsTarget("00".repeat(32), "ff".repeat(32))).toBe(true);
  });

  it("is false when the hash is greater than the target", () => {
    expect(meetsTarget("ff".repeat(32), "00".repeat(31) + "01")).toBe(false);
  });

  it("is true when the hash exactly equals the target", () => {
    const t = "5".repeat(64);
    expect(meetsTarget(t, t)).toBe(true);
  });
});

describe("mineBlockHeader", () => {
  it("finds a nonce whose resulting hash meets an easy target and matches computeBlockHash", () => {
    const header = baseHeader("f".repeat(64)); // trivially easy: any hash qualifies
    const { header: mined, hash } = mineBlockHeader(header);

    expect(meetsTarget(hash, header.difficultyTarget)).toBe(true);
    expect(hash).toBe(computeBlockHash(mined));
    expect(mined.previousHash).toBe(header.previousHash);
  });

  it("is deterministic: mining the same header twice yields the same nonce and hash", () => {
    const header = baseHeader("0" + "f".repeat(63));
    const a = mineBlockHeader(header);
    const b = mineBlockHeader(header);
    expect(a.header.nonce).toBe(b.header.nonce);
    expect(a.hash).toBe(b.hash);
  });

  it("throws when the nonce space is exhausted without meeting an impossible target", () => {
    const header = baseHeader("0".repeat(64)); // impossible: no hash is <= all-zero target
    expect(() => mineBlockHeader(header, 50)).toThrow();
  });
});
