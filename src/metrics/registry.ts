/**
 * A small Prometheus-style metrics registry: counters and gauges with
 * labels, rendered in the text exposition format (version 0.0.4). No
 * dependencies, so any layer can hold a registry; `rpc/` serves it at
 * `/metrics`.
 *
 * Label values are escaped on render, but callers must still keep label
 * *cardinality* bounded -- never use a peer- or client-supplied string as
 * a label value without mapping it onto a fixed set first.
 */

export type Labels = Record<string, string>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

/** Canonical key for a label set: values in declared label order. */
function labelKey(labelNames: readonly string[], labels: Labels, metric: string): string {
  const given = Object.keys(labels);
  if (given.length !== labelNames.length || given.some((name) => !labelNames.includes(name))) {
    throw new Error(`metric ${metric} expects labels [${labelNames.join(", ")}], got [${given.join(", ")}]`);
  }
  return labelNames.map((name) => `${name}="${escapeLabelValue(labels[name]!)}"`).join(",");
}

abstract class Metric {
  protected readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    readonly type: "counter" | "gauge",
  ) {}

  protected key(labels: Labels): string {
    return labelKey(this.labelNames, labels, this.name);
  }

  /** Sample lines, sorted by label set for stable output. An unlabelled
   *  metric that was never touched renders as 0 so dashboards see it. */
  render(): string[] {
    if (this.values.size === 0 && this.labelNames.length === 0) return [`${this.name} 0`];
    return [...this.values.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${this.name}${key ? `{${key}}` : ""} ${formatValue(value)}`);
  }
}

export class Counter extends Metric {
  /** `inc()`, `inc(by)`, `inc(labels)`, `inc(by, labels)` or `inc(labels, by)`. */
  inc(a?: number | Labels, b?: number | Labels): void {
    const by = typeof a === "number" ? a : typeof b === "number" ? b : 1;
    const labels = typeof a === "object" ? a : typeof b === "object" ? b : {};
    if (by < 0) throw new Error(`counter ${this.name} cannot be incremented by a negative amount`);
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
}

export class Gauge extends Metric {
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    /**
     * Called at render time. Returning a number sets the unlabelled value;
     * a labelled gauge instead calls `set` on the gauge it is handed.
     */
    private readonly collect?: (gauge: Gauge) => number | bigint | void,
  ) {
    super(name, help, labelNames, "gauge");
  }

  set(value: number | bigint, labels: Labels = {}): void {
    this.values.set(this.key(labels), Number(value));
  }

  override render(): string[] {
    if (this.collect) {
      const value = this.collect(this);
      if (value !== undefined) this.values.set("", Number(value));
    }
    return super.render();
  }
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.register(new Counter(name, help, labelNames, "counter"));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = [], collect?: (gauge: Gauge) => number | bigint | void): Gauge {
    return this.register(new Gauge(name, help, labelNames, collect));
  }

  private register<T extends Metric>(metric: T): T {
    if (!METRIC_NAME.test(metric.name)) throw new Error(`invalid metric name "${metric.name}"`);
    for (const label of metric.labelNames) {
      if (!LABEL_NAME.test(label) || label.startsWith("__")) throw new Error(`invalid label name "${label}" on ${metric.name}`);
    }
    if (this.metrics.some((m) => m.name === metric.name)) throw new Error(`metric ${metric.name} already registered`);
    this.metrics.push(metric);
    return metric;
  }

  /** Prometheus text exposition format 0.0.4, in registration order. */
  render(): string {
    const lines: string[] = [];
    for (const metric of this.metrics) {
      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`, `# TYPE ${metric.name} ${metric.type}`, ...metric.render());
    }
    return lines.join("\n") + "\n";
  }
}
