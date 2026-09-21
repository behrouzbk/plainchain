import { sha256 } from "../crypto/hash.js";
import type { Transaction, TxOutput, UnsignedTransactionBody } from "./types.js";

function serializeOutput(output: TxOutput): string {
  return `${output.address}:${output.amount.toString()}`;
}

/**
 * Canonical payload every input's signature is produced over: the referenced
 * outpoints, the outputs, the timestamp, and the fee. Deliberately excludes
 * each input's own signature/publicKey so all inputs on a transaction sign
 * the same message and so re-attaching a signature never changes it.
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
 * output, and no outpoint referenced twice. Enforced here (not only in the
 * mempool) because blocks from peers never pass through the mempool.
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
