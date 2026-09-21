import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel } from "../../src/node/logger.js";

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("createLogger", () => {
  it("text format: one line per event with timestamp, level, node id and fields", () => {
    const out = capture();
    const log = createLogger({ format: "text", level: "info", nodeId: "n1", write: out.write, now: () => new Date("2026-09-20T12:00:00.000Z") });
    log.info("block adopted", { height: 12, hash: "abc" });
    log.warn("rejected block");
    expect(out.lines).toEqual([
      "2026-09-20T12:00:00.000Z INFO  [n1] block adopted height=12 hash=abc",
      "2026-09-20T12:00:00.000Z WARN  [n1] rejected block",
    ]);
  });

  it("json format: one JSON object per line, fields merged, fixed keys first", () => {
    const out = capture();
    const log = createLogger({ format: "json", level: "info", nodeId: "n1", write: out.write, now: () => new Date("2026-09-20T12:00:00.000Z") });
    log.info("peer connected", { peer: "n2", height: 3 });
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0]!)).toEqual({
      ts: "2026-09-20T12:00:00.000Z",
      level: "info",
      node: "n1",
      msg: "peer connected",
      peer: "n2",
      height: 3,
    });
    expect(out.lines[0]!.startsWith('{"ts":"2026-09-20T12:00:00.000Z","level":"info","node":"n1","msg":"peer connected"')).toBe(true);
  });

  it("json format: bigints and errors are serialized, and a field cannot overwrite the fixed keys", () => {
    const out = capture();
    const log = createLogger({ format: "json", level: "debug", nodeId: "n1", write: out.write });
    log.warn("tx rejected", { fee: 12n, err: new Error("boom"), level: "spoofed", msg: "spoofed" });
    const parsed = JSON.parse(out.lines[0]!) as Record<string, unknown>;
    expect(parsed.fee).toBe("12");
    expect(parsed.err).toBe("boom");
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("tx rejected");
  });

  it("text format: field values with spaces or quotes are quoted, newlines escaped", () => {
    const out = capture();
    const log = createLogger({ format: "text", level: "info", nodeId: "n1", write: out.write, now: () => new Date(0) });
    log.info("x", { reason: 'peer said "no"\nreally', n: 1n });
    expect(out.lines[0]).toBe('1970-01-01T00:00:00.000Z INFO  [n1] x reason="peer said \\"no\\"\\nreally" n=1');
  });

  it("filters by level", () => {
    const out = capture();
    const log = createLogger({ format: "text", level: "warn", nodeId: "n1", write: out.write });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(out.lines.map((l) => l.split(" ")[1])).toEqual(["WARN", "ERROR"]);
  });

  it("child loggers carry bound fields", () => {
    const out = capture();
    const log = createLogger({ format: "json", level: "info", nodeId: "n1", write: out.write });
    log.child({ peer: "n2" }).info("hello", { height: 1 });
    expect(JSON.parse(out.lines[0]!)).toMatchObject({ peer: "n2", height: 1, msg: "hello" });
  });

  it("parseLogLevel accepts the four levels and rejects anything else", () => {
    expect(parseLogLevel("info")).toBe("info");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(() => parseLogLevel("verbose")).toThrow(/log level/);
  });
});
