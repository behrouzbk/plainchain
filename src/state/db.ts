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

/**
 * Opening a new LevelDB writes a temp file and renames it to CURRENT. On
 * Windows another program (typically an antivirus scanning the new file)
 * can hold it for a moment, and the rename fails with "Access is denied".
 * Those failures are worth retrying; anything else (corruption, a bad
 * path, a second process holding the LOCK) is not.
 */
const TRANSIENT_OPEN_ERROR = /Access is denied|being used by another process/i;

/** Waits before each retry; about 1.5 s in total before the real error is thrown. */
const OPEN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

export async function retryTransientOpen(
  open: () => Promise<void>,
  delaysMs: readonly number[] = OPEN_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await open();
    } catch (err) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !TRANSIENT_OPEN_ERROR.test(String((err as Error)?.message))) throw err;
      await sleep(delay);
    }
  }
}

/** The implementation hook abstract-level calls inside `open()`. */
interface OpenHook {
  _open(options: unknown): Promise<void>;
}

export function openStateDb(location: string): StateDb {
  const root = new Level<string, string>(location, { valueEncoding: "utf8" });
  // The deferred open starts on the next microtask, so the hook is in place
  // before it runs. Operations queued while the database opens just wait
  // longer instead of failing with "Database is not open".
  const openOnce = (Level.prototype as unknown as OpenHook)._open;
  (root as unknown as OpenHook)._open = (options) => retryTransientOpen(() => openOnce.call(root, options));

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
