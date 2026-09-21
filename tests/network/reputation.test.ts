import { describe, expect, it } from "vitest";
import { PeerReputation } from "../../src/network/reputation.js";

describe("PeerReputation", () => {
  it("bans a key once accumulated penalties reach the threshold", () => {
    const rep = new PeerReputation({ banThreshold: 100, banDurationMs: 1000 });
    expect(rep.penalize("p1", 40, 0)).toBe(false);
    expect(rep.penalize("p1", 40, 0)).toBe(false);
    expect(rep.isBanned("p1", 0)).toBe(false);
    expect(rep.penalize("p1", 20, 0)).toBe(true);
    expect(rep.isBanned("p1", 0)).toBe(true);
  });

  it("keeps scores per key", () => {
    const rep = new PeerReputation({ banThreshold: 100, banDurationMs: 1000 });
    rep.penalize("p1", 100, 0);
    expect(rep.isBanned("p2", 0)).toBe(false);
  });

  it("lifts the ban and forgets the score once the ban duration elapses", () => {
    const rep = new PeerReputation({ banThreshold: 100, banDurationMs: 1000 });
    rep.penalize("p1", 100, 0);
    expect(rep.isBanned("p1", 999)).toBe(true);
    expect(rep.isBanned("p1", 1000)).toBe(false);
    // Score reset: a single small penalty after expiry must not re-ban.
    expect(rep.penalize("p1", 10, 1000)).toBe(false);
  });

  it("can ban a key outright, regardless of score", () => {
    const rep = new PeerReputation({ banThreshold: 100, banDurationMs: 1000 });
    rep.ban("p1", 0);
    expect(rep.isBanned("p1", 0)).toBe(true);
    expect(rep.isBanned("p1", 1000)).toBe(false);
  });

  it("does not extend an existing ban when penalized again while banned", () => {
    const rep = new PeerReputation({ banThreshold: 100, banDurationMs: 1000 });
    rep.penalize("p1", 100, 0);
    rep.penalize("p1", 100, 500);
    expect(rep.isBanned("p1", 1000)).toBe(false);
  });
});
