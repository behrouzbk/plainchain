import { merkleRoot } from "../crypto/merkle.js";
import { computeBlockHash } from "../ledger/block.js";
import { validateTransactionStructure } from "../ledger/transaction.js";
import { serializeBlock } from "../ledger/serialize.js";
import type { Block, BlockHeader } from "../ledger/types.js";
import { PowEngine, type ConsensusEngine } from "./engine.js";

export interface BlockValidationResult {
  valid: boolean;
  reason?: string;
}

/** The one rejection an honest peer can produce (their clock is ahead of
 *  ours), exported so the node can decline to penalize for it. */
export const FUTURE_TIMESTAMP_REASON = "timestamp is too far in the future";

export interface HeaderValidationContext {
  /** The header this one claims to extend. Must already be known and valid. */
  parent: { header: BlockHeader; hash: string };
  /** What the difficulty retarget rule says this header's target must be. */
  expectedTarget: string;
  /** Wall-clock reference for the future-drift bound. */
  now: number;
  maxFutureDriftMs: number;
  /** If this height is checkpointed, the hash it must have. */
  checkpoint?: string;
  /** How the seal is judged; proof of work when omitted. */
  engine?: ConsensusEngine;
  /** Signers of the preceding headers (see SealContext); only proof of authority reads it. */
  recentSigners?: string[];
}

const POW_RULES = new PowEngine();

/**
 * Block size limits (consensus rules; part of `rulesHash`). Bound the
 * memory and validation time one block can cost. 1 MB sits well under the
 * default 4 MB P2P frame cap, so every valid block can be relayed.
 */
export const DEFAULT_MAX_BLOCK_BYTES = 1_000_000;
export const DEFAULT_MAX_TRANSACTIONS_PER_BLOCK = 5000;

/** Size of a block as consensus measures it: its canonical serialization. */
export function blockByteSize(block: Block): number {
  return Buffer.byteLength(serializeBlock(block), "utf8");
}

export interface BlockValidationContext extends Omit<HeaderValidationContext, "parent"> {
  /** The block this one claims to extend. Must already be known and valid. */
  parent: Block;
  blockReward: bigint;
  /** Defaults to DEFAULT_MAX_BLOCK_BYTES. */
  maxBlockBytes?: number;
  /** Defaults to DEFAULT_MAX_TRANSACTIONS_PER_BLOCK. */
  maxTransactionsPerBlock?: number;
}

/**
 * The header-only consensus rules: proof of work at the right target,
 * linkage to the parent, timestamp bounds, and checkpoint agreement. This
 * is everything that can be checked about a chain from its headers alone
 * -- header-first sync validates a peer's whole chain this way before
 * downloading a single block body.
 */
export function validateHeader(header: BlockHeader, hash: string, ctx: HeaderValidationContext): BlockValidationResult {
  if (computeBlockHash(header) !== hash) {
    return { valid: false, reason: "block hash does not match header" };
  }
  if (header.difficultyTarget !== ctx.expectedTarget) {
    return {
      valid: false,
      reason: `difficulty target ${header.difficultyTarget} does not match expected ${ctx.expectedTarget}`,
    };
  }
  const seal = (ctx.engine ?? POW_RULES).verifySeal(header, hash, { recentSigners: ctx.recentSigners ?? [] });
  if (!seal.valid) return seal;
  if (header.previousHash !== ctx.parent.hash) {
    return { valid: false, reason: "previousHash does not match parent" };
  }
  if (header.height !== ctx.parent.header.height + 1) {
    return { valid: false, reason: `height ${header.height} is not parent height + 1` };
  }
  if (header.timestamp <= ctx.parent.header.timestamp) {
    return { valid: false, reason: "timestamp is not after parent's timestamp" };
  }
  if (header.timestamp > ctx.now + ctx.maxFutureDriftMs) {
    return { valid: false, reason: FUTURE_TIMESTAMP_REASON };
  }
  if (ctx.checkpoint !== undefined && ctx.checkpoint !== hash) {
    return { valid: false, reason: `conflicts with checkpoint at height ${header.height}` };
  }
  return { valid: true };
}

/**
 * Every context-free consensus rule a block must satisfy before its
 * transactions are checked against UTXO state. Kept pure so it can be
 * applied to a fork block against *its* ancestry, not just the current
 * canonical chain. UTXO-dependent rules (inputs exist, signatures match
 * owners, maturity) are applied later during chain replay.
 */
export function validateBlock(block: Block, ctx: BlockValidationContext): BlockValidationResult {
  const { header } = block;

  const headerVerdict = validateHeader(header, block.hash, {
    parent: { header: ctx.parent.header, hash: ctx.parent.hash },
    expectedTarget: ctx.expectedTarget,
    now: ctx.now,
    maxFutureDriftMs: ctx.maxFutureDriftMs,
    checkpoint: ctx.checkpoint,
    engine: ctx.engine,
    recentSigners: ctx.recentSigners,
  });
  if (!headerVerdict.valid) return headerVerdict;

  const [coinbase, ...rest] = block.transactions;
  if (!coinbase) {
    return { valid: false, reason: "block has no transactions (missing coinbase)" };
  }
  // Size limits before any per-transaction work, so an oversized block is
  // refused for its size, not after paying to validate it.
  const maxTransactions = ctx.maxTransactionsPerBlock ?? DEFAULT_MAX_TRANSACTIONS_PER_BLOCK;
  if (block.transactions.length > maxTransactions) {
    return { valid: false, reason: `block has ${block.transactions.length} transactions; at most ${maxTransactions} allowed` };
  }
  const maxBytes = ctx.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
  const size = blockByteSize(block);
  if (size > maxBytes) {
    return { valid: false, reason: `block is ${size} bytes; at most ${maxBytes} allowed` };
  }

  if (coinbase.inputs.length !== 0) {
    return { valid: false, reason: "first transaction must be the coinbase (no inputs)" };
  }
  for (const tx of rest) {
    if (tx.inputs.length === 0) {
      return { valid: false, reason: "only the first transaction may be a coinbase" };
    }
  }

  if (merkleRoot(block.transactions.map((t) => t.id)) !== header.merkleRoot) {
    return { valid: false, reason: "merkle root does not match transactions" };
  }

  const seenTxIds = new Set<string>();
  const spentOutpoints = new Set<string>();
  let totalFees = 0n;
  for (const tx of block.transactions) {
    const structural = validateTransactionStructure(tx);
    if (!structural.valid) {
      return { valid: false, reason: `transaction ${tx.id}: ${structural.reason}` };
    }
    if (seenTxIds.has(tx.id)) {
      return { valid: false, reason: `duplicate transaction ${tx.id} in block` };
    }
    seenTxIds.add(tx.id);
    for (const input of tx.inputs) {
      const key = `${input.txId}:${input.outputIndex}`;
      if (spentOutpoints.has(key)) {
        return { valid: false, reason: `outpoint ${key} spent twice within block` };
      }
      spentOutpoints.add(key);
    }
    totalFees += tx.fee;
  }

  const coinbaseOut = coinbase.outputs.reduce((sum, o) => sum + o.amount, 0n);
  const maxCoinbase = ctx.blockReward + totalFees;
  if (coinbaseOut > maxCoinbase) {
    return {
      valid: false,
      reason: `coinbase pays ${coinbaseOut} but block reward + fees is only ${maxCoinbase}`,
    };
  }

  return { valid: true };
}
