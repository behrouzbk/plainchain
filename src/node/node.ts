import { computeBlockHash, createGenesisBlock, genesisAllocationTotal, type GenesisConfig } from "../ledger/block.js";
import { serializeTransaction } from "../ledger/serialize.js";
import { merkleProof, merkleRoot, type MerkleProof } from "../crypto/merkle.js";
import { computeTransactionId, validateTransactionStructure } from "../ledger/transaction.js";
import type { Block, BlockHeader, Transaction } from "../ledger/types.js";
import {
  DEFAULT_MAX_BLOCK_BYTES,
  DEFAULT_MAX_TRANSACTIONS_PER_BLOCK,
  FUTURE_TIMESTAMP_REASON,
  blockByteSize,
  validateBlock,
  validateHeader,
} from "../consensus/blockValidator.js";
import { nextTarget, retargetWindow } from "../consensus/difficulty.js";
import { isBetterChain } from "../consensus/forkChoice.js";
import { createEngine, type ConsensusEngine, type ConsensusMode } from "../consensus/engine.js";
import type { KeyPair } from "../crypto/keypair.js";
import { MiningAbortedError, WorkerMiner, type BlockMiner } from "../consensus/miner.js";
import { blockRewardAt, cumulativeEmission, maxSupply, nextHalvingHeight, rulesHash, type MonetaryPolicy } from "../consensus/monetary.js";
import { Mempool, type MempoolResult } from "../mempool/mempool.js";
import { MetricsRegistry, type Counter } from "../metrics/registry.js";
import { AddressBook, type AddressBookOptions } from "../network/addressBook.js";
import { P2PServer, type P2PServerOptions } from "../network/p2pServer.js";
import type { Message } from "../network/protocol.js";
import { ChainState, type AddressActivity, type BlockUndo, type ChainTip } from "../state/chainState.js";
import { closeStateDb, commitAtomic, openStateDb, type StateBatchOperation, type StateDb } from "../state/db.js";
import { loadAddressBookJson, saveAddressBookJson } from "../state/peerStore.js";
import { UtxoSet, type Unspent, type ValidationResult } from "../state/utxoSet.js";
import { createLogger } from "./logger.js";

export interface ConsensusConfig {
  targetBlockTimeMs: number;
  difficultyRetargetInterval: number;
  maxDifficultyAdjustmentFactor: number;
  /** How blocks are sealed (consensus/engine.ts): "pow" (default) or "poa". Part of the rules hash. */
  mode?: ConsensusMode;
  /** Proof-of-authority signers (public keys) in turn order. Part of the rules hash. */
  authorities?: string[];
  /** Blocks a coinbase output must be buried under before it's spendable. */
  coinbaseMaturity: number;
  /** How far ahead of local wall-clock a block timestamp may be. */
  maxFutureDriftMs: number;
  /** Consensus block limits; defaults in consensus/blockValidator.ts. */
  maxBlockBytes?: number;
  maxTransactionsPerBlock?: number;
  /**
   * Known-good block hashes at fixed heights. A block or header at a
   * checkpointed height with any other hash is invalid, and once our own
   * chain contains a checkpoint, nothing below it can be reorged away.
   * Bounds how far back a well-funded attacker can rewrite history.
   */
  checkpoints?: { height: number; hash: string }[];
}

export interface MempoolConfig {
  maxSize: number;
  minFee: bigint;
  /** Replace-by-fee: most pending transactions one replacement may evict (default 100). */
  maxReplacements?: number;
}

/** What the node needs from a logger; `node/logger.ts` is the full one. */
export interface NodeLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Point-in-time operational snapshot (what `/health` reports). */
export interface NodeStats {
  nodeId: string;
  networkId: string;
  height: number;
  tipHash: string | undefined;
  peers: number;
  mempool: number;
  orphans: number;
  uptimeSeconds: number;
}

export interface NetworkConfig extends Partial<P2PServerOptions> {
  /** Most blocks sent in reply to one GET_BLOCKS. A requester that needs
   *  more gets an INV_BLOCKS continuation and asks again, so one request
   *  can't make us stream the whole chain. */
  maxBlocksPerResponse?: number;
  /** Most headers sent in reply to one GET_HEADERS; a full reply is the
   *  requester's cue to ask for more. */
  maxHeadersPerResponse?: number;
  /** How often to refresh peer lists and re-dial known addresses. */
  peerMaintenanceIntervalMs?: number;
  /** Most new outbound dials started per maintenance tick (or per PEERS message). */
  maxDialsPerTick?: number;
  /** Addresses remembered at most; a PEERS flood cannot grow memory past this. */
  maxAddressBookSize?: number;
  /** First retry delay after a failed dial; doubles per failure up to 60x. */
  peerDialBackoffMs?: number;
}

export interface SupplyInfo {
  height: number;
  genesisAllocation: bigint;
  /** Genesis allocation plus every reward paid so far (fees are transfers, not issuance). */
  circulating: bigint;
  /** Undefined when emission never stops. */
  maxSupply: bigint | undefined;
  /** Reward the next block (tip + 1) may claim. */
  currentReward: bigint;
  nextHalvingHeight: number | undefined;
  halvingInterval: number;
  tailEmission: bigint;
}

export interface ChainInfo {
  networkId: string;
  genesisHash: string;
  tip: ChainTip | null;
  coinbaseMaturity: number;
  minFee: bigint;
  blockReward: bigint;
  peerCount: number;
  consensusMode: ConsensusMode;
  /** What `listTransactions` can answer: history from `fromHeight` up (depth 0 = the whole chain), or null when the node keeps no address index. */
  addressIndex: { depth: number; fromHeight: number } | null;
}

/**
 * Address-index (wallet history) policy. The index grows with every output
 * ever created, so an operator can bound it: `depth` keeps only the last
 * that many canonical blocks (0 = all of them); `enabled: false` keeps
 * none, and `listTransactions` is refused.
 */
export interface AddressIndexOptions {
  enabled?: boolean;
  depth?: number;
}

/** `listTransactions` on a node started with `--no-addrindex`. */
export class AddressIndexDisabledError extends Error {
  constructor() {
    super("this node keeps no address index (started with --no-addrindex); transaction history is unavailable");
  }
}

export interface TransactionProof {
  txId: string;
  blockHash: string;
  blockHeight: number;
  /** Position of the transaction in its block. */
  index: number;
  siblings: MerkleProof;
  merkleRoot: string;
}

export interface NodeOptions {
  nodeId: string;
  /** Chain identity; peers on a different networkId (or genesis) are refused. */
  networkId: string;
  dataDir: string;
  port: number;
  genesis: GenesisConfig;
  consensus: ConsensusConfig;
  mempool: MempoolConfig;
  minerAddress: string;
  /** Reward of the first era. Shorthand for `monetary.initialReward` when `monetary` is omitted (constant reward). */
  blockReward: bigint;
  /** Emission schedule; defaults to a constant `blockReward` forever. */
  monetary?: MonetaryPolicy;
  logger?: NodeLogger;
  network?: NetworkConfig;
  /** Registry to publish metrics into; a fresh one is created if omitted. */
  metrics?: MetricsRegistry;
  /** Proof-of-work engine; defaults to a worker thread (WorkerMiner). Ignored under proof of authority. */
  miner?: BlockMiner;
  /** Wallet-history index policy; defaults to a complete index. */
  addressIndex?: AddressIndexOptions;
  /** Proof of authority: this node's own authority key (`--signer-key`). Without it the node validates but cannot produce blocks. */
  signerKey?: KeyPair;
}

export class Node {
  private static readonly MAX_ORPHANS = 50;
  private static readonly DEFAULT_MAX_BLOCKS_PER_RESPONSE = 500;
  private static readonly DEFAULT_MAX_HEADERS_PER_RESPONSE = 2000;
  private static readonly DEFAULT_PEER_MAINTENANCE_INTERVAL_MS = 30_000;
  private static readonly DEFAULT_MAX_DIALS_PER_TICK = 4;
  private static readonly DEFAULT_MAX_ADDRESS_BOOK_SIZE = 1000;
  private static readonly DEFAULT_PEER_DIAL_BACKOFF_MS = 10_000;
  /** Non-anchor addresses are forgotten after this many consecutive failed dials. */
  private static readonly MAX_DIAL_FAILURES = 10;
  /** Locator entries beyond this are ignored: an honest locator is ~10 +
   *  log2(height) entries, so this bounds the lookups a junk one can cause. */
  private static readonly MAX_LOCATOR_ENTRIES = 64;
  /** INV_BLOCKS entries beyond this are ignored, for the same reason. */
  private static readonly MAX_INV_ENTRIES = 64;

  /** Misbehavior points (see P2PServer.penalize). An invalid block is an
   *  instant ban -- producing one costs the sender real work, so it's never
   *  an accident. A malformed transaction is cheap to relay unknowingly, so
   *  it takes a stream of them. */
  private static readonly PENALTY_INVALID_BLOCK = 100;
  private static readonly PENALTY_INVALID_TX = 10;

  private readonly maxBlocksPerResponse: number;
  private readonly maxHeadersPerResponse: number;
  private readonly peerMaintenanceIntervalMs: number;
  private readonly maxDialsPerTick: number;

  /** Every peer address we have heard of, with dial outcomes; persisted. */
  private addressBook: AddressBook;
  private readonly addressBookOptions: AddressBookOptions;
  private readonly dialsInFlight = new Set<string>();
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  /** Seals blocks and weighs chains: proof of work or proof of authority (consensus/engine.ts). */
  private readonly engine: ConsensusEngine;
  /** Serializes mineBlock calls: one search at a time. */
  private miningLock: Promise<unknown> = Promise.resolve();
  /** Abort handle of the search in progress; fired whenever the tip moves. */
  private miningAbort: AbortController | undefined;
  /** How many times one mineBlock call re-templates before giving up. */
  private static readonly MAX_MINING_ATTEMPTS = 5;
  private readonly checkpoints = new Map<number, string>();
  /** Highest checkpoint height whose block is on our canonical chain.
   *  Blocks at or below it that aren't canonical are rejected outright:
   *  they could only be part of a reorg that removes the checkpoint. */
  private verifiedCheckpointHeight = -1;

  readonly p2pServer: P2PServer;

  private db!: StateDb;
  private utxoSet!: UtxoSet;
  private chainState!: ChainState;
  private mempool!: Mempool;
  private cachedTipHeight = 0;
  private readonly logger: NodeLogger;
  private readonly genesisHash: string;
  private readonly policy: MonetaryPolicy;
  /** Fingerprint of consensus + emission rules, compared in the handshake. */
  readonly rulesHash: string;
  private readonly startedAt = Date.now();

  /** Operational counters/gauges; served by `rpc/` at /metrics. */
  readonly metrics: MetricsRegistry;
  private readonly counters: {
    blocksAdopted: Counter;
    blocksDisconnected: Counter;
    reorgs: Counter;
    blocksRejected: Counter;
    txAccepted: Counter;
    txRejected: Counter;
    txReplaced: Counter;
    p2pMessages: Counter;
    peersConnected: Counter;
    peersDisconnected: Counter;
    peersBanned: Counter;
    peerDials: Counter;
    miningAttempts: Counter;
    addrIndexPruned: Counter;
  };

  private readonly addressIndexEnabled: boolean;
  /** Canonical blocks of history kept per address; 0 = all. */
  private readonly addressIndexDepth: number;

  /** Blocks received before their parent, keyed by the parent hash they're
   *  waiting for. Resolved once that parent successfully connects. */
  private readonly orphansByMissingParent = new Map<string, { block: Block; fromNodeId: string }[]>();
  private readonly orphanHashes = new Set<string>();
  /** Blocks that have completed full evaluation (ancestry resolved, fork
   *  choice decided) -- as opposed to merely being stored, which also
   *  happens for still-unresolved orphans. */
  private readonly processedBlockHashes = new Set<string>();
  /** Blocks that failed validation. Anything building on one is rejected
   *  without re-evaluation. In-memory only: on restart they'd simply be
   *  re-validated and fail again. */
  private readonly invalidBlockHashes = new Set<string>();
  /** Subset of invalidBlockHashes whose sender wasn't penalized (see rejectBlock). */
  private readonly blamelessInvalidHashes = new Set<string>();

  /**
   * Serializes everything that reads-then-writes chain/UTXO state. Message
   * handlers run concurrently, so without this two incoming blocks (or a
   * block and a mempool submission) could interleave at await points and
   * validate against each other's half-applied staging.
   */
  private chainLock: Promise<unknown> = Promise.resolve();

  private withChainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chainLock.then(fn, fn);
    this.chainLock = run.catch(() => undefined);
    return run;
  }

  constructor(private readonly options: NodeOptions) {
    this.logger = options.logger ?? createLogger({ format: "text", level: "info", nodeId: options.nodeId });
    this.genesisHash = createGenesisBlock(options.genesis).hash;
    this.policy = options.monetary ?? { initialReward: options.blockReward, halvingInterval: 0, tailEmission: 0n };
    this.rulesHash = rulesHash(options.consensus, this.policy);
    // A block the rules allow must also fit in one P2P frame, or it can be
    // mined but never relayed.
    const maxBlockBytes = options.consensus.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    const maxFrame = options.network?.maxMessageBytes ?? 4 * 1024 * 1024;
    if (maxBlockBytes > maxFrame / 2) {
      this.logger.warn(`consensus.maxBlockBytes (${maxBlockBytes}) is more than half network.maxMessageBytes (${maxFrame}); large valid blocks may not relay`);
    }
    this.metrics = options.metrics ?? new MetricsRegistry();
    this.counters = this.registerMetrics();
    this.addressIndexEnabled = options.addressIndex?.enabled ?? true;
    this.addressIndexDepth = options.addressIndex?.depth ?? 0;
    if (!Number.isInteger(this.addressIndexDepth) || this.addressIndexDepth < 0) {
      throw new Error(`addressIndex.depth must be a non-negative integer, got ${String(options.addressIndex?.depth)}`);
    }
    this.engine = createEngine(options.consensus, {
      miner: options.consensus.mode === "poa" ? undefined : (options.miner ?? new WorkerMiner()),
      signerKey: options.signerKey,
    });
    const {
      maxBlocksPerResponse,
      maxHeadersPerResponse,
      peerMaintenanceIntervalMs,
      maxDialsPerTick,
      maxAddressBookSize,
      peerDialBackoffMs,
      ...p2pOptions
    } = options.network ?? {};
    this.maxBlocksPerResponse = maxBlocksPerResponse ?? Node.DEFAULT_MAX_BLOCKS_PER_RESPONSE;
    this.maxHeadersPerResponse = maxHeadersPerResponse ?? Node.DEFAULT_MAX_HEADERS_PER_RESPONSE;
    this.peerMaintenanceIntervalMs = peerMaintenanceIntervalMs ?? Node.DEFAULT_PEER_MAINTENANCE_INTERVAL_MS;
    this.maxDialsPerTick = maxDialsPerTick ?? Node.DEFAULT_MAX_DIALS_PER_TICK;
    const backoff = peerDialBackoffMs ?? Node.DEFAULT_PEER_DIAL_BACKOFF_MS;
    this.addressBookOptions = {
      maxSize: maxAddressBookSize ?? Node.DEFAULT_MAX_ADDRESS_BOOK_SIZE,
      baseBackoffMs: backoff,
      maxBackoffMs: backoff * 60,
      maxFailures: Node.MAX_DIAL_FAILURES,
    };
    this.addressBook = new AddressBook(this.addressBookOptions);
    for (const { height, hash } of options.consensus.checkpoints ?? []) {
      this.checkpoints.set(height, hash);
    }
    this.p2pServer = new P2PServer(
      options.nodeId,
      options.port,
      () => this.cachedTipHeight,
      { networkId: options.networkId, genesisHash: this.genesisHash, rulesHash: this.rulesHash },
      p2pOptions,
    );
  }

  private registerMetrics(): Node["counters"] {
    const m = this.metrics;
    m.gauge("l1_chain_height", "Height of the canonical chain tip.", [], () => this.cachedTipHeight);
    m.gauge("l1_mempool_transactions", "Transactions waiting in the mempool.", [], () => this.mempool?.size() ?? 0);
    m.gauge("l1_orphan_blocks", "Blocks held while waiting for a missing parent.", [], () => this.orphanHashes.size);
    m.gauge("l1_invalid_blocks_known", "Distinct blocks that failed validation since start.", [], () => this.invalidBlockHashes.size);
    m.gauge("l1_address_book_size", "Peer addresses remembered for (re)dialing.", [], () => this.addressBook.size);
    m.gauge("l1_peers_connected", "Handshaked peers by connection direction.", ["direction"], (g) => {
      const counts = this.p2pServer.getPeerCounts();
      g.set(counts.inbound, { direction: "inbound" });
      g.set(counts.outbound, { direction: "outbound" });
    });
    return {
      blocksAdopted: m.counter("l1_blocks_adopted_total", "Blocks that became the canonical tip (mined or received)."),
      blocksDisconnected: m.counter("l1_blocks_disconnected_total", "Blocks removed from the canonical chain by reorgs."),
      reorgs: m.counter("l1_reorgs_total", "Tip switches that disconnected at least one block."),
      blocksRejected: m.counter("l1_blocks_rejected_total", "Blocks that failed validation."),
      txAccepted: m.counter("l1_transactions_accepted_total", "Transactions admitted to the mempool (local or relayed)."),
      txRejected: m.counter("l1_transactions_rejected_total", "Transactions refused by the mempool or structure checks."),
      txReplaced: m.counter("l1_transactions_replaced_total", "Pending transactions evicted by a replace-by-fee replacement."),
      // Message types are validated by the wire decoder, so the label set is bounded.
      p2pMessages: m.counter("l1_p2p_messages_total", "P2P messages by direction and type.", ["direction", "type"]),
      peersConnected: m.counter("l1_peers_connected_total", "Peer connections that completed a handshake."),
      peersDisconnected: m.counter("l1_peers_disconnected_total", "Peer connections closed after a handshake."),
      peersBanned: m.counter("l1_peers_banned_total", "Peers banned for misbehaviour."),
      peerDials: m.counter("l1_peer_dials_total", "Outbound dial attempts by outcome.", ["outcome"]),
      miningAttempts: m.counter("l1_mining_attempts_total", "Block searches by outcome: mined, aborted (tip moved), stale (solved too late).", ["outcome"]),
      addrIndexPruned: m.counter("l1_address_index_pruned_total", "Address-index entries deleted because they fell outside --addrindex-depth."),
    };
  }

  async start(): Promise<void> {
    this.db = openStateDb(this.options.dataDir);
    this.utxoSet = new UtxoSet(this.db.utxo, this.options.consensus.coinbaseMaturity);
    this.chainState = new ChainState(this.db.blocks, this.db.meta, this.db.undo, this.db.headers, this.db.txIndex, this.db.addrIndex);
    this.mempool = new Mempool(this.utxoSet, this.options.mempool.maxSize, this.options.mempool.minFee, {
      ...(this.options.mempool.maxReplacements !== undefined ? { maxReplacements: this.options.mempool.maxReplacements } : {}),
    });

    const existingTip = await this.chainState.getTip();
    if (existingTip) {
      this.cachedTipHeight = existingTip.height;
    } else {
      const genesis = createGenesisBlock(this.options.genesis);
      await this.utxoSet.applyTransaction(genesis.transactions[0]!, 0);
      await this.chainState.putBlock(genesis);
      await this.chainState.putHeader(genesis.hash, genesis.header, this.engine.blockWork(genesis.header, genesis.hash));
      await this.chainState.setCanonicalHashAtHeight(0, genesis.hash);
      await this.chainState.setTip(genesis.hash, 0);
      this.cachedTipHeight = 0;
    }
    await this.refreshVerifiedCheckpoint();
    await this.backfillTxIndex();
    await this.reconcileAddressIndex();
    this.addressBook = AddressBook.fromJSON(await loadAddressBookJson(this.db), this.addressBookOptions);

    this.p2pServer.on("message", (message: Message, fromNodeId: string) => {
      this.counters.p2pMessages.inc({ direction: "in", type: message.type });
      // Never let a peer's message take the process down: an unhandled
      // rejection here would be fatal on modern Node.
      this.handleMessage(message, fromNodeId).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn(`failed handling ${message.type}: ${detail}`, { peer: fromNodeId, type: message.type });
      });
    });
    this.p2pServer.on("message:sent", (message: Message) => {
      this.counters.p2pMessages.inc({ direction: "out", type: message.type });
    });
    this.p2pServer.on("peer:connected", (peerId: string, height: number) => {
      this.counters.peersConnected.inc();
      this.logger.info?.("peer connected", { peer: peerId, peerHeight: height });
      // Header-first: learn what the peer has (cheaply, and verifiably)
      // before deciding whether its blocks are worth downloading.
      this.requestHeadersFrom(peerId).catch((err: unknown) => {
        this.logger.warn(`initial sync request failed: ${String(err)}`, { peer: peerId });
      });
      this.p2pServer.send(peerId, { type: "GET_PEERS", payload: {} });
    });
    this.p2pServer.on("peer:disconnected", (peerId: string, handshaked: boolean) => {
      if (!handshaked) return; // a failed dial or refused handshake, not a lost peer
      this.counters.peersDisconnected.inc();
      this.logger.info?.("peer disconnected", { peer: peerId });
    });
    this.p2pServer.on("peer:rejected", (peerId: string, reason: string) => {
      // Handshake-level refusals (wrong network, different rules, banned):
      // the one line an operator needs when two nodes "just won't connect".
      this.logger.warn(`peer rejected: ${reason}`, { peer: peerId });
    });
    this.p2pServer.on("peer:banned", (peerId: string, reason: string) => {
      this.counters.peersBanned.inc();
      this.logger.warn(`banned peer: ${reason}`, { peer: peerId });
    });

    await this.p2pServer.start();

    // Periodic peer maintenance: refresh peer lists and re-dial known
    // addresses so a node stays connected through peer restarts and finds
    // peers that joined after the one-shot discovery on connect. `unref`:
    // the timer must never keep a stopping process alive.
    this.maintenanceTimer = setInterval(() => this.maintainPeers(), this.peerMaintenanceIntervalMs);
    this.maintenanceTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.miningAbort?.abort();
    await this.engine.close();
    await this.p2pServer.stop();
    await saveAddressBookJson(this.db, this.addressBook.toJSON()).catch(() => undefined);
    await closeStateDb(this.db);
  }

  getAddressBookSize(): number {
    return this.addressBook.size;
  }

  getDialsInFlight(): number {
    return this.dialsInFlight.size;
  }

  /** One maintenance tick: remember who we're talking to, ask them for more, fill free outbound slots. */
  private maintainPeers(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const address of this.p2pServer.getKnownPeerAddresses()) this.addressBook.add(address, now);
    for (const peerId of this.p2pServer.getPeerIds()) {
      this.p2pServer.send(peerId, { type: "GET_PEERS", payload: {} });
    }
    this.dialCandidates();
  }

  /**
   * Starts up to maxDialsPerTick dials to addresses that are due, if there
   * is outbound room. Bounded per call so neither the timer nor a PEERS
   * message from a hostile peer can trigger a dial storm.
   */
  private dialCandidates(): void {
    if (this.stopped) return;
    const room = this.p2pServer.outboundRoom();
    if (room === 0) return;
    const exclude = new Set([...this.p2pServer.getKnownPeerAddresses(), ...this.dialsInFlight]);
    const own = this.p2pServer.getListenAddress();
    if (own) exclude.add(own);
    for (const address of this.addressBook.candidates(exclude, Math.min(room, this.maxDialsPerTick), Date.now())) {
      void this.dial(address).catch(() => undefined);
    }
  }

  /** Dials once, recording the outcome in the address book. Rejects on failure. */
  private async dial(address: string): Promise<void> {
    if (this.dialsInFlight.has(address)) return;
    this.dialsInFlight.add(address);
    try {
      await this.p2pServer.connect(address);
      this.addressBook.markSuccess(address, Date.now());
      this.counters.peerDials.inc({ outcome: "ok" });
    } catch (err) {
      this.addressBook.markFailure(address, Date.now());
      this.counters.peerDials.inc({ outcome: "failed" });
      throw err;
    } finally {
      this.dialsInFlight.delete(address);
      if (!this.stopped) await saveAddressBookJson(this.db, this.addressBook.toJSON()).catch(() => undefined);
    }
  }

  getBoundPort(): number {
    return this.p2pServer.getBoundPort();
  }

  /** Dials a configured peer (`--peers`): remembered as an anchor and always retried. */
  async connectToPeer(url: string): Promise<void> {
    this.addressBook.add(url, Date.now(), { anchor: true });
    await this.dial(url);
  }

  async getTip(): Promise<ChainTip | undefined> {
    return this.chainState.getTip();
  }

  get nodeId(): string {
    return this.options.nodeId;
  }

  get networkId(): string {
    return this.options.networkId;
  }

  async getStats(): Promise<NodeStats> {
    const tip = await this.chainState.getTip();
    return {
      nodeId: this.options.nodeId,
      networkId: this.options.networkId,
      height: tip?.height ?? 0,
      tipHash: tip?.hash,
      peers: this.p2pServer.getPeerIds().length,
      mempool: this.mempool.size(),
      orphans: this.orphanHashes.size,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /** What a wallet needs to know before building a spend. */
  /**
   * Canonical headers from `fromHeight`, at most `count`, with their
   * hashes. What a light client walks to verify proof-of-work from genesis.
   */
  async getHeaders(fromHeight: number, count: number): Promise<{ hash: string; header: BlockHeader }[]> {
    const tip = await this.chainState.getTip();
    if (!tip) return [];
    const result: { hash: string; header: BlockHeader }[] = [];
    for (let h = fromHeight; h <= tip.height && result.length < count; h++) {
      const hash = await this.chainState.getCanonicalHashAtHeight(h);
      const header = hash ? await this.lookupHeader(hash) : undefined;
      if (!hash || !header) break;
      result.push({ hash, header });
    }
    return result;
  }

  /**
   * Merkle inclusion proof for a confirmed transaction: the siblings that
   * fold its id up to the merkle root of the canonical block containing
   * it. Undefined if the transaction isn't in the canonical chain (never
   * mined, still in the mempool, or in an abandoned fork).
   */
  async getTransactionProof(txId: string): Promise<TransactionProof | undefined> {
    const location = await this.chainState.getTxLocation(txId);
    if (!location) return undefined;
    const block = await this.chainState.getBlock(location.blockHash);
    if (!block) return undefined;
    // The index is maintained inside the adoption batch, so this only
    // fails if the database is inconsistent; check anyway rather than
    // hand out a proof against a non-canonical block.
    if ((await this.chainState.getCanonicalHashAtHeight(block.header.height)) !== block.hash) return undefined;
    const ids = block.transactions.map((t) => t.id);
    const index = ids.indexOf(txId);
    if (index < 0) return undefined;
    return {
      txId,
      blockHash: block.hash,
      blockHeight: block.header.height,
      index,
      siblings: merkleProof(ids, index),
      merkleRoot: block.header.merkleRoot,
    };
  }

  /** One-time build of the transaction index for databases that predate it. */
  private async backfillTxIndex(): Promise<void> {
    if (await this.chainState.isTxIndexBuilt()) return;
    const tip = await this.chainState.getTip();
    const ops: StateBatchOperation[] = [];
    for (let h = 0; tip && h <= tip.height; h++) {
      const hash = await this.chainState.getCanonicalHashAtHeight(h);
      const block = hash ? await this.chainState.getBlock(hash) : undefined;
      for (const tx of block?.transactions ?? []) {
        ops.push(this.chainState.putTxLocationOp(tx.id, block!.hash));
      }
    }
    ops.push(this.chainState.markTxIndexBuiltOp());
    await commitAtomic(this.db, ops);
  }

  /**
   * Per-address totals for one transaction: outputs paid to the address,
   * and inputs that spent the address's outputs (known from the UTXO
   * entries the spend consumed).
   */
  private static addressActivityOf(tx: Transaction, spent: { entry: { address: string; amount: bigint } }[]): Map<string, { received: bigint; sent: bigint }> {
    const totals = new Map<string, { received: bigint; sent: bigint }>();
    const bump = (address: string, field: "received" | "sent", amount: bigint): void => {
      const t = totals.get(address) ?? { received: 0n, sent: 0n };
      t[field] += amount;
      totals.set(address, t);
    };
    for (const output of tx.outputs) bump(output.address, "received", output.amount);
    for (const { entry } of spent) bump(entry.address, "sent", entry.amount);
    return totals;
  }

  private addressIndexOps(block: Block, undo: BlockUndo, remove: boolean): StateBatchOperation[] {
    const ops: StateBatchOperation[] = [];
    block.transactions.forEach((tx, i) => {
      for (const [address, totals] of Node.addressActivityOf(tx, undo[i]?.spent ?? [])) {
        ops.push(
          remove
            ? this.chainState.deleteAddressActivityOp(address, block.header.height, tx.id)
            : this.chainState.putAddressActivityOp({ address, txId: tx.id, height: block.header.height, blockHash: block.hash, timestamp: tx.timestamp, ...totals }),
        );
      }
    });
    return ops;
  }

  /** First height the address index covers at tip height `tipHeight`. */
  private addressIndexFloor(tipHeight: number): number {
    return this.addressIndexDepth === 0 ? 0 : Math.max(0, tipHeight - this.addressIndexDepth + 1);
  }

  /** The canonical block at `height` with its undo record: what pruning or restoring its address entries needs. */
  private async canonicalBlockWithUndo(height: number): Promise<{ block: Block; undo: BlockUndo } | undefined> {
    if (height < 0) return undefined;
    const hash = await this.chainState.getCanonicalHashAtHeight(height);
    const block = hash ? await this.chainState.getBlock(hash) : undefined;
    if (!block) return undefined;
    return { block, undo: (await this.chainState.getUndo(block.hash)) ?? [] };
  }

  /**
   * Brings the on-disk address index in line with this node's policy at
   * startup: builds it for a database that predates it (from the tx
   * index), sweeps entries a tighter depth no longer keeps, rebuilds the
   * heights a looser depth now wants, or drops it when disabled. Each
   * step is idempotent, so a crash mid-way simply repeats it next start.
   */
  private async reconcileAddressIndex(): Promise<void> {
    const built = await this.chainState.isAddrIndexBuilt();
    if (!this.addressIndexEnabled) {
      if (built) await this.chainState.dropAddressIndex();
      return;
    }
    const tipHeight = (await this.chainState.getTip())?.height ?? 0;
    const floor = this.addressIndexFloor(tipHeight);
    const depthOp = this.chainState.setAddrIndexDepthOp(this.addressIndexDepth);
    if (!built) {
      await this.backfillAddressIndex(floor, tipHeight, [depthOp, this.chainState.markAddrIndexBuiltOp()]);
      return;
    }
    const stored = (await this.chainState.getAddrIndexDepth()) ?? 0;
    if (stored === this.addressIndexDepth) return;
    const tighter = this.addressIndexDepth !== 0 && (stored === 0 || this.addressIndexDepth < stored);
    if (tighter) {
      await this.sweepAddressIndexBelow(floor);
      await commitAtomic(this.db, [depthOp]);
    } else {
      const storedFloor = stored === 0 ? 0 : Math.max(0, tipHeight - stored + 1);
      await this.backfillAddressIndex(floor, storedFloor - 1, [depthOp]);
    }
  }

  /** Deletes every address-index entry below `floor`, in bounded batches. */
  private async sweepAddressIndexBelow(floor: number): Promise<void> {
    let ops: StateBatchOperation[] = [];
    for await (const key of this.chainState.addressActivityKeysBelow(floor)) {
      ops.push(this.chainState.deleteAddressActivityKeyOp(key));
      if (ops.length >= 10_000) {
        await commitAtomic(this.db, ops);
        this.counters.addrIndexPruned.inc(ops.length);
        ops = [];
      }
    }
    if (ops.length > 0) {
      await commitAtomic(this.db, ops);
      this.counters.addrIndexPruned.inc(ops.length);
    }
  }

  /** Writes the address entries of canonical heights `from..to` (from the tx index) plus `extraOps`, atomically. */
  private async backfillAddressIndex(from: number, to: number, extraOps: StateBatchOperation[]): Promise<void> {
    const ops: StateBatchOperation[] = [];
    for (let h = from; h <= to; h++) {
      const hash = await this.chainState.getCanonicalHashAtHeight(h);
      const block = hash ? await this.chainState.getBlock(hash) : undefined;
      if (!block) continue;
      for (const tx of block.transactions) {
        const spent: { entry: { address: string; amount: bigint } }[] = [];
        for (const input of tx.inputs) {
          const location = await this.chainState.getTxLocation(input.txId);
          const sourceBlock = location ? await this.chainState.getBlock(location.blockHash) : undefined;
          const output = sourceBlock?.transactions.find((t) => t.id === input.txId)?.outputs[input.outputIndex];
          if (output) spent.push({ entry: { address: output.address, amount: output.amount } });
        }
        for (const [address, totals] of Node.addressActivityOf(tx, spent)) {
          ops.push(this.chainState.putAddressActivityOp({ address, txId: tx.id, height: h, blockHash: block.hash, timestamp: tx.timestamp, ...totals }));
        }
      }
    }
    ops.push(...extraOps);
    await commitAtomic(this.db, ops);
  }

  /** Canonical transactions involving `address`, newest first. Throws AddressIndexDisabledError on a `--no-addrindex` node. */
  async getAddressHistory(address: string, limit = 50): Promise<AddressActivity[]> {
    if (!this.addressIndexEnabled) throw new AddressIndexDisabledError();
    return this.chainState.listAddressActivity(address, limit);
  }

  async getInfo(): Promise<ChainInfo> {
    const tip = await this.chainState.getTip();
    return {
      networkId: this.options.networkId,
      genesisHash: this.genesisHash,
      tip: tip ?? null,
      coinbaseMaturity: this.options.consensus.coinbaseMaturity,
      minFee: this.options.mempool.minFee,
      blockReward: blockRewardAt((tip?.height ?? 0) + 1, this.policy),
      peerCount: this.p2pServer.getPeerIds().length,
      consensusMode: this.engine.mode,
      addressIndex: this.addressIndexEnabled ? { depth: this.addressIndexDepth, fromHeight: this.addressIndexFloor(tip?.height ?? 0) } : null,
    };
  }

  async getSupply(): Promise<SupplyInfo> {
    const height = (await this.chainState.getTip())?.height ?? 0;
    const genesisAllocation = genesisAllocationTotal(this.options.genesis);
    return {
      height,
      genesisAllocation,
      circulating: genesisAllocation + cumulativeEmission(height, this.policy),
      maxSupply: maxSupply(this.policy, genesisAllocation),
      currentReward: blockRewardAt(height + 1, this.policy),
      nextHalvingHeight: nextHalvingHeight(height + 1, this.policy),
      halvingInterval: this.policy.halvingInterval,
      tailEmission: this.policy.tailEmission,
    };
  }

  async getBlockByHash(hash: string): Promise<Block | undefined> {
    return this.chainState.getBlock(hash);
  }

  async getBlockByHeight(height: number): Promise<Block | undefined> {
    const hash = await this.chainState.getCanonicalHashAtHeight(height);
    return hash ? this.chainState.getBlock(hash) : undefined;
  }

  async getBalance(address: string): Promise<bigint> {
    return this.utxoSet.getBalance(address);
  }

  async listUnspent(address: string): Promise<Unspent[]> {
    return this.utxoSet.listUnspent(address);
  }

  getMempoolTransactions(): Transaction[] {
    return this.mempool.getTransactions();
  }

  async submitTransaction(tx: Transaction): Promise<ValidationResult> {
    const result = await this.withChainLock(async () => this.mempool.addTransaction(tx, await this.nextSpendingHeight()));
    this.recordAdmission(tx, result);
    if (result.valid) {
      this.p2pServer.broadcast({ type: "NEW_TX", payload: { transaction: tx } });
    }
    return result;
  }

  private recordAdmission(tx: Transaction, result: MempoolResult): void {
    (result.valid ? this.counters.txAccepted : this.counters.txRejected).inc();
    if (result.replaced && result.replaced.length > 0) {
      this.counters.txReplaced.inc(result.replaced.length);
      this.logger.info?.("transaction replaced by fee", { txId: tx.id, fee: tx.fee, replaced: result.replaced });
    }
  }

  /**
   * Asks a peer for the canonical headers above what we share. `fromHash`
   * continues a previous reply: the responder starts from it (it is
   * canonical there, since it just sent it), and our own locator follows
   * as a fallback in case the peer reorged in between.
   */
  private async requestHeadersFrom(peerId: string, fromHash?: string): Promise<void> {
    const locator = await this.buildLocator();
    this.p2pServer.send(peerId, {
      type: "GET_HEADERS",
      payload: { locator: fromHash ? [fromHash, ...locator] : locator },
    });
  }

  /** Asks a peer for the canonical block bodies it has beyond our chain. */
  private async requestBlocksFrom(peerId: string): Promise<void> {
    const tip = await this.chainState.getTip();
    this.p2pServer.send(peerId, {
      type: "GET_BLOCKS",
      payload: { fromHeight: tip?.height ?? 0, locator: await this.buildLocator() },
    });
  }

  /**
   * Our canonical hashes, tip-first: the last 10 consecutively, then with
   * doubling gaps, always ending at genesis. ~log(n) entries, and the
   * responder can always find a shared ancestor (genesis at worst).
   */
  private async buildLocator(): Promise<string[]> {
    const tip = await this.chainState.getTip();
    if (!tip) return [];
    const locator: string[] = [];
    let step = 1;
    for (let h = tip.height; h > 0; h -= step) {
      const hash = await this.chainState.getCanonicalHashAtHeight(h);
      if (hash) locator.push(hash);
      if (locator.length >= 10) step *= 2;
    }
    locator.push(this.genesisHash);
    return locator;
  }

  /** Height of the first locator entry that is on our canonical chain. */
  private async highestSharedHeight(locator: string[]): Promise<number> {
    for (const hash of locator.slice(0, Node.MAX_LOCATOR_ENTRIES)) {
      const block = await this.chainState.getBlock(hash);
      if (block && (await this.chainState.getCanonicalHashAtHeight(block.header.height)) === hash) {
        return block.header.height;
      }
    }
    return 0; // genesis is always shared (identity check guarantees it)
  }

  /** The height a mempool transaction would next be mined at: tip height + 1. */
  private async nextSpendingHeight(): Promise<number> {
    const tip = await this.chainState.getTip();
    return (tip?.height ?? 0) + 1;
  }

  /**
   * Mines one block on the current tip. The proof-of-work search runs on
   * the miner (a worker thread by default) *outside* the chain lock, so
   * peers' blocks keep being adopted and RPC keeps answering meanwhile.
   * If the tip moves during the search, the search is aborted and a fresh
   * template is built on the new tip; a solution that arrives just after
   * the tip moved is discarded as stale. Gives up after a few attempts.
   */
  async mineBlock(): Promise<Block> {
    const run = this.miningLock.then(() => this.mineBlockSerialized(), () => this.mineBlockSerialized());
    this.miningLock = run.catch(() => undefined);
    return run;
  }

  private async mineBlockSerialized(): Promise<Block> {
    for (let attempt = 1; attempt <= Node.MAX_MINING_ATTEMPTS; attempt++) {
      const template = await this.withChainLock(() => this.buildBlockTemplate());

      const abort = new AbortController();
      this.miningAbort = abort;
      let mined;
      try {
        mined = await this.engine.seal(template.header, abort.signal);
      } catch (err) {
        if (err instanceof MiningAbortedError) {
          if (this.stopped) throw err;
          this.counters.miningAttempts.inc({ outcome: "aborted" });
          continue;
        }
        throw err;
      } finally {
        if (this.miningAbort === abort) this.miningAbort = undefined;
      }

      // A seal the network would refuse (a proof-of-authority key that
      // signed too recently) must fail here, not be adopted locally and
      // then rejected by every peer.
      const seal = this.engine.verifySeal(mined.header, mined.hash, {
        recentSigners: await this.recentSignersFor(template.header.previousHash),
      });
      if (!seal.valid) throw new Error(`cannot produce a block: ${seal.reason}`);

      const block: Block = { header: mined.header, transactions: template.transactions, hash: mined.hash };
      const adopted = await this.withChainLock(async () => {
        const tip = await this.chainState.getTip();
        if (tip?.hash !== block.header.previousHash) return false;
        await this.adoptBlock(block);
        return true;
      });
      if (!adopted) {
        this.counters.miningAttempts.inc({ outcome: "stale" });
        continue;
      }
      this.counters.miningAttempts.inc({ outcome: "mined" });
      this.p2pServer.broadcast({ type: "NEW_BLOCK", payload: { block } });
      return block;
    }
    throw new Error(`chain advanced ${Node.MAX_MINING_ATTEMPTS} times while mining; giving up`);
  }

  /** Snapshot of tip + mempool as an unmined block. Must run under the chain lock. */
  private async buildBlockTemplate(): Promise<{ header: BlockHeader; transactions: Transaction[] }> {
    const tip = await this.chainState.getTip();
    if (!tip) {
      throw new Error("cannot mine before genesis is initialized");
    }
    const parent = await this.chainState.getBlock(tip.hash);
    if (!parent) {
      throw new Error(`tip block ${tip.hash} missing from store`);
    }

    // Consensus requires strictly increasing timestamps; two blocks mined
    // within the same millisecond would otherwise produce an invalid child.
    const timestamp = Math.max(Date.now(), parent.header.timestamp + 1);
    const height = parent.header.height + 1;

    // Fill the block by fee within the consensus limits. Byte accounting is
    // exact: serializeBlock renders each transaction exactly as
    // serializeTransaction does, joined by commas, so the size of the block
    // with the coinbase alone plus each fragment (+1 for its comma) is the
    // final size. The coinbase amount changes with the fees included, but
    // its length only changes when the digit count does; the final
    // measurement catches that and drops the last transaction if needed.
    const maxBytes = this.options.consensus.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    const maxTransactions = this.options.consensus.maxTransactionsPerBlock ?? DEFAULT_MAX_TRANSACTIONS_PER_BLOCK;
    const buildCoinbase = (fees: bigint): Transaction => {
      const body = { inputs: [], outputs: [{ address: this.options.minerAddress, amount: blockRewardAt(height, this.policy) + fees }], timestamp, fee: 0n };
      return { ...body, id: computeTransactionId(body) };
    };
    const headerFor = (txs: Transaction[]): BlockHeader => ({
      version: 1,
      previousHash: parent.hash,
      merkleRoot: merkleRoot(txs.map((t) => t.id)),
      timestamp,
      difficultyTarget: expectedTarget,
      nonce: 0,
      height,
    });
    const expectedTarget = await this.expectedTargetFor({ header: parent.header, hash: parent.hash });
    const measure = (txs: Transaction[]): number => blockByteSize({ header: headerFor(txs), transactions: txs, hash: "0".repeat(64) });

    const selected: Transaction[] = [];
    let fees = 0n;
    let bytes = measure([buildCoinbase(0n)]);
    for (const tx of this.mempool.getTransactionsByFee()) {
      if (selected.length + 1 >= maxTransactions) break;
      const extra = Buffer.byteLength(serializeTransaction(tx), "utf8") + 1;
      if (bytes + extra > maxBytes) continue; // a smaller, lower-fee tx may still fit
      selected.push(tx);
      fees += tx.fee;
      bytes += extra;
    }
    let transactions = [buildCoinbase(fees), ...selected];
    while (transactions.length > 1 && measure(transactions) > maxBytes) {
      const dropped = transactions.pop()!;
      fees -= dropped.fee;
      transactions[0] = buildCoinbase(fees);
    }

    return { header: headerFor(transactions), transactions };
  }

  /**
   * The difficulty target the retarget rule requires for the block after
   * `parent`. Used both to mine and to validate incoming blocks. Walks the
   * parent's own ancestry (not the canonical height index) so it gives the
   * right answer for a fork block whose history differs from ours.
   */
  private async expectedTargetFor(
    parent: { header: BlockHeader; hash: string },
    unstored?: Map<string, BlockHeader>,
  ): Promise<string> {
    const { difficultyRetargetInterval } = this.options.consensus;
    const nextHeight = parent.header.height + 1;

    if (!this.engine.retargets || nextHeight % difficultyRetargetInterval !== 0) {
      return parent.header.difficultyTarget;
    }

    // Walk the parent's own ancestry back to the period start (see
    // retargetWindow): `gaps` steps behind the parent.
    const { gaps } = retargetWindow(nextHeight, difficultyRetargetInterval);
    let periodStart: BlockHeader | undefined = parent.header;
    for (let i = 0; i < gaps && periodStart; i++) {
      periodStart = await this.lookupHeader(periodStart.previousHash, unstored);
    }
    if (!periodStart) {
      throw new Error(`cannot compute retarget: missing ancestor of ${parent.hash}`);
    }
    return nextTarget(parent.header, periodStart, this.options.consensus);
  }

  /**
   * Signers of the `recentSignerWindow()` headers ending at `parentHash`
   * (the parent first), walked along that parent's own ancestry, for the
   * proof-of-authority turn rule. Empty under proof of work.
   */
  private async recentSignersFor(parentHash: string, unstored?: Map<string, BlockHeader>): Promise<string[]> {
    const window = this.engine.recentSignerWindow();
    const signers: string[] = [];
    let cursor = window > 0 ? await this.lookupHeader(parentHash, unstored) : undefined;
    for (let i = 0; i < window && cursor; i++) {
      if (cursor.signer !== undefined) signers.push(cursor.signer);
      cursor = cursor.height === 0 ? undefined : await this.lookupHeader(cursor.previousHash, unstored);
    }
    return signers;
  }

  /** A header by hash: from a not-yet-stored batch, the header index, or the block store. */
  private async lookupHeader(hash: string, unstored?: Map<string, BlockHeader>): Promise<BlockHeader | undefined> {
    return (
      unstored?.get(hash) ??
      (await this.chainState.getHeader(hash))?.header ??
      (await this.chainState.getBlock(hash))?.header
    );
  }

  /**
   * The header index entry for `hash`, with the cumulative work of its
   * chain. Databases written before the index existed are backfilled
   * lazily from stored blocks (walking back to the nearest indexed
   * ancestor, then forward). Undefined if the ancestry is incomplete.
   */
  private async getIndexedHeader(hash: string): Promise<{ header: BlockHeader; hash: string; work: bigint } | undefined> {
    const indexed = await this.chainState.getHeader(hash);
    if (indexed) return { ...indexed, hash };

    const pending: Block[] = [];
    let cursor = hash;
    let work: bigint | undefined;
    for (;;) {
      const entry = await this.chainState.getHeader(cursor);
      if (entry) {
        work = entry.work;
        break;
      }
      const block = await this.chainState.getBlock(cursor);
      if (!block) return undefined;
      pending.push(block);
      if (block.header.height === 0) {
        work = 0n;
        break;
      }
      cursor = block.header.previousHash;
    }
    for (const block of pending.reverse()) {
      work += this.engine.blockWork(block.header, block.hash);
      await this.chainState.putHeader(block.hash, block.header, work);
    }
    const head = pending[pending.length - 1]!;
    return { header: head.header, hash, work };
  }

  private checkpointFor(height: number): string | undefined {
    return this.checkpoints.get(height);
  }

  /** Recomputes which checkpoints our canonical chain has reached. */
  private async refreshVerifiedCheckpoint(): Promise<void> {
    let best = -1;
    for (const [height, hash] of this.checkpoints) {
      if (height > best && (await this.chainState.getCanonicalHashAtHeight(height)) === hash) best = height;
    }
    this.verifiedCheckpointHeight = best;
  }

  /**
   * A block at or below a checkpoint we've already verified must be the
   * canonical one: anything else is a fork that would need to reorg the
   * checkpoint away, which is exactly what checkpoints forbid.
   */
  private async conflictsWithVerifiedCheckpoint(height: number, hash: string): Promise<boolean> {
    if (height > this.verifiedCheckpointHeight) return false;
    const canonical = await this.chainState.getCanonicalHashAtHeight(height);
    return canonical !== undefined && canonical !== hash;
  }

  private async handleMessage(message: Message, fromNodeId: string): Promise<void> {
    switch (message.type) {
      case "NEW_TX": {
        const tx = message.payload.transaction;
        if (this.mempool.has(tx.id)) return;
        // Structural failures are the sender's fault (they'd have failed the
        // same check before relaying). State/policy failures -- unknown
        // outpoint, low fee, mempool full -- can be an honest disagreement
        // or a race with a block, so they're not penalized.
        const structural = validateTransactionStructure(tx);
        if (!structural.valid) {
          this.counters.txRejected.inc();
          this.p2pServer.penalize(fromNodeId, Node.PENALTY_INVALID_TX, `invalid transaction: ${structural.reason}`);
          return;
        }
        const result = await this.withChainLock(async () => this.mempool.addTransaction(tx, await this.nextSpendingHeight()));
        this.recordAdmission(tx, result);
        if (result.valid) {
          this.p2pServer.broadcast(message, fromNodeId);
        }
        return;
      }
      case "NEW_BLOCK": {
        await this.withChainLock(() => this.handleIncomingBlock(message.payload.block, fromNodeId));
        return;
      }
      case "GET_BLOCKS": {
        const tip = await this.chainState.getTip();
        if (!tip) return;
        const start = message.payload.locator
          ? await this.highestSharedHeight(message.payload.locator)
          : message.payload.fromHeight;
        const end = Math.min(tip.height, start + this.maxBlocksPerResponse);
        for (let h = start + 1; h <= end; h++) {
          const hash = await this.chainState.getCanonicalHashAtHeight(h);
          const block = hash ? await this.chainState.getBlock(hash) : undefined;
          if (block) {
            this.p2pServer.send(fromNodeId, { type: "NEW_BLOCK", payload: { block } });
          }
        }
        if (end < tip.height) {
          // Tell the requester where the rest starts; it asks again if it
          // wants it. Pull, not push, keeps the requester in control.
          const next = await this.chainState.getCanonicalHashAtHeight(end + 1);
          if (next) {
            this.p2pServer.send(fromNodeId, { type: "INV_BLOCKS", payload: { hashes: [next] } });
          }
        }
        return;
      }
      case "GET_HEADERS": {
        const tip = await this.chainState.getTip();
        if (!tip) return;
        const start = await this.highestSharedHeight(message.payload.locator);
        const end = Math.min(tip.height, start + this.maxHeadersPerResponse);
        const headers: BlockHeader[] = [];
        for (let h = start + 1; h <= end; h++) {
          const hash = await this.chainState.getCanonicalHashAtHeight(h);
          const header = hash ? await this.lookupHeader(hash) : undefined;
          if (!header) break;
          headers.push(header);
        }
        this.p2pServer.send(fromNodeId, { type: "HEADERS", payload: { headers } });
        return;
      }
      case "HEADERS": {
        await this.withChainLock(() =>
          this.handleHeaders(message.payload.headers.slice(0, this.maxHeadersPerResponse), fromNodeId),
        );
        return;
      }
      case "INV_BLOCKS": {
        // A continuation from a capped GET_BLOCKS reply (or, in future, an
        // announcement). Under the chain lock so the blocks delivered ahead
        // of this INV on the same connection have been adopted first, and
        // the locator we send reflects them.
        await this.withChainLock(async () => {
          for (const hash of message.payload.hashes.slice(0, Node.MAX_INV_ENTRIES)) {
            if (this.invalidBlockHashes.has(hash)) continue;
            if (await this.chainState.getBlock(hash)) continue;
            await this.requestBlocksFrom(fromNodeId);
            return;
          }
        });
        return;
      }
      case "GET_PEERS": {
        this.p2pServer.send(fromNodeId, {
          type: "PEERS",
          payload: { addresses: this.p2pServer.getKnownPeerAddresses(fromNodeId) },
        });
        return;
      }
      case "PEERS": {
        this.handleDiscoveredPeers(message.payload.addresses);
        return;
      }
      case "HANDSHAKE":
        return;
    }
  }

  /** This node's currently connected peer nodeIds. */
  getConnectedPeerIds(): string[] {
    return this.p2pServer.getPeerIds();
  }

  /**
   * Best-effort peer discovery: try connecting to any newly learned address
   * we're not already linked to. Failures (unreachable/stale addresses) are
   * silently ignored -- discovery is opportunistic, not guaranteed. Actual
   * duplicate-connection safety (e.g. a race where we're mid-connect to an
   * address when this fires) is enforced at the P2PServer level, which
   * collapses redundant links by nodeId once handshakes complete.
   */
  private handleDiscoveredPeers(addresses: string[]): void {
    const ownAddress = this.p2pServer.getListenAddress();
    const now = Date.now();
    for (const address of addresses) {
      if (address === ownAddress) continue;
      if (!this.addressBook.add(address, now)) break; // book full: the rest is dropped
    }
    // Dial now rather than waiting for the next tick, but still bounded.
    this.dialCandidates();
  }

  private async handleIncomingBlock(block: Block, fromNodeId: string): Promise<void> {
    // "Processed" is tracked separately from "stored": a block is persisted
    // as soon as it passes validation (so later ancestry walks can find it)
    // but only marked processed once fork choice has been decided for it.
    if (this.processedBlockHashes.has(block.hash) || this.invalidBlockHashes.has(block.hash)) return;

    if (this.invalidBlockHashes.has(block.header.previousHash)) {
      const blame = !this.blamelessInvalidHashes.has(block.header.previousHash);
      this.rejectBlock(block, fromNodeId, "builds on a known-invalid block", blame);
      return;
    }

    const parent = await this.chainState.getBlock(block.header.previousHash);
    if (!parent) {
      // Orphan: queue it so a later arrival of the missing ancestor can
      // resolve it, and ask the sender to fill the gap between our tip and
      // here. Deliberately not marked processed: it's re-evaluated in full
      // once its parent connects.
      this.queueOrphan(block, fromNodeId);
      await this.requestHeadersFrom(fromNodeId);
      return;
    }

    if (await this.conflictsWithVerifiedCheckpoint(block.header.height, block.hash)) {
      this.rejectBlock(block, fromNodeId, `conflicts with checkpoint: would reorg below verified height ${this.verifiedCheckpointHeight}`);
      return;
    }

    const verdict = validateBlock(block, {
      parent,
      expectedTarget: await this.expectedTargetFor({ header: parent.header, hash: parent.hash }),
      blockReward: blockRewardAt(block.header.height, this.policy),
      maxBlockBytes: this.options.consensus.maxBlockBytes,
      maxTransactionsPerBlock: this.options.consensus.maxTransactionsPerBlock,
      now: Date.now(),
      maxFutureDriftMs: this.options.consensus.maxFutureDriftMs,
      checkpoint: this.checkpointFor(block.header.height),
      engine: this.engine,
      recentSigners: await this.recentSignersFor(parent.hash),
    });
    if (!verdict.valid) {
      const blame = verdict.reason !== FUTURE_TIMESTAMP_REASON;
      this.rejectBlock(block, fromNodeId, verdict.reason ?? "invalid block", blame);
      return;
    }

    const parentIndexed = await this.getIndexedHeader(parent.hash);
    if (!parentIndexed) {
      // Parent exists but its own ancestry is incomplete; treat as orphan.
      this.queueOrphan(block, fromNodeId);
      return;
    }

    await this.chainState.putBlock(block);
    this.processedBlockHashes.add(block.hash);

    // One read, not a walk to genesis: the index carries cumulative work.
    const candidateWork = parentIndexed.work + this.engine.blockWork(block.header, block.hash);
    if (!(await this.chainState.getHeader(block.hash))) {
      await this.chainState.putHeader(block.hash, block.header, candidateWork);
    }
    const currentTip = await this.chainState.getTip();
    const currentWork = currentTip ? ((await this.getIndexedHeader(currentTip.hash))?.work ?? 0n) : 0n;

    if (isBetterChain(candidateWork, currentWork)) {
      try {
        await this.adoptBlock(block);
      } catch (err) {
        if (err instanceof ChainReplayError) {
          // A transaction failed against UTXO state (e.g. a double-spend
          // only visible with full state): the block itself is bad.
          this.rejectBlock(block, fromNodeId, err.message);
          return;
        }
        // Anything else (e.g. the commit itself failed) is not the block's
        // fault. Nothing was written; let it be re-evaluated if it's seen
        // again.
        this.processedBlockHashes.delete(block.hash);
        throw err;
      }
      this.p2pServer.broadcast({ type: "NEW_BLOCK", payload: { block } }, fromNodeId);
    }

    // Whether or not this block became the new tip, its arrival may unblock
    // orphans that were waiting on it as their missing parent.
    await this.resolveOrphansOf(block.hash);
  }

  /**
   * @param blame Whether the sender is penalized. False for rejections an
   * honest peer could plausibly produce (a timestamp that's only too far
   * ahead by *our* clock); that exemption carries over to blocks built on
   * such a block, since a skewed-clock peer would relay those too.
   */
  private rejectBlock(block: Block, fromNodeId: string, reason: string, blame = true): void {
    this.invalidBlockHashes.add(block.hash);
    if (!blame) this.blamelessInvalidHashes.add(block.hash);
    this.processedBlockHashes.add(block.hash);
    this.counters.blocksRejected.inc();
    this.logger.warn(`rejected block: ${reason}`, { hash: block.hash, height: block.header.height, peer: fromNodeId });
    if (blame) {
      this.p2pServer.penalize(fromNodeId, Node.PENALTY_INVALID_BLOCK, `invalid block ${block.hash}: ${reason}`);
    }
    // Anything queued behind it can never connect either.
    const dependents = this.orphansByMissingParent.get(block.hash) ?? [];
    this.orphansByMissingParent.delete(block.hash);
    for (const { block: dependent, fromNodeId: from } of dependents) {
      this.orphanHashes.delete(dependent.hash);
      this.rejectBlock(dependent, from, "builds on a known-invalid block", blame);
    }
  }

  private queueOrphan(block: Block, fromNodeId: string): void {
    if (this.orphanHashes.has(block.hash)) return;

    const waiting = this.orphansByMissingParent.get(block.header.previousHash) ?? [];
    waiting.push({ block, fromNodeId });
    this.orphansByMissingParent.set(block.header.previousHash, waiting);
    this.orphanHashes.add(block.hash);

    if (this.orphanHashes.size > Node.MAX_ORPHANS) {
      // Bound memory against a peer flooding us with fake future blocks:
      // drop the oldest waiting group.
      const oldestParent = this.orphansByMissingParent.keys().next().value;
      if (oldestParent !== undefined) {
        const dropped = this.orphansByMissingParent.get(oldestParent) ?? [];
        for (const { block: droppedBlock } of dropped) {
          this.orphanHashes.delete(droppedBlock.hash);
        }
        this.orphansByMissingParent.delete(oldestParent);
      }
    }
  }

  private async resolveOrphansOf(parentHash: string): Promise<void> {
    const waiting = this.orphansByMissingParent.get(parentHash);
    if (!waiting) return;

    this.orphansByMissingParent.delete(parentHash);
    for (const { block, fromNodeId } of waiting) {
      this.orphanHashes.delete(block.hash);
      await this.handleIncomingBlock(block, fromNodeId);
    }
  }

  /**
   * Header-first sync, receiving side. Validates a peer's headers against
   * consensus (PoW, target, linkage, timestamps, checkpoints) and indexes
   * them with cumulative work. Bodies are requested only if the resulting
   * chain is heavier than ours -- so a peer can't make us download and
   * replay blocks for a chain that could never win, and an invalid chain
   * costs us one header's worth of validation before the peer is banned.
   * A full reply means there may be more: ask again from the last header.
   */
  private async handleHeaders(headers: BlockHeader[], fromNodeId: string): Promise<void> {
    if (headers.length === 0) return;

    let prev: { header: BlockHeader; hash: string; work: bigint } | undefined = await this.getIndexedHeader(
      headers[0]!.previousHash,
    );
    if (!prev) {
      // Doesn't connect to anything we know. Not necessarily malicious
      // (our locator may have missed a deep fork), but nothing to do.
      this.logger.warn(`ignoring ${headers.length} headers: unknown parent`, { peer: fromNodeId });
      return;
    }

    const batch = new Map<string, BlockHeader>();
    for (const header of headers) {
      const hash = computeBlockHash(header);
      const known = await this.chainState.getHeader(hash);
      if (known) {
        prev = { ...known, hash };
        continue;
      }
      if (this.invalidBlockHashes.has(hash) || this.invalidBlockHashes.has(header.previousHash)) {
        this.p2pServer.penalize(fromNodeId, Node.PENALTY_INVALID_BLOCK, `header ${hash} is (or builds on) a known-invalid block`);
        return;
      }
      if (await this.conflictsWithVerifiedCheckpoint(header.height, hash)) {
        this.p2pServer.penalize(fromNodeId, Node.PENALTY_INVALID_BLOCK, `header ${hash} conflicts with checkpoint: would reorg below verified height ${this.verifiedCheckpointHeight}`);
        return;
      }
      const verdict = validateHeader(header, hash, {
        parent: { header: prev.header, hash: prev.hash },
        expectedTarget: await this.expectedTargetFor(prev, batch),
        now: Date.now(),
        maxFutureDriftMs: this.options.consensus.maxFutureDriftMs,
        checkpoint: this.checkpointFor(header.height),
        engine: this.engine,
        recentSigners: await this.recentSignersFor(prev.hash, batch),
      });
      if (!verdict.valid) {
        if (verdict.reason !== FUTURE_TIMESTAMP_REASON) {
          this.p2pServer.penalize(fromNodeId, Node.PENALTY_INVALID_BLOCK, `invalid header ${hash}: ${verdict.reason}`);
        }
        return;
      }
      const work: bigint = prev.work + this.engine.blockWork(header, hash);
      await this.chainState.putHeader(hash, header, work);
      batch.set(hash, header);
      prev = { header, hash, work };
    }

    const tip = await this.chainState.getTip();
    const tipWork = tip ? ((await this.getIndexedHeader(tip.hash))?.work ?? 0n) : 0n;
    if (isBetterChain(prev.work, tipWork) && !(await this.chainState.getBlock(prev.hash))) {
      await this.requestBlocksFrom(fromNodeId);
    }
    if (headers.length >= this.maxHeadersPerResponse) {
      await this.requestHeadersFrom(fromNodeId, prev.hash);
    }
  }

  /**
   * Makes `headBlock` the canonical tip incrementally: walk both chains back
   * to their fork point, disconnect the old chain's blocks above it using
   * their undo records (tip-first), then connect the new chain's blocks
   * (fork-first). Cost is O(fork depth), not O(chain length). A plain
   * extension of the tip is the degenerate case with nothing to disconnect.
   *
   * Crash-atomic: nothing is written to disk until the end. UTXO changes
   * are staged in memory (reads see them, so dependent transactions still
   * validate), undo/height/tip changes are collected as ops, and everything
   * is committed in one LevelDB batch, which is applied all-or-nothing. A
   * crash before the commit leaves the old state intact; after it, the new
   * state is complete. A block that fails against UTXO state mid-connect
   * simply discards the staging -- there is nothing to unwind.
   *
   * Transactions from abandoned blocks that the new chain doesn't include
   * go back to the mempool. Databases written before undo records existed
   * can't be disconnected incrementally; those fall back to a full replay
   * (which also writes the missing undo records, so the fallback is
   * one-time).
   */
  private async adoptBlock(headBlock: Block): Promise<void> {
    const previousTip = await this.chainState.getTip();
    const previousHead = previousTip ? await this.chainState.getBlock(previousTip.hash) : undefined;

    let connected: Block[];
    let disconnected: Block[] = [];
    const ops: StateBatchOperation[] = [this.chainState.putBlockOp(headBlock)];
    if (!(await this.chainState.getHeader(headBlock.hash))) {
      // Locally mined blocks arrive here without passing through
      // handleIncomingBlock, so index their header now.
      const parentIndexed = headBlock.header.height === 0 ? undefined : await this.getIndexedHeader(headBlock.header.previousHash);
      const work = (parentIndexed?.work ?? 0n) + this.engine.blockWork(headBlock.header, headBlock.hash);
      ops.push(this.chainState.putHeaderOp(headBlock.hash, headBlock.header, work));
    }

    this.utxoSet.beginStaging();
    try {
      if (!previousHead) {
        connected = await this.replayChainTo(headBlock, ops);
      } else {
        const plan = await this.planReorg(previousHead, headBlock);
        const undos = await Promise.all(plan.toDisconnect.map((b) => this.chainState.getUndo(b.hash)));

        if (undos.some((u) => u === undefined)) {
          connected = await this.replayChainTo(headBlock, ops);
        } else {
          for (const [i, block] of plan.toDisconnect.entries()) {
            await this.disconnectBlock(block, undos[i]!, ops);
          }
          const connectedInBatch = new Map<number, { block: Block; undo: BlockUndo }>();
          for (const block of plan.toConnect) {
            await this.connectBlock(block, ops, connectedInBatch);
          }
          connected = plan.toConnect;
          disconnected = plan.toDisconnect;
        }
      }

      if (previousTip && previousTip.height > headBlock.header.height) {
        ops.push(...this.chainState.clearCanonicalHashesAboveOps(headBlock.header.height, previousTip.height));
      }
      ops.push(...this.chainState.setTipOps(headBlock.hash, headBlock.header.height));
      ops.push(...(await this.utxoSet.takeStagedOps()));
    } catch (err) {
      this.utxoSet.discardStaging();
      throw err;
    }

    await commitAtomic(this.db, ops);
    this.cachedTipHeight = headBlock.header.height;
    if (this.checkpoints.size > 0) await this.refreshVerifiedCheckpoint();

    this.counters.blocksAdopted.inc();
    if (disconnected.length > 0) {
      this.counters.reorgs.inc();
      this.counters.blocksDisconnected.inc(disconnected.length);
      this.logger.warn(`reorg: disconnected ${disconnected.length} block(s)`, {
        height: headBlock.header.height,
        hash: headBlock.hash,
        disconnected: disconnected.length,
        connected: connected.length,
      });
    } else {
      this.logger.info?.("block adopted", {
        height: headBlock.header.height,
        hash: headBlock.hash,
        transactions: headBlock.transactions.length,
      });
    }

    // The tip moved: any search in progress is building on the wrong parent.
    this.miningAbort?.abort();

    const includedTxIds = new Set(connected.flatMap((b) => b.transactions.map((t) => t.id)));
    for (const txId of includedTxIds) {
      this.mempool.remove(txId);
    }
    // Pending transactions that spend an outpoint the new blocks consumed
    // (e.g. an RBF bump whose original a peer mined) are now invalid and
    // would poison the next block template.
    const spent = new Set(connected.flatMap((b) => b.transactions.flatMap((t) => t.inputs.map((i) => `${i.txId}:${i.outputIndex}`))));
    for (const tx of this.mempool.getTransactions()) {
      if (tx.inputs.some((i) => spent.has(`${i.txId}:${i.outputIndex}`))) this.mempool.remove(tx.id);
    }

    // Give abandoned non-coinbase transactions another chance on the new
    // chain. Best-effort: some may now conflict, and that's fine.
    const spendingHeight = headBlock.header.height + 1;
    for (const block of disconnected) {
      for (const tx of block.transactions) {
        if (tx.inputs.length > 0 && !includedTxIds.has(tx.id)) {
          await this.mempool.addTransaction(tx, spendingHeight);
        }
      }
    }
  }

  /** Blocks to disconnect (tip-first) and connect (fork-first) to move from `from` to `to`. */
  private async planReorg(from: Block, to: Block): Promise<{ toDisconnect: Block[]; toConnect: Block[] }> {
    const parentOf = async (block: Block): Promise<Block> => {
      const parent = await this.chainState.getBlock(block.header.previousHash);
      if (!parent) throw new Error(`reorg: missing ancestor ${block.header.previousHash}`);
      return parent;
    };

    const toConnect: Block[] = [];
    const toDisconnect: Block[] = [];
    let a = to;
    let b = from;
    while (a.header.height > b.header.height) {
      toConnect.push(a);
      a = await parentOf(a);
    }
    while (b.header.height > a.header.height) {
      toDisconnect.push(b);
      b = await parentOf(b);
    }
    while (a.hash !== b.hash) {
      toConnect.push(a);
      toDisconnect.push(b);
      a = await parentOf(a);
      b = await parentOf(b);
    }
    toConnect.reverse();
    return { toDisconnect, toConnect };
  }

  /**
   * Stages a block's transactions against the UTXO set and appends its undo
   * record and height index to `ops`. Throws ChainReplayError if a
   * transaction is invalid against state.
   */
  private async connectBlock(block: Block, ops: StateBatchOperation[], connectedInBatch: Map<number, { block: Block; undo: BlockUndo }>): Promise<void> {
    const undo: BlockUndo = [];
    for (const tx of block.transactions) {
      try {
        undo.push(await this.utxoSet.applyTransaction(tx, block.header.height));
      } catch (err) {
        throw new ChainReplayError(block.hash, err instanceof Error ? err.message : String(err));
      }
    }
    ops.push(this.chainState.putUndoOp(block.hash, undo));
    for (const tx of block.transactions) {
      ops.push(this.chainState.putTxLocationOp(tx.id, block.hash));
    }
    if (this.addressIndexEnabled) {
      ops.push(...this.addressIndexOps(block, undo, false));
      connectedInBatch.set(block.header.height, { block, undo });
      // Pruning is the disconnect path applied to the block that just left
      // the window. During a reorg that block may itself have been connected
      // earlier in this batch (not yet canonical on disk), hence the map.
      if (this.addressIndexDepth > 0) {
        const leaving = block.header.height - this.addressIndexDepth;
        const target = connectedInBatch.get(leaving) ?? (await this.canonicalBlockWithUndo(leaving));
        if (target) {
          const deletes = this.addressIndexOps(target.block, target.undo, true);
          ops.push(...deletes);
          this.counters.addrIndexPruned.inc(deletes.length);
        }
      }
    }
    ops.push(this.chainState.setCanonicalHashAtHeightOp(block.header.height, block.hash));
  }

  private async disconnectBlock(block: Block, undo: BlockUndo, ops: StateBatchOperation[]): Promise<void> {
    for (const txUndo of [...undo].reverse()) {
      await this.utxoSet.undoTransaction(txUndo);
    }
    ops.push(this.chainState.deleteUndoOp(block.hash));
    for (const tx of block.transactions) {
      ops.push(this.chainState.deleteTxLocationOp(tx.id));
    }
    if (this.addressIndexEnabled) {
      // Deletes are idempotent, so entries pruned earlier need nothing here.
      ops.push(...this.addressIndexOps(block, undo, true));
      // The block this one pushed out of the window comes back in, so the
      // index always holds exactly the last `depth` canonical blocks.
      if (this.addressIndexDepth > 0) {
        const returning = await this.canonicalBlockWithUndo(block.header.height - this.addressIndexDepth);
        if (returning) ops.push(...this.addressIndexOps(returning.block, returning.undo, false));
      }
    }
  }

  /** Stages a rebuild of the UTXO set, undo records, and canonical index from genesis to `headBlock`. */
  private async replayChainTo(headBlock: Block, ops: StateBatchOperation[]): Promise<Block[]> {
    const chain: Block[] = [];
    let cursor: Block | undefined = headBlock;
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.header.height === 0 ? undefined : await this.chainState.getBlock(cursor.header.previousHash);
    }
    chain.reverse();

    // Restart staging with the persisted set masked out: the replay must
    // start from an empty UTXO set, and the commit will delete what's there.
    this.utxoSet.discardStaging();
    this.utxoSet.beginStaging({ clearBase: true });
    const connectedInBatch = new Map<number, { block: Block; undo: BlockUndo }>();
    for (const block of chain) {
      await this.connectBlock(block, ops, connectedInBatch);
    }
    return chain;
  }
}

/** A block's transactions failed against UTXO state: the block is invalid. */
export class ChainReplayError extends Error {
  constructor(
    readonly blockHash: string,
    detail: string,
  ) {
    super(`block ${blockHash} failed state replay: ${detail}`);
  }
}
