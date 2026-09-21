import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

export function sign(privateKeyHex: string, message: string): string {
  const keyObject = createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type: "pkcs8",
  });

  return nodeSign(null, Buffer.from(message), keyObject).toString("hex");
}

export function verify(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): boolean {
  try {
    const keyObject = createPublicKey({
      key: Buffer.from(publicKeyHex, "hex"),
      format: "der",
      type: "spki",
    });

    return nodeVerify(
      null,
      Buffer.from(message),
      keyObject,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}
