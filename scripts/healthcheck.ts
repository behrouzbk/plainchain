/**
 * Container HEALTHCHECK: exit 0 if the node's /health says ok, 1 otherwise.
 * Configured by env so the same image works with and without TLS:
 *   L1_HEALTH_URL     (default http://127.0.0.1:<L1_RPC_PORT or 9001>/health)
 *   L1_RPC_TLS_CERT   when set, the URL is https and this cert is trusted
 */
import { probeHealth } from "../src/ops/healthProbe.js";

const port = process.env.L1_RPC_PORT ?? "9001";
const scheme = process.env.L1_RPC_TLS_CERT ? "https" : "http";
const url = process.env.L1_HEALTH_URL ?? `${scheme}://127.0.0.1:${port}/health`;

probeHealth(url, { caPath: process.env.L1_RPC_TLS_CERT }).then((result) => {
  console.log(`${result.ok ? "healthy" : "unhealthy"}: ${result.detail}`);
  process.exitCode = result.ok ? 0 : 1;
});
