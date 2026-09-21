import type { BlockHeader } from "../ledger/types.js";

const MAX_TARGET = BigInt(`0x${"f".repeat(64)}`);

export interface DifficultyRetargetParams {
  currentTarget: string;
  actualTimespanMs: number;
  targetTimespanMs: number;
  maxAdjustmentFactor: number;
}

/**
 * Bitcoin-style linear retarget: newTarget = currentTarget * (clampedActual / target).
 * Clamping the timespan (not the ratio) before the multiply keeps a single
 * adjustment bounded by maxAdjustmentFactor in both directions.
 */
export function retargetDifficulty(params: DifficultyRetargetParams): string {
  const { currentTarget, actualTimespanMs, targetTimespanMs, maxAdjustmentFactor } = params;

  const minTimespan = targetTimespanMs / maxAdjustmentFactor;
  const maxTimespan = targetTimespanMs * maxAdjustmentFactor;
  const clampedTimespan = Math.min(maxTimespan, Math.max(minTimespan, actualTimespanMs));

  const currentTargetValue = BigInt(`0x${currentTarget}`);
  // Scale by a fixed-point factor before dividing so fractional timespans
  // (e.g. 0.25x) aren't lost to integer division.
  const PRECISION = 1_000_000n;
  const scaledFactor = BigInt(Math.round(clampedTimespan * Number(PRECISION))) / BigInt(targetTimespanMs);
  let newTargetValue = (currentTargetValue * scaledFactor) / PRECISION;

  if (newTargetValue > MAX_TARGET) newTargetValue = MAX_TARGET;
  if (newTargetValue < 1n) newTargetValue = 1n;

  return newTargetValue.toString(16).padStart(64, "0");
}

export interface RetargetRules {
  targetBlockTimeMs: number;
  difficultyRetargetInterval: number;
  maxDifficultyAdjustmentFactor: number;
}

/**
 * The ancestor that bounds the period a retarget at `nextHeight` measures,
 * and how many block intervals that period spans. The completed period is
 * the `interval` blocks ending at `nextHeight - 1`; they were produced
 * between the block *before* the period and its last block, i.e. over
 * `interval` gaps -- except the first period, which can only start at
 * genesis. Measuring `interval - 1` gaps against `interval * blockTime`
 * (the classic off-by-one) made a perfectly timed chain look ~1/interval
 * too fast and raised difficulty every period.
 */
export function retargetWindow(nextHeight: number, interval: number): { startHeight: number; gaps: number } {
  const startHeight = Math.max(0, nextHeight - interval - 1);
  return { startHeight, gaps: nextHeight - 1 - startHeight };
}

/**
 * The target a block after `parent` must use when `parent.height + 1` is a
 * retarget height, given the period's starting ancestor (see
 * retargetWindow). Shared by the node and the light client so they can
 * never disagree.
 */
export function nextTarget(parent: BlockHeader, periodStart: BlockHeader, rules: RetargetRules): string {
  const gaps = parent.height - periodStart.height;
  if (gaps <= 0) throw new Error(`retarget period start (height ${periodStart.height}) must precede the parent (height ${parent.height})`);
  return retargetDifficulty({
    currentTarget: parent.difficultyTarget,
    actualTimespanMs: parent.timestamp - periodStart.timestamp,
    targetTimespanMs: gaps * rules.targetBlockTimeMs,
    maxAdjustmentFactor: rules.maxDifficultyAdjustmentFactor,
  });
}
