import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { computeTransactionId, getSigningPayload } from "../../src/ledger/transaction.js";
import type { Transaction, UnsignedTransactionBody } from "../../src/ledger/types.js";
import { Mempool } from "../../src/mempool/mempool.js";
import { closeStateDb, openStateDb, type StateDb } from "../../src/state/db.js";
import { UtxoSet } from "../../src/state/utxoSet.js";

function finalize(body: UnsignedTransactionBody): Transaction {
  return { ...body, id: computeTransactionId(body) };
}

function coinbase(address: string, amount: bigint, timestamp = 1700000000000): Transaction {
  return finalize({ inputs: [], outputs: [{ address, amount }], timestamp, fee: 0n });
}

function spend(
  owner: { publicKey: string; privateKey: string },
  outpoint: { txId: string; outputIndex: number },
  outputs: { address: string; amount: bigint }[],
  fee: bigint,
  timestamp = 1700000000001,
): Transaction {
  const body: UnsignedTransactionBody = {
    inputs: [{ ...outpoint, signature: "", publicKey: owner.publicKey }],
    outputs,
    timestamp,
    fee,
  };
  const payload = getSigningPayload(body);
  body.inputs[0]!.signature = sign(owner.privateKey, payload);
  return finalize(body);
}

describe("Mempool", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;
  let mempool: Mempool;
  let alice: { publicKey: string; privateKey: string };
  let aliceAddress: string;
  let bobAddress: string;
  let cb: Transaction;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-mempool-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
    mempool = new Mempool(utxoSet);

    alice = generateKeyPair();
    aliceAddress = deriveAddress(alice.publicKey);
    bobAddress = deriveAddress(generateKeyPair().publicKey);

    cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid, positive-fee transaction spending an existing UTXO", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    const result = await mempool.addTransaction(tx);
    expect(result.valid).toBe(true);
    expect(mempool.has(tx.id)).toBe(true);
    expect(mempool.size()).toBe(1);
  });

  it("rejects a duplicate transaction (same id already pending)", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    await mempool.addTransaction(tx);
    const result = await mempool.addTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/duplicate/i);
    expect(mempool.size()).toBe(1);
  });

  it("rejects a zero-fee transaction", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }], 0n);
    const result = await mempool.addTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/fee/i);
    expect(mempool.size()).toBe(0);
  });

  it("rejects a transaction with an invalid signature", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    tx.outputs[0]!.amount = 1n; // tamper after signing
    const result = await mempool.addTransaction(tx);
    expect(result.valid).toBe(false);
    expect(mempool.size()).toBe(0);
  });

  it("rejects a coinbase-style transaction (no inputs) submitted directly", async () => {
    const tx = coinbase(bobAddress, 500n);
    const result = await mempool.addTransaction(tx);
    expect(result.valid).toBe(false);
    expect(mempool.size()).toBe(0);
  });

  it("rejects a transaction spending a UTXO already spent by another pending mempool tx (mempool double-spend)", async () => {
    const first = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    await mempool.addTransaction(first);

    // Pays less than the pending spend: not a valid replacement (see the
    // replace-by-fee suite for the case where it outbids it).
    const second = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 950n }], 50n, 1700000000002);
    const result = await mempool.addTransaction(second);
    expect(result.valid).toBe(false);
    expect(mempool.size()).toBe(1);
    expect(mempool.has(first.id)).toBe(true);
  });

  it("orders pending transactions by descending fee", async () => {
    const carolAddress = deriveAddress(generateKeyPair().publicKey);
    const cb2 = coinbase(aliceAddress, 1000n, 1700000000000 + 1);
    await utxoSet.applyTransaction(cb2);

    const lowFee = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 990n }], 10n);
    const highFee = spend(alice, { txId: cb2.id, outputIndex: 0 }, [{ address: carolAddress, amount: 500n }], 500n, 1700000000003);

    await mempool.addTransaction(lowFee);
    await mempool.addTransaction(highFee);

    const ordered = mempool.getTransactionsByFee();
    expect(ordered.map((t) => t.id)).toEqual([highFee.id, lowFee.id]);
  });

  it("removes transactions (e.g. after they are included in a mined block)", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    await mempool.addTransaction(tx);
    mempool.remove(tx.id);
    expect(mempool.has(tx.id)).toBe(false);
    expect(mempool.size()).toBe(0);
  });

  it("rejects spending an immature coinbase output when a spendingHeight and coinbaseMaturity are configured", async () => {
    const matureUtxoSet = new UtxoSet(db.utxo, 10);
    const matureMempool = new Mempool(matureUtxoSet);

    const immatureCb = coinbase(aliceAddress, 1000n, 1700000000010);
    await matureUtxoSet.applyTransaction(immatureCb, 5); // matures at height 15

    const tx = spend(alice, { txId: immatureCb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }], 1n);
    const result = await matureMempool.addTransaction(tx, 14); // one block short
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/matur/i);
  });
});

describe("Mempool size limits and eviction", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;
  let alice: { publicKey: string; privateKey: string };
  let aliceAddress: string;
  let bobAddress: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-mempool-limit-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);

    alice = generateKeyPair();
    aliceAddress = deriveAddress(alice.publicKey);
    bobAddress = deriveAddress(generateKeyPair().publicKey);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function fundedTx(amount: bigint, fee: bigint, salt: number): Promise<Transaction> {
    const cb = coinbase(aliceAddress, amount, 1700000000000 + salt);
    await utxoSet.applyTransaction(cb);
    return spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: amount - fee }], fee, 1700000001000 + salt);
  }

  it("rejects a new transaction once the mempool is full and its fee does not exceed the lowest pending fee", async () => {
    const mempool = new Mempool(utxoSet, 2);
    const tx1 = await fundedTx(1000n, 50n, 1);
    const tx2 = await fundedTx(1000n, 60n, 2);
    const tx3 = await fundedTx(1000n, 10n, 3); // lower fee than both pending

    expect((await mempool.addTransaction(tx1)).valid).toBe(true);
    expect((await mempool.addTransaction(tx2)).valid).toBe(true);
    expect(mempool.size()).toBe(2);

    const result = await mempool.addTransaction(tx3);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/full|capacity/i);
    expect(mempool.size()).toBe(2);
    expect(mempool.has(tx1.id)).toBe(true);
    expect(mempool.has(tx2.id)).toBe(true);
  });

  it("evicts the lowest-fee pending transaction to make room for a higher-fee one at capacity", async () => {
    const mempool = new Mempool(utxoSet, 2);
    const lowFee = await fundedTx(1000n, 10n, 1);
    const midFee = await fundedTx(1000n, 50n, 2);
    const highFee = await fundedTx(1000n, 500n, 3);

    expect((await mempool.addTransaction(lowFee)).valid).toBe(true);
    expect((await mempool.addTransaction(midFee)).valid).toBe(true);
    expect(mempool.size()).toBe(2);

    const result = await mempool.addTransaction(highFee);
    expect(result.valid).toBe(true);
    expect(mempool.size()).toBe(2);
    expect(mempool.has(lowFee.id)).toBe(false); // evicted
    expect(mempool.has(midFee.id)).toBe(true);
    expect(mempool.has(highFee.id)).toBe(true);
  });

  it("rejects a transaction below a configured minFee even though its fee is positive", async () => {
    const mempool = new Mempool(utxoSet, Infinity, 100n);
    const tx = await fundedTx(1000n, 50n, 1); // positive fee, but below minFee
    const result = await mempool.addTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/fee/i);
  });

  it("does not restrict mempool size when no maxSize is configured", async () => {
    const mempool = new Mempool(utxoSet);
    for (let i = 0; i < 5; i++) {
      const tx = await fundedTx(1000n, 10n + BigInt(i), i);
      expect((await mempool.addTransaction(tx)).valid).toBe(true);
    }
    expect(mempool.size()).toBe(5);
  });
});

describe("Mempool replace-by-fee", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;
  let alice: { publicKey: string; privateKey: string };
  let aliceAddress: string;
  let bobAddress: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-mempool-rbf-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
    alice = generateKeyPair();
    aliceAddress = deriveAddress(alice.publicKey);
    bobAddress = deriveAddress(generateKeyPair().publicKey);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function fund(amount: bigint, salt: number): Promise<Transaction> {
    const cb = coinbase(aliceAddress, amount, 1700000000000 + salt);
    await utxoSet.applyTransaction(cb);
    return cb;
  }

  /** Spends several outpoints in one transaction. */
  function spendMany(outpoints: { txId: string; outputIndex: number }[], to: string, amount: bigint, fee: bigint, ts: number): Transaction {
    const body: UnsignedTransactionBody = {
      inputs: outpoints.map((o) => ({ ...o, signature: "", publicKey: alice.publicKey })),
      outputs: [{ address: to, amount }],
      timestamp: ts,
      fee,
    };
    const signature = sign(alice.privateKey, getSigningPayload(body));
    for (const input of body.inputs) input.signature = signature;
    return finalize(body);
  }

  it("replaces a pending transaction with a conflicting one that pays at least the old fee plus minFee", async () => {
    const mempool = new Mempool(utxoSet, Infinity, 10n);
    const cb = await fund(1000n, 1);
    const original = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    expect((await mempool.addTransaction(original)).valid).toBe(true);

    const bumped = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 890n }], 110n, 1700000000002);
    const result = await mempool.addTransaction(bumped);
    expect(result).toEqual({ valid: true, replaced: [original.id] });
    expect(mempool.has(original.id)).toBe(false);
    expect(mempool.has(bumped.id)).toBe(true);
    expect(mempool.size()).toBe(1);

    // The outpoint is now claimed by the replacement only: the original
    // can't sneak back in.
    const again = await mempool.addTransaction(original);
    expect(again.valid).toBe(false);
    expect(again.reason).toMatch(/replace|fee/i);
  });

  it("attack: a conflicting transaction that does not pay for the replacement is rejected (cheap double-spend attempts)", async () => {
    const mempool = new Mempool(utxoSet, Infinity, 10n);
    const cb = await fund(1000n, 1);
    const original = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    await mempool.addTransaction(original);

    for (const fee of [50n, 100n, 109n]) {
      const rival = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: aliceAddress, amount: 1000n - fee }], fee, 1700000000002);
      const result = await mempool.addTransaction(rival);
      expect(result.valid, `fee ${fee}`).toBe(false);
      expect(result.reason).toMatch(/replace.*fee|fee.*replace/i);
      expect(result.reason).toContain("110"); // tells the sender what it would take
    }
    expect(mempool.has(original.id)).toBe(true);
    expect(mempool.size()).toBe(1);
  });

  it("a replacement that conflicts with several pending transactions must outbid their combined fees", async () => {
    const mempool = new Mempool(utxoSet, Infinity, 1n);
    const cbA = await fund(500n, 1);
    const cbB = await fund(500n, 2);
    const txA = spend(alice, { txId: cbA.id, outputIndex: 0 }, [{ address: bobAddress, amount: 460n }], 40n, 1700000000010);
    const txB = spend(alice, { txId: cbB.id, outputIndex: 0 }, [{ address: bobAddress, amount: 440n }], 60n, 1700000000011);
    await mempool.addTransaction(txA);
    await mempool.addTransaction(txB);

    const outpoints = [{ txId: cbA.id, outputIndex: 0 }, { txId: cbB.id, outputIndex: 0 }];
    const tooLow = spendMany(outpoints, bobAddress, 900n, 100n, 1700000000012); // 40 + 60 + 1 = 101 needed
    expect((await mempool.addTransaction(tooLow)).valid).toBe(false);
    expect(mempool.size()).toBe(2);

    const enough = spendMany(outpoints, bobAddress, 899n, 101n, 1700000000013);
    const result = await mempool.addTransaction(enough);
    expect(result.valid).toBe(true);
    expect(result.replaced?.sort()).toEqual([txA.id, txB.id].sort());
    expect(mempool.getTransactions().map((t) => t.id)).toEqual([enough.id]);
  });

  it("attack: refuses a replacement that would evict more than maxReplacements pending transactions at once", async () => {
    const mempool = new Mempool(utxoSet, Infinity, 1n, { maxReplacements: 2 });
    const cbs = [await fund(100n, 1), await fund(100n, 2), await fund(100n, 3)];
    for (const [i, cb] of cbs.entries()) {
      await mempool.addTransaction(spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 90n }], 10n, 1700000000020 + i));
    }
    const sweep = spendMany(cbs.map((cb) => ({ txId: cb.id, outputIndex: 0 })), bobAddress, 200n, 100n, 1700000000030);
    const result = await mempool.addTransaction(sweep);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/too many|maxReplacements|at most 2/i);
    expect(mempool.size()).toBe(3);
  });

  it("a replacement is still subject to full validation: an invalid conflicting tx evicts nothing", async () => {
    const mempool = new Mempool(utxoSet, Infinity, 1n);
    const cb = await fund(1000n, 1);
    const original = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 900n }], 100n);
    await mempool.addTransaction(original);
    // Pays a higher fee but tries to create more value than it spends.
    const inflated = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 5000n }], 200n, 1700000000002);
    expect((await mempool.addTransaction(inflated)).valid).toBe(false);
    expect(mempool.has(original.id)).toBe(true);
  });

  it("capacity eviction and replacement compose: a replacement at capacity does not evict an unrelated tx", async () => {
    const mempool = new Mempool(utxoSet, 2, 1n);
    const cb1 = await fund(1000n, 1);
    const cb2 = await fund(1000n, 2);
    const tx1 = spend(alice, { txId: cb1.id, outputIndex: 0 }, [{ address: bobAddress, amount: 990n }], 10n, 1700000000001);
    const tx2 = spend(alice, { txId: cb2.id, outputIndex: 0 }, [{ address: bobAddress, amount: 950n }], 50n, 1700000000002);
    await mempool.addTransaction(tx1);
    await mempool.addTransaction(tx2);
    // Replaces tx1 (the lowest-fee one); the mempool is full but the
    // replacement frees its own slot, so tx2 must stay.
    const bump = spend(alice, { txId: cb1.id, outputIndex: 0 }, [{ address: bobAddress, amount: 980n }], 20n, 1700000000003);
    expect((await mempool.addTransaction(bump)).valid).toBe(true);
    expect(mempool.getTransactions().map((t) => t.id).sort()).toEqual([tx2.id, bump.id].sort());
  });
});
