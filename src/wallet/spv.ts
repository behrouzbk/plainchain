import { validateHeader } from "../consensus/blockValidator.js";
import { nextTarget, retargetWindow } from "../consensus/difficulty.js";
import { createEngine, type ConsensusMode } from "../consensus/engine.js";
import { verifyMerkleProof, type MerkleProof } from "../crypto/merkle.js";
import type { BlockHeader } from "../ledger/types.js";

/**
 * Simplified payment verification: a client that holds only headers can
 * check (1) that a chain of headers is valid proof-of-work from a genesis
 * it trusts, and (2) that a transaction is in one of those headers'
 * blocks, via a merkle inclusion proof. Neither step trusts the node's
 * UTXO state or its word about what's confirmed: forging either would
 * take real work.
 */

export interface ChainHeader {
  hash: string;
  header: BlockHeader;
}

export interface SpvParams {
  /** Root of trust: the client's own knowledge of the chain's genesis. */
  genesisHash: string;
  consensus: {
    targetBlockTimeMs: number;
    difficultyRetargetInterval: number;
    maxDifficultyAdjustmentFactor: number;
    maxFutureDriftMs: number;
    /** Sealing rules; proof of work when omitted. Under proof of authority the
     *  authority set is part of the client's root of trust, like the genesis hash. */
    mode?: ConsensusMode;
    authorities?: string[];
  };
  /** Wall-clock reference; defaults to Date.now(). */
  now?: number;
}

export interface HeaderChainResult {
  valid: boolean;
  reason?: string;
  tipHeight?: number;
  totalWork?: bigint;
}

export interface InclusionProof {
  txId: string;
  blockHash: string;
  blockHeight: number;
  index: number;
  siblings: MerkleProof;
  merkleRoot: string;
}

/** Cumulative weight of a header chain under the params' sealing rules (proof of work when omitted). */
export function chainWork(chain: ChainHeader[], params?: Pick<SpvParams, "consensus">): bigint {
  const engine = createEngine(params?.consensus ?? {});
  let work = 0n;
  for (const { header, hash } of chain) work += engine.blockWork(header, hash);
  return work;
}

/**
 * Validates `chain[from..]` against the already-accepted prefix
 * `chain[..from)`: each header links to the previous, meets the target
 * the retarget rule dictates for its height, and has a sane timestamp.
 * Mirrors the node's expectedTargetFor on an in-memory array.
 */
function verifyFrom(chain: ChainHeader[], from: number, params: SpvParams): { valid: boolean; reason?: string } {
  const { difficultyRetargetInterval, maxFutureDriftMs } = params.consensus;
  const now = params.now ?? Date.now();
  const engine = createEngine(params.consensus);
  const window = engine.recentSignerWindow();

  for (let i = from; i < chain.length; i++) {
    const { hash, header } = chain[i]!;
    const parent = chain[i - 1]!;

    let expectedTarget = parent.header.difficultyTarget;
    if (engine.retargets && header.height % difficultyRetargetInterval === 0) {
      // chain[k] is the header at height k (the chain starts at genesis).
      const periodStart = chain[retargetWindow(header.height, difficultyRetargetInterval).startHeight];
      if (!periodStart) {
        return { valid: false, reason: `height ${header.height}: retarget period start missing from chain` };
      }
      expectedTarget = nextTarget(parent.header, periodStart.header, params.consensus);
    }

    // Signers of the `window` headers before this one, newest first (the turn rule).
    const recentSigners = chain
      .slice(Math.max(0, i - window), i)
      .reverse()
      .map((h) => h.header.signer)
      .filter((s): s is string => s !== undefined);
    const verdict = validateHeader(header, hash, { parent, expectedTarget, now, maxFutureDriftMs, engine, recentSigners });
    if (!verdict.valid) {
      return { valid: false, reason: `height ${header.height}: ${verdict.reason}` };
    }
  }
  return { valid: true };
}

/**
 * Verifies a contiguous header chain from genesis: the first header must
 * be the trusted genesis, then every header is checked against its
 * predecessor (see verifyFrom).
 */
export function verifyHeaderChain(chain: ChainHeader[], params: SpvParams): HeaderChainResult {
  const first = chain[0];
  if (!first) return { valid: false, reason: "empty chain: expected genesis first" };
  if (first.header.height !== 0 || first.hash !== params.genesisHash) {
    return { valid: false, reason: `chain does not start at the trusted genesis ${params.genesisHash}` };
  }
  const verdict = verifyFrom(chain, 1, params);
  if (!verdict.valid) return verdict;
  return { valid: true, tipHeight: chain[chain.length - 1]!.header.height, totalWork: chainWork(chain, params) };
}

export interface ExtendResult extends HeaderChainResult {
  /** The combined chain when valid. */
  chain: ChainHeader[];
}

/**
 * Appends `additions` to an already-verified `prefix`, checking only the
 * new headers. This is what makes incremental sync cheap: a wallet that
 * has verified N headers pays for the new ones, not for N again.
 */
export function extendHeaderChain(prefix: ChainHeader[], additions: ChainHeader[], params: SpvParams): ExtendResult {
  if (prefix.length === 0) {
    const fresh = verifyHeaderChain(additions, params);
    return { ...fresh, chain: fresh.valid ? additions : [] };
  }
  const chain = [...prefix, ...additions];
  const verdict = verifyFrom(chain, prefix.length, params);
  if (!verdict.valid) return { ...verdict, chain: [] };
  return { valid: true, chain, tipHeight: chain[chain.length - 1]!.header.height, totalWork: chainWork(chain, params) };
}

/** Where headers come from: the node's `getHeaders(fromHeight, count)` RPC. */
export interface HeaderSource {
  getHeaders(fromHeight: number, count: number): Promise<ChainHeader[]>;
}

export interface SyncResult {
  /** The verified chain after sync (the stored one if nothing changed). */
  chain: ChainHeader[];
  /** Headers downloaded and verified this time. */
  fetched: number;
  /** Stored headers abandoned because the node's heavier chain forked below them. */
  discarded: number;
  /** Highest height at which the stored chain and the node agree (-1 when nothing was stored). */
  forkHeight: number;
  totalWork: bigint;
  tipHeight: number;
  /** Set when the node offered a fork that was refused for having less work. */
  rejectedFork?: string;
}

/** The node served something that fails verification; nothing was accepted. */
export class HeaderSyncError extends Error {}

/**
 * Brings a locally stored, already-verified header chain up to date with a
 * node, downloading only what is new. If the node's chain has forked below
 * our tip (a reorg, or a different node), the fork point is located with
 * exponential back-off + binary search over single-header probes, and the
 * node's branch replaces ours only if it carries strictly more work --
 * the same rule a full node applies. A lighter fork is refused, so a node
 * cannot "confirm" a transaction on a cheap side chain to a wallet that has
 * already seen the heavier one.
 */
export async function syncHeaders(stored: ChainHeader[], source: HeaderSource, params: SpvParams, pageSize = 2000): Promise<SyncResult> {
  const reasonOf = (r: { reason?: string }): string => r.reason ?? "invalid headers";

  if (stored.length === 0) {
    const chain = await fetchFrom(source, 0, pageSize);
    const verdict = verifyHeaderChain(chain, params);
    if (!verdict.valid) throw new HeaderSyncError(`header chain invalid: ${reasonOf(verdict)}`);
    return { chain, fetched: chain.length, discarded: 0, forkHeight: -1, totalWork: verdict.totalWork!, tipHeight: verdict.tipHeight! };
  }

  const storedTip = stored.length - 1;
  const agreesAt = async (height: number): Promise<boolean> => (await source.getHeaders(height, 1))[0]?.hash === stored[height]!.hash;

  // Fast path: the node's next header builds on our tip (or the node is
  // simply behind us and still agrees with our tip).
  let tail = await source.getHeaders(storedTip + 1, pageSize);
  let forkHeight: number;
  if (tail.length > 0 ? tail[0]!.header.previousHash === stored[storedTip]!.hash : await agreesAt(storedTip)) {
    forkHeight = storedTip;
  } else {
    // The node disagrees with our tip. Back off exponentially to a height
    // we both agree on, then binary-search the highest such height.
    let mismatch = storedTip;
    let step = 1;
    let match = -1;
    while (mismatch - step >= 0) {
      if (await agreesAt(mismatch - step)) {
        match = mismatch - step;
        break;
      }
      mismatch -= step;
      step *= 2;
    }
    if (match < 0) {
      if (!(await agreesAt(0))) throw new HeaderSyncError(`node does not share the trusted genesis ${params.genesisHash}`);
      match = 0;
    }
    while (mismatch - match > 1) {
      const mid = Math.floor((match + mismatch) / 2);
      if (await agreesAt(mid)) match = mid;
      else mismatch = mid;
    }
    forkHeight = match;
    tail = await fetchFrom(source, forkHeight + 1, pageSize);
  }

  const prefix = stored.slice(0, forkHeight + 1);
  const extended = extendHeaderChain(prefix, tail, params);
  if (!extended.valid) throw new HeaderSyncError(`header chain invalid: ${reasonOf(extended)}`);

  const storedWork = chainWork(stored, params);
  if (forkHeight < storedTip && extended.totalWork! <= storedWork) {
    return {
      chain: stored,
      fetched: 0,
      discarded: 0,
      forkHeight,
      totalWork: storedWork,
      tipHeight: storedTip,
      rejectedFork: `node offers a lighter fork from height ${forkHeight} (less work than the ${stored.length} headers already verified); keeping the heavier chain`,
    };
  }
  return {
    chain: extended.chain,
    fetched: tail.length,
    discarded: storedTip - forkHeight,
    forkHeight,
    totalWork: extended.totalWork!,
    tipHeight: extended.tipHeight!,
  };
}

/** Pages `getHeaders` from `fromHeight` until a short page. */
async function fetchFrom(source: HeaderSource, fromHeight: number, pageSize: number): Promise<ChainHeader[]> {
  const out: ChainHeader[] = [];
  for (let from = fromHeight; ; from += pageSize) {
    const page = await source.getHeaders(from, pageSize);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

/**
 * Checks an inclusion proof against a header the client has already
 * verified. The proof's own `merkleRoot` field is informational only:
 * the root that counts is the one in the PoW-protected header.
 */
export function verifyInclusion(proof: InclusionProof, header: ChainHeader): { valid: boolean; reason?: string } {
  if (proof.blockHash !== header.hash) {
    return { valid: false, reason: `proof is for block ${proof.blockHash}, not ${header.hash}` };
  }
  if (proof.blockHeight !== header.header.height) {
    return { valid: false, reason: `proof height ${proof.blockHeight} does not match header height ${header.header.height}` };
  }
  if (!verifyMerkleProof(proof.txId, proof.siblings, header.header.merkleRoot)) {
    return { valid: false, reason: "merkle proof does not reproduce the header's merkle root" };
  }
  return { valid: true };
}
