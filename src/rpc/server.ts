import express, { type Express, type Request, type RequestHandler } from "express";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { packageVersion } from "../config/index.js";
import { AddressError, normalizeAddress } from "../ledger/address.js";
import { deserializeTransaction } from "../ledger/serialize.js";
import type { Node } from "../node/node.js";
import { extractBearerToken, tokensMatch } from "./auth.js";
import { sendJson } from "./json.js";
import { createJsonRpcDispatcher } from "./jsonRpc.js";
import { RateLimiter, type RateLimitConfig } from "./rateLimit.js";
import type { TlsCredentials } from "./tls.js";

export interface RpcServerOptions {
  /** Bearer token required by protected operations (currently: mining). */
  authToken: string;
  rateLimit: RateLimitConfig;
  /**
   * Number of reverse-proxy hops in front of this node whose
   * `X-Forwarded-For` entries are trusted (0 or unset = none). The rate
   * limiter then keys on the address the last trusted proxy appended,
   * never on entries a client could have put in front of it. Only enable
   * this when the node is reachable *only* through those proxies: a direct
   * client of a node that trusts one hop could pick its own bucket.
   */
  trustProxy?: number;
}

const MAX_BODY = "1mb";

export function createRpcServer(node: Node, options: RpcServerOptions): Express {
  const app = express();
  // Express resolves req.ip from X-Forwarded-For only for this many hops;
  // with 0 the header is ignored and req.ip is the socket peer.
  app.set("trust proxy", options.trustProxy && options.trustProxy > 0 ? options.trustProxy : false);
  const rpcCalls = node.metrics.counter("l1_rpc_calls_total", "JSON-RPC calls by method and outcome.", ["method", "outcome"]);
  const rateLimited = node.metrics.counter("l1_rpc_rate_limited_total", "HTTP requests refused with 429.");
  registerProcessMetrics(node);
  const dispatch = createJsonRpcDispatcher(node, { onCall: (method, outcome) => rpcCalls.inc({ method, outcome }) });
  const limiter = new RateLimiter(options.rateLimit);
  const isAuthenticated = (req: Request): boolean =>
    tokensMatch(options.authToken, extractBearerToken(req.header("authorization")));

  // Liveness probe: registered before the rate limiter so an orchestrator's
  // health checks never flap under client load. Constant-size and cheap.
  app.get("/health", async (_req, res) => {
    const stats = await node.getStats();
    sendJson(res, { status: "ok", ...stats });
  });

  /** Charges `weight` requests to the client; responds 429 if over budget. */
  const charge = (req: Request, res: express.Response, weight: number): boolean => {
    const decision = limiter.consume(req.ip ?? "unknown", weight);
    if (decision.allowed) return true;
    rateLimited.inc();
    res
      .status(429)
      .set("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)))
      .json({ error: "rate limit exceeded" });
    return false;
  };

  const rateLimit: RequestHandler = (req, res, next) => {
    if (charge(req, res, 1)) next();
  };

  const requireAuth: RequestHandler = (req, res, next) => {
    if (!isAuthenticated(req)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized: bearer token required" });
      return;
    }
    next();
  };

  // JSON-RPC 2.0 -- the standardized wallet-facing interface. Body is read
  // as text so a parse failure can be answered with a spec-compliant
  // -32700 rather than express's default 400 page. A batch is charged one
  // request per call so batching can't sidestep the rate limit.
  app.post("/rpc", express.text({ type: "*/*", limit: MAX_BODY }), async (req, res) => {
    const rawBody = typeof req.body === "string" ? req.body : "";
    if (!charge(req, res, batchWeight(rawBody))) return;

    const response = await dispatch(rawBody, { authenticated: isAuthenticated(req) });
    if (response === undefined) {
      res.status(204).end(); // notification(s) only: no response body, per spec
      return;
    }
    sendJson(res, response);
  });

  app.use(rateLimit);

  // Prometheus scrape target (text exposition format 0.0.4).
  app.get("/metrics", (_req, res) => {
    res.status(200).set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(node.metrics.render());
  });

  /** Address path params accept the checksummed or raw form; anything else is a 400. */
  const addressParam = (req: Request, res: express.Response): string | undefined => {
    try {
      return normalizeAddress(req.params.address!);
    } catch (err) {
      if (!(err instanceof AddressError)) throw err;
      res.status(400).json({ error: `address: ${err.message}` });
      return undefined;
    }
  };

  app.get("/utxos/:address", async (req, res) => {
    const address = addressParam(req, res);
    if (address !== undefined) sendJson(res, await node.listUnspent(address));
  });

  app.get("/chain/tip", async (_req, res) => {
    const tip = await node.getTip();
    sendJson(res, tip ?? null);
  });

  app.get("/mempool", (_req, res) => {
    sendJson(res, node.getMempoolTransactions());
  });

  // Registered before /block/:height so a literal "hash" segment can't be
  // swallowed as a :height param.
  app.get("/block/hash/:hash", async (req, res) => {
    const block = await node.getBlockByHash(req.params.hash);
    if (!block) {
      res.status(404).json({ error: "block not found" });
      return;
    }
    sendJson(res, block);
  });

  app.get("/block/height/:height", async (req, res) => {
    const height = Number(req.params.height);
    const block = await node.getBlockByHeight(height);
    if (!block) {
      res.status(404).json({ error: "block not found" });
      return;
    }
    sendJson(res, block);
  });

  app.get("/balance/:address", async (req, res) => {
    const address = addressParam(req, res);
    if (address !== undefined) sendJson(res, { address, balance: await node.getBalance(address) });
  });

  app.post("/mine", requireAuth, async (_req, res) => {
    try {
      const block = await node.mineBlock();
      sendJson(res, { hash: block.hash, height: block.header.height, transactionCount: block.transactions.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/tx", express.text({ type: "*/*", limit: MAX_BODY }), async (req, res) => {
    try {
      const tx = deserializeTransaction(req.body as string);
      const result = await node.submitTransaction(tx);
      if (!result.valid) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.status(200).json({ txId: tx.id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

export interface RpcListenOptions {
  port: number;
  bind: string;
  /** Serve HTTPS with these credentials; plain HTTP when omitted. */
  tls?: TlsCredentials;
}

export interface RpcListener {
  server: HttpServer | HttpsServer;
  /** Base URL clients should use, e.g. `https://127.0.0.1:9001`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Binds the RPC app, over TLS when credentials are given. The exposure
 * policy (cleartext only on loopback) is the caller's to check first --
 * see `checkRpcExposure` -- so tests can bind wherever they like.
 */
export function listenRpc(app: Express, options: RpcListenOptions): Promise<RpcListener> {
  const server = options.tls ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, app) : createHttpServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bind, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const host = options.bind.includes(":") ? `[${options.bind}]` : options.bind;
      resolve({
        server,
        port,
        url: `${options.tls ? "https" : "http"}://${host}:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            // Don't wait for idle keep-alive sockets on shutdown.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** Process-level gauges and the build-info marker every Prometheus setup expects. */
function registerProcessMetrics(node: Node): void {
  const m = node.metrics;
  m.gauge("process_uptime_seconds", "Seconds since the node process started.", [], () => Math.floor(process.uptime()));
  m.gauge("process_resident_memory_bytes", "Resident set size.", [], () => process.memoryUsage().rss);
  m.gauge("nodejs_heap_used_bytes", "V8 heap in use.", [], () => process.memoryUsage().heapUsed);
  m.gauge("nodejs_event_loop_lag_seconds", "Delay of a zero-delay timer, sampled at scrape time.", [], () => lastEventLoopLagSeconds);
  m.gauge("l1_build_info", "Always 1; labels carry the node's version and identity.", ["network_id", "node_id", "version"]).set(1, {
    network_id: node.networkId,
    node_id: node.nodeId,
    version: packageVersion(),
  });
  if (!lagSamplerStarted) {
    lagSamplerStarted = true;
    scheduleLagSample();
  }
}

const LAG_SAMPLE_INTERVAL_MS = 1000;
let lagSamplerStarted = false;
let lastEventLoopLagSeconds = 0;
/** How late a timer fires is how blocked the event loop was (e.g. by mining). Re-arms itself; `unref` so it never keeps the process alive. */
function scheduleLagSample(): void {
  const start = process.hrtime.bigint();
  setTimeout(() => {
    lastEventLoopLagSeconds = Math.max(0, Number(process.hrtime.bigint() - start) / 1e9 - LAG_SAMPLE_INTERVAL_MS / 1000);
    scheduleLagSample();
  }, LAG_SAMPLE_INTERVAL_MS).unref();
}

/** Number of JSON-RPC calls in a body: batch length, or 1 (unparseable counts as 1). */
function batchWeight(rawBody: string): number {
  if (!rawBody.trimStart().startsWith("[")) return 1;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return Array.isArray(parsed) ? Math.max(1, parsed.length) : 1;
  } catch {
    return 1;
  }
}
