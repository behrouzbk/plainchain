import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/** Error returned by the node in a JSON-RPC error response. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** The node couldn't be reached or didn't speak JSON-RPC. */
export class RpcTransportError extends Error {}

export interface JsonRpcClientOptions {
  /** Bearer token for protected methods. */
  token?: string;
  /**
   * PEM certificate(s) to trust for an `https:` URL, in place of the system
   * store -- how a wallet pins a node's self-signed certificate. Hostname
   * verification still applies.
   */
  ca?: string;
}

/** TLS verification failures that `--ca` (or a correct URL) would fix. */
const TLS_TRUST_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Minimal JSON-RPC 2.0 client over http(s). Uses `node:http(s)` rather than
 * `fetch` because the latter has no way to pin a CA. Amounts arrive as
 * decimal strings (the server's bigint encoding); callers convert what they
 * need.
 */
export class JsonRpcClient {
  private nextId = 1;
  private readonly options: JsonRpcClientOptions;

  constructor(
    private readonly url: string,
    options: JsonRpcClientOptions = {},
  ) {
    this.options = options;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const { status, text } = await this.post(payload);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcTransportError(`node at ${this.url} returned a non-JSON response (HTTP ${status})`);
    }
    if (typeof body !== "object" || body === null || (body as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      throw new RpcTransportError(`node at ${this.url} returned a non-JSON-RPC response (HTTP ${status})`);
    }
    const { error, result } = body as { error?: { code: number; message: string; data?: unknown }; result?: T };
    if (error) throw new RpcError(error.code, error.message, error.data);
    return result as T;
  }

  private post(payload: string): Promise<{ status: number; text: string }> {
    let target: URL;
    try {
      target = new URL("rpc", this.url.endsWith("/") ? this.url : `${this.url}/`);
    } catch {
      throw new RpcTransportError(`invalid node URL: ${this.url}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new RpcTransportError(`node URL must be http:// or https://, got ${this.url}`);
    }
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const req = request(
        target,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
          },
          ...(this.options.ca ? { ca: this.options.ca } : {}),
        },
        (res: IncomingMessage) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
          res.on("error", (err) => reject(this.transportError(err)));
        },
      );
      req.on("error", (err) => reject(this.transportError(err)));
      req.end(payload);
    });
  }

  private transportError(err: unknown): RpcTransportError {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      code && TLS_TRUST_ERRORS.has(code)
        ? " (the node's TLS certificate is not trusted: pass --ca <node-cert.pem> or $L1_RPC_CA, and check the URL's hostname)"
        : "";
    return new RpcTransportError(`could not reach node at ${this.url}: ${message}${hint}`);
  }
}
