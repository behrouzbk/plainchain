import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedRpcToken {
  token: string;
  source: "explicit" | "cookie";
  cookiePath?: string;
}

/**
 * Resolves the RPC bearer token. An explicit token wins; otherwise a random
 * one is generated once and persisted as `<dataDir>/rpc-token` (owner-only
 * permissions where the platform supports them), Bitcoin-Core cookie style,
 * so local tooling can pick it up without any config step and auth is on
 * by default.
 */
export function resolveRpcToken(options: { explicitToken?: string; dataDir: string }): ResolvedRpcToken {
  if (options.explicitToken !== undefined) {
    if (options.explicitToken.length === 0) {
      throw new Error("RPC token must not be empty (omit it to use a generated cookie instead)");
    }
    return { token: options.explicitToken, source: "explicit" };
  }

  const cookiePath = join(options.dataDir, "rpc-token");
  if (existsSync(cookiePath)) {
    const existing = readFileSync(cookiePath, "utf8").trim();
    if (existing.length > 0) {
      return { token: existing, source: "cookie", cookiePath };
    }
  }

  mkdirSync(options.dataDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(cookiePath, `${token}\n`, { mode: 0o600 });
  return { token, source: "cookie", cookiePath };
}

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return match?.[1];
}

/** Constant-time comparison so token guessing can't be timed. */
export function tokensMatch(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
