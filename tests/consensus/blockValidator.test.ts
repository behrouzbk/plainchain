import { describe, expect, it } from "vitest";
import { merkleRoot } from "../../src/crypto/merkle.js";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { computeBlockHash, createGenesisBlock } from "../../src/ledger/block.js";
import { computeTransactionId, getSigningPayload } from "../../src/ledger/transaction.js";
import type { Block, BlockHeader, Transaction, UnsignedTransactionBody } from "../../src/ledger/types.js";
import { mineBlockHeader } from "../../src/consensus/pow.js";
import {
  DEFAULT_MAX_BLOCK_BYTES,
  DEFAULT_MAX_TRANSACTIONS_PER_BLOCK,
  FUTURE_TIMESTAMP_REASON,
  validateBlock,
  validateHeader,
  type BlockValidationContext,
  type HeaderValidationContext,
} from "../../src/consensus/blockValidator.js";
import { serializeBlock } from "../../src/ledger/serialize.js";

const EASY_TARGET = "f".repeat(64);
const REWARD = 5000000000n;
const NOW = 1700000100000;

const genesisMiner = generateKeyPair();
const genesisAddress = deriveAddress(genesisMiner.publicKey);
const genesis = createGenesisBlock({
  timestamp: 1700000000000,
  difficultyTarget: EASY_TARGET,
  reward: REWARD,
  genesisAddress,
});

function finalize(body: UnsignedTransactionBody): Transaction {
  return { ...body, id: computeTransactionId(body) };
}

function coinbase(amount: bigint, timestamp = NOW): Transaction {
  return finalize({ inputs: [], outputs: [{ address: "miner", amount }], timestamp, fee: 0n });
}

function spendGenesis(amount: bigint, fee: bigint, timestamp = NOW): Transaction {
  const body: UnsignedTransactionBody = {
    inputs: [{ txId: genesis.transactions[0]!.id, outputIndex: 0, signature: "", publicKey: genesisMiner.publicKey }],
    outputs: [{ address: "bob", amount }],
    timestamp,
    fee,
  };
  body.inputs[0]!.signature = sign(genesisMiner.privateKey, getSigningPayload(body));
  return finalize(body);
}

/** Builds a fully valid block on `parent`, then applies header overrides and re-mines. */
function buildBlock(
  parent: Block,
  transactions: Transaction[],
  headerOverrides: Partial<BlockHeader> = {},
  remine = true,
): Block {
  const header: BlockHeader = {
    version: 1,
    previousHash: parent.hash,
    merkleRoot: headerOverrides.merkleRoot ?? merkleRoot(transactions.map((t) => t.id)),
    timestamp: NOW,
    difficultyTarget: EASY_TARGET,
    nonce: 0,
    height: parent.header.height + 1,
    ...headerOverrides,
  };
  if (!remine) {
    return { header, transactions, hash: computeBlockHash(header) };
  }
  const mined = mineBlockHeader(header);
  return { header: mined.header, transactions, hash: mined.hash };
}

function ctx(overrides: Partial<BlockValidationContext> = {}): BlockValidationContext {
  return {
    parent: genesis,
    expectedTarget: EASY_TARGET,
    blockReward: REWARD,
    now: NOW,
    maxFutureDriftMs: 2 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("validateBlock", () => {
  it("accepts a well-formed block with a coinbase paying exactly reward + fees", () => {
    const tx = spendGenesis(1000n, 10n);
    const block = buildBlock(genesis, [coinbase(REWARD + 10n), tx]);
    expect(validateBlock(block, ctx())).toEqual({ valid: true });
  });

  it("attack: rejects a block with more transactions than maxTransactionsPerBlock", () => {
    const txs = [1n, 2n, 3n].map((fee, i) => spendGenesis(100n + BigInt(i), fee));
    const block = buildBlock(genesis, [coinbase(REWARD + 6n), ...txs]);
    // Distinct outpoints are needed for three spends: use three different outputs of genesis? Genesis has one, so
    // these spend the same outpoint and would fail the double-spend rule after the count rule -- the count rule
    // must fire first so the reason is unambiguous.
    const verdict = validateBlock(block, ctx({ maxTransactionsPerBlock: 3 }));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/4 transactions.*at most 3/);
    expect(validateBlock(buildBlock(genesis, [coinbase(REWARD)]), ctx({ maxTransactionsPerBlock: 1 })).valid).toBe(true);
  });

  it("attack: rejects a block whose canonical serialization exceeds maxBlockBytes", () => {
    const tx = spendGenesis(1000n, 10n);
    const block = buildBlock(genesis, [coinbase(REWARD + 10n), tx]);
    const size = Buffer.byteLength(serializeBlock(block), "utf8");
    expect(validateBlock(block, ctx({ maxBlockBytes: size })).valid).toBe(true);
    const verdict = validateBlock(block, ctx({ maxBlockBytes: size - 1 }));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(new RegExp(`${size} bytes.*at most ${size - 1}`));
  });

  it("applies the default limits when the context gives none (1 MB, 5000 transactions)", () => {
    expect(DEFAULT_MAX_BLOCK_BYTES).toBe(1_000_000);
    expect(DEFAULT_MAX_TRANSACTIONS_PER_BLOCK).toBe(5000);
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    expect(validateBlock(block, ctx()).valid).toBe(true);
  });

  it("accepts a coinbase paying less than reward + fees (miner may under-claim)", () => {
    const block = buildBlock(genesis, [coinbase(REWARD - 1n)]);
    expect(validateBlock(block, ctx()).valid).toBe(true);
  });

  it("rejects a block whose hash does not match its header", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    const forged = { ...block, hash: "0".repeat(64) };
    expect(validateBlock(forged, ctx()).reason).toMatch(/hash/i);
  });

  it("rejects a block whose hash does not meet its own target", () => {
    const hardTarget = "0".repeat(64);
    // Don't mine: nonce 0 will (essentially never) satisfy an all-zero target.
    const block = buildBlock(genesis, [coinbase(REWARD)], { difficultyTarget: hardTarget }, false);
    expect(validateBlock(block, ctx({ expectedTarget: hardTarget })).reason).toMatch(/target/i);
  });

  it("rejects a block that claims an easier target than the retarget rule dictates", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]); // claims EASY_TARGET
    const result = validateBlock(block, ctx({ expectedTarget: "0".repeat(8) + "f".repeat(56) }));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target/i);
  });

  it("rejects a block whose previousHash is not the parent's hash", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)], { previousHash: "1".repeat(64) });
    expect(validateBlock(block, ctx()).reason).toMatch(/previous|parent/i);
  });

  it("rejects a block whose height is not parent height + 1", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)], { height: 5 });
    expect(validateBlock(block, ctx()).reason).toMatch(/height/i);
  });

  it("rejects a timestamp not strictly after the parent's", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)], { timestamp: genesis.header.timestamp });
    expect(validateBlock(block, ctx()).reason).toMatch(/timestamp/i);
  });

  it("rejects a timestamp too far in the future", () => {
    const farFuture = NOW + 3 * 60 * 60 * 1000;
    const block = buildBlock(genesis, [coinbase(REWARD)], { timestamp: farFuture });
    expect(validateBlock(block, ctx()).reason).toMatch(/timestamp|future/i);
  });

  it("rejects a block with no transactions", () => {
    const block = buildBlock(genesis, [], { merkleRoot: "a".repeat(64) });
    expect(validateBlock(block, ctx()).reason).toMatch(/coinbase|transactions/i);
  });

  it("rejects a block whose first transaction is not a coinbase", () => {
    const block = buildBlock(genesis, [spendGenesis(1000n, 10n)]);
    expect(validateBlock(block, ctx()).reason).toMatch(/coinbase/i);
  });

  it("rejects a block with more than one coinbase (inflation)", () => {
    const block = buildBlock(genesis, [coinbase(REWARD), coinbase(REWARD, NOW + 1)]);
    expect(validateBlock(block, ctx()).reason).toMatch(/coinbase/i);
  });

  it("rejects a coinbase that claims more than reward + fees", () => {
    const tx = spendGenesis(1000n, 10n);
    const block = buildBlock(genesis, [coinbase(REWARD + 11n), tx]);
    const result = validateBlock(block, ctx());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/reward/i);
  });

  it("rejects a merkle root that does not match the transactions", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)], { merkleRoot: "b".repeat(64) });
    expect(validateBlock(block, ctx()).reason).toMatch(/merkle/i);
  });

  it("rejects a block containing the same transaction twice", () => {
    const tx = spendGenesis(1000n, 10n);
    const block = buildBlock(genesis, [coinbase(REWARD + 20n), tx, tx]);
    expect(validateBlock(block, ctx()).reason).toMatch(/duplicate/i);
  });

  it("rejects two transactions in one block spending the same outpoint", () => {
    const a = spendGenesis(1000n, 10n, NOW);
    const b = spendGenesis(2000n, 10n, NOW + 1); // different id, same input
    const block = buildBlock(genesis, [coinbase(REWARD + 20n), a, b]);
    expect(validateBlock(block, ctx()).reason).toMatch(/spent|outpoint/i);
  });

  it("rejects a block containing a structurally invalid transaction (negative amount)", () => {
    const bad = spendGenesis(-5n, 10n);
    const block = buildBlock(genesis, [coinbase(REWARD + 10n), bad]);
    expect(validateBlock(block, ctx()).valid).toBe(false);
  });
});

describe("validateHeader", () => {
  const hctx = (overrides: Partial<HeaderValidationContext> = {}): HeaderValidationContext => ({
    parent: { header: genesis.header, hash: genesis.hash },
    expectedTarget: EASY_TARGET,
    now: NOW,
    maxFutureDriftMs: 2 * 60 * 60 * 1000,
    ...overrides,
  });

  it("accepts a header that links to its parent, meets the expected target, and has a sane timestamp", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    expect(validateHeader(block.header, block.hash, hctx())).toEqual({ valid: true });
  });

  it("rejects a header whose hash doesn't match its contents", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    expect(validateHeader(block.header, "0".repeat(64), hctx()).valid).toBe(false);
  });

  it("rejects a header that doesn't meet its own target (no proof of work)", () => {
    const harder = "0".repeat(8) + "f".repeat(56);
    const block = buildBlock(genesis, [coinbase(REWARD)], { difficultyTarget: harder }, false);
    expect(validateHeader(block.header, block.hash, hctx({ expectedTarget: harder })).reason).toMatch(/meet/);
  });

  it("rejects a header claiming a different target than the retarget rule dictates", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    expect(validateHeader(block.header, block.hash, hctx({ expectedTarget: "0" + "f".repeat(63) })).reason).toMatch(/target/);
  });

  it("rejects a header with the wrong previousHash or height", () => {
    const wrongPrev = buildBlock(genesis, [coinbase(REWARD)], { previousHash: "1".repeat(64) });
    expect(validateHeader(wrongPrev.header, wrongPrev.hash, hctx()).reason).toMatch(/previousHash/);
    const wrongHeight = buildBlock(genesis, [coinbase(REWARD)], { height: 5 });
    expect(validateHeader(wrongHeight.header, wrongHeight.hash, hctx()).reason).toMatch(/height/);
  });

  it("rejects timestamps not after the parent's, or too far in the future", () => {
    const stale = buildBlock(genesis, [coinbase(REWARD)], { timestamp: genesis.header.timestamp });
    expect(validateHeader(stale.header, stale.hash, hctx()).reason).toMatch(/timestamp/);
    const future = buildBlock(genesis, [coinbase(REWARD)], { timestamp: NOW + 3 * 60 * 60 * 1000 });
    expect(validateHeader(future.header, future.hash, hctx()).reason).toBe(FUTURE_TIMESTAMP_REASON);
  });

  it("rejects a header at a checkpointed height whose hash differs from the checkpoint", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    expect(validateHeader(block.header, block.hash, hctx({ checkpoint: block.hash }))).toEqual({ valid: true });
    const verdict = validateHeader(block.header, block.hash, hctx({ checkpoint: "a".repeat(64) }));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/checkpoint/);
  });

  it("validateBlock applies the same checkpoint rule", () => {
    const block = buildBlock(genesis, [coinbase(REWARD)]);
    expect(validateBlock(block, ctx({ checkpoint: "a".repeat(64) })).reason).toMatch(/checkpoint/);
    expect(validateBlock(block, ctx({ checkpoint: block.hash })).valid).toBe(true);
  });
});
