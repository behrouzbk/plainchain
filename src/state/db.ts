import { Level } from "level";
import type { AbstractBatchOperation, AbstractSublevel } from "abstract-level";

export type Sublevel = AbstractSublevel<
  Level<string, string>,
  string | Buffer | Uint8Array,
  string,
  string
>;

/**
 * A write op for the root database, tagged with the sublevel it targets.
 * Ops for several sublevels can be committed together with
 * `commitAtomic`, which LevelDB applies all-or-nothing.
 */
export type StateBatchOperation = AbstractBatchOperation<Level<string, string>, string, string>;

export async function commitAtomic(db: StateDb, ops: StateBatchOperation[]): Promise<void> {
  if (ops.length === 0) return;
  await db.root.batch(ops);
}

export interface StateDb {
  root: Level<string, string>;
  blocks: Sublevel;
  utxo: Sublevel;
  meta: Sublevel;
  /** Per-block undo records (what connecting the block did to the UTXO set). */
  undo: Sublevel;
  /** Validated headers with cumulative chain work, keyed by block hash. */
  headers: Sublevel;
  /** Confirmed transaction id -> hash of the canonical block containing it. */
  txIndex: Sublevel;
  /** Peer address book (see network/addressBook.ts), one JSON document. */
  peers: Sublevel;
  /** Per-address activity: `<address>:<height>:<txId>` -> amounts received/sent (canonical chain only). */
  addrIndex: Sublevel;
  /** Anchored records: `<data>:<height>:<txId>` -> block hash + time (canonical chain only). */
  anchors: Sublevel;
}

export function openStateDb(location: string): StateDb {
  const root = new Level<string, string>(location, { valueEncoding: "utf8" });

  return {
    root,
    blocks: root.sublevel("blocks", { valueEncoding: "utf8" }),
    utxo: root.sublevel("utxo", { valueEncoding: "utf8" }),
    meta: root.sublevel("meta", { valueEncoding: "utf8" }),
    undo: root.sublevel("undo", { valueEncoding: "utf8" }),
    headers: root.sublevel("headers", { valueEncoding: "utf8" }),
    txIndex: root.sublevel("txindex", { valueEncoding: "utf8" }),
    peers: root.sublevel("peers", { valueEncoding: "utf8" }),
    addrIndex: root.sublevel("addrindex", { valueEncoding: "utf8" }),
    anchors: root.sublevel("anchors", { valueEncoding: "utf8" }),
  };
}

export async function closeStateDb(db: StateDb): Promise<void> {
  await db.root.close();
}
