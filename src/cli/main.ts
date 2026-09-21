import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { runWalletCli, type CliIo } from "./wallet.js";

/**
 * Piped (non-TTY) stdin: one shared reader hands out lines in order. A
 * fresh readline per prompt would find the stream already consumed by the
 * previous one and return nothing for the second prompt.
 */
let pipedLines: { queue: string[]; waiting: ((line: string) => void)[]; ended: boolean } | undefined;

function readPipedLine(): Promise<string> {
  if (!pipedLines) {
    const state = { queue: [] as string[], waiting: [] as ((line: string) => void)[], ended: false };
    pipedLines = state;
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const waiter = state.waiting.shift();
      if (waiter) waiter(line);
      else state.queue.push(line);
    });
    rl.on("close", () => {
      state.ended = true;
      for (const waiter of state.waiting.splice(0)) waiter("");
    });
  }
  const state = pipedLines;
  const queued = state.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (state.ended) return Promise.resolve("");
  return new Promise((resolve) => state.waiting.push(resolve));
}

/**
 * Reads a line from stdin without echoing it (for passphrases). Falls back
 * to a plain line read when stdin isn't a terminal (piped input).
 */
function promptPassphrase(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();

  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    // A sink that swallows the echoed characters; the prompt itself was
    // already written above.
    const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    rl.once("error", reject);
  });
}

const io: CliIo = {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  env: process.env,
  promptPassphrase,
};

// Set the exit code and let the event loop drain rather than calling
// process.exit(): on Windows, exiting while the ESM loader thread is still
// closing trips a libuv assertion (UV_HANDLE_CLOSING) and the code is lost.
runWalletCli(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
