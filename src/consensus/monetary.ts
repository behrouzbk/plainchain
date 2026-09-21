import { sha256 } from "../crypto/hash.js";
import { DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_TRANSACTIONS_PER_BLOCK } from "./blockValidator.js";
import type { ConsensusMode } from "./engine.js";

/**
 * Emission schedule: how many new coins a block at a given height may
 * create. Consensus-critical -- a node with a different schedule would
 * reject the other's coinbases -- so it is folded into `rulesHash`,
 * which peers compare in the handshake.
 */
export interface MonetaryPolicy {
  /** Reward for blocks in the first era (heights 0..halvingInterval-1). */
  initialReward: bigint;
  /** Blocks per era; the reward halves at every multiple. 0 = never halves. */
  halvingInterval: number;
  /** Floor the reward never drops below (0 = emission eventually stops). */
  tailEmission: bigint;
}

/**
 * Bumped whenever a validity rule changes in code (not just in config), so
 * nodes running different rules refuse each other even with identical
 * configs. History: 1 initial; 2 retarget window off-by-one fix (#27);
 * 3 consensus engines -- mode + authority set join the hash, and a header
 * may carry a signer (#37); 4 the proof-of-authority signature joins the
 * block hash (self-audit finding F7).
 */
export const RULES_VERSION = 4;

/** The consensus parameters, besides the emission schedule, that decide which blocks are valid. */
export interface ConsensusRules {
  targetBlockTimeMs: number;
  difficultyRetargetInterval: number;
  maxDifficultyAdjustmentFactor: number;
  coinbaseMaturity: number;
  /** Block limits; defaults apply when omitted (see blockValidator.ts). */
  maxBlockBytes?: number;
  maxTransactionsPerBlock?: number;
  /** Sealing rules (consensus/engine.ts); proof of work when omitted. */
  mode?: ConsensusMode;
  /** Proof-of-authority signers in turn order. */
  authorities?: string[];
  /** Node policy, not a rule: tolerated but ignored by the hash. */
  maxFutureDriftMs?: number;
  checkpoints?: unknown;
}

function eraOf(height: number, policy: MonetaryPolicy): number {
  return policy.halvingInterval > 0 ? Math.floor(height / policy.halvingInterval) : 0;
}

function rewardInEra(era: number, policy: MonetaryPolicy): bigint {
  // A bigint shift by >= its bit length is simply 0: no wrap, no negatives.
  const halved = policy.initialReward >> BigInt(era);
  return halved > policy.tailEmission ? halved : policy.tailEmission;
}

/** New coins a block at `height` (>= 1) may pay its miner, before fees. */
export function blockRewardAt(height: number, policy: MonetaryPolicy): bigint {
  if (!Number.isInteger(height) || height < 1) throw new Error(`block reward is defined for height >= 1, got ${height}`);
  return rewardInEra(eraOf(height, policy), policy);
}

/** Sum of rewards for heights 1..tipHeight, in closed form per era. */
export function cumulativeEmission(tipHeight: number, policy: MonetaryPolicy): bigint {
  if (tipHeight < 1) return 0n;
  if (policy.halvingInterval === 0) return policy.initialReward * BigInt(tipHeight);
  let total = 0n;
  const lastEra = eraOf(tipHeight, policy);
  for (let era = 0; era <= lastEra; era++) {
    const first = Math.max(1, era * policy.halvingInterval);
    const last = Math.min(tipHeight, (era + 1) * policy.halvingInterval - 1);
    if (last >= first) total += rewardInEra(era, policy) * BigInt(last - first + 1);
  }
  return total;
}

/**
 * Coins that can ever exist: the genesis allocation plus every reward.
 * Undefined when emission never stops (tail emission, or a constant reward).
 */
export function maxSupply(policy: MonetaryPolicy, genesisAllocation: bigint): bigint | undefined {
  if (policy.halvingInterval === 0 || policy.tailEmission > 0n) return undefined;
  let total = genesisAllocation;
  for (let era = 0; rewardInEra(era, policy) > 0n; era++) {
    // Era 0 starts at height 1 (genesis mints nothing through the schedule).
    const blocks = era === 0 ? policy.halvingInterval - 1 : policy.halvingInterval;
    total += rewardInEra(era, policy) * BigInt(blocks);
  }
  return total;
}

/** First height above `height` where the reward changes, if it ever will. */
export function nextHalvingHeight(height: number, policy: MonetaryPolicy): number | undefined {
  if (policy.halvingInterval === 0) return undefined;
  const next = (eraOf(height, policy) + 1) * policy.halvingInterval;
  return blockRewardAt(next, policy) < blockRewardAt(Math.max(1, height), policy) ? next : undefined;
}

/**
 * Fingerprint of everything that decides block validity beyond genesis.
 * Sent in the handshake; peers with a different value are refused, so a
 * node with, say, a slower halving cannot quietly fork the network.
 * Checkpoints and clock tolerance are node policy, not rules, and are
 * excluded.
 */
export function rulesHash(consensus: ConsensusRules, policy: MonetaryPolicy): string {
  const canonical = [
    "rulesVersion",
    RULES_VERSION,
    "targetBlockTimeMs",
    consensus.targetBlockTimeMs,
    "difficultyRetargetInterval",
    consensus.difficultyRetargetInterval,
    "maxDifficultyAdjustmentFactor",
    consensus.maxDifficultyAdjustmentFactor,
    "coinbaseMaturity",
    consensus.coinbaseMaturity,
    "maxBlockBytes",
    consensus.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES,
    "maxTransactionsPerBlock",
    consensus.maxTransactionsPerBlock ?? DEFAULT_MAX_TRANSACTIONS_PER_BLOCK,
    "mode",
    consensus.mode ?? "pow",
    "authorities",
    (consensus.authorities ?? []).join(","),
    "initialReward",
    policy.initialReward.toString(),
    "halvingInterval",
    policy.halvingInterval,
    "tailEmission",
    policy.tailEmission.toString(),
  ].join("|");
  return sha256(canonical);
}
