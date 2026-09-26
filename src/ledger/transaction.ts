import { sha256 } from "../crypto/hash.js";
import type { Transaction, TxOutput, UnsignedTransactionBody } from "./types.js";

/**
 * Most bytes of record data one transaction may carry: enough for a
 * sha256 (32) plus a tag or a second digest, not enough to use the chain
 * as file storage. A consensus rule (part of RULES_VERSION 5).
 */
export const MAX_TX_DATA_BYTES = 80;

/** Appended only when present, so transactions without data keep their pre-anchoring ids. */
function dataPart(body: UnsignedTransactionBody): string[] {
  return body.data === undefined ? [] : [`data:${body.data}`];
}

function serializeOutput(output: TxOutput): string {
  return `${output.address}:${output.amount.toString()}`;
}

/**
 * Canonical payload every input's signature is produced over: the referenced
 * outpoints, the outputs, the timestamp, the fee, and the record data if
 * any. Deliberately excludes each input's own signature/publicKey so all
 * inputs on a transaction sign the same message and so re-attaching a
 * signature never changes it.
 */
export function getSigningPayload(body: UnsignedTransactionBody): string {
  const inputsPart = body.inputs
    .map((input) => `${input.txId}:${input.outputIndex}`)
    .join(",");
  const outputsPart = body.outputs.map(serializeOutput).join(",");

  return [
    inputsPart,
    outputsPart,
    body.timestamp.toString(),
    body.fee.toString(),
    ...dataPart(body),
  ].join("|");
}

/**
 * Full canonical serialization used to derive the transaction id. Includes
 * signatures/public keys, so the id is only final once every input is signed.
 */
function serializeTransactionBody(body: UnsignedTransactionBody): string {
  const inputsPart = body.inputs
    .map(
      (input) =>
        `${input.txId}:${input.outputIndex}:${input.signature}:${input.publicKey}`,
    )
    .join(",");
  const outputsPart = body.outputs.map(serializeOutput).join(",");

  return [
    inputsPart,
    outputsPart,
    body.timestamp.toString(),
    body.fee.toString(),
    ...dataPart(body),
  ].join("|");
}

export function computeTransactionId(body: UnsignedTransactionBody): string {
  return sha256(serializeTransactionBody(body));
}

export interface TxStructureResult {
  valid: boolean;
  reason?: string;
}

/**
 * Context-free integrity rules every transaction must satisfy regardless of
 * UTXO state: honest id, positive amounts, non-negative fee, at least one
 * output, no outpoint referenced twice, and well-formed bounded data.
 * Enforced here (not only in the mempool) because blocks from peers never
 * pass through the mempool.
 */
export function validateTransactionStructure(tx: Transaction): TxStructureResult {
  if (computeTransactionId(tx) !== tx.id) {
    return { valid: false, reason: "transaction id does not match its content" };
  }

  if (tx.outputs.length === 0) {
    return { valid: false, reason: "transaction has no outputs" };
  }

  for (const output of tx.outputs) {
    if (output.amount <= 0n) {
      return { valid: false, reason: `output amount must be positive, got ${output.amount}` };
    }
  }

  if (tx.fee < 0n) {
    return { valid: false, reason: `fee must be non-negative, got ${tx.fee}` };
  }

  if (tx.data !== undefined) {
    if (typeof tx.data !== "string" || !/^([0-9a-f]{2})+$/.test(tx.data)) {
      return { valid: false, reason: "data must be non-empty lowercase hex" };
    }
    if (tx.data.length / 2 > MAX_TX_DATA_BYTES) {
      return { valid: false, reason: `data is ${tx.data.length / 2} bytes, more than the ${MAX_TX_DATA_BYTES}-byte limit` };
    }
  }

  const seen = new Set<string>();
  for (const input of tx.inputs) {
    const key = `${input.txId}:${input.outputIndex}`;
    if (seen.has(key)) {
      return { valid: false, reason: `duplicate input outpoint ${key}` };
    }
    seen.add(key);
  }

  return { valid: true };
}
