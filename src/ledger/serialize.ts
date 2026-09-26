import type { Block, BlockHeader, Transaction, TxOutput } from "./types.js";

interface WireTxOutput {
  address: string;
  amount: string;
}

interface WireTransaction {
  id: string;
  inputs: Transaction["inputs"];
  outputs: WireTxOutput[];
  timestamp: number;
  fee: string;
  data?: string;
}

interface WireBlock {
  header: Block["header"];
  transactions: WireTransaction[];
  hash: string;
}

function toWireOutput(output: TxOutput): WireTxOutput {
  return { address: output.address, amount: output.amount.toString() };
}

function fromWireOutput(output: WireTxOutput): TxOutput {
  return { address: output.address, amount: BigInt(output.amount) };
}

function toWireTransaction(tx: Transaction): WireTransaction {
  return {
    id: tx.id,
    inputs: tx.inputs,
    outputs: tx.outputs.map(toWireOutput),
    timestamp: tx.timestamp,
    fee: tx.fee.toString(),
    // Only when present: a payment's wire form (and so block size) is unchanged.
    ...(tx.data === undefined ? {} : { data: tx.data }),
  };
}

function fromWireTransaction(wire: WireTransaction): Transaction {
  return {
    id: wire.id,
    inputs: wire.inputs,
    outputs: wire.outputs.map(fromWireOutput),
    timestamp: wire.timestamp,
    fee: BigInt(wire.fee),
    ...(wire.data === undefined ? {} : { data: wire.data }),
  };
}

export function serializeTransaction(tx: Transaction): string {
  return JSON.stringify(toWireTransaction(tx));
}

export function deserializeTransaction(json: string): Transaction {
  return parseWireTransaction(JSON.parse(json));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAmount(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error(`${what} must be a decimal integer string`);
  }
  return BigInt(value);
}

/**
 * Converts an untrusted wire-format object (e.g. an RPC request body) into
 * a Transaction, throwing a descriptive Error on any shape violation. This
 * is a boundary check on *shape* only; consensus rules are applied later.
 */
export function parseWireTransaction(value: unknown): Transaction {
  if (!isRecord(value)) throw new Error("transaction must be an object");
  if (typeof value.id !== "string") throw new Error("transaction.id must be a string");
  if (!Array.isArray(value.inputs)) throw new Error("transaction.inputs must be an array");
  if (!Array.isArray(value.outputs)) throw new Error("transaction.outputs must be an array");
  if (typeof value.timestamp !== "number") throw new Error("transaction.timestamp must be a number");
  if (value.data !== undefined && typeof value.data !== "string") throw new Error("transaction.data must be a hex string");

  const inputs = value.inputs.map((input, i) => {
    if (!isRecord(input)) throw new Error(`inputs[${i}] must be an object`);
    const { txId, outputIndex, signature, publicKey } = input;
    if (typeof txId !== "string") throw new Error(`inputs[${i}].txId must be a string`);
    if (typeof outputIndex !== "number") throw new Error(`inputs[${i}].outputIndex must be a number`);
    if (typeof signature !== "string") throw new Error(`inputs[${i}].signature must be a string`);
    if (typeof publicKey !== "string") throw new Error(`inputs[${i}].publicKey must be a string`);
    return { txId, outputIndex, signature, publicKey };
  });

  const outputs = value.outputs.map((output, i) => {
    if (!isRecord(output)) throw new Error(`outputs[${i}] must be an object`);
    if (typeof output.address !== "string") throw new Error(`outputs[${i}].address must be a string`);
    return { address: output.address, amount: parseAmount(output.amount, `outputs[${i}].amount`) };
  });

  return {
    id: value.id,
    inputs,
    outputs,
    timestamp: value.timestamp,
    fee: parseAmount(value.fee, "transaction.fee"),
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

export function serializeBlock(block: Block): string {
  const wire: WireBlock = {
    header: block.header,
    transactions: block.transactions.map(toWireTransaction),
    hash: block.hash,
  };
  return JSON.stringify(wire);
}

export function deserializeBlock(json: string): Block {
  const wire = JSON.parse(json) as WireBlock;
  return {
    header: wire.header,
    transactions: wire.transactions.map(fromWireTransaction),
    hash: wire.hash,
  };
}

/** A wire object has a field of the wrong type or shape. */
export class WireShapeError extends Error {}

function shapeFail(what: string): never {
  throw new WireShapeError(`malformed ${what}`);
}

function shapeHex(value: unknown, what: string, length?: number): string {
  const ok = typeof value === "string" && /^([0-9a-f]{2})*$/.test(value) && (length === undefined || value.length === length);
  if (!ok) shapeFail(`${what}: expected ${length === undefined ? "hex" : `${length} hex characters`}`);
  return value as string;
}

function shapeInteger(value: unknown, what: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) shapeFail(`${what}: expected an integer >= ${min}`);
  return value as number;
}

/**
 * An untrusted header (from a peer, or a node answering a light client)
 * rebuilt with every field type-checked, in canonical key order, unknown
 * keys dropped. Types are consensus-relevant: a header whose `timestamp`
 * is the string "1700…" hashes identically to the real one and passes
 * every coercing comparison, but corrupts arithmetic done on it later.
 */
export function parseWireHeader(value: unknown, what = "header"): BlockHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) shapeFail(`${what}: expected an object`);
  const v = value as Record<string, unknown>;
  const header: BlockHeader = {
    version: shapeInteger(v.version, `${what}.version`, 0),
    previousHash: shapeHex(v.previousHash, `${what}.previousHash`, 64),
    merkleRoot: shapeHex(v.merkleRoot, `${what}.merkleRoot`, 64),
    timestamp: shapeInteger(v.timestamp, `${what}.timestamp`, 0),
    difficultyTarget: shapeHex(v.difficultyTarget, `${what}.difficultyTarget`, 64),
    nonce: shapeInteger(v.nonce, `${what}.nonce`, 0),
    height: shapeInteger(v.height, `${what}.height`, 0),
  };
  // Proof-of-authority seal: both present or both absent.
  if (v.signer !== undefined || v.signature !== undefined) {
    header.signer = shapeHex(v.signer, `${what}.signer`);
    header.signature = shapeHex(v.signature, `${what}.signature`);
  }
  return header;
}

/** `{ hash, header }` as `getHeaders` returns it, with the hash recomputed rather than trusted. */
export function parseWireChainHeader(value: unknown, what = "header"): { hash: string; header: BlockHeader } {
  if (typeof value !== "object" || value === null) shapeFail(`${what}: expected an object`);
  const header = parseWireHeader((value as { header?: unknown }).header, `${what}.header`);
  const hash = shapeHex((value as { hash?: unknown }).hash, `${what}.hash`, 64);
  return { hash, header };
}
