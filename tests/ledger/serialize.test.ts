import { describe, expect, it } from "vitest";
import { computeBlockHash, createGenesisBlock } from "../../src/ledger/block.js";
import {
  deserializeBlock,
  deserializeTransaction,
  serializeBlock,
  serializeTransaction,
  parseWireChainHeader,
  parseWireHeader,
  WireShapeError,
} from "../../src/ledger/serialize.js";
import type { Transaction } from "../../src/ledger/types.js";

describe("transaction serialize/deserialize round-trip", () => {
  it("preserves all fields including bigint amounts and fee", () => {
    const tx: Transaction = {
      id: "txid1",
      inputs: [
        { txId: "prev", outputIndex: 0, signature: "sig", publicKey: "pub" },
      ],
      outputs: [{ address: "alice", amount: 123456789012345678n }],
      timestamp: 1700000000000,
      fee: 42n,
    };

    const json = serializeTransaction(tx);
    expect(typeof json).toBe("string");

    const roundTripped = deserializeTransaction(json);
    expect(roundTripped).toEqual(tx);
    expect(typeof roundTripped.outputs[0]!.amount).toBe("bigint");
    expect(typeof roundTripped.fee).toBe("bigint");
  });

  it("round-trips a transaction with no inputs (coinbase)", () => {
    const tx: Transaction = {
      id: "coinbase-id",
      inputs: [],
      outputs: [{ address: "genesis", amount: 5000000000n }],
      timestamp: 1700000000000,
      fee: 0n,
    };
    expect(deserializeTransaction(serializeTransaction(tx))).toEqual(tx);
  });
});

describe("block serialize/deserialize round-trip", () => {
  it("preserves the genesis block exactly, including bigint output amounts", () => {
    const genesis = createGenesisBlock({
      timestamp: 1700000000000,
      difficultyTarget: "f".repeat(64),
      reward: 5000000000n,
      genesisAddress: "genesis",
    });

    const json = serializeBlock(genesis);
    const roundTripped = deserializeBlock(json);

    expect(roundTripped).toEqual(genesis);
    expect(typeof roundTripped.transactions[0]!.outputs[0]!.amount).toBe(
      "bigint",
    );
  });
});

describe("parseWireHeader: untrusted headers are type-checked and canonicalized", () => {
  const genesis = createGenesisBlock({ timestamp: 1700000000000, difficultyTarget: "f".repeat(64), reward: 1n, genesisAddress: "g" });
  const header = { ...genesis.header, previousHash: "ab".repeat(32), height: 1 };

  it("accepts a well-formed header and rebuilds it in canonical field order without unknown keys", () => {
    const parsed = parseWireHeader({ extra: 1, ...header, more: "x" });
    expect(parsed).toEqual(header);
    expect(Object.keys(parsed)).toEqual(["version", "previousHash", "merkleRoot", "timestamp", "difficultyTarget", "nonce", "height"]);
    expect(parseWireChainHeader({ hash: computeBlockHash(header), header })).toEqual({ hash: computeBlockHash(header), header });
  });

  it("attack: a numeric-string timestamp hashes like the real header but is refused", () => {
    const bad = { ...header, timestamp: String(header.timestamp) };
    expect(computeBlockHash(bad as never)).toBe(computeBlockHash(header));
    expect(() => parseWireHeader(bad)).toThrow(WireShapeError);
    expect(() => parseWireHeader(bad)).toThrow(/timestamp/);
    expect(() => parseWireHeader({ ...header, nonce: -1 })).toThrow(/nonce/);
    expect(() => parseWireHeader({ ...header, height: 1.5 })).toThrow(/height/);
    expect(() => parseWireHeader({ ...header, merkleRoot: "deadbeef" })).toThrow(/merkleRoot/);
    expect(() => parseWireHeader({ ...header, signer: "aa" })).toThrow(/signature/); // a signer without a signature
    expect(() => parseWireHeader(null)).toThrow(/object/);
    expect(() => parseWireChainHeader({ hash: "nope", header })).toThrow(/hash/);
  });

  it("keeps a proof-of-authority seal when both halves are hex", () => {
    const sealed = parseWireHeader({ ...header, signer: "302a", signature: "beef" });
    expect(sealed.signer).toBe("302a");
    expect(sealed.signature).toBe("beef");
    expect(Object.keys(sealed).slice(-2)).toEqual(["signer", "signature"]);
  });
});
