import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { ENGLISH_WORDLIST } from "./wordlist.js";

/**
 * BIP-39 recovery phrases: entropy ↔ words, and words → the 64-byte seed
 * that SLIP-0010 (wallet/hd.ts) turns into every account key. A phrase is
 * what a person can write on paper and type back in; the checksum (the
 * last few bits of the last word) means a copying mistake is refused
 * instead of silently restoring an empty wallet.
 *
 * Only the English wordlist is supported.
 */
export class MnemonicError extends Error {}

/** Word counts BIP-39 allows, keyed by entropy length in bytes. */
const WORD_COUNTS = new Map<number, number>([
  [16, 12],
  [20, 15],
  [24, 18],
  [28, 21],
  [32, 24],
]);
const ENTROPY_BYTES = new Map<number, number>([...WORD_COUNTS].map(([bytes, words]) => [words, bytes]));

export type WordCount = 12 | 15 | 18 | 21 | 24;

const INDEX = new Map<string, number>(ENGLISH_WORDLIST.map((w, i) => [w, i]));

/**
 * The canonical form of a typed phrase: NFKD, lower case, single spaces.
 * Being lenient here costs nothing (the checksum still guards the words)
 * and saves a user whose editor capitalised the first word.
 */
export function normalizeMnemonic(phrase: string): string {
  return phrase.normalize("NFKD").toLowerCase().trim().split(/\s+/).filter((w) => w.length > 0).join(" ");
}

function checksumBits(entropy: Buffer): string {
  const hash = createHash("sha256").update(entropy).digest();
  const bits = entropy.length / 4; // ENT / 32
  return toBits(hash).slice(0, bits);
}

function toBits(bytes: Buffer): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return bits;
}

/** Entropy (16–32 bytes, multiple of 4) → space-separated words. */
export function entropyToMnemonic(entropy: Buffer): string {
  const count = WORD_COUNTS.get(entropy.length);
  if (count === undefined) throw new MnemonicError(`entropy must be 16, 20, 24, 28 or 32 bytes, got ${entropy.length}`);
  const bits = toBits(entropy) + checksumBits(entropy);
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(ENGLISH_WORDLIST[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]!);
  return words.join(" ");
}

/** Words → entropy. Throws `MnemonicError` on a wrong count, an unknown word, or a checksum mismatch. */
export function mnemonicToEntropy(phrase: string): Buffer {
  const words = normalizeMnemonic(phrase).split(" ").filter((w) => w.length > 0);
  const entropyBytes = ENTROPY_BYTES.get(words.length);
  if (entropyBytes === undefined) throw new MnemonicError(`a recovery phrase has 12, 15, 18, 21 or 24 words, got ${words.length}`);
  let bits = "";
  for (const word of words) {
    const index = INDEX.get(word);
    if (index === undefined) throw new MnemonicError(`"${word}" is not a BIP-39 word`);
    bits += index.toString(2).padStart(11, "0");
  }
  const entropy = Buffer.alloc(entropyBytes);
  for (let i = 0; i < entropyBytes; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (bits.slice(entropyBytes * 8) !== checksumBits(entropy)) {
    throw new MnemonicError("recovery phrase checksum mismatch: a word is wrong, missing or out of order");
  }
  return entropy;
}

export function validateMnemonic(phrase: string): { valid: true } | { valid: false; reason: string } {
  try {
    mnemonicToEntropy(phrase);
    return { valid: true };
  } catch (err) {
    if (err instanceof MnemonicError) return { valid: false, reason: err.message };
    throw err;
  }
}

/**
 * The 64-byte seed: PBKDF2-HMAC-SHA512, 2048 rounds, salted with
 * "mnemonic" + passphrase, as the BIP specifies. The phrase is validated
 * first; BIP-39 itself would happily derive a seed from garbage.
 */
export function mnemonicToSeed(phrase: string, passphrase = ""): Buffer {
  mnemonicToEntropy(phrase);
  const normalized = normalizeMnemonic(phrase);
  return pbkdf2Sync(Buffer.from(normalized, "utf8"), Buffer.from(("mnemonic" + passphrase).normalize("NFKD"), "utf8"), 2048, 64, "sha512");
}

export function generateMnemonic(words: WordCount = 12): string {
  const bytes = ENTROPY_BYTES.get(words);
  if (bytes === undefined) throw new MnemonicError(`a recovery phrase has 12, 15, 18, 21 or 24 words, got ${words}`);
  return entropyToMnemonic(randomBytes(bytes));
}
