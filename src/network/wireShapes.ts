import { computeBlockHash } from "../ledger/block.js";
import { parseWireHeader, WireShapeError } from "../ledger/serialize.js";
import type { Block, Transaction } from "../ledger/types.js";
import type { Message } from "./protocol.js";

/**
 * Shape checks for every P2P payload, applied in `decodeMessage` so that
 * nothing reaching `node/node.ts` has a field of the wrong type. Types
 * matter for consensus, not just robustness: a header whose `timestamp`
 * is the string "1700…" hashes identically to the real one (`toString`
 * on both), passes every coercing comparison, and once stored turns the
 * next block template's `parent.timestamp + 1` into string
 * concatenation. Headers are also rebuilt in canonical field order with
 * unknown keys dropped, because the block size rule measures the
 * serialized header.
 */
function fail(what: string): never {
  throw new WireShapeError(`malformed ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex64(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${what}: expected 64 hex characters`);
  return value;
}

function hex(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^([0-9a-f]{2})*$/.test(value)) fail(`${what}: expected hex`);
  return value;
}

function integer(value: unknown, what: string, min = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail(`${what}: expected an integer${min > Number.MIN_SAFE_INTEGER ? ` >= ${min}` : ""}`);
  return value;
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) fail(`${what}: expected an array of strings`);
  return value;
}

/** A transaction after the bigint reviver: amounts and fee must already be bigints. */
export function parseP2PTransaction(value: unknown, what = "transaction"): Transaction {
  if (!isRecord(value)) fail(`${what}: expected an object`);
  const id = hex64(value.id, `${what}.id`);
  if (!Array.isArray(value.inputs)) fail(`${what}.inputs: expected an array`);
  if (!Array.isArray(value.outputs)) fail(`${what}.outputs: expected an array`);
  const inputs = value.inputs.map((input, i) => {
    if (!isRecord(input)) fail(`${what}.inputs[${i}]: expected an object`);
    return {
      txId: hex64(input.txId, `${what}.inputs[${i}].txId`),
      outputIndex: integer(input.outputIndex, `${what}.inputs[${i}].outputIndex`, 0),
      signature: hex(input.signature, `${what}.inputs[${i}].signature`),
      publicKey: hex(input.publicKey, `${what}.inputs[${i}].publicKey`),
    };
  });
  const outputs = value.outputs.map((output, i) => {
    if (!isRecord(output)) fail(`${what}.outputs[${i}]: expected an object`);
    if (typeof output.address !== "string") fail(`${what}.outputs[${i}].address: expected a string`);
    if (typeof output.amount !== "bigint") fail(`${what}.outputs[${i}].amount: expected a bigint`);
    return { address: output.address, amount: output.amount };
  });
  if (typeof value.fee !== "bigint") fail(`${what}.fee: expected a bigint`);
  const tx: Transaction = { id, inputs, outputs, timestamp: integer(value.timestamp, `${what}.timestamp`, 0), fee: value.fee };
  // Record data is part of the id: dropping it here would make an honest
  // peer's transaction look forged.
  if (value.data !== undefined) tx.data = hex(value.data, `${what}.data`);
  return tx;
}

/** A block whose claimed hash really is the hash of its header (a claimed hash is never trusted). */
export function parseWireBlock(value: unknown, what = "block"): Block {
  if (!isRecord(value)) fail(`${what}: expected an object`);
  const header = parseWireHeader(value.header, `${what}.header`);
  if (!Array.isArray(value.transactions)) fail(`${what}.transactions: expected an array`);
  const transactions = value.transactions.map((tx, i) => parseP2PTransaction(tx, `${what}.transactions[${i}]`));
  const hash = hex64(value.hash, `${what}.hash`);
  if (computeBlockHash(header) !== hash) fail(`${what}.hash: does not match the header`);
  return { header, transactions, hash };
}

/** Validates and canonicalizes a decoded message's payload by type. */
export function checkPayload(type: string, payload: Record<string, unknown>): Message["payload"] {
  switch (type) {
    case "HANDSHAKE": {
      if (typeof payload.nodeId !== "string") fail("HANDSHAKE.nodeId: expected a string");
      for (const key of ["listenAddress", "networkId", "genesisHash", "rulesHash"] as const) {
        if (payload[key] !== undefined && typeof payload[key] !== "string") fail(`HANDSHAKE.${key}: expected a string`);
      }
      return payload as unknown as Message["payload"];
    }
    case "GET_BLOCKS":
      integer(payload.fromHeight, "GET_BLOCKS.fromHeight", 0);
      if (payload.locator !== undefined) stringList(payload.locator, "GET_BLOCKS.locator");
      return payload as unknown as Message["payload"];
    case "GET_HEADERS":
      stringList(payload.locator, "GET_HEADERS.locator");
      return payload as unknown as Message["payload"];
    case "HEADERS": {
      if (!Array.isArray(payload.headers)) fail("HEADERS.headers: expected an array");
      return { headers: payload.headers.map((h, i) => parseWireHeader(h, `HEADERS.headers[${i}]`)) };
    }
    case "INV_BLOCKS":
      stringList(payload.hashes, "INV_BLOCKS.hashes");
      return payload as unknown as Message["payload"];
    case "NEW_BLOCK":
      return { block: parseWireBlock(payload.block, "NEW_BLOCK.block") };
    case "NEW_TX":
      return { transaction: parseP2PTransaction(payload.transaction, "NEW_TX.transaction") };
    case "GET_PEERS":
      return payload as unknown as Message["payload"];
    case "PEERS":
      stringList(payload.addresses, "PEERS.addresses");
      return payload as unknown as Message["payload"];
    default:
      fail(`message type ${type}`);
  }
}
