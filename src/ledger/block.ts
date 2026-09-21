import { sha256 } from "../crypto/hash.js";
import { merkleRoot } from "../crypto/merkle.js";
import { computeTransactionId } from "./transaction.js";
import type { Block, BlockHeader, Transaction } from "./types.js";

const ZERO_HASH = "0".repeat(64);

export function computeBlockHash(header: BlockHeader): string {
  const fields = [
    header.version.toString(),
    header.previousHash,
    header.merkleRoot,
    header.timestamp.toString(),
    header.difficultyTarget,
    header.nonce.toString(),
    header.height.toString(),
  ];
  // A proof-of-authority seal is part of the block's identity (appended
  // only when present, so unsigned headers -- every proof-of-work header
  // and genesis -- hash exactly as before). The signature is over
  // `computeSealHash`, which is this hash without the signature; including
  // the signature here means a copy with a mangled signature is a
  // *different* block, so rejecting it cannot poison the real one.
  if (header.signer !== undefined) fields.push(String(header.signer));
  if (header.signature !== undefined) fields.push(String(header.signature));
  return sha256(fields.join("|"));
}

/** What a proof-of-authority signer signs: the block hash with the signature left out. */
export function computeSealHash(header: BlockHeader): string {
  const { signature: _signature, ...unsigned } = header;
  return computeBlockHash(unsigned);
}

export interface GenesisAllocation {
  address: string;
  amount: bigint;
}

export interface GenesisConfig {
  timestamp: number;
  difficultyTarget: string;
  /** Shorthand for a single allocation of `reward` to `genesisAddress`. */
  reward: bigint;
  genesisAddress: string;
  /** Explicit premine: one coinbase output per entry, in this order. Overrides the shorthand. */
  allocations?: GenesisAllocation[];
}

/** The outputs of the genesis coinbase: the chain's initial allocation. */
export function genesisAllocations(config: GenesisConfig): GenesisAllocation[] {
  const allocations = config.allocations ?? [{ address: config.genesisAddress, amount: config.reward }];
  if (allocations.length === 0) throw new Error("genesis allocation must have at least one output");
  for (const { address, amount } of allocations) {
    if (amount <= 0n) throw new Error(`genesis allocation to ${address}: amount must be positive, got ${amount}`);
  }
  return allocations;
}

export function genesisAllocationTotal(config: GenesisConfig): bigint {
  return genesisAllocations(config).reduce((sum, a) => sum + a.amount, 0n);
}

export function createGenesisBlock(config: GenesisConfig): Block {
  const coinbaseBody = {
    inputs: [],
    outputs: genesisAllocations(config).map(({ address, amount }) => ({ address, amount })),
    timestamp: config.timestamp,
    fee: 0n,
  };

  const coinbase: Transaction = {
    ...coinbaseBody,
    id: computeTransactionId(coinbaseBody),
  };

  const header: BlockHeader = {
    version: 1,
    previousHash: ZERO_HASH,
    merkleRoot: merkleRoot([coinbase.id]),
    timestamp: config.timestamp,
    difficultyTarget: config.difficultyTarget,
    nonce: 0,
    height: 0,
  };

  return {
    header,
    transactions: [coinbase],
    hash: computeBlockHash(header),
  };
}
