import { computeBlockHash } from "../ledger/block.js";
import type { BlockHeader } from "../ledger/types.js";

export function meetsTarget(hash: string, target: string): boolean {
  return BigInt(`0x${hash}`) <= BigInt(`0x${target}`);
}

export interface MinedHeader {
  header: BlockHeader;
  hash: string;
}

export function mineBlockHeader(
  header: BlockHeader,
  maxNonce = Number.MAX_SAFE_INTEGER,
): MinedHeader {
  for (let nonce = 0; nonce <= maxNonce; nonce++) {
    const candidate: BlockHeader = { ...header, nonce };
    const hash = computeBlockHash(candidate);
    if (meetsTarget(hash, candidate.difficultyTarget)) {
      return { header: candidate, hash };
    }
  }

  throw new Error(
    `mineBlockHeader: exhausted nonce range [0, ${maxNonce}] without meeting target ${header.difficultyTarget}`,
  );
}
