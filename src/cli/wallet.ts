import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "../config/args.js";
import { genesisConfigFrom, loadConfig } from "../config/index.js";
import { createGenesisBlock } from "../ledger/block.js";
import type { BlockHeader } from "../ledger/types.js";
import { parseWireChainHeader, parseWireTransaction, serializeTransaction } from "../ledger/serialize.js";
import type { Unspent } from "../state/utxoSet.js";
import { randomBytes } from "node:crypto";
import { AddressError, encodeAddress, normalizeAddress } from "../ledger/address.js";
import {
  addAccount,
  createHdKeystore,
  createMnemonicKeystore,
  exportMnemonic,
  exportSeed,
  exportWatchOnly,
  isWatchOnly,
  keystoreAccounts,
  parseKeystore,
  unlockAccount,
  WatchOnlyError,
  type Keystore,
  type KeystoreAccount,
} from "../wallet/keystore.js";
import { generateMnemonic, MnemonicError, mnemonicToEntropy, type WordCount } from "../wallet/mnemonic.js";
import { loadVerifiedHeaders, saveHeaders } from "../wallet/headerStore.js";
import { HeaderSyncError, syncHeaders, verifyInclusion, type ChainHeader, type InclusionProof, type SpvParams, type SyncResult } from "../wallet/spv.js";
import { buildAnchorTransaction, buildTransaction, bumpFee, InsufficientFundsError, isMature } from "../wallet/txBuilder.js";
import { sha256 } from "../crypto/hash.js";
import { computeTransactionId, MAX_TX_DATA_BYTES } from "../ledger/transaction.js";
import { isLoopbackHost } from "../rpc/tls.js";
import { JsonRpcClient, RpcError, RpcTransportError } from "./rpcClient.js";

/** Everything the CLI touches in the outside world, so tests can script it. */
export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  env: Record<string, string | undefined>;
  /** Reads a passphrase without echo. Only called when no flag/env supplies one. */
  promptPassphrase(prompt: string): Promise<string>;
}

export const DEFAULT_RPC_URL = "http://127.0.0.1:9001";
export const DEFAULT_WALLET_PATH = "data/wallet.json";
export const DEFAULT_HEADERS_PATH = "data/headers.json";

export const USAGE = `Usage: npm run wallet -- <command> [options]

Commands:
  create              Generate a wallet (BIP-39 recovery phrase + account 0), encrypted, at
                      --wallet; prints the phrase once -- write it down. --words 24 for a
                      longer phrase
  restore             Recreate a wallet from --mnemonic "<words>" (or typed at a hidden
                      prompt), or from a raw --seed <64 hex>
  watch-only          Write a copy holding addresses only, no keys, to --out <path>; on
                      another machine it shows balances and history but can never sign
  address             Print an account's address (no passphrase needed)
  account list        List accounts (index, address, label)
  account new         Derive the next account (--label <text> optional)
  seed                Print the recovery phrase (or raw seed) for backup (needs the passphrase)
  balance             Show total / spendable / immature balance
  unspent             List the wallet's unspent outputs
  history             Confirmed transactions involving the account, newest first
  send                Pay --amount to --to (plus --fee, default: node's minimum)
  bump                Replace a pending payment (--tx) with a copy paying --fee, taken
                      from its change output (replace-by-fee)
  anchor              Record a document on chain: sends its sha256 (--file <path>, hashed
                      here; or --hash <hex>) in a transaction that pays nobody (fee only)
  find-anchor         Prove a record was anchored (--file or --hash): block, height, block
                      time, confirmations; checks the transaction carries the record, its
                      merkle proof and the header chain, without trusting the node
  info                Show the node's chain info
  verify              SPV-check that --tx is confirmed: verifies the header chain from
                      genesis (PoW, targets, timestamps) and a merkle inclusion proof,
                      without trusting the node's UTXO state
  sync                Bring the local header store up to date with the node (what
                      verify does first); prints the verified tip

Addresses are printed checksummed (l1…); commands accept that form or the raw
64-hex form. A typo in a checksummed address is refused instead of sending
coins to nobody.

Options:
  --wallet <path>       Keystore file (default: ${DEFAULT_WALLET_PATH})
  --account <n>         Which account to use (default: 0)
  --address <addr>      For balance/unspent/history: this address instead of the wallet's
  --to <addr>           Recipient (send)
  --limit <n>           Most entries to show (history; default 50)
  --label <text>        Label for a new account (account new)
  --words <n>           Recovery phrase length: 12 (default), 15, 18, 21 or 24 (create)
  --mnemonic <words>    Recovery phrase to restore, quoted (restore); omit to type it hidden
  --seed <hex>          Raw 32-byte seed to restore (restore)
  --out <path>          Where to write the watch-only copy (watch-only)
  --raw                 Print addresses as raw hex (address, account list)
  --amount <n>          Amount in base units, integer (send)
  --fee <n>             Fee in base units, integer (send, anchor; bump: the new, higher fee)
  --file <path>         Document to anchor or look up; only its sha256 is sent (anchor, find-anchor)
  --hash <hex>          Record to anchor or look up, e.g. a sha256 computed elsewhere (up to
                        80 bytes of hex) (anchor, find-anchor)
  --tx <txId>           Transaction to verify (verify) or replace (bump)
  --genesis-hash <h>    Trusted genesis hash (verify/sync; default: computed from config/default.json)
  --config <path>       Chain config (genesis, consensus rules, authorities) for verify/sync
                        (default: $L1_CONFIG or config/default.json)
  --headers <path>      Verified-header store, so sync/verify download only new headers
                        (default: $L1_HEADERS_PATH or ${DEFAULT_HEADERS_PATH})
  --rpc <url>           Node JSON-RPC base URL (default: $L1_RPC_URL or ${DEFAULT_RPC_URL})
  --ca <path>           PEM certificate to trust for an https:// node (default: $L1_RPC_CA);
                        needed for a self-signed node certificate
  --passphrase <text>   Wallet passphrase (prefer $L1_WALLET_PASSPHRASE or the prompt;
                        a flag lands in your shell history)`;

class UsageError extends Error {}
/** The chain or proof the node served did not verify. */
class SpvError extends Error {}

/** Wire shapes as the node's JSON-RPC returns them (bigints as strings). */
interface WireInfo {
  networkId: string;
  genesisHash: string;
  tip: { hash: string; height: number } | null;
  coinbaseMaturity: number;
  minFee: string;
  blockReward: string;
  peerCount: number;
  consensusMode: "pow" | "poa";
  addressIndex: { depth: number; fromHeight: number } | null;
}
interface WireSupply {
  circulating: string;
  maxSupply: string | null;
  nextHalvingHeight: number | null;
  halvingInterval: number;
  tailEmission: string;
}
interface WireActivity {
  txId: string;
  height: number;
  blockHash: string;
  timestamp: number;
  received: string;
  sent: string;
}
interface WireAnchor {
  txId: string;
  height: number;
  blockHash: string;
  blockTimestamp: number;
  confirmations: number;
}
interface WireUnspent {
  txId: string;
  outputIndex: number;
  address: string;
  amount: string;
  blockHeight: number;
  isCoinbase: boolean;
}

function parseAmount(raw: string | undefined, name: string): bigint {
  if (raw === undefined) throw new UsageError(`--${name} is required`);
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer in base units, got "${raw}"`);
  return BigInt(raw);
}

/** Accepts a checksummed or raw address; a bad checksum is a usage error. */
function parseAddressFlag(value: string, name: string): string {
  try {
    return normalizeAddress(value);
  } catch (err) {
    if (err instanceof AddressError) throw new UsageError(`--${name}: ${err.message}; coins sent to a typo are unrecoverable`);
    throw err;
  }
}

function parseAccount(flags: Record<string, string>): number {
  if (flags.account === undefined) return 0;
  if (!/^\d+$/.test(flags.account)) throw new UsageError(`--account must be a non-negative integer, got "${flags.account}"`);
  return Number(flags.account);
}

/**
 * The record to anchor or look up: `--file` (sha256 of its bytes, computed
 * here, so the file never leaves this machine) or `--hash` (a digest
 * computed elsewhere; any hex record up to MAX_TX_DATA_BYTES).
 */
function parseRecord(flags: Record<string, string>): string {
  if ((flags.file === undefined) === (flags.hash === undefined)) throw new UsageError("give exactly one of --file <path> or --hash <hex>");
  if (flags.file !== undefined) {
    if (!existsSync(flags.file)) throw new UsageError(`--file: ${flags.file} does not exist`);
    return sha256(readFileSync(flags.file));
  }
  const record = flags.hash!.toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(record) || record.length / 2 > MAX_TX_DATA_BYTES) {
    throw new UsageError(`--hash must be hex, 1 to ${MAX_TX_DATA_BYTES} bytes (a sha256 is 64 hex characters)`);
  }
  return record;
}

/** Spending, deriving and backups need keys; a watch-only file has none, and says so before any prompt. */
function requireKeys(keystore: Keystore, action: string): void {
  if (isWatchOnly(keystore)) throw new UsageError(new WatchOnlyError(action).message);
}

function parseWordCount(flags: Record<string, string>): WordCount {
  if (flags.words === undefined) return 12;
  const n = Number(flags.words);
  if (![12, 15, 18, 21, 24].includes(n)) throw new UsageError(`--words must be 12, 15, 18, 21 or 24, got "${flags.words}"`);
  return n as WordCount;
}

function selectAccount(keystore: Keystore, index: number): KeystoreAccount {
  const account = keystoreAccounts(keystore).find((a) => a.index === index);
  if (!account) throw new UsageError(`account ${index} does not exist in this wallet (run "account new" or "account list")`);
  return account;
}

function showAddress(raw: string, flags: Record<string, string>): string {
  return flags.raw !== undefined ? raw : encodeAddress(raw);
}

function saveKeystore(path: string, keystore: Keystore, flag: "w" | "wx"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keystore, null, 2) + "\n", { mode: 0o600, flag });
}

function fromWireUnspent(u: WireUnspent): Unspent {
  return { ...u, amount: BigInt(u.amount) };
}

function loadKeystore(path: string): Keystore {
  if (!existsSync(path)) throw new UsageError(`wallet file not found: ${path} (run "create" first, or pass --wallet)`);
  try {
    return parseKeystore(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`cannot read wallet file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadCa(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read --ca certificate ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Nothing secret leaves the wallet (keys never do, transactions are signed
 * locally), but over cleartext a network attacker can watch balances and
 * feed the wallet fake UTXOs, so talking to a remote node without TLS
 * deserves a warning. Loopback is the devnet default and stays quiet.
 */
function warnIfCleartextRemote(rpcUrl: string, io: CliIo): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return; // the client reports a bad URL
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    io.stderr(`warning: ${rpcUrl} is not on this host and not https -- requests travel in cleartext`);
  }
}

/** Root of trust for SPV: our own idea of genesis and the consensus rules, never the node's. */
function spvParams(flags: Record<string, string>, io: CliIo): SpvParams {
  const config = loadConfig(flags.config ?? io.env.L1_CONFIG);
  const genesisHash = flags["genesis-hash"] ?? createGenesisBlock(genesisConfigFrom(config)).hash;
  return { genesisHash, consensus: config.consensus };
}

/**
 * Loads the local header store, checks the node is on our genesis, syncs
 * only what's new (following a heavier fork, refusing a lighter one), and
 * persists the result. A node on another chain (or lying about its
 * genesis) is rejected before anything else is believed.
 */
async function syncVerifiedHeaders(client: JsonRpcClient, flags: Record<string, string>, io: CliIo): Promise<SyncResult & { mode: "pow" | "poa" | undefined }> {
  const params = spvParams(flags, io);
  const storePath = flags.headers ?? io.env.L1_HEADERS_PATH ?? DEFAULT_HEADERS_PATH;

  const info = await client.call<WireInfo>("getInfo");
  if (info.genesisHash !== params.genesisHash) {
    throw new SpvError(`node reports genesis ${info.genesisHash}, but the trusted genesis is ${params.genesisHash}`);
  }

  const stored = loadVerifiedHeaders(storePath, params);
  if (stored.discardedReason) io.stderr(`warning: ${stored.discardedReason}`);

  let synced: SyncResult;
  try {
    synced = await syncHeaders(stored.headers, {
      // Shapes are checked before anything is verified or stored: the node is not trusted for types either.
      getHeaders: async (fromHeight, count) => (await client.call<unknown[]>("getHeaders", [fromHeight, count])).map((h, i) => parseWireChainHeader(h, `headers[${i}]`)),
    }, params);
  } catch (err) {
    if (err instanceof HeaderSyncError) throw new SpvError(err.message);
    throw err;
  }
  if (synced.fetched > 0 || synced.discarded > 0) saveHeaders(storePath, synced.chain);
  return { ...synced, mode: params.consensus.mode };
}

function describeSync(synced: SyncResult, mode: "pow" | "poa" | undefined): string {
  const parts = [`${synced.chain.length} headers`, `${synced.fetched} downloaded`, `${synced.chain.length - synced.fetched} from local store`];
  if (synced.discarded > 0) parts.push(`reorg: ${synced.discarded} stored header${synced.discarded === 1 ? "" : "s"} abandoned for a heavier chain`);
  if (synced.rejectedFork) parts.push(synced.rejectedFork);
  return `${parts.join(", ")}; ${mode === "poa" ? "authority signatures and turns" : "proof-of-work and retargets"} checked`;
}

async function resolvePassphrase(flags: Record<string, string>, io: CliIo, confirm: boolean): Promise<string> {
  const given = flags.passphrase ?? io.env.L1_WALLET_PASSPHRASE;
  if (given !== undefined) return given;
  const first = await io.promptPassphrase("Wallet passphrase: ");
  if (confirm) {
    const second = await io.promptPassphrase("Confirm passphrase: ");
    if (first !== second) throw new UsageError("passphrases do not match");
  }
  return first;
}

/**
 * Runs one wallet command. Returns the process exit code: 0 ok, 1 the
 * operation failed (node error, wrong passphrase, insufficient funds...),
 * 2 bad usage. Never throws for expected failures -- they're one line on
 * stderr, not a stack trace.
 */
export async function runWalletCli(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const walletPath = flags.wallet ?? DEFAULT_WALLET_PATH;
  const rpcUrl = flags.rpc ?? io.env.L1_RPC_URL ?? DEFAULT_RPC_URL;
  const caPath = flags.ca ?? io.env.L1_RPC_CA;

  try {
    if (command === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    const client = new JsonRpcClient(rpcUrl, { ca: caPath === undefined ? undefined : loadCa(caPath) });
    warnIfCleartextRemote(rpcUrl, io);

    switch (command) {

      case "create":
      case "restore": {
        if (existsSync(walletPath)) {
          throw new UsageError(`wallet file already exists: ${walletPath} (refusing to overwrite)`);
        }
        // Validate what we're restoring from before the passphrase prompt:
        // a typo in the phrase is a usage error, not something to encrypt.
        let source: { seed: Buffer } | { entropy: Buffer } | { words: WordCount };
        if (flags.seed !== undefined) {
          if (!/^[0-9a-f]{64}$/.test(flags.seed)) throw new UsageError("--seed must be 64 hex characters (32 bytes)");
          source = { seed: Buffer.from(flags.seed, "hex") };
        } else if (command === "restore") {
          const phrase = flags.mnemonic ?? (await io.promptPassphrase("Recovery phrase (12-24 words): "));
          try {
            source = { entropy: mnemonicToEntropy(phrase) };
          } catch (err) {
            if (err instanceof MnemonicError) throw new UsageError(`--mnemonic: ${err.message}`);
            throw err;
          }
        } else {
          if (flags.mnemonic !== undefined) throw new UsageError(`to recreate a wallet from a recovery phrase use "restore"`);
          source = { words: parseWordCount(flags) };
        }
        const passphrase = await resolvePassphrase(flags, io, true);
        if (passphrase.length === 0) throw new UsageError("passphrase must not be empty");

        let keystore: Keystore;
        let how: string;
        let phrase: string | undefined;
        if ("seed" in source) {
          keystore = createHdKeystore(source.seed, passphrase);
          how = " (restored from seed)";
        } else if ("entropy" in source) {
          keystore = createMnemonicKeystore(source.entropy, passphrase);
          how = " (restored from recovery phrase)";
        } else {
          phrase = generateMnemonic(source.words);
          keystore = createMnemonicKeystore(mnemonicToEntropy(phrase), passphrase);
          how = "";
        }
        saveKeystore(walletPath, keystore, "wx");
        io.stdout(`wallet ${command === "restore" ? "restored" : "created"}: ${walletPath}${how}`);
        io.stdout(`address: ${showAddress(keystoreAccounts(keystore)[0]!.address, flags)}`);
        if (phrase !== undefined) {
          io.stdout(`recovery phrase: ${phrase}`);
          io.stderr(`write the recovery phrase down and keep it offline: it recreates every account of this wallet ("restore"), and anyone who has it has your coins`);
        }
        return 0;
      }

      case "watch-only": {
        const keystore = loadKeystore(walletPath);
        const out = flags.out;
        if (!out) throw new UsageError("--out <path> is required (where to write the watch-only copy)");
        if (existsSync(out)) throw new UsageError(`file already exists: ${out} (refusing to overwrite)`);
        const watch = exportWatchOnly(keystore);
        saveKeystore(out, watch, "wx");
        io.stdout(`watch-only wallet written: ${out} (${watch.accounts.length} account${watch.accounts.length === 1 ? "" : "s"}, no keys)`);
        return 0;
      }

      case "address": {
        io.stdout(showAddress(selectAccount(loadKeystore(walletPath), parseAccount(flags)).address, flags));
        return 0;
      }

      case "account": {
        const sub = positional[1];
        const keystore = loadKeystore(walletPath);
        if (sub === "list") {
          for (const a of keystoreAccounts(keystore)) io.stdout(`${a.index}  ${showAddress(a.address, flags)}${a.label ? `  ${a.label}` : ""}`);
          if (isWatchOnly(keystore)) io.stderr("(watch-only wallet: addresses only, no keys)");
          return 0;
        }
        if (sub === "new") {
          requireKeys(keystore, "derive accounts");
          const passphrase = await resolvePassphrase(flags, io, false);
          const updated = addAccount(keystore, passphrase, flags.label);
          saveKeystore(walletPath, updated, "w");
          const created = updated.accounts[updated.accounts.length - 1]!;
          io.stdout(`account ${created.index}${created.label ? ` (${created.label})` : ""}: ${showAddress(created.address, flags)}`);
          return 0;
        }
        throw new UsageError(`account: expected "list" or "new"`);
      }

      case "seed": {
        const keystore = loadKeystore(walletPath);
        requireKeys(keystore, "export a seed");
        if (keystore.version === 1) throw new UsageError("this is a version 1 (single-key) wallet; it has no seed");
        const passphrase = await resolvePassphrase(flags, io, false);
        if (keystore.version === 3) {
          io.stdout(exportMnemonic(keystore, passphrase));
          io.stderr(`anyone with this recovery phrase controls every account of this wallet; "restore" recreates it`);
        } else {
          io.stdout(exportSeed(keystore, passphrase).toString("hex"));
          io.stderr(`anyone with this seed controls every account of this wallet; "restore --seed" recreates it`);
        }
        return 0;
      }

      case "history": {
        const address = flags.address !== undefined ? parseAddressFlag(flags.address, "address") : selectAccount(loadKeystore(walletPath), parseAccount(flags)).address;
        const limit = flags.limit !== undefined ? Number(parseAmount(flags.limit, "limit")) : 50;
        const [entries, info] = await Promise.all([client.call<WireActivity[]>("listTransactions", [address, limit]), client.call<WireInfo>("getInfo")]);
        if (entries.length === 0) io.stdout("(no confirmed transactions)");
        for (const e of entries) {
          const received = BigInt(e.received);
          const sent = BigInt(e.sent);
          const net = received - sent;
          io.stdout(`${new Date(e.timestamp).toISOString()}  height=${e.height}  ${net >= 0n ? "+" : ""}${net}  (in ${received}, out ${sent})  ${e.txId}`);
        }
        // A pruning node cannot say whether older history existed: tell the user what the answer covers.
        if (info.addressIndex && info.addressIndex.depth > 0) {
          io.stderr(`note: this node only keeps history for heights ${info.addressIndex.fromHeight} and above (last ${info.addressIndex.depth} blocks); older transactions are not shown`);
        }
        return 0;
      }

      case "balance": {
        const address = flags.address !== undefined ? parseAddressFlag(flags.address, "address") : selectAccount(loadKeystore(walletPath), parseAccount(flags)).address;
        const [info, unspent] = await Promise.all([
          client.call<WireInfo>("getInfo"),
          client.call<WireUnspent[]>("listUnspent", [address]),
        ]);
        const tipHeight = info.tip?.height ?? 0;
        let spendable = 0n;
        let immature = 0n;
        for (const u of unspent.map(fromWireUnspent)) {
          if (isMature(u, tipHeight, info.coinbaseMaturity)) spendable += u.amount;
          else immature += u.amount;
        }
        io.stdout(`address:   ${showAddress(address, flags)}`);
        io.stdout(`total:     ${spendable + immature}`);
        io.stdout(`spendable: ${spendable}`);
        io.stdout(`immature:  ${immature}${immature > 0n ? ` (coinbase outputs awaiting ${info.coinbaseMaturity} confirmations)` : ""}`);
        return 0;
      }

      case "unspent": {
        const address = flags.address !== undefined ? parseAddressFlag(flags.address, "address") : selectAccount(loadKeystore(walletPath), parseAccount(flags)).address;
        const unspent = await client.call<WireUnspent[]>("listUnspent", [address]);
        if (unspent.length === 0) {
          io.stdout("(no unspent outputs)");
          return 0;
        }
        for (const u of unspent) {
          io.stdout(`${u.txId}:${u.outputIndex}  amount=${u.amount}  height=${u.blockHeight}${u.isCoinbase ? "  coinbase" : ""}`);
        }
        return 0;
      }

      case "send": {
        // Validate everything local first: no node round-trip, no
        // passphrase prompt, for a typo.
        if (!flags.to) throw new UsageError("--to <address> is required");
        const to = parseAddressFlag(flags.to, "to");
        const amount = parseAmount(flags.amount, "amount");
        if (amount === 0n) throw new UsageError("--amount must be positive");
        const explicitFee = flags.fee !== undefined ? parseAmount(flags.fee, "fee") : undefined;

        const keystore = loadKeystore(walletPath);
        requireKeys(keystore, "sign a payment");
        const accountIndex = parseAccount(flags);
        const account = selectAccount(keystore, accountIndex);
        const [info, wireUnspent] = await Promise.all([
          client.call<WireInfo>("getInfo"),
          client.call<WireUnspent[]>("listUnspent", [account.address]),
        ]);
        const fee = explicitFee ?? BigInt(info.minFee);
        const unspent = wireUnspent.map(fromWireUnspent);
        const tipHeight = info.tip?.height ?? 0;

        // Signing needs the key, but the funds check doesn't: do it first so
        // an unaffordable payment fails before the passphrase is asked for.
        let spendable = 0n;
        let immature = 0n;
        for (const u of unspent) {
          if (isMature(u, tipHeight, info.coinbaseMaturity)) spendable += u.amount;
          else immature += u.amount;
        }
        if (spendable < amount + fee) throw new InsufficientFundsError(spendable, amount + fee, immature);

        const passphrase = await resolvePassphrase(flags, io, false);
        const keyPair = unlockAccount(keystore, passphrase, accountIndex);

        const tx = buildTransaction({
          keyPair,
          unspent,
          to,
          amount,
          fee,
          timestamp: Date.now(),
          tipHeight,
          coinbaseMaturity: info.coinbaseMaturity,
        });
        const { txId } = await client.call<{ txId: string }>("sendRawTransaction", [JSON.parse(serializeTransaction(tx))]);
        io.stdout(`sent ${amount} to ${showAddress(to, flags)} (fee ${fee}, ${tx.inputs.length} input${tx.inputs.length === 1 ? "" : "s"})`);
        io.stdout(`txId: ${txId}`);
        return 0;
      }

      case "bump": {
        const txId = flags.tx;
        if (!txId || !/^[0-9a-f]{64}$/.test(txId)) throw new UsageError("--tx <txId> (64 hex characters) is required");
        const newFee = parseAmount(flags.fee, "fee");
        const keystore = loadKeystore(walletPath);
        requireKeys(keystore, "sign a replacement");

        // The pending transaction comes from the node's mempool: the wallet
        // keeps no history of what it sent.
        const pending = (await client.call<unknown[]>("getMempool")).map(parseWireTransaction);
        const original = pending.find((t) => t.id === txId);
        if (!original) throw new Error(`transaction ${txId} is not in the mempool of ${rpcUrl} (already mined, replaced, or never received)`);
        if (newFee <= original.fee) throw new UsageError(`--fee ${newFee} must be higher than the current fee ${original.fee}`);

        const passphrase = await resolvePassphrase(flags, io, false);
        const keyPair = unlockAccount(keystore, passphrase, parseAccount(flags));
        const replacement = bumpFee({ keyPair, original, newFee, timestamp: Date.now() });
        const sent = await client.call<{ txId: string }>("sendRawTransaction", [JSON.parse(serializeTransaction(replacement))]);
        io.stdout(`replaced ${txId} (fee ${original.fee}) with a copy paying fee ${newFee}`);
        io.stdout(`txId: ${sent.txId}`);
        return 0;
      }

      case "anchor": {
        // Validate everything local first, as for send.
        const record = parseRecord(flags);
        const explicitFee = flags.fee !== undefined ? parseAmount(flags.fee, "fee") : undefined;
        const keystore = loadKeystore(walletPath);
        requireKeys(keystore, "sign an anchor");
        const accountIndex = parseAccount(flags);
        const account = selectAccount(keystore, accountIndex);
        const [info, wireUnspent] = await Promise.all([
          client.call<WireInfo>("getInfo"),
          client.call<WireUnspent[]>("listUnspent", [account.address]),
        ]);
        const fee = explicitFee ?? BigInt(info.minFee);
        const unspent = wireUnspent.map(fromWireUnspent);
        const tipHeight = info.tip?.height ?? 0;
        // Fee plus one unit of change: the transaction's only output.
        let spendable = 0n;
        let immature = 0n;
        for (const u of unspent) {
          if (isMature(u, tipHeight, info.coinbaseMaturity)) spendable += u.amount;
          else immature += u.amount;
        }
        if (spendable < fee + 1n) throw new InsufficientFundsError(spendable, fee + 1n, immature);

        const passphrase = await resolvePassphrase(flags, io, false);
        const keyPair = unlockAccount(keystore, passphrase, accountIndex);
        const tx = buildAnchorTransaction({ keyPair, unspent, data: record, fee, timestamp: Date.now(), tipHeight, coinbaseMaturity: info.coinbaseMaturity });
        const { txId } = await client.call<{ txId: string }>("sendRawTransaction", [JSON.parse(serializeTransaction(tx))]);
        io.stdout(`record: ${record}`);
        io.stdout(`sent for anchoring (fee ${fee}); it is anchored once mined`);
        io.stdout(`txId: ${txId}`);
        io.stdout(`check with: find-anchor --hash ${record}`);
        return 0;
      }

      case "find-anchor": {
        const record = parseRecord(flags);
        const anchors = await client.call<WireAnchor[]>("getAnchors", [record, 1]);
        const first = anchors[0];
        if (!first) throw new Error(`record ${record} is not anchored in the node's chain (never sent, or not mined yet)`);

        // Nothing the node said is believed yet. The chain of evidence is:
        // the transaction's content hashes to its id and carries the record;
        // the id folds to the merkle root of a header on the verified chain.
        const block = await client.call<{ transactions: unknown[] }>("getBlockByHash", [first.blockHash]);
        const tx = block.transactions.map((t) => parseWireTransaction(t)).find((t) => t.id === first.txId);
        if (!tx || computeTransactionId(tx) !== first.txId) throw new SpvError(`the node's block ${first.blockHash} does not contain transaction ${first.txId}`);
        if (tx.data !== record) throw new SpvError(`transaction ${first.txId} does not carry the record`);

        const proof = await client.call<InclusionProof>("getMerkleProof", [first.txId]);
        const synced = await syncVerifiedHeaders(client, flags, io);
        const header = synced.chain[proof.blockHeight];
        if (!header) throw new SpvError(`proof refers to height ${proof.blockHeight}, beyond the verified chain tip ${synced.tipHeight}`);
        if (proof.txId !== first.txId) throw new SpvError(`the node's proof is for ${proof.txId}, not ${first.txId}`);
        if (synced.rejectedFork && header.hash !== proof.blockHash) {
          throw new SpvError(`${synced.rejectedFork}; the anchor's block is not on the verified chain`);
        }
        const inclusion = verifyInclusion(proof, header);
        if (!inclusion.valid) throw new SpvError(`inclusion proof invalid: ${inclusion.reason}`);

        io.stdout(`record: ${record}`);
        io.stdout(`anchored in block ${header.hash} at height ${proof.blockHeight}`);
        io.stdout(`block time: ${new Date(header.header.timestamp).toISOString()}`);
        io.stdout(`confirmations: ${synced.tipHeight - proof.blockHeight + 1}`);
        io.stdout(`txId: ${first.txId}`);
        io.stdout(`transaction carries the record: its content hashes to its id`);
        io.stdout(`header chain valid from trusted genesis: ${describeSync(synced, synced.mode)}`);
        io.stdout(`inclusion proof valid: ${proof.siblings.length} sibling hashes fold to the header's merkle root`);
        return 0;
      }

      case "sync": {
        const synced = await syncVerifiedHeaders(client, flags, io);
        io.stdout(`verified tip: height ${synced.tipHeight} hash ${synced.chain[synced.chain.length - 1]!.hash}`);
        io.stdout(describeSync(synced, synced.mode));
        return 0;
      }

      case "verify": {
        const txId = flags.tx;
        if (!txId || !/^[0-9a-f]{64}$/.test(txId)) throw new UsageError("--tx <txId> (64 hex characters) is required");

        const proof = await client.call<InclusionProof>("getMerkleProof", [txId]);
        const synced = await syncVerifiedHeaders(client, flags, io);
        const { chain } = synced;

        const header = chain[proof.blockHeight];
        if (!header) throw new SpvError(`proof refers to height ${proof.blockHeight}, beyond the verified chain tip ${synced.tipHeight}`);
        if (synced.rejectedFork && header.hash !== proof.blockHash) {
          throw new SpvError(`${synced.rejectedFork}; the transaction's block is not on the verified chain`);
        }
        const inclusion = verifyInclusion(proof, header);
        if (!inclusion.valid) throw new SpvError(`inclusion proof invalid: ${inclusion.reason}`);

        const confirmations = synced.tipHeight - proof.blockHeight + 1;
        io.stdout(`transaction ${txId}`);
        io.stdout(`confirmed in block ${proof.blockHash} at height ${proof.blockHeight} (index ${proof.index})`);
        io.stdout(`confirmations: ${confirmations}`);
        io.stdout(`header chain valid from trusted genesis: ${describeSync(synced, synced.mode)}`);
        io.stdout(`inclusion proof valid: ${proof.siblings.length} sibling hashes fold to the header's merkle root`);
        return 0;
      }

      case "info": {
        const info = await client.call<WireInfo>("getInfo");
        io.stdout(`network:          ${info.networkId}`);
        io.stdout(`genesis:          ${info.genesisHash}`);
        io.stdout(`tip:              ${info.tip ? `height: ${info.tip.height}  hash: ${info.tip.hash}` : "(none)"}`);
        io.stdout(`consensus:        ${info.consensusMode === "poa" ? "proof of authority" : "proof of work"}`);
        io.stdout(`peers:            ${info.peerCount}`);
        io.stdout(`block reward:     ${info.blockReward}`);
        io.stdout(`min fee:          ${info.minFee}`);
        io.stdout(`coinbase maturity: ${info.coinbaseMaturity}`);
        const supply = await client.call<WireSupply>("getSupply");
        io.stdout(`supply:           ${supply.circulating} circulating${supply.maxSupply ? ` of ${supply.maxSupply} max` : " (unbounded)"}`);
        io.stdout(
          `emission:         ${supply.halvingInterval > 0 ? `halves every ${supply.halvingInterval} blocks` : "constant"}` +
            (supply.nextHalvingHeight ? `, next at height ${supply.nextHalvingHeight}` : "") +
            (BigInt(supply.tailEmission) > 0n ? `, tail ${supply.tailEmission}` : ""),
        );
        return 0;
      }

      default:
        io.stderr(`unknown command: ${command}`);
        io.stderr(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}`);
      return 2;
    }
    if (err instanceof InsufficientFundsError) {
      io.stderr(`error: ${err.message}`);
      if (err.immature > 0n) io.stderr("hint: coinbase rewards are not yet mature; wait for more blocks");
      return 1;
    }
    if (err instanceof SpvError) {
      io.stderr(`error: verification failed: ${err.message}`);
      return 1;
    }
    if (err instanceof RpcError) {
      io.stderr(`error: node rejected the request (${err.code}): ${err.message}`);
      return 1;
    }
    if (err instanceof RpcTransportError) {
      io.stderr(`error: ${err.message}`);
      return 1;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
