import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";
import {
  addAccount,
  createHdKeystore,
  createMnemonicKeystore,
  decryptKeystore,
  encryptKeyPair,
  exportMnemonic,
  exportSeed,
  exportWatchOnly,
  isWatchOnly,
  keystoreAccounts,
  parseKeystore,
  unlockAccount,
  WatchOnlyError,
  type Keystore,
} from "../../src/wallet/keystore.js";
import { accountKeyPair } from "../../src/wallet/hd.js";
import { mnemonicToEntropy, mnemonicToSeed } from "../../src/wallet/mnemonic.js";

// Small scrypt parameters so the suite stays fast; production defaults are
// exercised by the "defaults" test below.
const FAST_KDF = { N: 1024, r: 8, p: 1 };

describe("wallet keystore", () => {
  it("round-trips a key pair through encryption with the right passphrase", () => {
    const kp = generateKeyPair();
    const ks = encryptKeyPair(kp, "correct horse", FAST_KDF);
    expect(ks.version).toBe(1);
    expect(ks.address).toBe(deriveAddress(kp.publicKey));
    expect(ks.publicKey).toBe(kp.publicKey);

    const recovered = decryptKeystore(ks, "correct horse");
    expect(recovered).toEqual(kp);
  });

  it("never stores the private key in the clear", () => {
    const kp = generateKeyPair();
    const serialized = JSON.stringify(encryptKeyPair(kp, "pw", FAST_KDF));
    expect(serialized).not.toContain(kp.privateKey);
    // Not even a large substring of it.
    expect(serialized).not.toContain(kp.privateKey.slice(20, 60));
  });

  it("rejects a wrong passphrase", () => {
    const ks = encryptKeyPair(generateKeyPair(), "right", FAST_KDF);
    expect(() => decryptKeystore(ks, "wrong")).toThrow(/passphrase/i);
  });

  it("rejects a keystore whose ciphertext was tampered with (authenticated encryption)", () => {
    const ks = encryptKeyPair(generateKeyPair(), "pw", FAST_KDF);
    const bytes = Buffer.from(ks.cipher.ciphertext, "hex");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered: Keystore = { ...ks, cipher: { ...ks.cipher, ciphertext: bytes.toString("hex") } };
    expect(() => decryptKeystore(tampered, "pw")).toThrow(/passphrase|tamper|auth/i);
  });

  it("rejects a keystore whose stored address doesn't match the decrypted key (swapped-file attack)", () => {
    const kp = generateKeyPair();
    const ks = { ...encryptKeyPair(kp, "pw", FAST_KDF), address: deriveAddress(generateKeyPair().publicKey) };
    expect(() => decryptKeystore(ks, "pw")).toThrow(/address/i);
  });

  it("uses a fresh salt and iv every time, so identical keys and passphrases don't produce identical files", () => {
    const kp = generateKeyPair();
    const a = encryptKeyPair(kp, "pw", FAST_KDF);
    const b = encryptKeyPair(kp, "pw", FAST_KDF);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.cipher.ciphertext).not.toBe(b.cipher.ciphertext);
  });

  it("uses a memory-hard KDF by default (scrypt N >= 2^14)", () => {
    const ks = encryptKeyPair(generateKeyPair(), "pw");
    expect(ks.kdf.name).toBe("scrypt");
    expect(ks.kdf.N).toBeGreaterThanOrEqual(2 ** 14);
    expect(decryptKeystore(ks, "pw").publicKey).toBe(ks.publicKey);
  });

  it("parseKeystore validates the file shape instead of trusting it", () => {
    expect(() => parseKeystore("not json")).toThrow();
    expect(() => parseKeystore(JSON.stringify({ version: 1 }))).toThrow(/keystore/i);
    expect(() => parseKeystore(JSON.stringify({ ...encryptKeyPair(generateKeyPair(), "pw", FAST_KDF), version: 4 }))).toThrow(
      /version/i,
    );
    const ks = encryptKeyPair(generateKeyPair(), "pw", FAST_KDF);
    expect(parseKeystore(JSON.stringify(ks))).toEqual(ks);
  });
});

describe("HD keystore (version 2)", () => {
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

  it("stores an encrypted seed plus public account records, and unlocks accounts deterministically", () => {
    const ks = createHdKeystore(seed, "pw", FAST_KDF);
    expect(ks.version).toBe(2);
    expect(ks.accounts).toHaveLength(1);
    expect(ks.accounts[0]).toMatchObject({ index: 0, address: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(ks)).not.toContain(seed.toString("hex"));

    const kp0 = unlockAccount(ks, "pw", 0);
    expect(deriveAddress(kp0.publicKey)).toBe(ks.accounts[0]!.address);
    expect(kp0).toEqual(accountKeyPair(seed, 0));
    expect(exportSeed(ks, "pw").toString("hex")).toBe(seed.toString("hex"));
  });

  it("adds accounts with consecutive indexes and optional labels; the same seed restores the same addresses", () => {
    let ks = createHdKeystore(seed, "pw", FAST_KDF);
    ks = addAccount(ks, "pw", "savings");
    ks = addAccount(ks, "pw");
    expect(ks.accounts.map((a) => a.index)).toEqual([0, 1, 2]);
    expect(ks.accounts[1]!.label).toBe("savings");
    const restored = createHdKeystore(seed, "other-pw", FAST_KDF);
    expect(addAccount(addAccount(restored, "other-pw"), "other-pw").accounts.map((a) => a.address)).toEqual(ks.accounts.map((a) => a.address));
  });

  it("rejects a wrong passphrase and tampering, and refuses an account the file does not list", () => {
    const ks = createHdKeystore(seed, "pw", FAST_KDF);
    expect(() => unlockAccount(ks, "nope", 0)).toThrow(/passphrase|tampered/i);
    expect(() => unlockAccount(ks, "pw", 1)).toThrow(/account 1/);
    const tampered = { ...ks, cipher: { ...ks.cipher, ciphertext: ks.cipher.ciphertext.replace(/^../, "00") } };
    expect(() => unlockAccount(tampered, "pw", 0)).toThrow(/passphrase|tampered/i);
  });

  it("attack: an account record whose address was edited cannot misdirect a payment", () => {
    const ks = createHdKeystore(seed, "pw", FAST_KDF);
    const evil = { ...ks, accounts: [{ ...ks.accounts[0]!, address: deriveAddress(generateKeyPair().publicKey) }] };
    expect(() => unlockAccount(evil, "pw", 0)).toThrow(/account 0.*does not match/i);
  });

  it("a version-1 keystore is account 0 and nothing else", () => {
    const kp = generateKeyPair();
    const v1 = encryptKeyPair(kp, "pw", FAST_KDF);
    expect(keystoreAccounts(v1)).toEqual([{ index: 0, address: v1.address, publicKey: kp.publicKey }]);
    expect(unlockAccount(v1, "pw", 0)).toEqual(kp);
    expect(() => unlockAccount(v1, "pw", 1)).toThrow(/version 1|single-key/i);
    expect(() => addAccount(v1, "pw")).toThrow(/version 1|single-key/i);
  });

  it("parseKeystore accepts both versions and validates the v2 shape", () => {
    const ks = createHdKeystore(seed, "pw", FAST_KDF);
    const parsed = parseKeystore(JSON.stringify(ks));
    expect(parsed).toEqual(ks);
    expect(() => parseKeystore(JSON.stringify({ ...ks, accounts: "nope" }))).toThrow(/malformed/);
    expect(() => parseKeystore(JSON.stringify({ ...ks, accounts: [{ index: "0" }] }))).toThrow(/malformed/);
  });
});

describe("mnemonic keystore (version 3)", () => {
  const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const entropy = mnemonicToEntropy(phrase);

  it("seals the phrase's entropy and derives accounts from the BIP-39 seed", () => {
    const ks = createMnemonicKeystore(entropy, "pw", FAST_KDF);
    expect(ks).toMatchObject({ version: 3, type: "mnemonic" });
    expect(ks.accounts).toHaveLength(1);
    const json = JSON.stringify(ks);
    expect(json).not.toContain(entropy.toString("hex"));
    expect(json).not.toContain("legal");
    expect(unlockAccount(ks, "pw", 0)).toEqual(accountKeyPair(mnemonicToSeed(phrase), 0));
    expect(deriveAddress(unlockAccount(ks, "pw", 0).publicKey)).toBe(ks.accounts[0]!.address);
    expect(exportMnemonic(ks, "pw")).toBe(phrase);
    expect(exportSeed(ks, "pw").equals(mnemonicToSeed(phrase))).toBe(true);
    expect(() => exportMnemonic(ks, "nope")).toThrow(/passphrase|tampered/i);
  });

  it("adds accounts, and the same phrase restores the same addresses under another passphrase", () => {
    const ks = addAccount(addAccount(createMnemonicKeystore(entropy, "pw", FAST_KDF), "pw", "savings"), "pw");
    expect(ks.version).toBe(3);
    expect(ks.accounts.map((a) => a.index)).toEqual([0, 1, 2]);
    const restored = addAccount(addAccount(createMnemonicKeystore(mnemonicToEntropy(phrase), "other", FAST_KDF), "other"), "other");
    expect(restored.accounts.map((a) => a.address)).toEqual(ks.accounts.map((a) => a.address));
    expect(unlockAccount(restored, "other", 2)).toEqual(unlockAccount(ks, "pw", 2));
  });

  it("attack: an edited account record cannot misdirect a payment; a tampered ciphertext is refused", () => {
    const ks = createMnemonicKeystore(entropy, "pw", FAST_KDF);
    const evil = { ...ks, accounts: [{ ...ks.accounts[0]!, address: deriveAddress(generateKeyPair().publicKey) }] };
    expect(() => unlockAccount(evil, "pw", 0)).toThrow(/account 0.*does not match/i);
    const tampered = { ...ks, cipher: { ...ks.cipher, ciphertext: ks.cipher.ciphertext.replace(/^../, "00") } };
    expect(() => unlockAccount(tampered, "pw", 0)).toThrow(/passphrase|tampered/i);
  });

  it("exportMnemonic is only for mnemonic wallets; a raw-seed wallet has no phrase", () => {
    const seed = Buffer.alloc(32, 7);
    expect(() => exportMnemonic(createHdKeystore(seed, "pw", FAST_KDF), "pw")).toThrow(/no recovery phrase/);
  });

  it("parseKeystore round-trips a v3 file and validates its shape", () => {
    const ks = createMnemonicKeystore(entropy, "pw", FAST_KDF);
    expect(parseKeystore(JSON.stringify(ks))).toEqual(ks);
    expect(() => parseKeystore(JSON.stringify({ ...ks, type: "hd" }))).toThrow(/malformed|unsupported/);
    const { kdf: _kdf, ...noKdf } = ks;
    expect(() => parseKeystore(JSON.stringify(noKdf))).toThrow(/malformed|not a keystore/);
  });
});

describe("watch-only keystore", () => {
  const entropy = mnemonicToEntropy("legal winner thank year wave sausage worth useful legal winner thank yellow");

  it("holds the public account records and nothing secret", () => {
    const full = addAccount(createMnemonicKeystore(entropy, "pw", FAST_KDF), "pw", "savings");
    const watch = exportWatchOnly(full);
    expect(watch).toEqual({ version: 3, type: "watch-only", accounts: full.accounts });
    expect(isWatchOnly(watch)).toBe(true);
    expect(isWatchOnly(full)).toBe(false);
    expect(keystoreAccounts(watch)).toEqual(keystoreAccounts(full));
    expect(JSON.stringify(watch)).not.toMatch(/kdf|cipher|ciphertext/);
    expect(parseKeystore(JSON.stringify(watch))).toEqual(watch);
    // Exporting from v1/v2 works too: every keystore has public records.
    expect(exportWatchOnly(createHdKeystore(Buffer.alloc(32, 1), "pw", FAST_KDF)).accounts).toHaveLength(1);
    expect(exportWatchOnly(encryptKeyPair(generateKeyPair(), "pw", FAST_KDF)).accounts[0]!.index).toBe(0);
  });

  it("refuses to sign, derive or export secrets: there are none", () => {
    const watch = exportWatchOnly(createMnemonicKeystore(entropy, "pw", FAST_KDF));
    expect(() => unlockAccount(watch, "pw", 0)).toThrow(WatchOnlyError);
    expect(() => addAccount(watch, "pw")).toThrow(WatchOnlyError);
    expect(() => exportSeed(watch, "pw")).toThrow(WatchOnlyError);
    expect(() => exportMnemonic(watch, "pw")).toThrow(WatchOnlyError);
  });

  it("attack: a watch-only file given a stolen secret from another wallet cannot sign for its addresses", () => {
    // The attacker (or a confused user) turns the watch-only file into a
    // "mnemonic" file by pasting in the sealed secret of a wallet they DO
    // hold, hoping the CLI signs for the watched addresses with it.
    const watch = exportWatchOnly(createMnemonicKeystore(entropy, "pw", FAST_KDF));
    const theirs = createMnemonicKeystore(mnemonicToEntropy("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"), "pw", FAST_KDF);
    const forged = parseKeystore(JSON.stringify({ ...watch, type: "mnemonic", kdf: theirs.kdf, cipher: theirs.cipher }));
    expect(() => unlockAccount(forged, "pw", 0)).toThrow(/account 0.*does not match/i);
  });

  it("parseKeystore rejects a watch-only file with a malformed account list", () => {
    const watch = exportWatchOnly(createMnemonicKeystore(entropy, "pw", FAST_KDF));
    expect(() => parseKeystore(JSON.stringify({ ...watch, accounts: [{ index: 0 }] }))).toThrow(/malformed/);
    expect(() => parseKeystore(JSON.stringify({ version: 3, type: "watch-only" }))).toThrow(/malformed/);
  });
});
