export interface TxOutput {
  address: string;
  amount: bigint;
}

export interface TxOutpoint {
  txId: string;
  outputIndex: number;
}

export interface TxInput extends TxOutpoint {
  signature: string;
  publicKey: string;
}

export interface Transaction {
  id: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  timestamp: number;
  fee: bigint;
  /**
   * Record anchored on chain (lowercase hex, 1..MAX_TX_DATA_BYTES bytes),
   * typically the sha256 of a document. Signed and part of the id; absent
   * on ordinary payments, which then hash exactly as they always did.
   */
  data?: string;
}

export type UnsignedTransactionBody = Omit<Transaction, "id">;

export interface BlockHeader {
  version: number;
  previousHash: string;
  merkleRoot: string;
  timestamp: number;
  difficultyTarget: string;
  nonce: number;
  height: number;
  /**
   * Proof-of-authority seal (consensus/engine.ts). The signer's public key
   * is part of the block hash; the signature is over that hash and so
   * cannot be. Absent on proof-of-work headers and on genesis.
   */
  signer?: string;
  signature?: string;
}

export interface Block {
  header: BlockHeader;
  transactions: Transaction[];
  hash: string;
}
