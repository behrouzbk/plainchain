import { AddressError, normalizeAddress } from "../ledger/address.js";
import { parseWireTransaction } from "../ledger/serialize.js";
import { MAX_TX_DATA_BYTES } from "../ledger/transaction.js";
import { AddressIndexDisabledError, type Node } from "../node/node.js";

/** JSON-RPC 2.0 reserved codes plus this node's application range. */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Application: transaction rejected by mempool/consensus rules. */
  TRANSACTION_REJECTED: -32000,
  /** Application: requested block/resource doesn't exist. */
  NOT_FOUND: -32001,
  /** Application: method requires a bearer token that was missing or wrong. */
  UNAUTHORIZED: -32004,
  /** Application: this node is not configured to serve the request (e.g. no address index). */
  NOT_AVAILABLE: -32005,
} as const;

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Cap on one getHeaders reply; light clients page through the chain. */
const MAX_HEADERS_PER_CALL = 2000;

type Params = Record<string, unknown>;
type Handler = (params: Params) => Promise<unknown>;

export interface JsonRpcContext {
  /** Whether the caller presented a valid RPC bearer token. */
  authenticated: boolean;
}

/**
 * Normalizes JSON-RPC `params` (positional array, named object, or absent)
 * into a named record using the method's declared parameter order.
 */
function namedParams(raw: unknown, names: string[]): Params {
  if (raw === undefined) return {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(names.map((name, i) => [name, raw[i]]));
  }
  if (typeof raw === "object" && raw !== null) return raw as Params;
  throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, "params must be an array or object");
}

function requireString(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, `${name} must be a non-empty string`);
  }
  return value;
}

function requireInteger(params: Params, name: string): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, `${name} must be a non-negative integer`);
  }
  return value;
}

/** Wallet-facing method table. Param names double as the positional order. */
function buildMethods(node: Node): Record<string, { params: string[]; handler: Handler; requiresAuth?: true }> {
  return {
    getTip: {
      params: [],
      handler: async () => (await node.getTip()) ?? null,
    },
    getInfo: {
      params: [],
      handler: async () => node.getInfo(),
    },
    getBlockByHeight: {
      params: ["height"],
      handler: async (p) => {
        const block = await node.getBlockByHeight(requireInteger(p, "height"));
        if (!block) throw new JsonRpcError(RpcErrorCode.NOT_FOUND, "block not found");
        return block;
      },
    },
    getBlockByHash: {
      params: ["hash"],
      handler: async (p) => {
        const block = await node.getBlockByHash(requireString(p, "hash"));
        if (!block) throw new JsonRpcError(RpcErrorCode.NOT_FOUND, "block not found");
        return block;
      },
    },
    getBalance: {
      params: ["address"],
      handler: async (p) => {
        const address = requireAddress(p, "address");
        return { address, balance: await node.getBalance(address) };
      },
    },
    listUnspent: {
      params: ["address"],
      handler: async (p) => node.listUnspent(requireAddress(p, "address")),
    },
    listTransactions: {
      params: ["address", "limit"],
      handler: async (p) => {
        const limit = p.limit === undefined ? 50 : p.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, "limit must be an integer between 1 and 1000");
        }
        try {
          return await node.getAddressHistory(requireAddress(p, "address"), limit);
        } catch (err) {
          if (err instanceof AddressIndexDisabledError) throw new JsonRpcError(RpcErrorCode.NOT_AVAILABLE, err.message);
          throw err;
        }
      },
    },
    getHeaders: {
      params: ["fromHeight", "count"],
      handler: async (p) => {
        const fromHeight = requireInteger(p, "fromHeight");
        const count = requireInteger(p, "count");
        if (count < 1) throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, "count must be at least 1");
        return node.getHeaders(fromHeight, Math.min(count, MAX_HEADERS_PER_CALL));
      },
    },
    getMerkleProof: {
      params: ["txId"],
      handler: async (p) => {
        const proof = await node.getTransactionProof(requireString(p, "txId"));
        if (!proof) throw new JsonRpcError(RpcErrorCode.NOT_FOUND, "transaction not found in the canonical chain (unknown, not confirmed, or in an abandoned fork)");
        return proof;
      },
    },
    getAnchors: {
      params: ["data", "limit"],
      handler: async (p) => {
        const data = requireString(p, "data").toLowerCase();
        if (!/^([0-9a-f]{2})+$/.test(data) || data.length / 2 > MAX_TX_DATA_BYTES) {
          throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, `data must be hex, 1 to ${MAX_TX_DATA_BYTES} bytes (e.g. the sha256 of a document)`);
        }
        const limit = p.limit === undefined ? 100 : p.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, "limit must be an integer between 1 and 1000");
        }
        return node.getAnchors(data, limit);
      },
    },
    getSupply: {
      params: [],
      handler: async () => {
        const s = await node.getSupply();
        return { ...s, maxSupply: s.maxSupply ?? null, nextHalvingHeight: s.nextHalvingHeight ?? null };
      },
    },
    getMempool: {
      params: [],
      handler: async () => node.getMempoolTransactions(),
    },
    sendRawTransaction: {
      params: ["transaction"],
      handler: async (p) => {
        let tx;
        try {
          tx = parseWireTransaction(p.transaction);
        } catch (err) {
          throw new JsonRpcError(
            RpcErrorCode.INVALID_PARAMS,
            `invalid transaction: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const result = await node.submitTransaction(tx);
        if (!result.valid) {
          throw new JsonRpcError(RpcErrorCode.TRANSACTION_REJECTED, result.reason ?? "transaction rejected");
        }
        return { txId: tx.id };
      },
    },
    mine: {
      params: [],
      requiresAuth: true,
      handler: async () => {
        const block = await node.mineBlock();
        return { hash: block.hash, height: block.header.height, transactionCount: block.transactions.length };
      },
    },
  };
}

/** An address param in either the checksummed or the raw form, as raw hex. */
function requireAddress(params: Params, name: string): string {
  try {
    return normalizeAddress(requireString(params, name));
  } catch (err) {
    if (err instanceof AddressError) throw new JsonRpcError(RpcErrorCode.INVALID_PARAMS, `${name}: ${err.message}`);
    throw err;
  }
}

function isValidId(id: unknown): id is JsonRpcId {
  return typeof id === "string" || typeof id === "number" || id === null;
}

export type JsonRpcOutcome = "ok" | "error" | "unauthorized" | "not_found" | "invalid";

export interface JsonRpcDispatcherHooks {
  /**
   * Called once per call (each batch entry separately). `method` is a
   * registered method name or "unknown" -- never the raw client string,
   * so it is safe to use as a metric label.
   */
  onCall?(method: string, outcome: JsonRpcOutcome): void;
}

export function createJsonRpcDispatcher(
  node: Node,
  hooks: JsonRpcDispatcherHooks = {},
): (rawBody: string, ctx: JsonRpcContext) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  const methods = buildMethods(node);
  const record = (method: string, outcome: JsonRpcOutcome): void => hooks.onCall?.(method in methods ? method : "unknown", outcome);

  const errorResponse = (id: JsonRpcId, err: unknown): JsonRpcResponse => {
    if (err instanceof JsonRpcError) {
      return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: RpcErrorCode.INTERNAL_ERROR, message: err instanceof Error ? err.message : "internal error" },
    };
  };

  /** Returns undefined for a notification (no id), per spec. */
  const handleOne = async (request: unknown, ctx: JsonRpcContext): Promise<JsonRpcResponse | undefined> => {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      record("unknown", "invalid");
      return errorResponse(null, new JsonRpcError(RpcErrorCode.INVALID_REQUEST, "request must be an object"));
    }
    const { jsonrpc, method, params, id } = request as Record<string, unknown>;
    const isNotification = !("id" in (request as object));
    const responseId: JsonRpcId = isValidId(id) ? id : null;

    if (jsonrpc !== "2.0" || typeof method !== "string") {
      record("unknown", "invalid");
      return errorResponse(responseId, new JsonRpcError(RpcErrorCode.INVALID_REQUEST, "expected jsonrpc \"2.0\" and a string method"));
    }

    const entry = methods[method];
    if (!entry) {
      record(method, "not_found");
      return isNotification
        ? undefined
        : errorResponse(responseId, new JsonRpcError(RpcErrorCode.METHOD_NOT_FOUND, `method not found: ${method}`));
    }

    if (entry.requiresAuth && !ctx.authenticated) {
      record(method, "unauthorized");
      return isNotification
        ? undefined
        : errorResponse(
            responseId,
            new JsonRpcError(RpcErrorCode.UNAUTHORIZED, `unauthorized: ${method} requires a bearer token`),
          );
    }

    try {
      const result = await entry.handler(namedParams(params, entry.params));
      record(method, "ok");
      return isNotification ? undefined : { jsonrpc: "2.0", id: responseId, result };
    } catch (err) {
      record(method, "error");
      return isNotification ? undefined : errorResponse(responseId, err);
    }
  };

  return async (rawBody, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      record("unknown", "invalid");
      return errorResponse(null, new JsonRpcError(RpcErrorCode.PARSE_ERROR, "parse error: invalid JSON"));
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        record("unknown", "invalid");
        return errorResponse(null, new JsonRpcError(RpcErrorCode.INVALID_REQUEST, "empty batch"));
      }
      const responses = await Promise.all(parsed.map((r) => handleOne(r, ctx)));
      const nonNotifications = responses.filter((r): r is JsonRpcResponse => r !== undefined);
      return nonNotifications.length > 0 ? nonNotifications : undefined;
    }

    return handleOne(parsed, ctx);
  };
}
