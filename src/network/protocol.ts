import type { Block, BlockHeader, Transaction } from "../ledger/types.js";
import { checkPayload } from "./wireShapes.js";

export interface HandshakePayload {
  version: number;
  nodeId: string;
  height: number;
  /** This node's own reachable P2P URL (e.g. "ws://localhost:8001"), used
   *  for peer discovery. Omitted if the node doesn't know its own address
   *  yet (e.g. connecting out before its own server has bound a port). */
  listenAddress?: string;
  /** Chain identity, so nodes on different networks / genesis configs
   *  reject each other at handshake instead of silently never syncing. */
  networkId?: string;
  genesisHash?: string;
  /** Fingerprint of the consensus + emission rules (consensus/monetary.ts#rulesHash). */
  rulesHash?: string;
}

export interface GetBlocksPayload {
  /** Legacy/fallback: send canonical blocks strictly above this height. */
  fromHeight: number;
  /**
   * Block locator: the requester's canonical hashes, tip-first, dense near
   * the tip then exponentially sparser, ending at genesis. The responder
   * starts from the highest hash it shares, which makes sync correct across
   * forks (a bare fromHeight silently assumes both chains agree below it).
   */
  locator?: string[];
}

export interface GetHeadersPayload {
  /** Same block locator as GET_BLOCKS; the responder replies with the
   *  headers above the highest hash it shares, up to its cap. */
  locator: string[];
}

export interface HeadersPayload {
  /** Consecutive canonical headers, lowest first. Hashes are recomputed by
   *  the receiver (never trusted from the wire). */
  headers: BlockHeader[];
}

export interface InvBlocksPayload {
  hashes: string[];
}

export interface NewBlockPayload {
  block: Block;
}

export interface NewTxPayload {
  transaction: Transaction;
}

export type GetPeersPayload = Record<string, never>;

export interface PeersPayload {
  addresses: string[];
}

export type Message =
  | { type: "HANDSHAKE"; payload: HandshakePayload }
  | { type: "GET_BLOCKS"; payload: GetBlocksPayload }
  | { type: "GET_HEADERS"; payload: GetHeadersPayload }
  | { type: "HEADERS"; payload: HeadersPayload }
  | { type: "INV_BLOCKS"; payload: InvBlocksPayload }
  | { type: "NEW_BLOCK"; payload: NewBlockPayload }
  | { type: "NEW_TX"; payload: NewTxPayload }
  | { type: "GET_PEERS"; payload: GetPeersPayload }
  | { type: "PEERS"; payload: PeersPayload };

const BIGINT_MARKER = "__bigint__";

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_MARKER]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    BIGINT_MARKER in (value as Record<string, unknown>)
  ) {
    const encoded = (value as Record<string, unknown>)[BIGINT_MARKER];
    return BigInt(encoded as string);
  }
  return value;
}

export function encodeMessage(message: Message): string {
  return JSON.stringify(message, replacer);
}

const MESSAGE_TYPES: ReadonlySet<string> = new Set<Message["type"]>([
  "HANDSHAKE",
  "GET_BLOCKS",
  "GET_HEADERS",
  "HEADERS",
  "INV_BLOCKS",
  "NEW_BLOCK",
  "NEW_TX",
  "GET_PEERS",
  "PEERS",
]);

/** Throws if `raw` isn't a well-formed message envelope of a known type. */
export function decodeMessage(raw: string): Message {
  const parsed: unknown = JSON.parse(raw, reviver);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { type?: unknown }).type !== "string" ||
    !MESSAGE_TYPES.has((parsed as { type: string }).type) ||
    typeof (parsed as { payload?: unknown }).payload !== "object" ||
    (parsed as { payload?: unknown }).payload === null
  ) {
    throw new Error("malformed message envelope");
  }
  // Field-level shapes (types, hex lengths, a block hash that matches its
  // header) are checked here too, so handlers never see a wrong type; the
  // payload is rebuilt canonically (network/wireShapes.ts).
  const { type, payload } = parsed as { type: string; payload: Record<string, unknown> };
  return { type, payload: checkPayload(type, payload) } as Message;
}
