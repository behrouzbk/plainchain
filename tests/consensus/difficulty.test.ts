import { describe, expect, it } from "vitest";
import { nextTarget, retargetDifficulty, retargetWindow } from "../../src/consensus/difficulty.js";
import type { BlockHeader } from "../../src/ledger/types.js";

const TARGET_TIMESPAN_MS = 100_000; // 10 blocks * 10s target block time

describe("retargetDifficulty", () => {
  it("leaves the target unchanged when actual timespan equals target timespan", () => {
    const currentTarget = "0".repeat(4) + "f".repeat(60);
    const result = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS,
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(result).toBe(currentTarget);
  });

  it("decreases the target (raises difficulty) when blocks were mined too fast", () => {
    const currentTarget = "0".repeat(4) + "f".repeat(60);
    const result = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS / 2, // mined 2x too fast
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(BigInt("0x" + result)).toBeLessThan(BigInt("0x" + currentTarget));
  });

  it("increases the target (lowers difficulty) when blocks were mined too slowly", () => {
    const currentTarget = "0".repeat(4) + "f".repeat(60);
    const result = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS * 2, // mined 2x too slow
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(BigInt("0x" + result)).toBeGreaterThan(BigInt("0x" + currentTarget));
  });

  it("clamps the adjustment to maxAdjustmentFactor on extreme timespans", () => {
    const currentTarget = "0".repeat(4) + "f".repeat(60);

    const extremelyFast = retargetDifficulty({
      currentTarget,
      actualTimespanMs: 1, // absurdly fast
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    const cappedFast = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS / 4,
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(extremelyFast).toBe(cappedFast);

    const extremelySlow = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS * 1000,
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    const cappedSlow = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS * 4,
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(extremelySlow).toBe(cappedSlow);
  });

  it("never exceeds the maximum possible target (all-f)", () => {
    const currentTarget = "f".repeat(64);
    const result = retargetDifficulty({
      currentTarget,
      actualTimespanMs: TARGET_TIMESPAN_MS * 1000,
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(BigInt("0x" + result)).toBeLessThanOrEqual(BigInt("0x" + "f".repeat(64)));
  });

  it("returns a 64-character hex string", () => {
    const result = retargetDifficulty({
      currentTarget: "0".repeat(4) + "f".repeat(60),
      actualTimespanMs: TARGET_TIMESPAN_MS,
      targetTimespanMs: TARGET_TIMESPAN_MS,
      maxAdjustmentFactor: 4,
    });
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("retargetWindow", () => {
  it("spans `interval` block gaps once the chain is long enough, and genesis..parent before that", () => {
    // Retarget at height 10 (interval 10): the completed period is blocks
    // 0..9; genesis is the earliest ancestor, so only 9 gaps exist.
    expect(retargetWindow(10, 10)).toEqual({ startHeight: 0, gaps: 9 });
    // Retarget at 20: blocks 10..19 were produced between block 9 and block 19: 10 gaps.
    expect(retargetWindow(20, 10)).toEqual({ startHeight: 9, gaps: 10 });
    expect(retargetWindow(30, 10)).toEqual({ startHeight: 19, gaps: 10 });
    expect(retargetWindow(2016, 2016)).toEqual({ startHeight: 0, gaps: 2015 });
    expect(retargetWindow(4032, 2016)).toEqual({ startHeight: 2015, gaps: 2016 });
  });
});

describe("nextTarget (regression: the retarget window is not off by one)", () => {
  const rules = { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4 };
  const TARGET = "0".repeat(4) + "f".repeat(60);
  const headerAt = (height: number, timestamp: number): BlockHeader => ({
    version: 1,
    previousHash: "",
    merkleRoot: "",
    timestamp,
    difficultyTarget: TARGET,
    nonce: 0,
    height,
  });

  it("keeps the target constant when every block arrives exactly on time, at every retarget", () => {
    // Before the fix, a perfectly timed chain measured (interval-1) gaps
    // against interval*blockTime and raised difficulty ~11% every period.
    for (const nextHeight of [10, 20, 30, 100]) {
      const { startHeight } = retargetWindow(nextHeight, rules.difficultyRetargetInterval);
      const parent = headerAt(nextHeight - 1, (nextHeight - 1) * rules.targetBlockTimeMs);
      const start = headerAt(startHeight, startHeight * rules.targetBlockTimeMs);
      expect(nextTarget(parent, start, rules), `height ${nextHeight}`).toBe(TARGET);
    }
  });

  it("still raises difficulty for fast blocks and lowers it for slow ones", () => {
    const { startHeight } = retargetWindow(20, 10);
    const start = headerAt(startHeight, 0);
    const fast = nextTarget(headerAt(19, 10 * 5_000), start, rules); // 5 s blocks
    const slow = nextTarget(headerAt(19, 10 * 20_000), start, rules); // 20 s blocks
    expect(BigInt(`0x${fast}`)).toBeLessThan(BigInt(`0x${TARGET}`));
    expect(BigInt(`0x${slow}`)).toBeGreaterThan(BigInt(`0x${TARGET}`));
  });
});
