import { describe, expect, it } from "vitest";
import { computeBlockHash } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";
import { createGenesisBlock } from "../../src/ledger/block.js";
import type { Transaction } from "../../src/ledger/types.js";
import { decodeMessage, encodeMessage, type Message } from "../../src/network/protocol.js";

describe("encodeMessage / decodeMessage", () => {
  it("round-trips a HANDSHAKE message without a listenAddress", () => {
    const message: Message = {
      type: "HANDSHAKE",
      payload: { version: 1, nodeId: "node-a", height: 3 },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a HANDSHAKE message with a listenAddress", () => {
    const message: Message = {
      type: "HANDSHAKE",
      payload: { version: 1, nodeId: "node-a", height: 3, listenAddress: "ws://localhost:8001" },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a GET_PEERS message", () => {
    const message: Message = { type: "GET_PEERS", payload: {} };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a PEERS message", () => {
    const message: Message = {
      type: "PEERS",
      payload: { addresses: ["ws://localhost:8001", "ws://localhost:8002"] },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a GET_BLOCKS message", () => {
    const message: Message = { type: "GET_BLOCKS", payload: { fromHeight: 5 } };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a GET_BLOCKS message with a block locator", () => {
    const message: Message = { type: "GET_BLOCKS", payload: { fromHeight: 5, locator: ["h5", "h4", "h2", "h0"] } };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips GET_HEADERS / HEADERS messages (header-first sync)", () => {
    const get: Message = { type: "GET_HEADERS", payload: { locator: ["h5", "h0"] } };
    expect(decodeMessage(encodeMessage(get))).toEqual(get);
    const header = {
      version: 1,
      previousHash: "ab".repeat(32),
      merkleRoot: "cd".repeat(32),
      timestamp: 1,
      difficultyTarget: "f".repeat(64),
      nonce: 3,
      height: 1,
    };
    const headers: Message = { type: "HEADERS", payload: { headers: [header] } };
    expect(decodeMessage(encodeMessage(headers))).toEqual(headers);
  });

  it("round-trips an INV_BLOCKS message", () => {
    const message: Message = { type: "INV_BLOCKS", payload: { hashes: ["a", "b"] } };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a NEW_BLOCK message, preserving bigint output amounts", () => {
    const genesis = createGenesisBlock({
      timestamp: 1700000000000,
      difficultyTarget: "f".repeat(64),
      reward: 5000000000n,
      genesisAddress: "genesis",
    });
    const message: Message = { type: "NEW_BLOCK", payload: { block: genesis } };

    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded).toEqual(message);
    if (decoded.type === "NEW_BLOCK") {
      expect(typeof decoded.payload.block.transactions[0]!.outputs[0]!.amount).toBe("bigint");
    }
  });

  it("round-trips a NEW_TX message, preserving bigint fee and amounts", () => {
    const tx: Transaction = {
      id: "ef".repeat(32),
      inputs: [{ txId: "01".repeat(32), outputIndex: 0, signature: "5169", publicKey: "9b" }],
      outputs: [{ address: "alice", amount: 123456789012345n }],
      timestamp: 1700000000001,
      fee: 7n,
    };
    const message: Message = { type: "NEW_TX", payload: { transaction: tx } };

    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded).toEqual(message);
    if (decoded.type === "NEW_TX") {
      expect(typeof decoded.payload.transaction.fee).toBe("bigint");
    }
  });

  it("throws on malformed JSON", () => {
    expect(() => decodeMessage("not json")).toThrow();
  });

  describe("attack: payload shapes are validated at the boundary, not trusted", () => {
    const header = {
      version: 1,
      previousHash: "ab".repeat(32),
      merkleRoot: "cd".repeat(32),
      timestamp: 1700000001000,
      difficultyTarget: "f".repeat(64),
      nonce: 7,
      height: 1,
    };
    const hashOf = (h: object): string => computeBlockHash(h as BlockHeader);
    const tx = { id: "ef".repeat(32), inputs: [], outputs: [{ address: "a", amount: 5n }], timestamp: 1700000001000, fee: 0n };
    const raw = (message: unknown): string => encodeMessage(message as Message);

    it("a header field of the wrong type (a numeric string timestamp hashes identically) is refused", () => {
      const ok = raw({ type: "HEADERS", payload: { headers: [header] } });
      expect(() => decodeMessage(ok)).not.toThrow();
      const stringTs = { ...header, timestamp: String(header.timestamp) };
      expect(hashOf(stringTs)).toBe(hashOf(header)); // why this matters: the hash cannot tell them apart
      expect(() => decodeMessage(raw({ type: "HEADERS", payload: { headers: [stringTs] } }))).toThrow(/timestamp/);
      expect(() => decodeMessage(raw({ type: "HEADERS", payload: { headers: [{ ...header, height: "1" }] } }))).toThrow(/height/);
      expect(() => decodeMessage(raw({ type: "HEADERS", payload: { headers: [{ ...header, previousHash: "xyz" }] } }))).toThrow(/previousHash/);
      expect(() => decodeMessage(raw({ type: "HEADERS", payload: { headers: [{ ...header, signer: 42 }] } }))).toThrow(/signer/);
      expect(() => decodeMessage(raw({ type: "HEADERS", payload: { headers: ["nope"] } }))).toThrow(/header/);
      expect(() => decodeMessage(raw({ type: "HEADERS", payload: { headers: "nope" } }))).toThrow(/headers/);
    });

    it("a block whose claimed hash is not the hash of its header is refused (a claimed hash could poison a real block)", () => {
      const block = { header, transactions: [tx], hash: hashOf(header) };
      expect(() => decodeMessage(raw({ type: "NEW_BLOCK", payload: { block } }))).not.toThrow();
      const claimed = { ...block, hash: "00".repeat(32) };
      expect(() => decodeMessage(raw({ type: "NEW_BLOCK", payload: { block: claimed } }))).toThrow(/hash/);
      expect(() => decodeMessage(raw({ type: "NEW_BLOCK", payload: { block: { ...block, transactions: "x" } } }))).toThrow(/transactions/);
      expect(() => decodeMessage(raw({ type: "NEW_BLOCK", payload: { block: { ...block, transactions: [{ ...tx, outputs: [{ address: "a", amount: 5 }] }] } } }))).toThrow(/amount/);
    });

    it("unknown header keys are dropped and the header is rebuilt in canonical field order (block size is measured on it)", () => {
      const padded = { junk: "x".repeat(1000), ...header, more: 1 };
      const decoded = decodeMessage(raw({ type: "HEADERS", payload: { headers: [padded] } })) as { payload: { headers: BlockHeader[] } };
      expect(Object.keys(decoded.payload.headers[0]!)).toEqual(["version", "previousHash", "merkleRoot", "timestamp", "difficultyTarget", "nonce", "height"]);
      const signed = { ...header, signature: "aa", signer: "bb" };
      const decodedSigned = decodeMessage(raw({ type: "HEADERS", payload: { headers: [signed] } })) as { payload: { headers: BlockHeader[] } };
      expect(Object.keys(decodedSigned.payload.headers[0]!).slice(-2)).toEqual(["signer", "signature"]);
    });

    it("a transaction with a number amount (not a bigint) or a bad shape is refused", () => {
      expect(() => decodeMessage(raw({ type: "NEW_TX", payload: { transaction: tx } }))).not.toThrow();
      expect(() => decodeMessage(raw({ type: "NEW_TX", payload: { transaction: { ...tx, fee: 1 } } }))).toThrow(/fee/);
      expect(() => decodeMessage(raw({ type: "NEW_TX", payload: { transaction: { ...tx, inputs: [{ txId: 1 }] } } }))).toThrow(/inputs/);
      expect(() => decodeMessage(raw({ type: "NEW_TX", payload: { transaction: null } }))).toThrow(/transaction/);
    });

    it("locators, inventories and peer lists must be arrays of strings", () => {
      expect(() => decodeMessage(raw({ type: "GET_HEADERS", payload: { locator: [1] } }))).toThrow(/locator/);
      expect(() => decodeMessage(raw({ type: "INV_BLOCKS", payload: { hashes: "x" } }))).toThrow(/hashes/);
      expect(() => decodeMessage(raw({ type: "PEERS", payload: { addresses: [{}] } }))).toThrow(/addresses/);
      expect(() => decodeMessage(raw({ type: "GET_BLOCKS", payload: { fromHeight: "0" } }))).toThrow(/fromHeight/);
      expect(() => decodeMessage(raw({ type: "HANDSHAKE", payload: { nodeId: 5 } }))).toThrow(/nodeId/);
    });
  });
});
