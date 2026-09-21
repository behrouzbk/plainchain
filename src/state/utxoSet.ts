import type { AbstractBatchOperation } from "abstract-level";
import { verify } from "../crypto/signature.js";
import { deriveAddress } from "../ledger/address.js";
import { getSigningPayload, validateTransactionStructure } from "../ledger/transaction.js";
import type { Transaction, TxOutput } from "../ledger/types.js";
import type { StateBatchOperation, Sublevel } from "./db.js";

type UtxoBatchOperation = AbstractBatchOperation<Sublevel, string, string>;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface UtxoEntry extends TxOutput {
  /** Height of the block that created this output (0 for pre-chain / test usage). */
  blockHeight: number;
  /** Whether this output came from a coinbase (no-input) transaction. */
  isCoinbase: boolean;
}

/** An unspent outpoint plus everything a wallet needs to spend it. */
export interface Unspent extends UtxoEntry {
  txId: string;
  outputIndex: number;
}

/** What applying one transaction did to the UTXO set, sufficient to reverse it. */
export interface TxUndo {
  spent: { txId: string; outputIndex: number; entry: UtxoEntry }[];
  created: { txId: string; outputIndex: number }[];
}

function utxoKey(txId: string, outputIndex: number): string {
  return `${txId}:${outputIndex}`;
}

function parseUtxoKey(key: string): { txId: string; outputIndex: number } {
  const sep = key.lastIndexOf(":");
  return { txId: key.slice(0, sep), outputIndex: Number(key.slice(sep + 1)) };
}

function serializeEntry(entry: UtxoEntry): string {
  return JSON.stringify({
    address: entry.address,
    amount: entry.amount.toString(),
    blockHeight: entry.blockHeight,
    isCoinbase: entry.isCoinbase,
  });
}

function deserializeEntry(raw: string): UtxoEntry {
  const parsed = JSON.parse(raw) as {
    address: string;
    amount: string;
    blockHeight: number;
    isCoinbase: boolean;
  };
  return {
    address: parsed.address,
    amount: BigInt(parsed.amount),
    blockHeight: parsed.blockHeight,
    isCoinbase: parsed.isCoinbase,
  };
}

/** Pending writes not yet persisted; `null` marks a deletion. */
interface Staging {
  writes: Map<string, string | null>;
  /** Treat the persisted store as empty (used by full replays). */
  clearBase: boolean;
}

export class UtxoSet {
  private staging: Staging | undefined;

  /**
   * @param coinbaseMaturity Number of blocks a coinbase output must be
   * buried under before it can be spent (0 = spendable immediately, the
   * default so existing devnet/test usage is unaffected).
   */
  constructor(
    private readonly store: Sublevel,
    private readonly coinbaseMaturity = 0,
  ) {}

  /**
   * Start buffering writes in memory instead of persisting them. Reads
   * (and therefore validation) see the buffered state, so a sequence of
   * dependent transactions can be applied and then committed as a single
   * atomic batch via takeStagedOps(), or abandoned via discardStaging().
   * Iteration (getBalance/listUnspent) deliberately reads only persisted
   * state, so concurrent readers see a consistent pre-commit snapshot.
   */
  beginStaging(options: { clearBase?: boolean } = {}): void {
    if (this.staging) throw new Error("UtxoSet: staging already in progress");
    this.staging = { writes: new Map(), clearBase: options.clearBase ?? false };
  }

  discardStaging(): void {
    this.staging = undefined;
  }

  /** Drains the staged writes into batch ops targeting this sublevel and ends staging. */
  async takeStagedOps(): Promise<StateBatchOperation[]> {
    const staging = this.staging;
    if (!staging) throw new Error("UtxoSet: no staging in progress");
    this.staging = undefined;

    const ops: StateBatchOperation[] = [];
    if (staging.clearBase) {
      for await (const key of this.store.keys()) {
        if (!staging.writes.has(key)) ops.push({ type: "del", key, sublevel: this.store });
      }
    }
    for (const [key, value] of staging.writes) {
      ops.push(
        value === null
          ? { type: "del", key, sublevel: this.store }
          : { type: "put", key, value, sublevel: this.store },
      );
    }
    return ops;
  }

  async get(txId: string, outputIndex: number): Promise<TxOutput | undefined> {
    const entry = await this.getEntry(txId, outputIndex);
    return entry ? { address: entry.address, amount: entry.amount } : undefined;
  }

  private async readRaw(key: string): Promise<string | undefined> {
    if (this.staging) {
      if (this.staging.writes.has(key)) {
        return this.staging.writes.get(key) ?? undefined;
      }
      if (this.staging.clearBase) return undefined;
    }
    return this.store.get(key);
  }

  private async write(ops: UtxoBatchOperation[]): Promise<void> {
    if (this.staging) {
      for (const op of ops) {
        this.staging.writes.set(op.key, op.type === "put" ? op.value : null);
      }
      return;
    }
    await this.store.batch(ops);
  }

  private async getEntry(txId: string, outputIndex: number): Promise<UtxoEntry | undefined> {
    const raw = await this.readRaw(utxoKey(txId, outputIndex));
    return raw === undefined ? undefined : deserializeEntry(raw);
  }

  /**
   * @param spendingHeight The height of the block this transaction is being
   * validated for inclusion in (or, for mempool acceptance, the tip height
   * + 1 it would next be mined at). Defaults to 0 for callers that don't
   * care about coinbase maturity.
   */
  async validateTransaction(tx: Transaction, spendingHeight = 0): Promise<ValidationResult> {
    const structural = validateTransactionStructure(tx);
    if (!structural.valid) return structural;

    // Coinbase transactions (no inputs) have nothing to check against the
    // UTXO set. The reward-amount cap is a block-level rule, enforced by
    // consensus/blockValidator, since it depends on the other txs' fees.
    if (tx.inputs.length === 0) {
      return { valid: true };
    }

    const payload = getSigningPayload(tx);
    let totalIn = 0n;

    for (const input of tx.inputs) {
      const entry = await this.getEntry(input.txId, input.outputIndex);
      if (!entry) {
        return {
          valid: false,
          reason: `referenced UTXO not found (already spent or never existed): ${utxoKey(input.txId, input.outputIndex)}`,
        };
      }

      if (entry.isCoinbase && spendingHeight < entry.blockHeight + this.coinbaseMaturity) {
        return {
          valid: false,
          reason: `coinbase output not yet mature: created at height ${entry.blockHeight}, spendable at height ${entry.blockHeight + this.coinbaseMaturity}, attempted at height ${spendingHeight}`,
        };
      }

      if (deriveAddress(input.publicKey) !== entry.address) {
        return {
          valid: false,
          reason: `input public key does not match the owner address of the referenced output`,
        };
      }

      if (!verify(input.publicKey, payload, input.signature)) {
        return {
          valid: false,
          reason: `input signature does not verify against the transaction payload`,
        };
      }

      totalIn += entry.amount;
    }

    const totalOut = tx.outputs.reduce((sum, o) => sum + o.amount, 0n);

    if (totalIn < totalOut + tx.fee) {
      return {
        valid: false,
        reason: `insufficient input amount: inputs=${totalIn} outputs+fee=${totalOut + tx.fee}`,
      };
    }

    return { valid: true };
  }

  async getBalance(address: string): Promise<bigint> {
    let total = 0n;
    for await (const utxo of this.iterateUnspent(address)) {
      total += utxo.amount;
    }
    return total;
  }

  async listUnspent(address: string): Promise<Unspent[]> {
    const result: Unspent[] = [];
    for await (const utxo of this.iterateUnspent(address)) {
      result.push(utxo);
    }
    return result;
  }

  private async *iterateUnspent(address: string): AsyncGenerator<Unspent> {
    for await (const [key, raw] of this.store.iterator()) {
      const entry = deserializeEntry(raw);
      if (entry.address === address) {
        yield { ...parseUtxoKey(key), ...entry };
      }
    }
  }

  /**
   * @param height The height of the block this transaction is being applied
   * as part of (used to tag new outputs for coinbase maturity tracking).
   * Defaults to 0 for callers that don't care about maturity.
   */
  async applyTransaction(tx: Transaction, height = 0): Promise<TxUndo> {
    const result = await this.validateTransaction(tx, height);
    if (!result.valid) {
      throw new Error(`cannot apply invalid transaction ${tx.id}: ${result.reason}`);
    }

    const ops: UtxoBatchOperation[] = [];
    const isCoinbase = tx.inputs.length === 0;
    const undo: TxUndo = { spent: [], created: [] };

    for (const input of tx.inputs) {
      // validateTransaction just confirmed every input exists.
      const entry = (await this.getEntry(input.txId, input.outputIndex))!;
      undo.spent.push({ txId: input.txId, outputIndex: input.outputIndex, entry });
      ops.push({ type: "del", key: utxoKey(input.txId, input.outputIndex) });
    }

    tx.outputs.forEach((output, index) => {
      undo.created.push({ txId: tx.id, outputIndex: index });
      ops.push({
        type: "put",
        key: utxoKey(tx.id, index),
        value: serializeEntry({ ...output, blockHeight: height, isCoinbase }),
      });
    });

    await this.write(ops);
    return undo;
  }

  /** Reverses one applyTransaction. Callers must undo a block's transactions
   *  in reverse order, since later ones may spend earlier ones' outputs. */
  async undoTransaction(undo: TxUndo): Promise<void> {
    const ops: UtxoBatchOperation[] = [];
    for (const { txId, outputIndex } of undo.created) {
      ops.push({ type: "del", key: utxoKey(txId, outputIndex) });
    }
    for (const { txId, outputIndex, entry } of undo.spent) {
      ops.push({ type: "put", key: utxoKey(txId, outputIndex), value: serializeEntry(entry) });
    }
    await this.write(ops);
  }
}
