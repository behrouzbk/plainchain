import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * One GET against a node's /health, for container HEALTHCHECKs and
 * orchestrator probes. Kept free of other src/ dependencies so the
 * compiled script is tiny and starts fast (it runs every few seconds).
 */
export interface ProbeOptions {
  /** PEM certificate to trust for an https:// URL (a self-signed node cert). */
  caPath?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export function probeHealth(url: string, options: ProbeOptions): Promise<ProbeResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, detail: `invalid URL: ${url}` });
  }
  let ca: string | undefined;
  if (options.caPath) {
    try {
      ca = readFileSync(options.caPath, "utf8");
    } catch (err) {
      return Promise.resolve({ ok: false, detail: `cannot read CA ${options.caPath}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const req = request(target, { method: "GET", timeout: options.timeoutMs ?? 3000, ...(ca ? { ca } : {}) }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, detail: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const parsed = JSON.parse(body) as { status?: unknown; nodeId?: unknown; height?: unknown; peers?: unknown };
          resolve(
            parsed.status === "ok"
              ? { ok: true, detail: `${String(parsed.nodeId)} height=${String(parsed.height)} peers=${String(parsed.peers)}` }
              : { ok: false, detail: `status ${String(parsed.status)}` },
          );
        } catch {
          resolve({ ok: false, detail: "non-JSON body" });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ ok: false, detail: err.message }));
    req.end();
  });
}
