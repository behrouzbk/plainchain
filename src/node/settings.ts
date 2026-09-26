import { AddressError, normalizeAddress } from "../ledger/address.js";
import { parseLogFormat, parseLogLevel, type LogFormat, type LogLevel } from "./logger.js";

/**
 * Everything `main.ts` needs from the command line, resolved with one
 * rule: `--flag` beats `L1_FLAG` env var beats default. Env vars are how
 * containers are configured (docker-compose.yml sets nothing but env),
 * flags are how a person runs a node by hand. Pure: no filesystem, so it
 * is unit-tested exhaustively and main.ts stays a thin wrapper.
 */
export interface NodeSettings {
  nodeId: string;
  port: number;
  rpcPort: number;
  dataDir: string;
  peers: string[];
  advertiseUrl?: string;
  minerAddress?: string;
  rpcToken?: string;
  rpcBind: string;
  rpcTls?: { certPath: string; keyPath: string };
  rpcAllowInsecure: boolean;
  /** Overrides network.maxInboundPerIp when given (--max-inbound-per-ip / L1_MAX_INBOUND_PER_IP). */
  maxInboundPerIp?: number;
  /** Overrides rpc.trustProxy when given (--rpc-trust-proxy / L1_RPC_TRUST_PROXY): trusted proxy hops. */
  rpcTrustProxy?: number;
  /** Overrides index.addressIndexDepth when given (--addrindex-depth / L1_ADDRINDEX_DEPTH): blocks of history kept, 0 = all. */
  addrIndexDepth?: number;
  /** --no-addrindex / L1_NO_ADDRINDEX: keep no address index at all (listTransactions refused). */
  noAddrIndex: boolean;
  /** --signer-key / L1_SIGNER_KEY: file holding this node's proof-of-authority key. */
  signerKeyPath?: string;
  /** --anchor-key / L1_ANCHOR_KEY: file holding the key that pays for anchorRecord. */
  anchorKeyPath?: string;
  logFormat: LogFormat;
  logLevel: LogLevel;
}

export interface SettingsDefaults {
  defaultPort: number;
  rpcBind: string;
}

/** A setting that cannot be used as given; the message names the flag/env var. */
export class SettingsError extends Error {}

type Flags = Record<string, string | undefined>;
type Env = Record<string, string | undefined>;

/** `--node-id` <-> `L1_NODE_ID`. */
function envName(flag: string): string {
  return `L1_${flag.toUpperCase().replace(/-/g, "_")}`;
}

export function resolveNodeSettings(flags: Flags, env: Env, defaults: SettingsDefaults): NodeSettings {
  /** The raw value and where it came from, for error messages. */
  const pick = (flag: string): { value: string; source: string } | undefined => {
    if (flags[flag] !== undefined) return { value: flags[flag]!, source: `--${flag}` };
    // An empty env var counts as unset: compose files interpolate
    // `${L1_MINER_ADDRESS:-}` to "" when the operator left it blank.
    const name = envName(flag);
    if (env[name] !== undefined && env[name] !== "") return { value: env[name]!, source: name };
    return undefined;
  };
  const str = (flag: string): string | undefined => pick(flag)?.value;
  const port = (flag: string, fallback: number): number => {
    const picked = pick(flag);
    if (!picked) return fallback;
    const n = Number(picked.value);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new SettingsError(`${picked.source} must be a port number 0-65535, got "${picked.value}"`);
    return n;
  };
  const bool = (flag: string): boolean => {
    const picked = pick(flag);
    if (!picked) return false;
    // A bare `--flag` parses as "true"; env vars get the usual spellings.
    return ["true", "1", "yes"].includes(picked.value.trim().toLowerCase());
  };

  const nonNegativeInt = (flag: string): number | undefined => {
    const picked = pick(flag);
    if (!picked) return undefined;
    const n = Number(picked.value);
    if (!Number.isInteger(n) || n < 0) throw new SettingsError(`${picked.source} must be a non-negative integer, got "${picked.value}"`);
    return n;
  };

  const nodeId = str("node-id") ?? `node-${process.pid}`;
  const p2pPort = port("port", defaults.defaultPort);

  let minerAddress = str("miner-address");
  if (minerAddress !== undefined) {
    try {
      minerAddress = normalizeAddress(minerAddress); // checksummed or raw; the node works with raw
    } catch (err) {
      if (!(err instanceof AddressError)) throw err;
      throw new SettingsError(`${pick("miner-address")!.source}: ${err.message}`);
    }
  }

  const rpcToken = str("rpc-token");
  if (rpcToken !== undefined && rpcToken.length === 0) {
    throw new SettingsError(`${pick("rpc-token")!.source} must not be empty (omit it to have a token generated)`);
  }

  const certPath = str("rpc-tls-cert");
  const keyPath = str("rpc-tls-key");
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new SettingsError("--rpc-tls-cert/L1_RPC_TLS_CERT and --rpc-tls-key/L1_RPC_TLS_KEY must be given together");
  }

  let logFormat: LogFormat;
  let logLevel: LogLevel;
  try {
    logFormat = parseLogFormat(str("log-format"));
    logLevel = parseLogLevel(str("log-level"));
  } catch (err) {
    throw new SettingsError(err instanceof Error ? err.message : String(err));
  }

  return {
    nodeId,
    port: p2pPort,
    rpcPort: port("rpc-port", p2pPort + 1000),
    dataDir: str("data-dir") ?? `data/${nodeId}`,
    peers: (str("peers") ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    advertiseUrl: str("advertise-url"),
    minerAddress,
    rpcToken,
    rpcBind: str("rpc-bind") ?? defaults.rpcBind,
    rpcTls: certPath !== undefined && keyPath !== undefined ? { certPath, keyPath } : undefined,
    rpcAllowInsecure: bool("rpc-allow-insecure"),
    maxInboundPerIp: nonNegativeInt("max-inbound-per-ip"),
    rpcTrustProxy: nonNegativeInt("rpc-trust-proxy"),
    addrIndexDepth: nonNegativeInt("addrindex-depth"),
    noAddrIndex: bool("no-addrindex"),
    signerKeyPath: str("signer-key"),
    anchorKeyPath: str("anchor-key"),
    logFormat,
    logLevel,
  };
}
