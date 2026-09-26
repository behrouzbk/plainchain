import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign, verify } from "../../src/crypto/signature.js";
import { sha256 } from "../../src/crypto/hash.js";
import {
  computeTransactionId,
  getSigningPayload,
  MAX_TX_DATA_BYTES,
  validateTransactionStructure,
} from "../../src/ledger/transaction.js";
import type { Transaction, UnsignedTransactionBody } from "../../src/ledger/types.js";

function baseBody(): UnsignedTransactionBody {
  return {
    inputs: [
      { txId: "prevtx1", outputIndex: 0, signature: "", publicKey: "" },
    ],
    outputs: [{ address: "alice", amount: 100n }],
    timestamp: 1700000000000,
    fee: 1n,
  };
}

describe("getSigningPayload", () => {
  it("is deterministic for identical logical content", () => {
    expect(getSigningPayload(baseBody())).toBe(getSigningPayload(baseBody()));
  });

  it("does not change when signature/publicKey fields on inputs differ", () => {
    const a = baseBody();
    const b = baseBody();
    b.inputs[0]!.signature = "deadbeef";
    b.inputs[0]!.publicKey = "cafebabe";
    expect(getSigningPayload(a)).toBe(getSigningPayload(b));
  });

  it("changes when an output amount changes", () => {
    const a = baseBody();
    const b = baseBody();
    b.outputs[0]!.amount = 200n;
    expect(getSigningPayload(a)).not.toBe(getSigningPayload(b));
  });

  it("changes when the referenced outpoint changes", () => {
    const a = baseBody();
    const b = baseBody();
    b.inputs[0]!.outputIndex = 1;
    expect(getSigningPayload(a)).not.toBe(getSigningPayload(b));
  });
});

describe("computeTransactionId", () => {
  it("is deterministic for an identical full transaction", () => {
    const body = baseBody();
    body.inputs[0]!.signature = "sig";
    body.inputs[0]!.publicKey = "pub";
    expect(computeTransactionId(body)).toBe(computeTransactionId({ ...body }));
  });

  it("changes when the signature changes", () => {
    const a = baseBody();
    a.inputs[0]!.signature = "sig1";
    const b = baseBody();
    b.inputs[0]!.signature = "sig2";
    expect(computeTransactionId(a)).not.toBe(computeTransactionId(b));
  });

  it("changes when the fee changes", () => {
    const a = baseBody();
    const b = { ...baseBody(), fee: 2n };
    expect(computeTransactionId(a)).not.toBe(computeTransactionId(b));
  });
});

describe("end-to-end signing", () => {
  it("produces a signature over the signing payload that verifies with the owning key", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const body = baseBody();
    body.inputs[0]!.publicKey = publicKey;

    const payload = getSigningPayload(body);
    const signature = sign(privateKey, payload);
    body.inputs[0]!.signature = signature;

    expect(verify(publicKey, payload, body.inputs[0]!.signature)).toBe(true);

    const tx: Transaction = { ...body, id: computeTransactionId(body) };
    expect(tx.id).toBe(computeTransactionId(body));
  });
});

describe("record data (anchoring)", () => {
  const record = "ab".repeat(32);

  function signedWithData(data: string | undefined): Transaction {
    const kp = generateKeyPair();
    const body: UnsignedTransactionBody = { ...baseBody(), ...(data === undefined ? {} : { data }) };
    body.inputs[0]!.txId = "11".repeat(32);
    body.inputs[0]!.publicKey = kp.publicKey;
    const signature = sign(kp.privateKey, getSigningPayload(body));
    body.inputs[0]!.signature = signature;
    return { ...body, id: computeTransactionId(body) };
  }

  it("leaves the payload and id of a transaction without data exactly as before", () => {
    const body = baseBody();
    body.inputs[0]!.signature = "sig";
    body.inputs[0]!.publicKey = "pub";
    // The pre-anchoring serialization, spelled out: ids of existing
    // transactions (and so the genesis hash) must not move.
    expect(getSigningPayload(body)).toBe("prevtx1:0|alice:100|1700000000000|1");
    expect(computeTransactionId(body)).toBe(sha256("prevtx1:0:sig:pub|alice:100|1700000000000|1"));
  });

  it("is covered by the signing payload and the id", () => {
    const without = baseBody();
    const withData = { ...baseBody(), data: record };
    expect(getSigningPayload(withData)).not.toBe(getSigningPayload(without));
    expect(computeTransactionId(withData)).not.toBe(computeTransactionId(without));
    expect(computeTransactionId({ ...baseBody(), data: record })).not.toBe(computeTransactionId({ ...baseBody(), data: "cd".repeat(32) }));
  });

  it("attack: swapping the record after signing breaks the signature", () => {
    const tx = signedWithData(record);
    const tampered = { ...tx, data: "cd".repeat(32) };
    const kpPublic = tx.inputs[0]!.publicKey;
    expect(verify(kpPublic, getSigningPayload(tx), tx.inputs[0]!.signature)).toBe(true);
    expect(verify(kpPublic, getSigningPayload(tampered), tx.inputs[0]!.signature)).toBe(false);
  });

  it("accepts up to MAX_TX_DATA_BYTES bytes of lowercase hex", () => {
    expect(validateTransactionStructure(signedWithData(record))).toEqual({ valid: true });
    expect(validateTransactionStructure(signedWithData("00".repeat(MAX_TX_DATA_BYTES)))).toEqual({ valid: true });
  });

  it("attack: a record one byte over the limit is refused (no free bulk storage)", () => {
    const result = validateTransactionStructure(signedWithData("00".repeat(MAX_TX_DATA_BYTES + 1)));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/data/);
  });

  it("attack: uppercase hex is refused, so one record cannot be anchored under two spellings", () => {
    expect(validateTransactionStructure(signedWithData(record.toUpperCase())).valid).toBe(false);
  });

  it("refuses empty data, odd-length hex and non-hex text", () => {
    for (const data of ["", "abc", "zz"]) {
      expect(validateTransactionStructure(signedWithData(data)).valid, data).toBe(false);
    }
  });
});
