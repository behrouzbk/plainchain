import { describe, expect, it } from "vitest";
import { computeBlockHash, createGenesisBlock, genesisAllocationTotal } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";

function baseHeader(): BlockHeader {
  return {
    version: 1,
    previousHash: "0".repeat(64),
    merkleRoot: "a".repeat(64),
    timestamp: 1700000000000,
    difficultyTarget: "f".repeat(64),
    nonce: 0,
    height: 0,
  };
}

describe("computeBlockHash", () => {
  it("is deterministic for an identical header", () => {
    expect(computeBlockHash(baseHeader())).toBe(computeBlockHash(baseHeader()));
  });

  it("changes when the nonce changes", () => {
    const a = baseHeader();
    const b = { ...baseHeader(), nonce: 1 };
    expect(computeBlockHash(a)).not.toBe(computeBlockHash(b));
  });

  it("changes when the previousHash changes", () => {
    const a = baseHeader();
    const b = { ...baseHeader(), previousHash: "1".repeat(64) };
    expect(computeBlockHash(a)).not.toBe(computeBlockHash(b));
  });

  it("changes when the merkleRoot changes", () => {
    const a = baseHeader();
    const b = { ...baseHeader(), merkleRoot: "b".repeat(64) };
    expect(computeBlockHash(a)).not.toBe(computeBlockHash(b));
  });
});

describe("createGenesisBlock", () => {
  const config = {
    timestamp: 1700000000000,
    difficultyTarget: "0".repeat(4) + "f".repeat(60),
    reward: 5000000000n,
    genesisAddress: "genesis",
  };

  it("has height 0 and an all-zero previousHash", () => {
    const genesis = createGenesisBlock(config);
    expect(genesis.header.height).toBe(0);
    expect(genesis.header.previousHash).toBe("0".repeat(64));
  });

  it("contains exactly one coinbase-style transaction paying the genesis address", () => {
    const genesis = createGenesisBlock(config);
    expect(genesis.transactions).toHaveLength(1);
    expect(genesis.transactions[0]!.outputs).toEqual([
      { address: "genesis", amount: 5000000000n },
    ]);
  });

  it("supports a multi-output genesis allocation, hash-compatible with the single-address shorthand", () => {
    const shorthand = createGenesisBlock(config);
    const explicit = createGenesisBlock({ ...config, allocations: [{ address: "genesis", amount: 5000000000n }] });
    expect(explicit.hash).toBe(shorthand.hash);

    const multi = createGenesisBlock({ ...config, allocations: [{ address: "a", amount: 1n }, { address: "b", amount: 2n }] });
    expect(multi.transactions[0]!.outputs).toEqual([
      { address: "a", amount: 1n },
      { address: "b", amount: 2n },
    ]);
    expect(multi.hash).not.toBe(shorthand.hash);
    expect(genesisAllocationTotal({ ...config, allocations: [{ address: "a", amount: 1n }, { address: "b", amount: 2n }] })).toBe(3n);
    expect(genesisAllocationTotal(config)).toBe(5000000000n);
  });

  it("refuses an empty allocation or a non-positive amount (the genesis coinbase must be a valid transaction)", () => {
    expect(() => createGenesisBlock({ ...config, allocations: [] })).toThrow(/allocation/);
    expect(() => createGenesisBlock({ ...config, allocations: [{ address: "a", amount: 0n }] })).toThrow(/amount/);
    expect(() => createGenesisBlock({ ...config, reward: -1n })).toThrow(/amount/);
  });

  it("is fully deterministic given identical config", () => {
    const a = createGenesisBlock(config);
    const b = createGenesisBlock(config);
    expect(a.hash).toBe(b.hash);
    expect(a.header.merkleRoot).toBe(b.header.merkleRoot);
  });

  it("has a hash consistent with computeBlockHash(header)", () => {
    const genesis = createGenesisBlock(config);
    expect(genesis.hash).toBe(computeBlockHash(genesis.header));
  });
});
