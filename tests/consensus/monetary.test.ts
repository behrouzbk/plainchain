import { describe, expect, it } from "vitest";
import {
  RULES_VERSION,
  blockRewardAt,
  cumulativeEmission,
  maxSupply,
  nextHalvingHeight,
  rulesHash,
  type MonetaryPolicy,
} from "../../src/consensus/monetary.js";

const halving: MonetaryPolicy = { initialReward: 1000n, halvingInterval: 4, tailEmission: 0n };
const tail: MonetaryPolicy = { initialReward: 1000n, halvingInterval: 4, tailEmission: 100n };
const flat: MonetaryPolicy = { initialReward: 1000n, halvingInterval: 0, tailEmission: 0n };

const consensus = { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, coinbaseMaturity: 10, maxFutureDriftMs: 7_200_000 };

describe("blockRewardAt", () => {
  it("halves every halvingInterval blocks, era boundaries inclusive at the start", () => {
    expect([1, 2, 3, 4, 5, 7, 8, 12].map((h) => blockRewardAt(h, halving))).toEqual([1000n, 1000n, 1000n, 500n, 500n, 500n, 250n, 125n]);
  });

  it("never drops below the tail emission", () => {
    expect(blockRewardAt(12, tail)).toBe(125n);
    expect(blockRewardAt(16, tail)).toBe(100n); // 62 < 100 -> floor
    expect(blockRewardAt(10_000, tail)).toBe(100n);
  });

  it("reaches zero (not a negative or wrapped value) after enough halvings without tail emission", () => {
    expect(blockRewardAt(4 * 10, halving)).toBe(0n);
    expect(blockRewardAt(4 * 1000, halving)).toBe(0n);
  });

  it("halvingInterval 0 means a constant reward forever", () => {
    expect(blockRewardAt(1, flat)).toBe(1000n);
    expect(blockRewardAt(10_000_000, flat)).toBe(1000n);
  });

  it("rejects a non-positive height (genesis is an allocation, not a reward)", () => {
    expect(() => blockRewardAt(0, halving)).toThrow(/height/);
  });
});

describe("cumulativeEmission", () => {
  function bruteForce(tip: number, policy: MonetaryPolicy): bigint {
    let sum = 0n;
    for (let h = 1; h <= tip; h++) sum += blockRewardAt(h, policy);
    return sum;
  }

  it("matches a brute-force sum across era boundaries, tails, and flat schedules", () => {
    for (const policy of [halving, tail, flat]) {
      for (const tip of [0, 1, 3, 4, 5, 8, 9, 15, 16, 17, 50, 200]) {
        expect(cumulativeEmission(tip, policy), `tip ${tip}`).toBe(bruteForce(tip, policy));
      }
    }
  });

  it("is cheap at real heights (closed form, no per-block loop)", () => {
    const start = Date.now();
    const total = cumulativeEmission(50_000_000, { initialReward: 5_000_000_000n, halvingInterval: 210_000, tailEmission: 0n });
    expect(Date.now() - start).toBeLessThan(50);
    expect(total).toBeGreaterThan(0n);
  });
});

describe("maxSupply and nextHalvingHeight", () => {
  it("is finite for a halving schedule with no tail: allocation + every reward ever", () => {
    // Era 0 is heights 1..3 (genesis mints nothing through the schedule), then 4 blocks per era
    // until integer halving reaches 0: 3*1000 + 4*(500+250+125+62+31+15+7+3+1) = 6976.
    expect(maxSupply(halving, 500n)).toBe(500n + 6976n);
    expect(maxSupply(halving, 500n)).toBe(500n + cumulativeEmission(4 * 40, halving)); // nothing minted after the last era
  });

  it("is unbounded with tail emission or a constant reward", () => {
    expect(maxSupply(tail, 0n)).toBeUndefined();
    expect(maxSupply(flat, 0n)).toBeUndefined();
  });

  it("reports the next halving height, or none once rewards can no longer halve", () => {
    expect(nextHalvingHeight(1, halving)).toBe(4);
    expect(nextHalvingHeight(4, halving)).toBe(8);
    expect(nextHalvingHeight(7, halving)).toBe(8);
    expect(nextHalvingHeight(1, flat)).toBeUndefined();
    expect(nextHalvingHeight(4 * 40, halving)).toBeUndefined(); // reward already 0
    expect(nextHalvingHeight(16, tail)).toBeUndefined(); // already at the tail floor
  });
});

describe("rulesHash", () => {
  it("carries a rules version so nodes on different code with the same config still refuse each other", () => {
    // Bumped whenever a validity rule changes (last: transactions may carry record data).
    expect(RULES_VERSION).toBe(5);
  });

  it("is deterministic and independent of key order", () => {
    const a = rulesHash(consensus, halving);
    const b = rulesHash({ ...consensus }, { tailEmission: 0n, halvingInterval: 4, initialReward: 1000n });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any consensus or monetary parameter changes (a mismatched peer must not be able to connect)", () => {
    const base = rulesHash(consensus, halving);
    expect(rulesHash(consensus, { ...halving, halvingInterval: 5 })).not.toBe(base);
    expect(rulesHash(consensus, { ...halving, initialReward: 999n })).not.toBe(base);
    expect(rulesHash(consensus, { ...halving, tailEmission: 1n })).not.toBe(base);
    expect(rulesHash({ ...consensus, coinbaseMaturity: 11 }, halving)).not.toBe(base);
    expect(rulesHash({ ...consensus, targetBlockTimeMs: 9_999 }, halving)).not.toBe(base);
    expect(rulesHash({ ...consensus, maxBlockBytes: 999_999 }, halving)).not.toBe(base);
    expect(rulesHash({ ...consensus, maxTransactionsPerBlock: 4999 }, halving)).not.toBe(base);
    // Stating the defaults explicitly is the same rule set as leaving them out.
    expect(rulesHash({ ...consensus, maxBlockBytes: 1_000_000, maxTransactionsPerBlock: 5000 }, halving)).toBe(base);
  });

  it("ignores node policy that does not alter which history is valid: checkpoints and the future-drift tolerance", () => {
    const withCheckpoints = { ...consensus, checkpoints: [{ height: 1, hash: "a".repeat(64) }] };
    expect(rulesHash(withCheckpoints, halving)).toBe(rulesHash(consensus, halving));
    expect(rulesHash({ ...consensus, maxFutureDriftMs: 1 }, halving)).toBe(rulesHash(consensus, halving));
  });
});
