export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  /** Upper bound on tracked clients; stale ones are evicted first. */
  maxClients?: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

interface Window {
  start: number;
  count: number;
}

/**
 * Fixed-window counter per client. Dependency-free and good enough to stop
 * a single client from monopolizing the node; it is not a DDoS defense.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly maxClients: number;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.maxClients = config.maxClients ?? 10_000;
  }

  /** @param weight how many requests this counts as (e.g. a JSON-RPC batch size). */
  consume(clientId: string, weight = 1): RateLimitDecision {
    const now = this.now();
    let window = this.windows.get(clientId);

    if (!window || now - window.start >= this.config.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(clientId, window);
    }

    if (window.count + weight > this.config.maxRequests) {
      return { allowed: false, retryAfterMs: Math.max(1, window.start + this.config.windowMs - now) };
    }

    window.count += weight;
    if (this.windows.size > this.maxClients) this.evictStale(now);
    return { allowed: true };
  }

  trackedClients(): number {
    return this.windows.size;
  }

  private evictStale(now: number): void {
    for (const [id, window] of this.windows) {
      if (now - window.start >= this.config.windowMs) this.windows.delete(id);
    }
    // Still over the cap (all active): drop the oldest windows.
    if (this.windows.size > this.maxClients) {
      const oldest = [...this.windows.entries()].sort((a, b) => a[1].start - b[1].start);
      for (const [id] of oldest.slice(0, this.windows.size - this.maxClients)) this.windows.delete(id);
    }
  }
}
