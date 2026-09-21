import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/rpc/rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to maxRequests per window per client, then rejects", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 }, () => now);

    expect(limiter.consume("1.2.3.4")).toEqual({ allowed: true });
    expect(limiter.consume("1.2.3.4")).toEqual({ allowed: true });
    expect(limiter.consume("1.2.3.4")).toEqual({ allowed: true });
    const rejected = limiter.consume("1.2.3.4");
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.retryAfterMs).toBeGreaterThan(0);
      expect(rejected.retryAfterMs).toBeLessThanOrEqual(1000);
    }

    // Other clients are independent.
    expect(limiter.consume("5.6.7.8")).toEqual({ allowed: true });
    now += 1;
    expect(limiter.consume("1.2.3.4").allowed).toBe(false); // still inside the window
  });

  it("weights a request so a batch of N counts as N", () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 }, () => 0);
    expect(limiter.consume("c", 4).allowed).toBe(true);
    expect(limiter.consume("c", 2).allowed).toBe(false); // 4 + 2 > 5
    expect(limiter.consume("c", 1).allowed).toBe(true); // 4 + 1 = 5
  });

  it("resets once the window has elapsed", () => {
    let now = 0;
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100 }, () => now);
    expect(limiter.consume("c").allowed).toBe(true);
    expect(limiter.consume("c").allowed).toBe(false);
    now = 101;
    expect(limiter.consume("c").allowed).toBe(true);
  });

  it("bounds memory by evicting stale clients", () => {
    let now = 0;
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100, maxClients: 2 }, () => now);
    limiter.consume("a");
    limiter.consume("b");
    now = 500; // both stale
    limiter.consume("c");
    expect(limiter.trackedClients()).toBeLessThanOrEqual(2);
  });
});
