import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign, verify } from "../../src/crypto/signature.js";
import {
  computeTransactionId,
  getSigningPayload,
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
