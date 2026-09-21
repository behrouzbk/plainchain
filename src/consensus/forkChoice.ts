import type { BlockHeader } from "../ledger/types.js";

const MAX_TARGET_PLUS_ONE = BigInt(`0x${"f".repeat(64)}`) + 1n;

/** Work contributed by a single block: inversely proportional to its target. */
export function workForTarget(target: string): bigint {
  const targetValue = BigInt(`0x${target}`);
  return MAX_TARGET_PLUS_ONE / (targetValue + 1n);
}

export function computeChainWork(headers: BlockHeader[]): bigint {
  return headers.reduce((sum, h) => sum + workForTarget(h.difficultyTarget), 0n);
}

/** Heaviest-chain rule: a candidate only wins with strictly more cumulative work. */
export function isBetterChain(candidateWork: bigint, currentWork: bigint): boolean {
  return candidateWork > currentWork;
}
