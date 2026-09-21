import { existsSync, readFileSync } from "node:fs";
import type { ConsensusMode } from "../consensus/engine.js";
import type { MonetaryPolicy } from "../consensus/monetary.js";
import type { GenesisConfig } from "../ledger/block.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  networkId: string;
  genesis: {
    timestamp: number;
    difficultyTarget: string;
    /** Genesis allocation (shorthand for a single output). */
    reward: string;
    genesisAddress: string;
    /** Explicit premine, overriding the shorthand; see `npm run genesis`. */
    allocations?: { address: string; amount: string }[];
  };
  /** Emission schedule; consensus-critical (part of the handshake rules hash). */
  monetary: {
    initialReward: string;
    halvingInterval: number;
    tailEmission: string;
  };
  consensus: {
    targetBlockTimeMs: number;
    difficultyRetargetInterval: number;
    maxDifficultyAdjustmentFactor: number;
    coinbaseMaturity: number;
    maxFutureDriftMs: number;
    /** Consensus block limits (canonical serialized bytes; transaction count incl. coinbase). */
    maxBlockBytes: number;
    maxTransactionsPerBlock: number;
    /** Known-good `{ height, hash }` pairs; see ConsensusConfig in node.ts. */
    checkpoints: { height: number; hash: string }[];
    /** "pow" (default) or "poa"; consensus-critical (rules hash). */
    mode: ConsensusMode;
    /** Proof-of-authority signer public keys in turn order (`npm run gen-authority`). */
    authorities: string[];
  };
  mempool: {
    minFee: string;
    maxSize: number;
    /** Most pending transactions one replace-by-fee transaction may evict. */
    maxReplacements: number;
  };
  network: {
    defaultPort: number;
    handshakeTimeoutMs: number;
    maxInboundPeers: number;
    maxOutboundPeers: number;
    maxMessageBytes: number;
    banThreshold: number;
    banDurationMs: number;
    maxBlocksPerResponse: number;
    maxHeadersPerResponse: number;
    peerMaintenanceIntervalMs: number;
    maxDialsPerTick: number;
    maxAddressBookSize: number;
    peerDialBackoffMs: number;
    /** Inbound connections per remote IP; 0 = unlimited (single-host devnets). */
    maxInboundPerIp: number;
  };
  index: {
    /** Maintain the per-address history index behind `listTransactions`. */
    addressIndex: boolean;
    /** Canonical blocks of address history kept; 0 = the whole chain. */
    addressIndexDepth: number;
  };
  rpc: {
    /** Interface the HTTP server binds to. Loopback by default: exposing
     *  RPC beyond the host is an explicit choice. */
    bind: string;
    rateLimit: { maxRequests: number; windowMs: number };
    /** Reverse-proxy hops whose X-Forwarded-For is trusted for rate limiting; 0 = none. */
    trustProxy: number;
  };
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * The directory holding package.json, found by walking up from `from`.
 * Works whether this module runs from `src/config/` (tsx) or from
 * `dist/src/config/` (compiled, e.g. inside the Docker image), so
 * config/default.json and package.json are always the repo's own.
 */
export function projectRoot(from: string = moduleDir): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json found above ${from}`);
    dir = parent;
  }
}

/** Version from package.json, for build-info metrics and banners. */
export function packageVersion(): string {
  const path = join(projectRoot(), "package.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

/**
 * The chain configuration: `config/default.json` (the devnet) unless a
 * path is given (`--config` / `L1_CONFIG`), which is how a private or
 * consortium chain ships its own genesis and authority set. Sections the
 * file omits fall back to the defaults, so a chain config only needs to
 * state what differs.
 */
export function loadConfig(path?: string): AppConfig {
  const defaults = JSON.parse(readFileSync(join(projectRoot(), "config", "default.json"), "utf8")) as AppConfig;
  if (path === undefined) return defaults;
  let overrides: Partial<AppConfig>;
  try {
    overrides = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  } catch (err) {
    throw new Error(`cannot load config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return mergeConfig(defaults, overrides);
}

function mergeConfig(defaults: AppConfig, overrides: Partial<AppConfig>): AppConfig {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const base = (defaults as unknown as Record<string, unknown>)[key];
    merged[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value;
  }
  return merged as unknown as AppConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The genesis section as the ledger wants it (bigints, explicit allocations). */
export function genesisConfigFrom(config: AppConfig): GenesisConfig {
  return {
    timestamp: config.genesis.timestamp,
    difficultyTarget: config.genesis.difficultyTarget,
    reward: BigInt(config.genesis.reward),
    genesisAddress: config.genesis.genesisAddress,
    ...(config.genesis.allocations
      ? { allocations: config.genesis.allocations.map((a) => ({ address: a.address, amount: BigInt(a.amount) })) }
      : {}),
  };
}

export function monetaryPolicyFrom(config: AppConfig): MonetaryPolicy {
  return {
    initialReward: BigInt(config.monetary.initialReward),
    halvingInterval: config.monetary.halvingInterval,
    tailEmission: BigInt(config.monetary.tailEmission),
  };
}
