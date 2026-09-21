import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { verifyHeaderChain, type ChainHeader, type SpvParams } from "./spv.js";

/**
 * On-disk cache of the header chain a wallet has verified, so the next
 * `verify`/`sync` downloads only what's new. It is a cache, not a root of
 * trust: the chain is re-verified from the trusted genesis on load (cheap
 * -- one hash per header, no network), and anything that fails is
 * discarded and re-synced. Tampering with the file therefore costs the
 * attacker exactly what forging headers costs: proof of work.
 */

const FORMAT = 1;

interface StoreFile {
  format: number;
  headers: ChainHeader[];
}

export interface LoadedHeaders {
  headers: ChainHeader[];
  /** Why a present file was ignored (missing file is not a reason). */
  discardedReason?: string;
}

function isChainHeader(value: unknown): value is ChainHeader {
  if (typeof value !== "object" || value === null) return false;
  const { hash, header } = value as { hash?: unknown; header?: unknown };
  if (typeof hash !== "string" || typeof header !== "object" || header === null) return false;
  const h = header as Record<string, unknown>;
  return (
    typeof h.version === "number" &&
    typeof h.previousHash === "string" &&
    typeof h.merkleRoot === "string" &&
    typeof h.timestamp === "number" &&
    typeof h.difficultyTarget === "string" &&
    typeof h.nonce === "number" &&
    typeof h.height === "number"
  );
}

export function loadVerifiedHeaders(path: string, params: SpvParams): LoadedHeaders {
  if (!existsSync(path)) return { headers: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { headers: [], discardedReason: `cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const file = parsed as Partial<StoreFile>;
  if (file.format !== FORMAT || !Array.isArray(file.headers) || !file.headers.every(isChainHeader)) {
    return { headers: [], discardedReason: `${path} has an unexpected format` };
  }
  // Timestamps were checked against the clock when the headers were first
  // accepted; on reload only structure and work matter, so no `now` bound.
  const verdict = verifyHeaderChain(file.headers, { ...params, now: Number.MAX_SAFE_INTEGER });
  if (!verdict.valid) {
    return { headers: [], discardedReason: `${path} failed verification (${verdict.reason}); re-syncing from genesis` };
  }
  return { headers: file.headers };
}

/** Writes via a temp file + rename so a crash can't leave a truncated store. */
export function saveHeaders(path: string, headers: ChainHeader[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const file: StoreFile = { format: FORMAT, headers };
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, path);
}
