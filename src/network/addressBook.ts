/**
 * Addresses of peers we have heard of, with dial outcomes, so the node can
 * keep itself connected without operator help: re-dial peers that dropped,
 * retry ones that were down (with backoff), and forget ones that never
 * answer. Pure and size-bounded; the node persists it and drives the
 * dialing.
 */

export interface AddressRecord {
  address: string;
  /** Configured via --peers: never forgotten, always dialed first. */
  anchor: boolean;
  /** Consecutive failed dials; reset on success. */
  failures: number;
  /** Earliest time (ms) the next dial may be attempted. */
  nextAttemptAt: number;
  /** Last time (ms) the address was learned, dialed successfully, or seen connected. */
  lastSeenAt: number;
}

export interface AddressBookOptions {
  maxSize: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Non-anchor addresses are dropped after this many consecutive failures. */
  maxFailures: number;
}

function isRecord(value: unknown): value is AddressRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.address === "string" &&
    typeof r.anchor === "boolean" &&
    typeof r.failures === "number" &&
    typeof r.nextAttemptAt === "number" &&
    typeof r.lastSeenAt === "number"
  );
}

export class AddressBook {
  private readonly records = new Map<string, AddressRecord>();

  constructor(private readonly options: AddressBookOptions) {}

  static fromJSON(raw: unknown, options: AddressBookOptions): AddressBook {
    const book = new AddressBook(options);
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (isRecord(entry)) book.records.set(entry.address, { ...entry });
      }
    }
    return book;
  }

  toJSON(): AddressRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  get size(): number {
    return this.records.size;
  }

  get(address: string): AddressRecord | undefined {
    return this.records.get(address);
  }

  /**
   * Records an address as seen now. Returns false when the book is full and
   * the address is new (anchors always fit).
   */
  add(address: string, now: number, options: { anchor?: boolean } = {}): boolean {
    const existing = this.records.get(address);
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt, now);
      if (options.anchor) existing.anchor = true;
      return true;
    }
    if (!options.anchor && this.records.size >= this.options.maxSize) return false;
    this.records.set(address, { address, anchor: options.anchor ?? false, failures: 0, nextAttemptAt: now, lastSeenAt: now });
    return true;
  }

  markSuccess(address: string, now: number): void {
    const record = this.records.get(address);
    if (!record) return;
    record.failures = 0;
    record.nextAttemptAt = now;
    record.lastSeenAt = now;
  }

  markFailure(address: string, now: number): void {
    const record = this.records.get(address);
    if (!record) return;
    record.failures += 1;
    if (!record.anchor && record.failures >= this.options.maxFailures) {
      this.records.delete(address);
      return;
    }
    const backoff = Math.min(this.options.baseBackoffMs * 2 ** (record.failures - 1), this.options.maxBackoffMs);
    record.nextAttemptAt = now + backoff;
  }

  /** Addresses worth dialing now: not excluded, backoff elapsed; anchors first, then most recently seen. */
  candidates(exclude: ReadonlySet<string>, limit: number, now: number): string[] {
    return [...this.records.values()]
      .filter((r) => !exclude.has(r.address) && r.nextAttemptAt <= now)
      .sort((a, b) => Number(b.anchor) - Number(a.anchor) || b.lastSeenAt - a.lastSeenAt || (a.address < b.address ? -1 : 1))
      .slice(0, limit)
      .map((r) => r.address);
  }
}
