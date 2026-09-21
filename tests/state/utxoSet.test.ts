import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { computeTransactionId, getSigningPayload } from "../../src/ledger/transaction.js";
import type { Transaction, UnsignedTransactionBody } from "../../src/ledger/types.js";
import { closeStateDb, openStateDb, type StateDb } from "../../src/state/db.js";
import { UtxoSet } from "../../src/state/utxoSet.js";

function finalize(body: UnsignedTransactionBody): Transaction {
  return { ...body, id: computeTransactionId(body) };
}

function coinbase(address: string, amount: bigint): Transaction {
  return finalize({
    inputs: [],
    outputs: [{ address, amount }],
    timestamp: 1700000000000,
    fee: 0n,
  });
}

/** Builds a signed transaction spending one specific outpoint owned by `owner`. */
function spend(
  owner: { publicKey: string; privateKey: string },
  outpoint: { txId: string; outputIndex: number },
  outputs: { address: string; amount: bigint }[],
  fee = 0n,
): Transaction {
  const body: UnsignedTransactionBody = {
    inputs: [
      { ...outpoint, signature: "", publicKey: owner.publicKey },
    ],
    outputs,
    timestamp: 1700000000001,
    fee,
  };
  const payload = getSigningPayload(body);
  body.inputs[0]!.signature = sign(owner.privateKey, payload);
  return finalize(body);
}

describe("UtxoSet", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-utxo-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds coinbase outputs to the set and they become spendable", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const cb = coinbase(aliceAddress, 1000n);

    await utxoSet.applyTransaction(cb);

    const entry = await utxoSet.get(cb.id, 0);
    expect(entry).toEqual({ address: aliceAddress, amount: 1000n });
  });

  it("validates and applies a correctly signed spend, removing the input and adding new outputs", async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(bob.publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 900n },
    ], 100n);

    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(true);

    await utxoSet.applyTransaction(tx);

    expect(await utxoSet.get(cb.id, 0)).toBeUndefined();
    expect(await utxoSet.get(tx.id, 0)).toEqual({
      address: bobAddress,
      amount: 900n,
    });
  });

  it("rejects a double-spend of an already-spent output", async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(bob.publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    const firstSpend = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 1000n },
    ]);
    await utxoSet.applyTransaction(firstSpend);

    const doubleSpend = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 1000n },
    ]);

    const result = await utxoSet.validateTransaction(doubleSpend);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/utxo|spent|not found/i);
  });

  it("rejects a transaction referencing a nonexistent outpoint", async () => {
    const alice = generateKeyPair();
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const tx = spend(alice, { txId: "does-not-exist", outputIndex: 0 }, [
      { address: bobAddress, amount: 1n },
    ]);

    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(false);
  });

  it("rejects a spend signed by a key that does not own the referenced output", async () => {
    const alice = generateKeyPair();
    const mallory = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    // Mallory signs a transaction claiming Alice's output, using her own key.
    const tx = spend(mallory, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 1000n },
    ]);

    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/owner|signature|public key/i);
  });

  it("rejects a spend whose signature does not verify (tampered outputs)", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 1000n },
    ]);
    // Tamper with the output amount after signing, then re-derive the id so
    // the content-integrity check passes and only the signature is wrong.
    tx.outputs[0]!.amount = 999999n;
    const tampered: Transaction = { ...tx, id: computeTransactionId(tx) };

    const result = await utxoSet.validateTransaction(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it("rejects a spend where inputs are less than outputs plus fee", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 1000n },
    ], 100n); // 1000 in, but 1000 + 100 fee out -> insufficient

    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/insufficient|balance|amount/i);
  });

  it("getBalance sums all unspent outputs owned by an address, across multiple UTXOs", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    await utxoSet.applyTransaction(coinbase(aliceAddress, 500n));
    await utxoSet.applyTransaction(
      finalize({
        inputs: [],
        outputs: [{ address: aliceAddress, amount: 300n }],
        timestamp: 1700000000002,
        fee: 0n,
      }),
    );
    await utxoSet.applyTransaction(coinbase(bobAddress, 999n));

    expect(await utxoSet.getBalance(aliceAddress)).toBe(800n);
    expect(await utxoSet.getBalance(bobAddress)).toBe(999n);
  });

  it("getBalance returns 0 for an address with no unspent outputs", async () => {
    const unusedAddress = deriveAddress(generateKeyPair().publicKey);
    expect(await utxoSet.getBalance(unusedAddress)).toBe(0n);
  });

  it("getBalance excludes outputs that have since been spent", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);
    await utxoSet.applyTransaction(
      spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]),
    );

    expect(await utxoSet.getBalance(aliceAddress)).toBe(0n);
    expect(await utxoSet.getBalance(bobAddress)).toBe(1000n);
  });

  it("applyTransaction throws and does not mutate state when the transaction is invalid", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 1000n },
    ]);
    tx.outputs[0]!.amount = 5n; // tamper -> invalid signature

    await expect(utxoSet.applyTransaction(tx)).rejects.toThrow();

    // Original coinbase output must still be present and unspent.
    expect(await utxoSet.get(cb.id, 0)).toEqual({
      address: aliceAddress,
      amount: 1000n,
    });
  });
});

describe("UtxoSet undo log", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-utxo-undo-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("applyTransaction returns an undo record describing exactly what it consumed and created", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    const cbUndo = await utxoSet.applyTransaction(cb, 1);
    expect(cbUndo).toEqual({ spent: [], created: [{ txId: cb.id, outputIndex: 0 }] });

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 600n },
      { address: aliceAddress, amount: 400n },
    ]);
    const txUndo = await utxoSet.applyTransaction(tx, 2);
    expect(txUndo).toEqual({
      spent: [
        {
          txId: cb.id,
          outputIndex: 0,
          entry: { address: aliceAddress, amount: 1000n, blockHeight: 1, isCoinbase: true },
        },
      ],
      created: [
        { txId: tx.id, outputIndex: 0 },
        { txId: tx.id, outputIndex: 1 },
      ],
    });
  });

  it("undoTransaction restores the prior state exactly, including provenance of restored entries", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 1);
    const before = await utxoSet.listUnspent(aliceAddress);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    const undo = await utxoSet.applyTransaction(tx, 2);
    expect(await utxoSet.get(cb.id, 0)).toBeUndefined();
    expect(await utxoSet.get(tx.id, 0)).toBeDefined();

    await utxoSet.undoTransaction(undo);

    expect(await utxoSet.get(tx.id, 0)).toBeUndefined();
    expect(await utxoSet.listUnspent(aliceAddress)).toEqual(before);
    expect(await utxoSet.listUnspent(bobAddress)).toEqual([]);
    // Restored coinbase keeps its original height/flag, so maturity still applies.
    expect(before[0]).toMatchObject({ blockHeight: 1, isCoinbase: true });
  });

  it("a block's transactions can be undone in reverse to unwind the whole block", async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(bob.publicKey);
    const carolAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 1);

    // Block 2: alice -> bob, then bob -> carol (chained within the block).
    const t1 = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    const u1 = await utxoSet.applyTransaction(t1, 2);
    const t2 = spend(bob, { txId: t1.id, outputIndex: 0 }, [{ address: carolAddress, amount: 1000n }]);
    const u2 = await utxoSet.applyTransaction(t2, 2);

    for (const undo of [u2, u1]) {
      await utxoSet.undoTransaction(undo);
    }

    expect(await utxoSet.getBalance(aliceAddress)).toBe(1000n);
    expect(await utxoSet.getBalance(bobAddress)).toBe(0n);
    expect(await utxoSet.getBalance(carolAddress)).toBe(0n);
  });
});

describe("UtxoSet staged (overlay) writes", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;
  let alice: { publicKey: string; privateKey: string };
  let aliceAddress: string;
  let bobAddress: string;
  let cb: Transaction;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-utxo-overlay-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
    alice = generateKeyPair();
    aliceAddress = deriveAddress(alice.publicKey);
    bobAddress = deriveAddress(generateKeyPair().publicKey);
    cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 1);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("while staging, writes are visible to subsequent validation but not persisted until committed", async () => {
    utxoSet.beginStaging();
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    await utxoSet.applyTransaction(tx, 2);

    // Staged view: input consumed, output present.
    expect(await utxoSet.get(cb.id, 0)).toBeUndefined();
    expect(await utxoSet.get(tx.id, 0)).toEqual({ address: bobAddress, amount: 1000n });
    // A double-spend of the staged-consumed input is rejected against the staged view.
    const again = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1n }]);
    expect((await utxoSet.validateTransaction(again, 2)).valid).toBe(false);

    // Nothing hit disk yet.
    expect(await db.utxo.get(`${cb.id}:0`)).toBeDefined();
    expect(await db.utxo.get(`${tx.id}:0`)).toBeUndefined();

    const ops = await utxoSet.takeStagedOps();
    await db.root.batch(ops);

    expect(await db.utxo.get(`${cb.id}:0`)).toBeUndefined();
    expect(await db.utxo.get(`${tx.id}:0`)).toBeDefined();
    expect(await utxoSet.get(tx.id, 0)).toEqual({ address: bobAddress, amount: 1000n });
  });

  it("discarding staged writes leaves the persisted state untouched", async () => {
    utxoSet.beginStaging();
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    await utxoSet.applyTransaction(tx, 2);
    utxoSet.discardStaging();

    expect(await utxoSet.get(cb.id, 0)).toEqual({ address: aliceAddress, amount: 1000n });
    expect(await utxoSet.get(tx.id, 0)).toBeUndefined();
  });

  it("chained spends within one staging session validate against each other", async () => {
    const bob = generateKeyPair();
    const bobAddr = deriveAddress(bob.publicKey);
    utxoSet.beginStaging();
    const t1 = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddr, amount: 1000n }]);
    await utxoSet.applyTransaction(t1, 2);
    const t2 = spend(bob, { txId: t1.id, outputIndex: 0 }, [{ address: aliceAddress, amount: 1000n }]);
    const u2 = await utxoSet.applyTransaction(t2, 2);
    expect(u2.spent[0]!.entry).toEqual({ address: bobAddr, amount: 1000n, blockHeight: 2, isCoinbase: false });
    await db.root.batch(await utxoSet.takeStagedOps());
    expect(await utxoSet.getBalance(aliceAddress)).toBe(1000n);
    expect(await utxoSet.getBalance(bobAddr)).toBe(0n);
  });

  it("undo within a staging session cancels a staged apply", async () => {
    utxoSet.beginStaging();
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    const undo = await utxoSet.applyTransaction(tx, 2);
    await utxoSet.undoTransaction(undo);
    expect(await utxoSet.get(cb.id, 0)).toEqual({ address: aliceAddress, amount: 1000n });
    await db.root.batch(await utxoSet.takeStagedOps());
    expect(await utxoSet.get(cb.id, 0)).toEqual({ address: aliceAddress, amount: 1000n });
    expect(await utxoSet.get(tx.id, 0)).toBeUndefined();
  });

  it("staging with a cleared base sees no existing entries and commits their deletion", async () => {
    utxoSet.beginStaging({ clearBase: true });
    expect(await utxoSet.get(cb.id, 0)).toBeUndefined();
    const fresh = coinbase(bobAddress, 5n);
    await utxoSet.applyTransaction(fresh, 1);
    await db.root.batch(await utxoSet.takeStagedOps());
    expect(await utxoSet.get(cb.id, 0)).toBeUndefined();
    expect(await utxoSet.get(fresh.id, 0)).toEqual({ address: bobAddress, amount: 5n });
  });
});

describe("UtxoSet.listUnspent", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-utxo-list-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns every unspent outpoint owned by an address with amount and provenance", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb1 = coinbase(aliceAddress, 500n);
    await utxoSet.applyTransaction(cb1, 3);
    const cb2 = coinbase(aliceAddress, 300n);
    // same content as cb1 except amount -> distinct id
    await utxoSet.applyTransaction(cb2, 4);
    await utxoSet.applyTransaction(coinbase(bobAddress, 999n), 5);

    const utxos = await utxoSet.listUnspent(aliceAddress);
    expect(utxos).toHaveLength(2);
    expect(utxos).toEqual(
      expect.arrayContaining([
        { txId: cb1.id, outputIndex: 0, address: aliceAddress, amount: 500n, blockHeight: 3, isCoinbase: true },
        { txId: cb2.id, outputIndex: 0, address: aliceAddress, amount: 300n, blockHeight: 4, isCoinbase: true },
      ]),
    );
  });

  it("reflects spends: a spent outpoint disappears and the new outputs appear under their owners", async () => {
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 1);
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 600n },
      { address: aliceAddress, amount: 400n },
    ]);
    await utxoSet.applyTransaction(tx, 2);

    expect(await utxoSet.listUnspent(aliceAddress)).toEqual([
      { txId: tx.id, outputIndex: 1, address: aliceAddress, amount: 400n, blockHeight: 2, isCoinbase: false },
    ]);
    expect(await utxoSet.listUnspent(bobAddress)).toEqual([
      { txId: tx.id, outputIndex: 0, address: bobAddress, amount: 600n, blockHeight: 2, isCoinbase: false },
    ]);
  });

  it("returns an empty list for an unknown address", async () => {
    expect(await utxoSet.listUnspent("nobody")).toEqual([]);
  });
});

describe("UtxoSet adversarial transaction rules", () => {
  let dir: string;
  let db: StateDb;
  let utxoSet: UtxoSet;
  let alice: { publicKey: string; privateKey: string };
  let aliceAddress: string;
  let bobAddress: string;
  let cb: Transaction;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-utxo-adversarial-test-"));
    db = openStateDb(dir);
    utxoSet = new UtxoSet(db.utxo);
    alice = generateKeyPair();
    aliceAddress = deriveAddress(alice.publicKey);
    bobAddress = deriveAddress(generateKeyPair().publicKey);
    cb = coinbase(aliceAddress, 100n);
    await utxoSet.applyTransaction(cb);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a negative output amount (which would otherwise mint coins)", async () => {
    // 100 in; outputs 200 + (-100) = 100 out. Without a positivity check this
    // balances and Alice ends up with 200 coins from 100.
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: aliceAddress, amount: 200n },
      { address: bobAddress, amount: -100n },
    ]);
    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/amount/i);
  });

  it("rejects a zero-value output", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [
      { address: bobAddress, amount: 100n },
      { address: bobAddress, amount: 0n },
    ]);
    expect((await utxoSet.validateTransaction(tx)).valid).toBe(false);
  });

  it("rejects a negative fee", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 150n }], -50n);
    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/fee/i);
  });

  it("rejects the same outpoint referenced twice in one transaction (double-counted input)", async () => {
    const body: UnsignedTransactionBody = {
      inputs: [
        { txId: cb.id, outputIndex: 0, signature: "", publicKey: alice.publicKey },
        { txId: cb.id, outputIndex: 0, signature: "", publicKey: alice.publicKey },
      ],
      outputs: [{ address: bobAddress, amount: 200n }], // would "spend" 100 as 200
      timestamp: 1700000000001,
      fee: 0n,
    };
    const payload = getSigningPayload(body);
    const signature = sign(alice.privateKey, payload);
    body.inputs[0]!.signature = signature;
    body.inputs[1]!.signature = signature;
    const tx = finalize(body);

    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/duplicate/i);
  });

  it("rejects a transaction whose id does not match its content", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 100n }]);
    const forged: Transaction = { ...tx, id: "f".repeat(64) };
    const result = await utxoSet.validateTransaction(forged);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/id/i);
  });

  it("rejects a transaction with no outputs", async () => {
    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, []);
    expect((await utxoSet.validateTransaction(tx)).valid).toBe(false);
  });

  it("applies the same rules to coinbase outputs", async () => {
    const badCoinbase = finalize({
      inputs: [],
      outputs: [{ address: bobAddress, amount: -1n }],
      timestamp: 1700000000002,
      fee: 0n,
    });
    expect((await utxoSet.validateTransaction(badCoinbase)).valid).toBe(false);
  });
});

describe("UtxoSet coinbase maturity", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-utxo-maturity-test-"));
    db = openStateDb(dir);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects spending a coinbase output before it has matured", async () => {
    const utxoSet = new UtxoSet(db.utxo, 10);
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 5); // mined at height 5, matures at height 15

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);

    const result = await utxoSet.validateTransaction(tx, 14); // one block short of maturity
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/matur/i);

    await expect(utxoSet.applyTransaction(tx, 14)).rejects.toThrow();
  });

  it("allows spending a coinbase output exactly once it has matured", async () => {
    const utxoSet = new UtxoSet(db.utxo, 10);
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 5);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);

    const result = await utxoSet.validateTransaction(tx, 15); // exactly matured
    expect(result.valid).toBe(true);

    await utxoSet.applyTransaction(tx, 15);
    expect(await utxoSet.get(cb.id, 0)).toBeUndefined();
    expect(await utxoSet.get(tx.id, 0)).toEqual({ address: bobAddress, amount: 1000n });
  });

  it("does not restrict spending outputs of a non-coinbase transaction, regardless of maturity", async () => {
    const utxoSet = new UtxoSet(db.utxo, 10);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(bob.publicKey);
    const carolAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb, 0);
    // Matured immediately since height 0 + maturity 10 <= spending height 10.
    const firstSpend = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    await utxoSet.applyTransaction(firstSpend, 10);

    // firstSpend's output is NOT a coinbase output, so Bob can spend it immediately
    // in the very next block even though maturity is 10.
    const secondSpend = spend(bob, { txId: firstSpend.id, outputIndex: 0 }, [
      { address: carolAddress, amount: 1000n },
    ]);
    const result = await utxoSet.validateTransaction(secondSpend, 11);
    expect(result.valid).toBe(true);
  });

  it("defaults to zero coinbase maturity (immediately spendable) when unspecified", async () => {
    const utxoSet = new UtxoSet(db.utxo);
    const alice = generateKeyPair();
    const aliceAddress = deriveAddress(alice.publicKey);
    const bobAddress = deriveAddress(generateKeyPair().publicKey);

    const cb = coinbase(aliceAddress, 1000n);
    await utxoSet.applyTransaction(cb);

    const tx = spend(alice, { txId: cb.id, outputIndex: 0 }, [{ address: bobAddress, amount: 1000n }]);
    const result = await utxoSet.validateTransaction(tx);
    expect(result.valid).toBe(true);
  });
});
