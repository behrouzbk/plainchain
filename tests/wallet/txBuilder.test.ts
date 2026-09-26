import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { verify } from "../../src/crypto/signature.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { computeTransactionId, getSigningPayload, validateTransactionStructure } from "../../src/ledger/transaction.js";
import type { Unspent } from "../../src/state/utxoSet.js";
import { buildAnchorTransaction, bumpFee, buildTransaction, InsufficientFundsError, selectCoins } from "../../src/wallet/txBuilder.js";

const kp = generateKeyPair();
const me = deriveAddress(kp.publicKey);
const bob = deriveAddress(generateKeyPair().publicKey);

function utxo(txId: string, amount: bigint, extra: Partial<Unspent> = {}): Unspent {
  return { txId, outputIndex: 0, address: me, amount, blockHeight: 1, isCoinbase: false, ...extra };
}

describe("wallet transaction builder", () => {
  it("builds a signed transaction with a change output back to the sender", () => {
    const tx = buildTransaction({
      keyPair: kp,
      unspent: [utxo("a", 100n)],
      to: bob,
      amount: 30n,
      fee: 5n,
      timestamp: 1234,
      tipHeight: 10,
      coinbaseMaturity: 0,
    });

    expect(tx.inputs).toHaveLength(1);
    expect(tx.outputs).toEqual([
      { address: bob, amount: 30n },
      { address: me, amount: 65n },
    ]);
    expect(tx.fee).toBe(5n);
    expect(tx.timestamp).toBe(1234);
    expect(tx.id).toBe(computeTransactionId(tx));
    expect(validateTransactionStructure(tx).valid).toBe(true);

    const payload = getSigningPayload(tx);
    for (const input of tx.inputs) {
      expect(input.publicKey).toBe(kp.publicKey);
      expect(verify(kp.publicKey, payload, input.signature)).toBe(true);
    }
  });

  it("omits the change output when the inputs exactly cover amount + fee", () => {
    const tx = buildTransaction({
      keyPair: kp,
      unspent: [utxo("a", 35n)],
      to: bob,
      amount: 30n,
      fee: 5n,
      timestamp: 1,
      tipHeight: 10,
      coinbaseMaturity: 0,
    });
    expect(tx.outputs).toEqual([{ address: bob, amount: 30n }]);
  });

  it("selects the fewest, largest coins deterministically and signs every one", () => {
    const tx = buildTransaction({
      keyPair: kp,
      unspent: [utxo("small", 10n), utxo("big", 60n), utxo("mid", 40n)],
      to: bob,
      amount: 90n,
      fee: 5n,
      timestamp: 1,
      tipHeight: 10,
      coinbaseMaturity: 0,
    });
    expect(tx.inputs.map((i) => i.txId)).toEqual(["big", "mid"]);
    expect(tx.outputs).toEqual([
      { address: bob, amount: 90n },
      { address: me, amount: 5n },
    ]);
    const payload = getSigningPayload(tx);
    expect(tx.inputs.every((i) => verify(kp.publicKey, payload, i.signature))).toBe(true);
  });

  it("breaks amount ties by outpoint so two wallets with the same UTXOs build the same transaction", () => {
    const a = selectCoins([utxo("z", 10n), utxo("a", 10n, { outputIndex: 1 }), utxo("a", 10n)], 15n);
    expect(a.map((u) => `${u.txId}:${u.outputIndex}`)).toEqual(["a:0", "a:1"]);
  });

  it("throws InsufficientFundsError with the shortfall, without signing anything", () => {
    let err: unknown;
    try {
      buildTransaction({
        keyPair: kp,
        unspent: [utxo("a", 10n)],
        to: bob,
        amount: 30n,
        fee: 5n,
        timestamp: 1,
        tipHeight: 10,
        coinbaseMaturity: 0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).available).toBe(10n);
    expect((err as InsufficientFundsError).required).toBe(35n);
  });

  it("does not spend coinbase outputs that haven't matured yet, and counts them as unavailable", () => {
    // Maturity 10: a coinbase created at height 5 is spendable from height 15,
    // i.e. once the tip is at 14 (the tx would be mined at 15).
    const unspent = [utxo("young", 100n, { isCoinbase: true, blockHeight: 5 }), utxo("plain", 40n)];
    const build = (tipHeight: number) =>
      buildTransaction({ keyPair: kp, unspent, to: bob, amount: 50n, fee: 1n, timestamp: 1, tipHeight, coinbaseMaturity: 10 });

    expect(() => build(13)).toThrow(InsufficientFundsError);
    try {
      build(13);
    } catch (e) {
      expect((e as InsufficientFundsError).available).toBe(40n);
      expect((e as InsufficientFundsError).immature).toBe(100n);
    }
    expect(build(14).inputs.map((i) => i.txId)).toEqual(["young"]);
  });

  it("refuses a non-positive amount or a negative fee before touching keys", () => {
    const args = { keyPair: kp, unspent: [utxo("a", 100n)], to: bob, timestamp: 1, tipHeight: 1, coinbaseMaturity: 0 };
    expect(() => buildTransaction({ ...args, amount: 0n, fee: 1n })).toThrow(/amount/i);
    expect(() => buildTransaction({ ...args, amount: -5n, fee: 1n })).toThrow(/amount/i);
    expect(() => buildTransaction({ ...args, amount: 5n, fee: -1n })).toThrow(/fee/i);
  });

  it("refuses to spend outputs that don't belong to the key pair (a wrong listUnspent result can't be signed for)", () => {
    expect(() =>
      buildTransaction({
        keyPair: kp,
        unspent: [utxo("a", 100n, { address: bob })],
        to: bob,
        amount: 10n,
        fee: 1n,
        timestamp: 1,
        tipHeight: 1,
        coinbaseMaturity: 0,
      }),
    ).toThrow(/not owned/i);
  });
});

describe("bumpFee (replace-by-fee from the wallet side)", () => {
  const original = buildTransaction({
    keyPair: kp,
    unspent: [utxo("a", 100n)],
    to: bob,
    amount: 30n,
    fee: 5n,
    timestamp: 1234,
    tipHeight: 10,
    coinbaseMaturity: 0,
  });

  it("re-signs the same payment with a higher fee taken from the change output", () => {
    const bumped = bumpFee({ keyPair: kp, original, newFee: 12n, timestamp: 2345 });
    expect(bumped.inputs.map((i) => [i.txId, i.outputIndex])).toEqual(original.inputs.map((i) => [i.txId, i.outputIndex]));
    expect(bumped.outputs).toEqual([
      { address: bob, amount: 30n },
      { address: me, amount: 58n },
    ]);
    expect(bumped.fee).toBe(12n);
    expect(bumped.id).not.toBe(original.id);
    expect(bumped.id).toBe(computeTransactionId(bumped));
    expect(validateTransactionStructure(bumped).valid).toBe(true);
    const payload = getSigningPayload(bumped);
    for (const input of bumped.inputs) expect(verify(kp.publicKey, payload, input.signature)).toBe(true);
  });

  it("drops the change output when the bump consumes it exactly", () => {
    const bumped = bumpFee({ keyPair: kp, original, newFee: 70n, timestamp: 2345 });
    expect(bumped.outputs).toEqual([{ address: bob, amount: 30n }]);
    expect(bumped.fee).toBe(70n);
  });

  it("refuses a fee that is not higher, a bump the change cannot cover, and a transaction without change", () => {
    expect(() => bumpFee({ keyPair: kp, original, newFee: 5n, timestamp: 1 })).toThrow(/higher than/);
    expect(() => bumpFee({ keyPair: kp, original, newFee: 71n, timestamp: 1 })).toThrow(/change output .* only 65/);
    const noChange = buildTransaction({ keyPair: kp, unspent: [utxo("a", 35n)], to: bob, amount: 30n, fee: 5n, timestamp: 1, tipHeight: 10, coinbaseMaturity: 0 });
    expect(noChange.outputs).toHaveLength(1);
    expect(() => bumpFee({ keyPair: kp, original: noChange, newFee: 6n, timestamp: 1 })).toThrow(/no change output/);
  });

  it("refuses to bump a transaction whose inputs are not signed by this key (cannot re-sign someone else's spend)", () => {
    const other = generateKeyPair();
    expect(() => bumpFee({ keyPair: other, original, newFee: 12n, timestamp: 1 })).toThrow(/not owned|not signed by/i);
  });
});

describe("buildAnchorTransaction (record anchoring)", () => {
  const record = "ab".repeat(32);
  const base = { keyPair: kp, data: record, fee: 5n, timestamp: 1234, tipHeight: 10, coinbaseMaturity: 0 };

  it("pays nobody: the record plus a change output back to the sender, signed over the record", () => {
    const tx = buildAnchorTransaction({ ...base, unspent: [utxo("a", 100n)] });
    expect(tx.data).toBe(record);
    expect(tx.outputs).toEqual([{ address: me, amount: 95n }]);
    expect(tx.fee).toBe(5n);
    expect(validateTransactionStructure(tx)).toEqual({ valid: true });
    expect(verify(kp.publicKey, getSigningPayload(tx), tx.inputs[0]!.signature)).toBe(true);
  });

  it("needs one unit beyond the fee, because a transaction must keep at least one output", () => {
    expect(() => buildAnchorTransaction({ ...base, unspent: [utxo("a", 5n)] })).toThrow(InsufficientFundsError);
    expect(buildAnchorTransaction({ ...base, unspent: [utxo("a", 6n)] }).outputs).toEqual([{ address: me, amount: 1n }]);
  });

  it("refuses a record that the network would refuse, before signing", () => {
    for (const data of ["", "ABCD", "abc", "00".repeat(81)]) {
      expect(() => buildAnchorTransaction({ ...base, data, unspent: [utxo("a", 100n)] }), data).toThrow(/data/);
    }
  });

  it("bumpFee keeps the record, and refuses a bump that would leave no output", () => {
    const tx = buildAnchorTransaction({ ...base, unspent: [utxo("a", 100n)] });
    const bumped = bumpFee({ keyPair: kp, original: tx, newFee: 20n, timestamp: 2000 });
    expect(bumped.data).toBe(record);
    expect(bumped.outputs).toEqual([{ address: me, amount: 80n }]);
    expect(validateTransactionStructure(bumped)).toEqual({ valid: true });
    expect(() => bumpFee({ keyPair: kp, original: tx, newFee: 100n, timestamp: 2000 })).toThrow(/no output/);
  });
});

describe("buildAnchorTransaction change splitting (a node's anchor coin pool)", () => {
  const base = { keyPair: kp, data: "ab".repeat(32), fee: 5n, timestamp: 1234, tipHeight: 10, coinbaseMaturity: 0 };

  it("splits the change into equal coins, the remainder on the last, all back to the sender", () => {
    const tx = buildAnchorTransaction({ ...base, unspent: [utxo("a", 105n)], changeSplit: 3 });
    expect(tx.outputs).toEqual([
      { address: me, amount: 33n },
      { address: me, amount: 33n },
      { address: me, amount: 34n },
    ]);
    expect(validateTransactionStructure(tx)).toEqual({ valid: true });
  });

  it("never makes a coin of zero: small change gets fewer pieces", () => {
    expect(buildAnchorTransaction({ ...base, unspent: [utxo("a", 7n)], changeSplit: 8 }).outputs).toEqual([
      { address: me, amount: 1n },
      { address: me, amount: 1n },
    ]);
  });
});
