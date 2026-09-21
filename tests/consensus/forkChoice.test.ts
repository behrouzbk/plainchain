import { describe, expect, it } from "vitest";
import {
  computeChainWork,
  isBetterChain,
  workForTarget,
} from "../../src/consensus/forkChoice.js";
import type { BlockHeader } from "../../src/ledger/types.js";

function header(difficultyTarget: string, height: number): BlockHeader {
  return {
    version: 1,
    previousHash: "0".repeat(64),
    merkleRoot: "a".repeat(64),
    timestamp: 1700000000000,
    difficultyTarget,
    nonce: 0,
    height,
  };
}

describe("workForTarget", () => {
  it("assigns more work to a lower (harder) target", () => {
    const easy = workForTarget("f".repeat(64));
    const hard = workForTarget("0".repeat(4) + "f".repeat(60));
    expect(hard).toBeGreaterThan(easy);
  });

  it("is always positive", () => {
    expect(workForTarget("f".repeat(64))).toBeGreaterThan(0n);
  });
});

describe("computeChainWork", () => {
  it("sums work across all headers in the chain", () => {
    const h1 = header("f".repeat(64), 1);
    const h2 = header("f".repeat(64), 2);
    const total = computeChainWork([h1, h2]);
    expect(total).toBe(workForTarget(h1.difficultyTarget) + workForTarget(h2.difficultyTarget));
  });

  it("is zero for an empty chain", () => {
    expect(computeChainWork([])).toBe(0n);
  });

  it("a longer chain of easy blocks can have LESS work than a shorter chain of hard blocks", () => {
    const easyChain = [header("f".repeat(64), 1), header("f".repeat(64), 2), header("f".repeat(64), 3)];
    const hardChain = [header("0".repeat(8) + "f".repeat(56), 1)];

    expect(computeChainWork(hardChain)).toBeGreaterThan(computeChainWork(easyChain));
  });
});

describe("isBetterChain", () => {
  it("favors strictly more cumulative work", () => {
    expect(isBetterChain(100n, 50n)).toBe(true);
    expect(isBetterChain(50n, 100n)).toBe(false);
  });

  it("does not favor equal work (no-op, not a reorg)", () => {
    expect(isBetterChain(100n, 100n)).toBe(false);
  });
});
