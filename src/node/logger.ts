/**
 * Process logger for the node. Two output formats: human-readable text
 * (the default when a person is watching a terminal) and JSON lines (one
 * object per line, for log shippers and `jq`). Fields are structured in
 * both, so the same call site serves both formats.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every event. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  format: LogFormat;
  level: LogLevel;
  nodeId: string;
  /** Sink for one complete line (without trailing newline). Defaults to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVELS = Object.keys(LEVEL_RANK) as LogLevel[];

export function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return "info";
  const level = raw.toLowerCase();
  if (!LEVELS.includes(level as LogLevel)) throw new Error(`unknown log level "${raw}" (expected one of ${LEVELS.join(", ")})`);
  return level as LogLevel;
}

export function parseLogFormat(raw: string | undefined): LogFormat {
  if (raw === undefined) return "text";
  if (raw !== "text" && raw !== "json") throw new Error(`unknown log format "${raw}" (expected text or json)`);
  return raw;
}

/** JSON can't carry bigints or Errors; render them as strings. */
function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return value.message;
  return value;
}

function textValue(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : String(jsonValue(value));
  return /[\s"\\]/.test(raw) ? `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"` : raw;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_RANK[options.level];

  const emit = (level: LogLevel, message: string, fields: LogFields): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const ts = now().toISOString();
    if (options.format === "json") {
      // Fixed keys are written first and last so a field can't overwrite them.
      const record: Record<string, unknown> = { ts, level, node: options.nodeId, msg: message };
      for (const [key, value] of Object.entries(fields)) {
        if (!(key in record)) record[key] = jsonValue(value);
      }
      write(JSON.stringify(record));
      return;
    }
    const rendered = Object.entries(fields).map(([key, value]) => ` ${key}=${textValue(value)}`).join("");
    write(`${ts} ${level.toUpperCase().padEnd(5)} [${options.nodeId}] ${message}${rendered}`);
  };

  const make = (bound: LogFields): Logger => ({
    debug: (message, fields = {}) => emit("debug", message, { ...bound, ...fields }),
    info: (message, fields = {}) => emit("info", message, { ...bound, ...fields }),
    warn: (message, fields = {}) => emit("warn", message, { ...bound, ...fields }),
    error: (message, fields = {}) => emit("error", message, { ...bound, ...fields }),
    child: (fields) => make({ ...bound, ...fields }),
  });
  return make({});
}
