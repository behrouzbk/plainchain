import type { Transaction } from "../ledger/types.js";
import type { UtxoSet, ValidationResult } from "../state/utxoSet.js";

export interface MempoolPolicy {
  /**
   * Most pending transactions one replacement may evict. Bounds the work
   * (and relay churn) a single incoming transaction can cause.
   */
  maxReplacements: number;
}

export const DEFAULT_MEMPOOL_POLICY: MempoolPolicy = { maxReplacements: 100 };

export interface MempoolResult extends ValidationResult {
  /** Ids of pending transactions evicted by this one (replace-by-fee). */
  replaced?: string[];
}

/**
 * Pending transactions, with two admission policies on top of state
 * validation: capacity (lowest fee evicted for a higher one) and
 * replace-by-fee. Every transaction is replaceable (no opt-in flag): a
 * conflicting transaction -- one spending an outpoint a pending one
 * already claims -- is accepted if it pays at least the combined fees of
 * everything it displaces plus `minFee`, so each replacement strictly
 * raises what the sender pays, which is what keeps a stream of
 * replacements from being a free way to make the network re-validate and
 * re-relay. Mempool outputs cannot be spent before confirmation, so a
 * replacement never orphans descendants.
 */
export class Mempool {
  private readonly transactions = new Map<string, Transaction>();
  /** Outpoint -> id of the pending transaction spending it, to catch
   *  mempool-level double-spends the UTXO set itself can't see yet. */
  private readonly claimedOutpoints = new Map<string, string>();
  private readonly policy: MempoolPolicy;

  /**
   * @param maxSize Maximum number of pending transactions held at once.
   * Default Infinity (unbounded) preserves existing behavior for callers
   * that don't care about eviction. Once full, a new transaction is only
   * accepted if its fee exceeds the lowest pending fee, which is then
   * evicted to make room.
   * @param minFee Minimum fee a transaction must pay to be accepted.
   * Defaults to 1 (i.e. any positive fee), matching prior behavior.
   */
  constructor(
    private readonly utxoSet: UtxoSet,
    private readonly maxSize = Infinity,
    private readonly minFee = 1n,
    policy: Partial<MempoolPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_MEMPOOL_POLICY, ...policy };
  }

  /**
   * @param spendingHeight The height this transaction would next be mined
   * at (tip height + 1). Defaults to 0 for callers that don't care about
   * coinbase maturity.
   */
  async addTransaction(tx: Transaction, spendingHeight = 0): Promise<MempoolResult> {
    if (this.transactions.has(tx.id)) {
      return { valid: false, reason: "duplicate transaction: already pending" };
    }

    if (tx.inputs.length === 0) {
      return { valid: false, reason: "coinbase-style transactions are not accepted via the mempool" };
    }

    if (tx.fee < this.minFee) {
      return { valid: false, reason: `transaction fee ${tx.fee} is below the minimum required fee ${this.minFee}` };
    }

    // Replace-by-fee: what would this transaction displace, and does it pay for it?
    const conflicts = new Map<string, Transaction>();
    for (const input of tx.inputs) {
      const claimant = this.claimedOutpoints.get(`${input.txId}:${input.outputIndex}`);
      if (claimant !== undefined) conflicts.set(claimant, this.transactions.get(claimant)!);
    }
    if (conflicts.size > this.policy.maxReplacements) {
      return {
        valid: false,
        reason: `transaction would replace ${conflicts.size} pending transactions; at most ${this.policy.maxReplacements} allowed`,
      };
    }
    if (conflicts.size > 0) {
      let displacedFees = 0n;
      for (const conflict of conflicts.values()) displacedFees += conflict.fee;
      const required = displacedFees + this.minFee;
      if (tx.fee < required) {
        return {
          valid: false,
          reason: `conflicts with ${conflicts.size} pending transaction(s); to replace them the fee must be at least ${required} (their ${displacedFees} plus the minimum ${this.minFee}), got ${tx.fee}`,
        };
      }
    }

    const result = await this.utxoSet.validateTransaction(tx, spendingHeight);
    if (!result.valid) {
      return result;
    }

    // Evict the displaced transactions only now, after full validation:
    // a replacement that turns out invalid must not have cost anyone their slot.
    for (const id of conflicts.keys()) this.remove(id);

    if (this.transactions.size >= this.maxSize) {
      const lowestFeeTx = this.lowestFeeTransaction();
      if (!lowestFeeTx || lowestFeeTx.fee >= tx.fee) {
        return {
          valid: false,
          reason: `mempool full (max ${this.maxSize}) and incoming fee does not exceed the lowest pending fee`,
        };
      }
      this.remove(lowestFeeTx.id);
    }

    this.transactions.set(tx.id, tx);
    for (const input of tx.inputs) {
      this.claimedOutpoints.set(`${input.txId}:${input.outputIndex}`, tx.id);
    }

    return conflicts.size > 0 ? { valid: true, replaced: [...conflicts.keys()] } : { valid: true };
  }

  private lowestFeeTransaction(): Transaction | undefined {
    let lowest: Transaction | undefined;
    for (const tx of this.transactions.values()) {
      if (!lowest || tx.fee < lowest.fee) {
        lowest = tx;
      }
    }
    return lowest;
  }

  /** Whether a pending transaction already spends this outpoint. */
  isClaimed(txId: string, outputIndex: number): boolean {
    return this.claimedOutpoints.has(`${txId}:${outputIndex}`);
  }

  has(txId: string): boolean {
    return this.transactions.has(txId);
  }

  remove(txId: string): void {
    const tx = this.transactions.get(txId);
    if (!tx) return;
    this.transactions.delete(txId);
    for (const input of tx.inputs) {
      const key = `${input.txId}:${input.outputIndex}`;
      if (this.claimedOutpoints.get(key) === txId) this.claimedOutpoints.delete(key);
    }
  }

  size(): number {
    return this.transactions.size;
  }

  getTransactions(): Transaction[] {
    return [...this.transactions.values()];
  }

  getTransactionsByFee(limit?: number): Transaction[] {
    const sorted = [...this.transactions.values()].sort((a, b) =>
      b.fee > a.fee ? 1 : b.fee < a.fee ? -1 : 0,
    );
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }
}
