import { deserializeBlock, serializeBlock } from "../ledger/serialize.js";
import type { Block, BlockHeader } from "../ledger/types.js";
import type { StateBatchOperation, Sublevel } from "./db.js";
import type { TxUndo } from "./utxoSet.js";

export interface ChainTip {
  hash: string;
  height: number;
}

/** One TxUndo per transaction, in block order. */
export type BlockUndo = TxUndo[];

/** A validated header plus the total work of the chain ending at it. */
export interface IndexedHeader {
  header: BlockHeader;
  work: bigint;
}

const TIP_HASH_KEY = "tipHash";
const TIP_HEIGHT_KEY = "tipHeight";
const TX_INDEX_BUILT_KEY = "txIndexBuilt";
const ADDR_INDEX_BUILT_KEY = "addrIndexBuilt";
/** The `depth` the address index was last maintained with (0 = whole chain), so a changed setting can be reconciled at startup. */
const ADDR_INDEX_DEPTH_KEY = "addrIndexDepth";
/** Heights are zero-padded so lexicographic key order is chronological. */
const HEIGHT_WIDTH = 10;

/** One address's involvement in one canonical transaction. */
export interface AddressActivity {
  txId: string;
  height: number;
  blockHash: string;
  timestamp: number;
  received: bigint;
  sent: bigint;
}

function heightKey(height: number): string {
  return `height:${height}`;
}

function serializeUndo(undo: BlockUndo): string {
  return JSON.stringify(undo, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

function serializeHeader(entry: IndexedHeader): string {
  return JSON.stringify({ header: entry.header, work: entry.work.toString() });
}

function deserializeHeader(raw: string): IndexedHeader {
  const parsed = JSON.parse(raw) as { header: BlockHeader; work: string };
  return { header: parsed.header, work: BigInt(parsed.work) };
}

function deserializeUndo(raw: string): BlockUndo {
  const parsed = JSON.parse(raw) as BlockUndo;
  for (const tx of parsed) {
    for (const spent of tx.spent) {
      spent.entry.amount = BigInt(spent.entry.amount as unknown as string);
    }
  }
  return parsed;
}

export class ChainState {
  constructor(
    private readonly blocks: Sublevel,
    private readonly meta: Sublevel,
    private readonly undo: Sublevel,
    private readonly headers: Sublevel,
    private readonly txIndex: Sublevel,
    private readonly addrIndex: Sublevel,
  ) {}

  /**
   * Transaction index: txId -> canonical block hash, maintained inside the
   * adoption batch (added on connect, removed on disconnect) so it always
   * reflects the canonical chain. What getMerkleProof needs to find a
   * transaction's block without scanning the chain.
   */
  async getTxLocation(txId: string): Promise<{ blockHash: string } | undefined> {
    const blockHash = await this.txIndex.get(txId);
    return blockHash === undefined ? undefined : { blockHash };
  }

  putTxLocationOp(txId: string, blockHash: string): StateBatchOperation {
    return { type: "put", sublevel: this.txIndex, key: txId, value: blockHash };
  }

  deleteTxLocationOp(txId: string): StateBatchOperation {
    return { type: "del", sublevel: this.txIndex, key: txId };
  }

  /**
   * Address index: what each address received and sent in each canonical
   * transaction, maintained inside the adoption batch like the tx index so
   * it follows reorgs. Keys sort by address then height, so one range
   * scan (reversed) gives an address's history newest first.
   */
  putAddressActivityOp(activity: AddressActivity & { address: string }): StateBatchOperation {
    const { address, txId, height, ...rest } = activity;
    return {
      type: "put",
      sublevel: this.addrIndex,
      key: addressActivityKey(address, height, txId),
      value: JSON.stringify({ ...rest, received: rest.received.toString(), sent: rest.sent.toString() }),
    };
  }

  deleteAddressActivityOp(address: string, height: number, txId: string): StateBatchOperation {
    return { type: "del", sublevel: this.addrIndex, key: addressActivityKey(address, height, txId) };
  }

  async listAddressActivity(address: string, limit: number): Promise<AddressActivity[]> {
    const out: AddressActivity[] = [];
    const prefix = `${address}:`;
    for await (const [key, raw] of this.addrIndex.iterator({ gte: prefix, lt: `${prefix}\xff`, reverse: true, limit })) {
      const [, heightText, txId] = key.split(":");
      const value = JSON.parse(raw) as { blockHash: string; timestamp: number; received: string; sent: string };
      out.push({ txId: txId!, height: Number(heightText), blockHash: value.blockHash, timestamp: value.timestamp, received: BigInt(value.received), sent: BigInt(value.sent) });
    }
    return out;
  }

  async isAddrIndexBuilt(): Promise<boolean> {
    return (await this.meta.get(ADDR_INDEX_BUILT_KEY)) === "1";
  }

  markAddrIndexBuiltOp(): StateBatchOperation {
    return { type: "put", sublevel: this.meta, key: ADDR_INDEX_BUILT_KEY, value: "1" };
  }

  async getAddrIndexDepth(): Promise<number | undefined> {
    const raw = await this.meta.get(ADDR_INDEX_DEPTH_KEY);
    return raw === undefined ? undefined : Number(raw);
  }

  setAddrIndexDepthOp(depth: number): StateBatchOperation {
    return { type: "put", sublevel: this.meta, key: ADDR_INDEX_DEPTH_KEY, value: String(depth) };
  }

  /** Forgets the address index entirely (entries and the built marker), for a node that runs without one. */
  async dropAddressIndex(): Promise<void> {
    await this.addrIndex.clear();
    await this.meta.batch([
      { type: "del", key: ADDR_INDEX_BUILT_KEY },
      { type: "del", key: ADDR_INDEX_DEPTH_KEY },
    ]);
  }

  /** Every address-index key whose entry is below `height`: what a tighter depth setting sweeps at startup. */
  async *addressActivityKeysBelow(height: number): AsyncGenerator<string> {
    for await (const key of this.addrIndex.keys()) {
      if (Number(key.split(":")[1]) < height) yield key;
    }
  }

  deleteAddressActivityKeyOp(key: string): StateBatchOperation {
    return { type: "del", sublevel: this.addrIndex, key };
  }

  async isTxIndexBuilt(): Promise<boolean> {
    return (await this.meta.get(TX_INDEX_BUILT_KEY)) === "1";
  }

  async markTxIndexBuilt(): Promise<void> {
    await this.meta.put(TX_INDEX_BUILT_KEY, "1");
  }

  markTxIndexBuiltOp(): StateBatchOperation {
    return { type: "put", sublevel: this.meta, key: TX_INDEX_BUILT_KEY, value: "1" };
  }

  /**
   * Header index: every header that passed header-level validation, with
   * the cumulative work of its chain. Lets fork choice and header-first
   * sync answer "how heavy is the chain ending here?" in one read instead
   * of walking back to genesis. Headers may be indexed before (or without
   * ever) having their block body.
   */
  async putHeader(hash: string, header: BlockHeader, work: bigint): Promise<void> {
    await this.headers.put(hash, serializeHeader({ header, work }));
  }

  async getHeader(hash: string): Promise<IndexedHeader | undefined> {
    const raw = await this.headers.get(hash);
    return raw === undefined ? undefined : deserializeHeader(raw);
  }

  putHeaderOp(hash: string, header: BlockHeader, work: bigint): StateBatchOperation {
    return { type: "put", sublevel: this.headers, key: hash, value: serializeHeader({ header, work }) };
  }

  async putBlock(block: Block): Promise<void> {
    await this.blocks.put(block.hash, serializeBlock(block));
  }

  async getBlock(hash: string): Promise<Block | undefined> {
    const raw = await this.blocks.get(hash);
    return raw === undefined ? undefined : deserializeBlock(raw);
  }

  async putUndo(blockHash: string, undo: BlockUndo): Promise<void> {
    await this.undo.put(blockHash, serializeUndo(undo));
  }

  async getUndo(blockHash: string): Promise<BlockUndo | undefined> {
    const raw = await this.undo.get(blockHash);
    return raw === undefined ? undefined : deserializeUndo(raw);
  }

  async deleteUndo(blockHash: string): Promise<void> {
    await this.undo.del(blockHash);
  }

  async setTip(hash: string, height: number): Promise<void> {
    await this.meta.batch([
      { type: "put", key: TIP_HASH_KEY, value: hash },
      { type: "put", key: TIP_HEIGHT_KEY, value: height.toString() },
    ]);
  }

  async getTip(): Promise<ChainTip | undefined> {
    const hash = await this.meta.get(TIP_HASH_KEY);
    const height = await this.meta.get(TIP_HEIGHT_KEY);
    if (hash === undefined || height === undefined) {
      return undefined;
    }
    return { hash, height: Number(height) };
  }

  async setCanonicalHashAtHeight(height: number, hash: string): Promise<void> {
    await this.meta.put(heightKey(height), hash);
  }

  async getCanonicalHashAtHeight(height: number): Promise<string | undefined> {
    return this.meta.get(heightKey(height));
  }

  /** Removes canonical entries for heights in (keepUpTo, clearUpTo] -- used
   *  when a reorg adopts a chain shorter than the previous tip. */
  async clearCanonicalHashesAbove(keepUpTo: number, clearUpTo: number): Promise<void> {
    const ops = this.clearCanonicalHashesAboveOps(keepUpTo, clearUpTo);
    if (ops.length > 0) await this.meta.batch(ops.map(({ key }) => ({ type: "del" as const, key })));
  }

  // --- Batch-op variants: return root-db ops instead of writing, so a
  // whole chain adoption can be committed as one atomic LevelDB batch. ---

  putBlockOp(block: Block): StateBatchOperation {
    return { type: "put", sublevel: this.blocks, key: block.hash, value: serializeBlock(block) };
  }

  putUndoOp(blockHash: string, undo: BlockUndo): StateBatchOperation {
    return { type: "put", sublevel: this.undo, key: blockHash, value: serializeUndo(undo) };
  }

  deleteUndoOp(blockHash: string): StateBatchOperation {
    return { type: "del", sublevel: this.undo, key: blockHash };
  }

  setTipOps(hash: string, height: number): StateBatchOperation[] {
    return [
      { type: "put", sublevel: this.meta, key: TIP_HASH_KEY, value: hash },
      { type: "put", sublevel: this.meta, key: TIP_HEIGHT_KEY, value: height.toString() },
    ];
  }

  setCanonicalHashAtHeightOp(height: number, hash: string): StateBatchOperation {
    return { type: "put", sublevel: this.meta, key: heightKey(height), value: hash };
  }

  clearCanonicalHashesAboveOps(keepUpTo: number, clearUpTo: number): StateBatchOperation[] {
    const ops: StateBatchOperation[] = [];
    for (let h = keepUpTo + 1; h <= clearUpTo; h++) {
      ops.push({ type: "del", sublevel: this.meta, key: heightKey(h) });
    }
    return ops;
  }
}

function addressActivityKey(address: string, height: number, txId: string): string {
  return `${address}:${String(height).padStart(HEIGHT_WIDTH, "0")}:${txId}`;
}
