import type { Response } from "express";

/** Sends `value` as JSON, converting any bigint to a decimal string. */
export function sendJson(res: Response, value: unknown, status = 200): void {
  res
    .status(status)
    .type("application/json")
    .send(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
}
