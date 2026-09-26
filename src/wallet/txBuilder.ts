import type { KeyPair } from "../crypto/keypair.js";
import { sign } from "../crypto/signature.js";
import { deriveAddress } from "../ledger/address.js";
import { computeTransactionId, getSigningPayload, MAX_TX_DATA_BYTES } from "../ledger/transaction.js";
import type { Transaction, TxInput, TxOutput, UnsignedTransactionBody } from "../ledger/types.js";
import type { Unspent } from "../state/utxoSet.js";

interface SpendArgs {
  keyPair: KeyPair;
  /** Everything the node reports as unspent for the key pair's address. */
  unspent: Unspent[];
  fee: bigint;
  timestamp: number;
  /** Current chain tip; the transaction would be mined at tipHeight + 1. */
  tipHeight: number;
  coinbaseMaturity: number;
}

export interface BuildTransactionArgs extends SpendArgs {
  to: string;
  amount: bigint;
}

export interface BuildAnchorArgs extends SpendArgs {
  /** The record to anchor, lowercase hex (typically a sha256 of a document). */
  data: string;
}

export class InsufficientFundsError extends Error {
  constructor(
    /** Spendable right now. */
    readonly available: bigint,
    readonly required: bigint,
    /** Coinbase outputs still locked by maturity -- shown so "where did my
     *  mining reward go?" has an answer. */
    readonly immature: bigint,
  ) {
    super(
      `insufficient funds: need ${required}, have ${available} spendable` +
        (immature > 0n ? ` (${immature} more in coinbase outputs not yet mature)` : ""),
    );
  }
}

/** Whether a coinbase output is old enough to spend in the next block. */
export function isMature(utxo: Unspent, tipHeight: number, coinbaseMaturity: number): boolean {
  return !utxo.isCoinbase || utxo.blockHeight + coinbaseMaturity <= tipHeight + 1;
}

/**
 * Largest-first selection until `target` is covered: fewest inputs, so
 * the smallest transaction. Ties broken by outpoint so the choice is a
 * pure function of the UTXO set (two wallets with the same view build the
 * same transaction). Throws InsufficientFundsError (with immature = 0;
 * the caller knows about maturity) if the coins don't cover the target.
 */
export function selectCoins(spendable: Unspent[], target: bigint): Unspent[] {
  const sorted = [...spendable].sort((a, b) => {
    if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
    if (a.txId !== b.txId) return a.txId < b.txId ? -1 : 1;
    return a.outputIndex - b.outputIndex;
  });

  const chosen: Unspent[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    if (total >= target) break;
    chosen.push(utxo);
    total += utxo.amount;
  }
  if (total < target) {
    throw new InsufficientFundsError(total, target, 0n);
  }
  return chosen;
}

/**
 * Builds and signs a payment of `amount` to `to`, paying `fee`, returning
 * any change to the sender's own address. Every input is signed over the
 * same canonical payload (see getSigningPayload).
 */
export function buildTransaction(args: BuildTransactionArgs): Transaction {
  const { to, amount } = args;
  if (amount <= 0n) throw new Error(`amount must be positive, got ${amount}`);
  if (args.fee < 0n) throw new Error(`fee must be non-negative, got ${args.fee}`);
  if (to.length === 0) throw new Error("recipient address must not be empty");
  return buildSigned(args, [{ address: to, amount }], 0n);
}

/**
 * Builds and signs a transaction that anchors `data` on chain and pays
 * nobody: the only output is change back to the sender. A transaction
 * needs at least one output, so the coins must cover the fee plus one.
 */
export function buildAnchorTransaction(args: BuildAnchorArgs): Transaction {
  if (!/^([0-9a-f]{2})+$/.test(args.data)) throw new Error("data must be non-empty lowercase hex");
  if (args.data.length / 2 > MAX_TX_DATA_BYTES) throw new Error(`data is ${args.data.length / 2} bytes, more than the ${MAX_TX_DATA_BYTES}-byte limit`);
  if (args.fee < 0n) throw new Error(`fee must be non-negative, got ${args.fee}`);
  return buildSigned(args, [], 1n, args.data);
}

/** Selects coins for `payments` + fee (+ `minChange`), adds change, signs every input. */
function buildSigned(args: SpendArgs, payments: TxOutput[], minChange: bigint, data?: string): Transaction {
  const { keyPair, fee, timestamp, tipHeight, coinbaseMaturity } = args;
  const ownAddress = deriveAddress(keyPair.publicKey);
  const foreign = args.unspent.find((u) => u.address !== ownAddress);
  if (foreign) {
    throw new Error(`unspent output ${foreign.txId}:${foreign.outputIndex} is not owned by this wallet`);
  }

  const spendable = args.unspent.filter((u) => isMature(u, tipHeight, coinbaseMaturity));
  const immature = args.unspent.filter((u) => !isMature(u, tipHeight, coinbaseMaturity)).reduce((s, u) => s + u.amount, 0n);
  const required = payments.reduce((s, o) => s + o.amount, 0n) + fee;

  let chosen: Unspent[];
  try {
    chosen = selectCoins(spendable, required + minChange);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new InsufficientFundsError(err.available, err.required, immature);
    }
    throw err;
  }

  const inputTotal = chosen.reduce((s, u) => s + u.amount, 0n);
  const outputs: TxOutput[] = [...payments];
  const change = inputTotal - required;
  if (change > 0n) outputs.push({ address: ownAddress, amount: change });

  const unsignedInputs: TxInput[] = chosen.map((u) => ({
    txId: u.txId,
    outputIndex: u.outputIndex,
    signature: "",
    publicKey: keyPair.publicKey,
  }));
  const body: UnsignedTransactionBody = { inputs: unsignedInputs, outputs, timestamp, fee, ...(data === undefined ? {} : { data }) };
  const signature = sign(keyPair.privateKey, getSigningPayload(body));
  const signed: UnsignedTransactionBody = {
    ...body,
    inputs: unsignedInputs.map((input) => ({ ...input, signature })),
  };
  return { ...signed, id: computeTransactionId(signed) };
}

export interface BumpFeeArgs {
  keyPair: KeyPair;
  /** The pending transaction to replace; must be one this key pair signed. */
  original: Transaction;
  newFee: bigint;
  timestamp: number;
}

/**
 * Replace-by-fee from the sender's side: the same inputs and payments,
 * re-signed with a higher fee taken out of the change output. Only the
 * change shrinks; the recipient's amount is untouched. Nodes accept the
 * result if it pays at least the old fee plus their minimum fee.
 */
export function bumpFee(args: BumpFeeArgs): Transaction {
  const { keyPair, original, newFee, timestamp } = args;
  if (newFee <= original.fee) throw new Error(`new fee ${newFee} must be higher than the current fee ${original.fee}`);
  if (original.inputs.some((input) => input.publicKey !== keyPair.publicKey)) {
    throw new Error(`transaction ${original.id} is not signed by this wallet; it cannot be re-signed`);
  }
  const ownAddress = deriveAddress(keyPair.publicKey);
  // buildTransaction puts change last; take the last own-address output.
  const changeIndex = original.outputs.map((o) => o.address).lastIndexOf(ownAddress);
  if (changeIndex < 0) throw new Error(`transaction ${original.id} has no change output to take the extra fee from`);
  const change = original.outputs[changeIndex]!;
  const extra = newFee - original.fee;
  if (change.amount < extra) {
    throw new Error(`change output is only ${change.amount}; a bump to ${newFee} needs ${extra} more`);
  }

  const outputs: TxOutput[] = original.outputs.map((o, i) => (i === changeIndex ? { ...o, amount: o.amount - extra } : { ...o }));
  if (outputs[changeIndex]!.amount === 0n) outputs.splice(changeIndex, 1);
  if (outputs.length === 0) {
    throw new Error(`a bump to ${newFee} would spend the whole change output and leave no output; a transaction needs at least one`);
  }

  const unsignedInputs: TxInput[] = original.inputs.map((input) => ({ ...input, signature: "" }));
  // The record (if any) is kept: the replacement anchors the same data.
  const body: UnsignedTransactionBody = { inputs: unsignedInputs, outputs, timestamp, fee: newFee, ...(original.data === undefined ? {} : { data: original.data }) };
  const signature = sign(keyPair.privateKey, getSigningPayload(body));
  const signed: UnsignedTransactionBody = { ...body, inputs: unsignedInputs.map((input) => ({ ...input, signature })) };
  return { ...signed, id: computeTransactionId(signed) };
}
