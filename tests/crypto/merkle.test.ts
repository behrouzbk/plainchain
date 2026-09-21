import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/crypto/hash.js";
import { merkleProof, merkleRoot, verifyMerkleProof } from "../../src/crypto/merkle.js";

describe("merkleRoot", () => {
  it("throws on an empty list", () => {
    expect(() => merkleRoot([])).toThrow();
  });

  it("returns the single hash itself for a one-element list", () => {
    const h = sha256("tx1");
    expect(merkleRoot([h])).toBe(h);
  });

  it("combines two hashes deterministically", () => {
    const a = sha256("tx1");
    const b = sha256("tx2");
    const expected = sha256(a + b);
    expect(merkleRoot([a, b])).toBe(expected);
  });

  it("duplicates the last hash when the list has odd length", () => {
    const a = sha256("tx1");
    const b = sha256("tx2");
    const c = sha256("tx3");
    // level 1: [ab, cc] ; root: sha256(ab + cc)
    const ab = sha256(a + b);
    const cc = sha256(c + c);
    const expected = sha256(ab + cc);
    expect(merkleRoot([a, b, c])).toBe(expected);
  });

  it("is order-sensitive", () => {
    const a = sha256("tx1");
    const b = sha256("tx2");
    expect(merkleRoot([a, b])).not.toBe(merkleRoot([b, a]));
  });

  it("is deterministic across repeated calls", () => {
    const hashes = [sha256("tx1"), sha256("tx2"), sha256("tx3"), sha256("tx4")];
    expect(merkleRoot(hashes)).toBe(merkleRoot(hashes));
  });
});

describe("merkle inclusion proofs", () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => sha256(`tx${i}`));

  it("proves every leaf of trees of size 1..9 against the root", () => {
    for (let n = 1; n <= 9; n++) {
      const hashes = leaves(n);
      const root = merkleRoot(hashes);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(hashes, i);
        expect(verifyMerkleProof(hashes[i]!, proof, root)).toBe(true);
        expect(proof.length).toBe(n === 1 ? 0 : Math.ceil(Math.log2(n)));
      }
    }
  });

  it("a single-leaf tree has an empty proof and the leaf is the root", () => {
    const [only] = leaves(1);
    expect(merkleProof([only!], 0)).toEqual([]);
    expect(verifyMerkleProof(only!, [], only!)).toBe(true);
    expect(verifyMerkleProof(only!, [], sha256("other"))).toBe(false);
  });

  it("rejects a proof for a different leaf, a tampered sibling, or a flipped position", () => {
    const hashes = leaves(5);
    const root = merkleRoot(hashes);
    const proof = merkleProof(hashes, 2);

    expect(verifyMerkleProof(hashes[3]!, proof, root)).toBe(false);
    const tampered = proof.map((s, i) => (i === 0 ? { ...s, hash: sha256("evil") } : s));
    expect(verifyMerkleProof(hashes[2]!, tampered, root)).toBe(false);
    const flipped = proof.map((s, i) =>
      i === 0 ? { ...s, position: s.position === "left" ? ("right" as const) : ("left" as const) } : s,
    );
    expect(verifyMerkleProof(hashes[2]!, flipped, root)).toBe(false);
  });

  it("rejects a truncated or extended proof", () => {
    const hashes = leaves(8);
    const root = merkleRoot(hashes);
    const proof = merkleProof(hashes, 5);
    expect(verifyMerkleProof(hashes[5]!, proof.slice(1), root)).toBe(false);
    expect(verifyMerkleProof(hashes[5]!, [...proof, { hash: sha256("x"), position: "right" }], root)).toBe(false);
  });

  it("throws for an index outside the tree", () => {
    expect(() => merkleProof(leaves(3), 3)).toThrow(/index/);
    expect(() => merkleProof(leaves(3), -1)).toThrow(/index/);
    expect(() => merkleProof([], 0)).toThrow();
  });

  it("rejects malformed sibling hashes instead of hashing garbage", () => {
    const hashes = leaves(2);
    const root = merkleRoot(hashes);
    expect(verifyMerkleProof(hashes[0]!, [{ hash: "not-hex", position: "right" }], root)).toBe(false);
  });
});
