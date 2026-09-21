import type { KeyPair } from "../crypto/keypair.js";
import { sign, verify } from "../crypto/signature.js";
import { computeBlockHash, computeSealHash } from "../ledger/block.js";
import type { BlockHeader } from "../ledger/types.js";
import type { BlockValidationResult } from "./blockValidator.js";
import { workForTarget } from "./forkChoice.js";
import { type BlockMiner } from "./miner.js";
import { meetsTarget, type MinedHeader } from "./pow.js";

/**
 * How blocks are sealed and how sealed chains are compared -- the part of
 * consensus that differs between proof of work and proof of authority.
 * Everything else (linkage, timestamps, checkpoints, transactions, UTXO
 * rules, emission) is shared and stays in blockValidator / the node.
 *
 * The engine is consulted in three places: `validateHeader` asks it to
 * verify a seal, fork choice asks it how much a block weighs, and mining
 * asks it to seal a template. Its parameters are part of `rulesHash`, so
 * peers running a different mode or authority set refuse each other.
 */
export type ConsensusMode = "pow" | "poa";

export interface SealContext {
  /**
   * Signers of the headers immediately before this one on its own
   * ancestry, newest first, as many as `recentSignerWindow()` asks for
   * (fewer near genesis). Empty for proof of work.
   */
  recentSigners: string[];
}

export interface ConsensusEngine {
  readonly mode: ConsensusMode;
  /** Whether the difficulty retarget rule applies. Off means the target is constant from genesis. */
  readonly retargets: boolean;
  /** How many ancestors' signers `verifySeal` needs to see. */
  recentSignerWindow(): number;
  /** Header-only seal check: proof of work meets its target / an authority's signature is valid and allowed. */
  verifySeal(header: BlockHeader, hash: string, ctx: SealContext): BlockValidationResult;
  /** Fork-choice weight this block contributes to its chain. */
  blockWork(header: BlockHeader, hash: string): bigint;
  /** Whether this node can produce blocks (has a miner / an authority key). */
  readonly canSeal: boolean;
  /** Turns a template into a sealed header (PoW: nonce search; PoA: signature). */
  seal(header: BlockHeader, signal?: AbortSignal): Promise<MinedHeader>;
  close(): Promise<void>;
}

/** Proof of work: the seal is a hash below the target found by the miner. */
export class PowEngine implements ConsensusEngine {
  readonly mode = "pow";
  readonly retargets = true;

  constructor(private readonly miner?: BlockMiner) {}

  recentSignerWindow(): number {
    return 0;
  }

  verifySeal(header: BlockHeader, hash: string, _ctx: SealContext): BlockValidationResult {
    if (!meetsTarget(hash, header.difficultyTarget)) return { valid: false, reason: "block hash does not meet difficulty target" };
    return { valid: true };
  }

  blockWork(header: BlockHeader, _hash: string): bigint {
    return workForTarget(header.difficultyTarget);
  }

  get canSeal(): boolean {
    return this.miner !== undefined;
  }

  seal(header: BlockHeader, signal?: AbortSignal): Promise<MinedHeader> {
    if (!this.miner) return Promise.reject(new Error("this node has no miner"));
    return this.miner.mine(header, signal);
  }

  async close(): Promise<void> {
    await this.miner?.close();
  }
}

/** Fork-choice weight of a block sealed by the authority whose turn it was, and by any other. */
export const POA_IN_TURN_WORK = 2n;
export const POA_OUT_OF_TURN_WORK = 1n;

export interface PoaOptions {
  /** Public keys (the project's SPKI hex) in turn order; height h is authority h mod n's turn. */
  authorities: string[];
  /** This node's own authority key, if it produces blocks. */
  signerKey?: KeyPair;
}

/**
 * Proof of authority: a fixed, ordered set of signers takes turns. Rules
 * (checked from headers alone, so header-first sync and SPV both apply
 * them):
 *
 * 1. `signer` is an authority and `signature` is that key's signature
 *    over the seal hash (the block hash without the signature); the block
 *    hash itself covers both, so a block's identity includes its seal.
 * 2. No signer may sign more than one of any floor(n/2)+1 consecutive
 *    blocks, so producing a chain takes a majority of authorities and no
 *    minority can run away with it (the rule Clique uses).
 * 3. The authority scheduled for a height (h mod n) produces an in-turn
 *    block of weight 2; anyone else may fill in for weight 1, so when
 *    both happen the scheduled chain wins fork choice.
 *
 * The difficulty target is constant (whatever genesis set) and never
 * compared to the hash. Block pacing is not a rule: an authority sets its
 * own block times (bounded by rule 2 and the future-drift limit).
 */
export class PoaEngine implements ConsensusEngine {
  readonly mode = "poa";
  readonly retargets = false;
  private readonly authorities: string[];
  private readonly index: Map<string, number>;
  private readonly signerKey: KeyPair | undefined;

  constructor(options: PoaOptions) {
    if (options.authorities.length === 0) throw new Error("proof of authority needs at least one authority");
    this.authorities = [...options.authorities];
    this.index = new Map(this.authorities.map((a, i) => [a, i]));
    if (this.index.size !== this.authorities.length) throw new Error("duplicate authority in the authority set");
    if (options.signerKey && !this.index.has(options.signerKey.publicKey)) {
      throw new Error("signer key is not in the authority set: this node cannot produce blocks for this chain");
    }
    this.signerKey = options.signerKey;
  }

  recentSignerWindow(): number {
    return Math.floor(this.authorities.length / 2);
  }

  inTurnAuthority(height: number): string {
    return this.authorities[height % this.authorities.length]!;
  }

  verifySeal(header: BlockHeader, _hash: string, ctx: SealContext): BlockValidationResult {
    const { signer, signature } = header;
    if (typeof signer !== "string" || !this.index.has(signer)) return { valid: false, reason: "block signer is not an authority" };
    if (typeof signature !== "string" || !verify(signer, computeSealHash(header), signature)) return { valid: false, reason: "block signature is invalid" };
    const window = this.recentSignerWindow();
    if (ctx.recentSigners.slice(0, window).includes(signer)) {
      return { valid: false, reason: `authority signed too recently: at most one block per ${window + 1} consecutive blocks` };
    }
    return { valid: true };
  }

  blockWork(header: BlockHeader, _hash: string): bigint {
    return header.signer !== undefined && header.signer === this.inTurnAuthority(header.height) ? POA_IN_TURN_WORK : POA_OUT_OF_TURN_WORK;
  }

  get canSeal(): boolean {
    return this.signerKey !== undefined;
  }

  async seal(header: BlockHeader, _signal?: AbortSignal): Promise<MinedHeader> {
    if (!this.signerKey) throw new Error("this node has no signer key (--signer-key): it validates blocks but cannot produce them");
    const sealed: BlockHeader = { ...header, nonce: 0, signer: this.signerKey.publicKey };
    delete sealed.signature;
    sealed.signature = sign(this.signerKey.privateKey, computeSealHash(sealed));
    return { header: sealed, hash: computeBlockHash(sealed) };
  }

  async close(): Promise<void> {}
}

export interface EngineRules {
  mode?: ConsensusMode;
  authorities?: string[];
}

/** The engine a consensus config asks for. Proof of work when unspecified. */
export function createEngine(rules: EngineRules, options: { miner?: BlockMiner; signerKey?: KeyPair } = {}): ConsensusEngine {
  const mode = rules.mode ?? "pow";
  if (mode === "pow") return new PowEngine(options.miner);
  if (mode === "poa") {
    if (!rules.authorities || rules.authorities.length === 0) throw new Error(`consensus mode "poa" needs a non-empty consensus.authorities list`);
    return new PoaEngine({ authorities: rules.authorities, signerKey: options.signerKey });
  }
  throw new Error(`unknown consensus mode "${String(mode)}" (expected "pow" or "poa")`);
}
