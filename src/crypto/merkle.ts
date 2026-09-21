import { sha256 } from "./hash.js";

export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) {
    throw new Error("merkleRoot: cannot compute the root of an empty list");
  }

  let level = hashes;

  while (level.length > 1) {
    level = nextLevel(level);
  }

  return level[0] as string;
}

/** One step up the tree: pairs are hashed, an odd trailing node is paired with itself. */
function nextLevel(level: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i] as string;
    const right = (level[i + 1] ?? left) as string;
    next.push(sha256(left + right));
  }
  return next;
}

/** A sibling on the path from a leaf to the root, and which side it sits on. */
export interface MerkleProofStep {
  hash: string;
  position: "left" | "right";
}

export type MerkleProof = MerkleProofStep[];

/**
 * The siblings needed to recompute the root from `hashes[index]`, bottom
 * up. ~log2(n) hashes: what a light client needs to check a transaction is
 * in a block without the block. (An odd node's sibling is itself, matching
 * merkleRoot; consensus rejects duplicate tx ids, so the classic
 * duplicate-last-tx mutation can't produce a second valid block.)
 */
export function merkleProof(hashes: string[], index: number): MerkleProof {
  if (hashes.length === 0) {
    throw new Error("merkleProof: cannot prove membership in an empty list");
  }
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) {
    throw new Error(`merkleProof: index ${index} out of range for ${hashes.length} leaves`);
  }

  const proof: MerkleProof = [];
  let level = hashes;
  let i = index;
  while (level.length > 1) {
    const siblingIndex = i % 2 === 0 ? i + 1 : i - 1;
    const sibling = (level[siblingIndex] ?? level[i]) as string;
    proof.push({ hash: sibling, position: i % 2 === 0 ? "right" : "left" });
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

const HASH_HEX = /^[0-9a-f]{64}$/;

/** True if folding `leaf` up through `proof` reproduces `root`. */
export function verifyMerkleProof(leaf: string, proof: MerkleProof, root: string): boolean {
  if (!HASH_HEX.test(leaf) || !HASH_HEX.test(root)) return false;
  let current = leaf;
  for (const step of proof) {
    if (!HASH_HEX.test(step.hash)) return false;
    if (step.position === "right") current = sha256(current + step.hash);
    else if (step.position === "left") current = sha256(step.hash + current);
    else return false;
  }
  return current === root;
}
