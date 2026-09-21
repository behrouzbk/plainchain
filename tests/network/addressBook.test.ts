import { describe, expect, it } from "vitest";
import { AddressBook } from "../../src/network/addressBook.js";

const opts = { maxSize: 5, baseBackoffMs: 1000, maxBackoffMs: 8000, maxFailures: 3 };

describe("AddressBook", () => {
  it("offers fresh addresses immediately, excluding ones the caller is already connected to", () => {
    const book = new AddressBook(opts);
    book.add("ws://a:1", 0);
    book.add("ws://b:1", 0);
    book.add("ws://c:1", 0);
    expect(book.candidates(new Set(["ws://b:1"]), 10, 0).sort()).toEqual(["ws://a:1", "ws://c:1"]);
    expect(book.candidates(new Set(), 1, 0)).toHaveLength(1);
  });

  it("backs off exponentially after failures and forgets a non-anchor after maxFailures", () => {
    const book = new AddressBook(opts);
    book.add("ws://flaky:1", 0);
    book.markFailure("ws://flaky:1", 0);
    expect(book.candidates(new Set(), 10, 999)).toEqual([]);
    expect(book.candidates(new Set(), 10, 1000)).toEqual(["ws://flaky:1"]);
    book.markFailure("ws://flaky:1", 1000);
    expect(book.candidates(new Set(), 10, 2999)).toEqual([]);
    expect(book.candidates(new Set(), 10, 3000)).toEqual(["ws://flaky:1"]);
    book.markFailure("ws://flaky:1", 3000); // third failure: gone
    expect(book.size).toBe(0);
  });

  it("caps backoff at maxBackoffMs and resets it on success", () => {
    const book = new AddressBook({ ...opts, maxFailures: 100 });
    book.add("ws://x:1", 0);
    for (let i = 0; i < 10; i++) book.markFailure("ws://x:1", 0);
    expect(book.candidates(new Set(), 10, 7999)).toEqual([]);
    expect(book.candidates(new Set(), 10, 8000)).toEqual(["ws://x:1"]);
    book.markSuccess("ws://x:1", 8000);
    book.markFailure("ws://x:1", 8000);
    expect(book.candidates(new Set(), 10, 9000)).toEqual(["ws://x:1"]); // back to base backoff
  });

  it("never forgets an anchor (a configured --peers address), only backs it off", () => {
    const book = new AddressBook(opts);
    book.add("ws://anchor:1", 0, { anchor: true });
    for (let i = 0; i < 20; i++) book.markFailure("ws://anchor:1", 0);
    expect(book.size).toBe(1);
    expect(book.candidates(new Set(), 10, 8000)).toEqual(["ws://anchor:1"]);
    // Re-adding an anchor as a discovered address keeps it an anchor.
    book.add("ws://anchor:1", 0);
    expect(book.toJSON()[0]!.anchor).toBe(true);
  });

  it("prefers anchors, then the most recently seen addresses", () => {
    const book = new AddressBook({ ...opts, maxSize: 10 });
    book.add("ws://old:1", 0);
    book.add("ws://new:1", 500);
    book.add("ws://anchor:1", 0, { anchor: true });
    expect(book.candidates(new Set(), 10, 1000)).toEqual(["ws://anchor:1", "ws://new:1", "ws://old:1"]);
  });

  it("attack: refuses to grow past maxSize, so a flood of bogus addresses is bounded", () => {
    const book = new AddressBook(opts);
    for (let i = 0; i < 1000; i++) book.add(`ws://bogus-${i}:1`, 0);
    expect(book.size).toBe(5);
    // A known address is still refreshed even when the book is full.
    expect(book.add("ws://bogus-0:1", 42)).toBe(true);
    expect(book.add("ws://bogus-999:1", 42)).toBe(false);
    // Anchors always fit: they are the operator's explicit choice.
    expect(book.add("ws://anchor:1", 0, { anchor: true })).toBe(true);
  });

  it("round-trips through JSON", () => {
    const book = new AddressBook(opts);
    book.add("ws://a:1", 10, { anchor: true });
    book.add("ws://b:1", 20);
    book.markFailure("ws://b:1", 30);
    const restored = AddressBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())), opts);
    expect(restored.toJSON()).toEqual(book.toJSON());
    expect(restored.candidates(new Set(), 10, 5000)).toEqual(["ws://a:1", "ws://b:1"]);
  });

  it("ignores malformed records when restoring", () => {
    const restored = AddressBook.fromJSON([{ address: "ws://ok:1", anchor: false, failures: 0, nextAttemptAt: 0, lastSeenAt: 0 }, { nope: true }, null], opts);
    expect(restored.size).toBe(1);
  });
});
