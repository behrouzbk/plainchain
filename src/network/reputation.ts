export interface PeerReputationOptions {
  /** Accumulated penalty points at which a key gets banned. */
  banThreshold: number;
  /** How long a ban lasts; the score is forgotten when it expires. */
  banDurationMs: number;
}

/**
 * Misbehavior scoring with time-limited bans, keyed by an opaque string
 * (the transport decides what a key is -- see P2PServer). Pure and
 * clock-injected so it can be unit-tested without timers.
 *
 * This is a resource-protection mechanism ("stop spending CPU on a peer
 * that keeps feeding us invalid data, and don't redial it"), not Sybil
 * resistance: a key the peer controls can simply be rotated.
 */
export class PeerReputation {
  private readonly scores = new Map<string, number>();
  private readonly bans = new Map<string, number>(); // key -> expiresAt

  constructor(private readonly options: PeerReputationOptions) {}

  /** Adds `points` to `key`'s score. Returns true if this crossed the ban threshold. */
  penalize(key: string, points: number, now = Date.now()): boolean {
    if (this.isBanned(key, now)) return false;
    const score = (this.scores.get(key) ?? 0) + points;
    this.scores.set(key, score);
    if (score >= this.options.banThreshold) {
      this.ban(key, now);
      return true;
    }
    return false;
  }

  ban(key: string, now = Date.now()): void {
    this.bans.set(key, now + this.options.banDurationMs);
  }

  isBanned(key: string, now = Date.now()): boolean {
    const expiresAt = this.bans.get(key);
    if (expiresAt === undefined) return false;
    if (now >= expiresAt) {
      this.bans.delete(key);
      this.scores.delete(key);
      return false;
    }
    return true;
  }
}
