import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { KeyPair } from "../crypto/keypair.js";
import { deriveAddress } from "../ledger/address.js";
import { accountKeyPair } from "./hd.js";
import { entropyToMnemonic, mnemonicToSeed } from "./mnemonic.js";

/**
 * Encrypted key file. The private key is the money, so it never touches
 * disk in the clear: scrypt (memory-hard, so a stolen file can't be
 * brute-forced cheaply on GPUs) derives an AES-256 key from the
 * passphrase, and AES-GCM authenticates the ciphertext so tampering is
 * detected rather than yielding a silently different key.
 */
export interface KeystoreKdf {
  name: "scrypt";
  salt: string;
  N: number;
  r: number;
  p: number;
}
export interface KeystoreCipher {
  name: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Version 1: one Ed25519 key, encrypted. Still readable; behaves as account 0. */
export interface KeystoreV1 {
  version: 1;
  /** Derived from publicKey; stored for display without a passphrase and
   *  re-checked on decrypt. */
  address: string;
  publicKey: string;
  kdf: KeystoreKdf;
  cipher: KeystoreCipher;
}

export interface KeystoreAccount {
  /** SLIP-0010 account index: m/44'/7331'/<index>'. */
  index: number;
  address: string;
  publicKey: string;
  label?: string;
}

/**
 * Version 2: an encrypted 32-byte seed from which every account's key is
 * derived (wallet/hd.ts), plus the public half of each account the user
 * has created, so addresses can be listed without the passphrase. The
 * public records are re-derived and checked on unlock, so editing one
 * cannot misdirect a payment.
 */
export interface KeystoreV2 {
  version: 2;
  accounts: KeystoreAccount[];
  kdf: KeystoreKdf;
  cipher: KeystoreCipher;
}

/**
 * Version 3, `type: "mnemonic"`: like version 2, but the sealed secret is
 * the entropy behind a BIP-39 recovery phrase (16–32 bytes), so the phrase
 * itself can be shown again for backup. Account keys come from the
 * phrase's 64-byte BIP-39 seed through the same SLIP-0010 path.
 */
export interface KeystoreV3 {
  version: 3;
  type: "mnemonic";
  accounts: KeystoreAccount[];
  kdf: KeystoreKdf;
  cipher: KeystoreCipher;
}

/**
 * Version 3, `type: "watch-only"`: the public account records of another
 * wallet and nothing else. It can be given to a machine that should see
 * balances and history but must never be able to spend, because there is
 * no secret in the file to steal or unlock.
 */
export interface KeystoreWatchOnly {
  version: 3;
  type: "watch-only";
  accounts: KeystoreAccount[];
}

export type Keystore = KeystoreV1 | KeystoreV2 | KeystoreV3 | KeystoreWatchOnly;

/** Thrown when a watch-only wallet is asked for something only keys can do. */
export class WatchOnlyError extends Error {
  constructor(action: string) {
    super(`this wallet is watch-only (addresses, no keys): it cannot ${action}`);
  }
}

export function isWatchOnly(keystore: Keystore): keystore is KeystoreWatchOnly {
  return keystore.version === 3 && keystore.type === "watch-only";
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** N=2^15 is ~100 ms on a laptop and ~32 MB of memory: slow enough to hurt
 *  a brute-forcer, fast enough for one interactive unlock. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

export function encryptKeyPair(keyPair: KeyPair, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT): KeystoreV1 {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, params);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keyPair.privateKey, "hex")), cipher.final()]);
  return {
    version: 1,
    address: deriveAddress(keyPair.publicKey),
    publicKey: keyPair.publicKey,
    kdf: { name: "scrypt", salt: salt.toString("hex"), ...params },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    },
  };
}

/** Throws on a wrong passphrase, a tampered file, or an address that
 *  doesn't match the key inside (e.g. a file whose header was edited to
 *  make you think you're paying yourself). */
export function decryptKeystore(keystore: KeystoreV1, passphrase: string): KeyPair {
  if (deriveAddress(keystore.publicKey) !== keystore.address) {
    throw new Error("keystore address does not match its public key");
  }

  const key = deriveKey(passphrase, Buffer.from(keystore.kdf.salt, "hex"), keystore.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keystore.cipher.iv, "hex"));
  decipher.setAuthTag(Buffer.from(keystore.cipher.tag, "hex"));

  let privateKey: Buffer;
  try {
    privateKey = Buffer.concat([decipher.update(Buffer.from(keystore.cipher.ciphertext, "hex")), decipher.final()]);
  } catch {
    // GCM can't distinguish the two, and neither should an error message
    // that an attacker with the file could observe.
    throw new Error("wrong passphrase or tampered keystore");
  }
  return { publicKey: keystore.publicKey, privateKey: privateKey.toString("hex") };
}

/** Encrypts `secret` under the passphrase (shared by both keystore versions). */
function seal(secret: Buffer, passphrase: string, params: ScryptParams): { kdf: KeystoreKdf; cipher: KeystoreCipher } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, params);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    kdf: { name: "scrypt", salt: salt.toString("hex"), ...params },
    cipher: { name: "aes-256-gcm", iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") },
  };
}

function open(kdf: KeystoreKdf, cipher: KeystoreCipher, passphrase: string): Buffer {
  const key = deriveKey(passphrase, Buffer.from(kdf.salt, "hex"), kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "hex"));
  decipher.setAuthTag(Buffer.from(cipher.tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(cipher.ciphertext, "hex")), decipher.final()]);
  } catch {
    throw new Error("wrong passphrase or tampered keystore");
  }
}

function accountRecord(seed: Buffer, index: number, label?: string): KeystoreAccount {
  const { publicKey } = accountKeyPair(seed, index);
  return { index, address: deriveAddress(publicKey), publicKey, ...(label !== undefined ? { label } : {}) };
}

/** A new HD keystore holding `seed` (32 bytes) with account 0 created. */
export function createHdKeystore(seed: Buffer, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT): KeystoreV2 {
  if (seed.length !== 32) throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  return { version: 2, accounts: [accountRecord(seed, 0)], ...seal(seed, passphrase, params) };
}

/** A new keystore holding the entropy of a BIP-39 phrase, with account 0 created. */
export function createMnemonicKeystore(entropy: Buffer, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT): KeystoreV3 {
  const seed = mnemonicToSeed(entropyToMnemonic(entropy)); // validates the entropy length
  return { version: 3, type: "mnemonic", accounts: [accountRecord(seed, 0)], ...seal(entropy, passphrase, params) };
}

/**
 * The SLIP-0010 master seed, for backup or derivation: the raw 32 bytes of
 * a version 2 file, or the 64-byte BIP-39 seed of a mnemonic file.
 * Whoever holds it holds every account.
 */
export function exportSeed(keystore: Keystore, passphrase: string): Buffer {
  if (keystore.version === 1) throw new Error("version 1 (single-key) keystore has no seed");
  if (keystore.version === 3 && keystore.type === "watch-only") throw new WatchOnlyError("export a seed");
  const secret = open(keystore.kdf, keystore.cipher, passphrase);
  if (keystore.version === 2) {
    if (secret.length !== 32) throw new Error("wrong passphrase or tampered keystore");
    return secret;
  }
  let phrase: string;
  try {
    phrase = entropyToMnemonic(secret);
  } catch {
    throw new Error("wrong passphrase or tampered keystore");
  }
  return mnemonicToSeed(phrase);
}

/** The recovery phrase of a mnemonic wallet. */
export function exportMnemonic(keystore: Keystore, passphrase: string): string {
  if (isWatchOnly(keystore)) throw new WatchOnlyError("export a recovery phrase");
  if (keystore.version !== 3) throw new Error("this wallet has no recovery phrase (it was created from a raw seed or a single key)");
  const secret = open(keystore.kdf, keystore.cipher, passphrase);
  try {
    return entropyToMnemonic(secret);
  } catch {
    throw new Error("wrong passphrase or tampered keystore");
  }
}

/** A copy of the wallet's public account records with no secret at all. */
export function exportWatchOnly(keystore: Keystore): KeystoreWatchOnly {
  return { version: 3, type: "watch-only", accounts: keystoreAccounts(keystore) };
}

/** Public records of every account, with no passphrase needed. */
export function keystoreAccounts(keystore: Keystore): KeystoreAccount[] {
  if (keystore.version === 1) return [{ index: 0, address: keystore.address, publicKey: keystore.publicKey }];
  return keystore.accounts.map((a) => ({ ...a }));
}

/**
 * The key pair for one account. Re-derives the account's public key from
 * the seed and compares it with the stored record, so a file whose account
 * list was edited fails here rather than paying the wrong address.
 */
export function unlockAccount(keystore: Keystore, passphrase: string, account = 0): KeyPair {
  if (keystore.version === 1) {
    if (account !== 0) throw new Error(`version 1 (single-key) keystore has only account 0, not account ${account}`);
    return decryptKeystore(keystore, passphrase);
  }
  if (isWatchOnly(keystore)) throw new WatchOnlyError("sign");
  const record = keystore.accounts.find((a) => a.index === account);
  if (!record) throw new Error(`account ${account} does not exist in this wallet (run "account new")`);
  const keyPair = accountKeyPair(exportSeed(keystore, passphrase), account);
  if (keyPair.publicKey !== record.publicKey || deriveAddress(keyPair.publicKey) !== record.address) {
    throw new Error(`keystore account ${account} record does not match the key derived from the seed`);
  }
  return keyPair;
}

/** Derives the next account and returns the updated keystore (the input is not mutated). */
export function addAccount(keystore: KeystoreV2, passphrase: string, label?: string): KeystoreV2;
export function addAccount(keystore: KeystoreV3, passphrase: string, label?: string): KeystoreV3;
export function addAccount(keystore: Keystore, passphrase: string, label?: string): KeystoreV2 | KeystoreV3;
export function addAccount(keystore: Keystore, passphrase: string, label?: string): KeystoreV2 | KeystoreV3 {
  if (keystore.version === 1) throw new Error("version 1 (single-key) keystore cannot hold more accounts; create a new wallet");
  if (isWatchOnly(keystore)) throw new WatchOnlyError("derive accounts");
  const seed = exportSeed(keystore, passphrase);
  const next = keystore.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1;
  return { ...keystore, accounts: [...keystore.accounts, accountRecord(seed, next, label)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]*$/i.test(value);
}

/** Parses and shape-checks a keystore file's contents. */
export function parseKeystore(json: string): Keystore {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("not a keystore file");
  if (value.version !== 1 && value.version !== 2 && value.version !== 3) throw new Error(`unsupported keystore version ${String(value.version)}`);
  if (value.version === 3) {
    if (value.type !== "mnemonic" && value.type !== "watch-only") throw new Error("malformed keystore file");
    if (!Array.isArray(value.accounts) || !value.accounts.every(isAccountRecord)) throw new Error("malformed keystore file");
    const accounts = value.accounts.map(copyAccount);
    if (value.type === "watch-only") return { version: 3, type: "watch-only", accounts };
    return { version: 3, type: "mnemonic", accounts, ...parseSealed(value) };
  }
  const sealed = parseSealed(value);
  if (value.version === 1) {
    if (typeof value.address !== "string" || !isHex(value.publicKey)) throw new Error("malformed keystore file");
    return { version: 1, address: value.address, publicKey: value.publicKey, ...sealed };
  }
  if (!Array.isArray(value.accounts) || !value.accounts.every(isAccountRecord)) throw new Error("malformed keystore file");
  return { version: 2, accounts: value.accounts.map(copyAccount), ...sealed };
}

function copyAccount(a: KeystoreAccount): KeystoreAccount {
  return { index: a.index, address: a.address, publicKey: a.publicKey, ...(a.label !== undefined ? { label: a.label } : {}) };
}

function parseSealed(value: Record<string, unknown>): { kdf: KeystoreKdf; cipher: KeystoreCipher } {
  if (!isRecord(value.kdf) || !isRecord(value.cipher)) throw new Error("not a keystore file");
  const { kdf, cipher } = value;
  if (
    kdf.name !== "scrypt" ||
    !isHex(kdf.salt) ||
    typeof kdf.N !== "number" ||
    typeof kdf.r !== "number" ||
    typeof kdf.p !== "number" ||
    cipher.name !== "aes-256-gcm" ||
    !isHex(cipher.iv) ||
    !isHex(cipher.tag) ||
    !isHex(cipher.ciphertext)
  ) {
    throw new Error("malformed keystore file");
  }
  return {
    kdf: { name: "scrypt", salt: kdf.salt, N: kdf.N, r: kdf.r, p: kdf.p },
    cipher: { name: "aes-256-gcm", iv: cipher.iv, tag: cipher.tag, ciphertext: cipher.ciphertext },
  };
}

function isAccountRecord(value: unknown): value is KeystoreAccount {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.address === "string" &&
    isHex(value.publicKey) &&
    (value.label === undefined || typeof value.label === "string")
  );
}
