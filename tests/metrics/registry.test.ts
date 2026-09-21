import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../../src/metrics/registry.js";

describe("MetricsRegistry", () => {
  it("renders counters and gauges in Prometheus text exposition format", () => {
    const registry = new MetricsRegistry();
    const blocks = registry.counter("l1_blocks_adopted_total", "Blocks adopted onto the canonical chain.");
    const height = registry.gauge("l1_chain_height", "Height of the canonical tip.");
    blocks.inc();
    blocks.inc(2);
    height.set(41);

    expect(registry.render()).toBe(
      [
        "# HELP l1_blocks_adopted_total Blocks adopted onto the canonical chain.",
        "# TYPE l1_blocks_adopted_total counter",
        "l1_blocks_adopted_total 3",
        "# HELP l1_chain_height Height of the canonical tip.",
        "# TYPE l1_chain_height gauge",
        "l1_chain_height 41",
        "",
      ].join("\n"),
    );
  });

  it("renders one sample per label set, with values sorted for stable output", () => {
    const registry = new MetricsRegistry();
    const peers = registry.gauge("l1_peers", "Connected peers.", ["direction"]);
    peers.set(3, { direction: "outbound" });
    peers.set(5, { direction: "inbound" });
    const msgs = registry.counter("l1_msgs_total", "Messages.", ["direction", "type"]);
    msgs.inc({ direction: "in", type: "NEW_BLOCK" });
    msgs.inc({ direction: "in", type: "HANDSHAKE" });
    msgs.inc({ direction: "in", type: "NEW_BLOCK" });

    const text = registry.render();
    expect(text).toContain('l1_peers{direction="inbound"} 5\nl1_peers{direction="outbound"} 3\n');
    expect(text).toContain('l1_msgs_total{direction="in",type="HANDSHAKE"} 1\nl1_msgs_total{direction="in",type="NEW_BLOCK"} 2\n');
  });

  it("a gauge can be collected lazily at render time", () => {
    const registry = new MetricsRegistry();
    let size = 0;
    registry.gauge("l1_mempool_transactions", "Mempool size.", [], () => size);
    size = 7;
    expect(registry.render()).toContain("l1_mempool_transactions 7\n");
    size = 9;
    expect(registry.render()).toContain("l1_mempool_transactions 9\n");
  });

  it("attack: label values are escaped so an untrusted string cannot forge or break samples", () => {
    const registry = new MetricsRegistry();
    const c = registry.counter("l1_x_total", "x", ["who"]);
    c.inc({ who: 'evil"} 999\nl1_forged_total 1\\' });
    const text = registry.render();
    expect(text).toContain('l1_x_total{who="evil\\"} 999\\nl1_forged_total 1\\\\"} 1\n');
    expect(text.split("\n").filter((l) => l.startsWith("l1_forged_total"))).toEqual([]);
  });

  it("escapes HELP text and rejects invalid metric or label names", () => {
    const registry = new MetricsRegistry();
    registry.gauge("l1_help", "line one\nline two \\ done", []);
    expect(registry.render()).toContain("# HELP l1_help line one\\nline two \\\\ done\n");
    expect(() => registry.counter("bad-name", "x")).toThrow(/metric name/);
    expect(() => registry.counter("l1_ok", "x", ["bad-label"])).toThrow(/label name/);
    expect(() => registry.counter("l1_ok", "x", ["__reserved"])).toThrow(/label name/);
  });

  it("refuses to register the same name twice and refuses missing or extra labels", () => {
    const registry = new MetricsRegistry();
    const c = registry.counter("l1_dup_total", "x", ["a"]);
    expect(() => registry.gauge("l1_dup_total", "y")).toThrow(/already registered/);
    expect(() => c.inc({})).toThrow(/label/);
    expect(() => c.inc({ a: "1", b: "2" })).toThrow(/label/);
    expect(() => c.inc(-1, { a: "1" })).toThrow(/negative/);
  });

  it("formats bigint and non-finite values sanely", () => {
    const registry = new MetricsRegistry();
    const g = registry.gauge("l1_big", "x");
    g.set(123456789012345678901234567890n);
    expect(registry.render()).toContain("l1_big 1.2345678901234568e+29\n");
    g.set(Number.POSITIVE_INFINITY);
    expect(registry.render()).toContain("l1_big +Inf\n");
    g.set(Number.NaN);
    expect(registry.render()).toContain("l1_big NaN\n");
  });
});
