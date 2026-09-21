import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress, encodeAddress, decodeAddress, normalizeAddress, bech32mEncode, bech32mDecode, ADDRESS_HRP, AddressError } from "../../src/ledger/address.js";

const raw = deriveAddress(generateKeyPair().publicKey);

describe("checksummed address encoding (bech32m, hrp 'l1')", () => {
  it("round-trips a raw 32-byte address and looks like l1 1 <52 chars> <6 checksum>", () => {
    const encoded = encodeAddress(raw);
    expect(encoded).toMatch(new RegExp(`^${ADDRESS_HRP}1[02-9ac-hj-np-z]{58}$`));
    expect(encoded).toHaveLength(ADDRESS_HRP.length + 1 + 52 + 6);
    expect(decodeAddress(encoded)).toBe(raw);
  });

  it("is deterministic and lowercase", () => {
    expect(encodeAddress(raw)).toBe(encodeAddress(raw));
    expect(encodeAddress(raw)).toBe(encodeAddress(raw).toLowerCase());
  });

  it("accepts an all-uppercase spelling (bech32 rule) but rejects mixed case", () => {
    const encoded = encodeAddress(raw);
    expect(decodeAddress(encoded.toUpperCase())).toBe(raw);
    const mixed = encoded.slice(0, 10) + encoded.slice(10).toUpperCase();
    expect(() => decodeAddress(mixed)).toThrow(AddressError);
  });

  it("attack/typo: any single-character substitution is detected", () => {
    const encoded = encodeAddress(raw);
    const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let checked = 0;
    for (let i = ADDRESS_HRP.length + 1; i < encoded.length; i++) {
      for (const c of alphabet) {
        if (c === encoded[i]) continue;
        const corrupted = encoded.slice(0, i) + c + encoded.slice(i + 1);
        expect(() => decodeAddress(corrupted), corrupted).toThrow(AddressError);
        checked++;
      }
    }
    expect(checked).toBe(58 * 31);
  });

  it("detects a truncated or extended address and a wrong human-readable part", () => {
    const encoded = encodeAddress(raw);
    expect(() => decodeAddress(encoded.slice(0, -1))).toThrow(AddressError);
    expect(() => decodeAddress(encoded + "q")).toThrow(AddressError);
    // The prefix is inside the checksum, so a foreign prefix fails as a checksum error before anything else.
    expect(() => decodeAddress("xx" + encoded.slice(ADDRESS_HRP.length))).toThrow(AddressError);
    // A correctly checksummed string with the wrong prefix is refused by name.
    expect(() => decodeAddress(bech32mEncode("xx", bech32mDecode(encoded).data))).toThrow(/prefix "xx"/);
  });

  it("rejects a raw value that is not a 32-byte hex string", () => {
    expect(() => encodeAddress("abc")).toThrow(AddressError);
    expect(() => encodeAddress("g".repeat(64))).toThrow(AddressError);
  });

  it("matches the BIP-350 bech32m checksum on a known vector", () => {
    // BIP-350: "A1LQFN3A" / "a1lqfn3a" is a valid bech32m string with hrp "a" and no data.
    expect(bech32mDecode("a1lqfn3a")).toEqual({ hrp: "a", data: [] });
    expect(bech32mDecode("A1LQFN3A")).toEqual({ hrp: "a", data: [] });
    expect(bech32mEncode("a", [])).toBe("a1lqfn3a");
    // The same string is NOT valid under plain bech32 (different checksum constant).
    expect(() => bech32mDecode("a12uel5l")).toThrow(AddressError); // bech32 (BIP-173) checksum for the same payload
  });
});

describe("normalizeAddress (what the CLI and node accept)", () => {
  it("accepts a checksummed address and returns the raw form", () => {
    expect(normalizeAddress(encodeAddress(raw))).toBe(raw);
  });

  it("accepts a raw 64-hex address unchanged (legacy / node-internal form)", () => {
    expect(normalizeAddress(raw)).toBe(raw);
    expect(normalizeAddress(raw.toUpperCase())).toBe(raw);
  });

  it("rejects anything else with a message naming both accepted forms", () => {
    expect(() => normalizeAddress("bob")).toThrow(/l1…|64 hex|checksummed/i);
    expect(() => normalizeAddress(raw.slice(0, 63))).toThrow(AddressError);
  });
});
