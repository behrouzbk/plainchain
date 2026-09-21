/**
 * Minimal `--key value` / `--flag` parser shared by the node and wallet
 * entrypoints. Positional tokens (not starting with `--`) that don't follow
 * a key are collected under `_`.
 */
export interface ParsedArgs {
  flags: Record<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}
