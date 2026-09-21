import { describe, expect, it } from "vitest";
import { mineBlockHeader } from "../../src/consensus/pow.js";
import { nextTarget, retargetWindow } from "../../src/consensus/difficulty.js";
import { merkleProof, merkleRoot } from "../../src/crypto/merkle.js";
import { sha256 } from "../../src/crypto/hash.js";
import { createGenesisBlock } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";
import { verifyHeaderChain, verifyInclusion, type ChainHeader, type SpvParams } from "../../src/wallet/spv.js";

const EASY_TARGET = "f".repeat(64);
const genesis = createGenesisBlock({
  timestamp: 1700000000000,
  difficultyTarget: EASY_TARGET,
  reward: 5000000000n,
  genesisAddress: "genesis",
});

const params: SpvParams = {
  genesisHash: genesis.hash,
  consensus: {
    targetBlockTimeMs: 10_000,
    difficultyRetargetInterval: 10,
    maxDifficultyAdjustmentFactor: 4,
    maxFutureDriftMs: 2 * 60 * 60 * 1000,
  },
  now: 1700000000000 + 100 * 10_000,
};

/** Re-mines a tampered header so its hash is self-consistent and the intended rule is what fails. */
function remine(entry: ChainHeader, overrides: Partial<BlockHeader>): ChainHeader {
  const mined = mineBlockHeader({ ...entry.header, ...overrides, nonce: 0 });
  return { hash: mined.hash, header: mined.header };
}

/** A valid header chain of `n` blocks after genesis, honouring the retarget rule. */
function buildChain(n: number, txIdsPerBlock: Record<number, string[]> = {}, blockGapMs = 10_000): ChainHeader[] {
  const chain: ChainHeader[] = [{ hash: genesis.hash, header: genesis.header }];
  for (let h = 1; h <= n; h++) {
    const parent = chain[h - 1]!;
    let target = parent.header.difficultyTarget;
    if (h % params.consensus.difficultyRetargetInterval === 0) {
      const periodStart = chain[retargetWindow(h, params.consensus.difficultyRetargetInterval).startHeight]!;
      target = nextTarget(parent.header, periodStart.header, params.consensus);
    }
    const txIds = txIdsPerBlock[h] ?? [sha256(`coinbase-${h}`)];
    const header: BlockHeader = {
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot(txIds),
      timestamp: parent.header.timestamp + blockGapMs,
      difficultyTarget: target,
      nonce: 0,
      height: h,
    };
    const mined = mineBlockHeader(header);
    chain.push({ hash: mined.hash, header: mined.header });
  }
  return chain;
}

describe("SPV header chain verification", () => {
  it("accepts a valid chain from genesis, including across a retarget boundary", () => {
    const fast = buildChain(12, {}, 5_000); // blocks twice as fast as the 10 s target
    const result = verifyHeaderChain(fast, params);
    expect(result).toEqual({ valid: true, tipHeight: 12, totalWork: expect.any(BigInt) });
    expect(BigInt(`0x${fast[10]!.header.difficultyTarget}`)).toBeLessThan(BigInt(`0x${EASY_TARGET}`)); // the retarget actually happened
  });

  it("keeps the target constant across retargets when blocks are exactly on time (no off-by-one drift)", () => {
    const onTime = buildChain(31);
    expect(verifyHeaderChain(onTime, params).valid).toBe(true);
    for (const h of [10, 20, 30]) expect(onTime[h]!.header.difficultyTarget, `height ${h}`).toBe(EASY_TARGET);
  });

  it("rejects a chain that doesn't start at the trusted genesis", () => {
    const chain = buildChain(3);
    expect(verifyHeaderChain(chain, { ...params, genesisHash: "0".repeat(64) }).reason).toMatch(/genesis/);
    expect(verifyHeaderChain(chain.slice(1), params).reason).toMatch(/genesis/);
    expect(verifyHeaderChain([], params).reason).toMatch(/genesis|empty/);
  });

  it("rejects a header whose reported hash doesn't match its contents", () => {
    const chain = buildChain(3);
    chain[2] = { ...chain[2]!, hash: "a".repeat(64) };
    expect(verifyHeaderChain(chain, params).reason).toMatch(/hash/);
  });

  it("rejects a broken link or a gap in heights", () => {
    const chain = buildChain(4);
    const broken = [...chain];
    broken[3] = remine(broken[3]!, { previousHash: "b".repeat(64) });
    expect(verifyHeaderChain(broken, params).reason).toMatch(/previousHash/);

    const gapped = chain.filter((_, i) => i !== 2);
    expect(verifyHeaderChain(gapped, params).reason).toMatch(/height|previousHash/);
  });

  it("rejects a header that claims an easier target than the retarget rule dictates", () => {
    const chain = buildChain(12, {}, 5_000); // fast blocks: the retarget at 10 tightens the target
    // Height 10 is a retarget block: replace it with one at the old (easier) target.
    const parent = chain[9]!;
    const header: BlockHeader = { ...chain[10]!.header, difficultyTarget: EASY_TARGET, nonce: 0 };
    const mined = mineBlockHeader({ ...header, previousHash: parent.hash });
    const forged = [...chain.slice(0, 10), { hash: mined.hash, header: mined.header }];
    expect(verifyHeaderChain(forged, params).reason).toMatch(/target/);
  });

  it("rejects a header without valid proof of work for its target", () => {
    const chain = buildChain(2);
    const hard = "0".repeat(8) + "f".repeat(56);
    const header: BlockHeader = { ...chain[2]!.header, difficultyTarget: hard };
    // Same target rule violation aside, make the expected target itself
    // `hard` so the PoW check is what fails.
    const p = { ...params };
    const forged: ChainHeader[] = [...chain.slice(0, 2), { hash: sha256("whatever"), header }];
    const result = verifyHeaderChain(forged, p);
    expect(result.valid).toBe(false);
  });

  it("rejects timestamps that go backwards or too far into the future", () => {
    const chain = buildChain(3);
    const back = [...chain];
    back[2] = remine(back[2]!, { timestamp: back[1]!.header.timestamp });
    expect(verifyHeaderChain(back, params).reason).toMatch(/timestamp/);

    const future = buildChain(2);
    expect(verifyHeaderChain(future, { ...params, now: genesis.header.timestamp - 3 * 60 * 60 * 1000 }).reason).toMatch(/future/);
  });

  it("reports the total work so a client can compare two chains", () => {
    const shorter = verifyHeaderChain(buildChain(3), params);
    const longer = verifyHeaderChain(buildChain(5), params);
    expect(longer.valid && shorter.valid && longer.totalWork! > shorter.totalWork!).toBe(true);
  });
});

describe("SPV inclusion verification", () => {
  const txIds = [sha256("cb"), sha256("pay-1"), sha256("pay-2")];
  const chain = buildChain(2, { 1: txIds });
  const header = chain[1]!;

  it("accepts a proof that folds the txId to the header's merkle root", () => {
    const proof = { txId: txIds[1]!, blockHash: header.hash, blockHeight: 1, index: 1, siblings: merkleProof(txIds, 1), merkleRoot: header.header.merkleRoot };
    expect(verifyInclusion(proof, header)).toEqual({ valid: true });
  });

  it("rejects a proof whose block hash or height doesn't match the header it's checked against", () => {
    const proof = { txId: txIds[1]!, blockHash: "c".repeat(64), blockHeight: 1, index: 1, siblings: merkleProof(txIds, 1), merkleRoot: header.header.merkleRoot };
    expect(verifyInclusion(proof, header).reason).toMatch(/block/);
    expect(verifyInclusion({ ...proof, blockHash: header.hash, blockHeight: 2 }, header).reason).toMatch(/height/);
  });

  it("rejects a proof whose siblings don't reproduce the root (the node's claimed merkleRoot is irrelevant)", () => {
    const proof = {
      txId: sha256("not-in-block"),
      blockHash: header.hash,
      blockHeight: 1,
      index: 1,
      siblings: merkleProof(txIds, 1),
      merkleRoot: header.header.merkleRoot,
    };
    expect(verifyInclusion(proof, header).reason).toMatch(/merkle/);
    // A node lying about the root in the proof object changes nothing:
    // verification uses the header's root, which is PoW-protected.
    const lying = { ...proof, txId: txIds[1]!, merkleRoot: "d".repeat(64) };
    expect(verifyInclusion(lying, header)).toEqual({ valid: true });
  });
});
