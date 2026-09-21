import { sha256 } from "../crypto/hash.js";

/** The on-chain address: sha256 of the public key, 64 lowercase hex chars. */
export function deriveAddress(publicKeyHex: string): string {
  return sha256(publicKeyHex);
}

/**
 * Human-facing address encoding: bech32m (BIP-350) with the human-readable
 * part "l1". A one-character typo, a dropped or added character, or a
 * paste from another chain fails the checksum instead of sending coins to
 * an address nobody owns. Consensus and state never see this form -- the
 * CLI decodes to the raw hex before it reaches the node.
 */
export const ADDRESS_HRP = "l1";

export class AddressError extends Error {}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** bech32m over 5-bit groups. Exported for its test vectors; use encodeAddress for addresses. */
export function bech32mEncode(hrp: string, data: number[]): string {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32M_CONST;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

export function bech32mDecode(input: string): { hrp: string; data: number[] } {
  const lower = input.toLowerCase();
  if (lower !== input && input.toUpperCase() !== input) throw new AddressError("address must not mix upper and lower case");
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) throw new AddressError("address is missing its separator or checksum");
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new AddressError(`address contains an invalid character "${c}"`);
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) throw new AddressError("address checksum does not match (typo?)");
  return { hrp, data: data.slice(0, -6) };
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new AddressError("address payload has invalid padding");
  }
  return out;
}

const RAW_ADDRESS = /^[0-9a-f]{64}$/;

export function encodeAddress(rawHex: string): string {
  if (!RAW_ADDRESS.test(rawHex)) throw new AddressError(`not a raw address (expected 64 hex characters): ${rawHex}`);
  const bytes = [...Buffer.from(rawHex, "hex")];
  return bech32mEncode(ADDRESS_HRP, convertBits(bytes, 8, 5, true));
}

export function decodeAddress(encoded: string): string {
  const { hrp, data } = bech32mDecode(encoded);
  if (hrp !== ADDRESS_HRP) throw new AddressError(`address has prefix "${hrp}", expected "${ADDRESS_HRP}" (a different network or coin?)`);
  const bytes = convertBits(data, 5, 8, false);
  if (bytes.length !== 32) throw new AddressError(`address payload is ${bytes.length} bytes, expected 32`);
  return Buffer.from(bytes).toString("hex");
}

/**
 * Accepts either the checksummed form or the raw 64-hex form (what the
 * node stores and older configs contain) and returns the raw form.
 */
export function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  if (RAW_ADDRESS.test(trimmed.toLowerCase())) return trimmed.toLowerCase();
  if (trimmed.toLowerCase().startsWith(`${ADDRESS_HRP}1`)) return decodeAddress(trimmed);
  throw new AddressError(`"${input}" is not an address: expected a checksummed l1… address or 64 hex characters`);
}
