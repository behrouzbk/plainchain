import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { BlockHeader } from "../ledger/types.js";
import type { MinedHeader } from "./pow.js";
import type { MineReply, MineRequest } from "./powWorker.js";

/** Something the node can hand a block template to and get proof of work back. */
export interface BlockMiner {
  /** Resolves with the first nonce meeting the target; rejects with MiningAbortedError on abort. */
  mine(header: BlockHeader, signal?: AbortSignal): Promise<MinedHeader>;
  close(): Promise<void>;
}

/** The search was stopped before a solution was found (new tip, shutdown). */
export class MiningAbortedError extends Error {
  constructor(reason = "mining aborted") {
    super(reason);
  }
}

/**
 * Proof-of-work on a worker thread, so the node keeps serving RPC and P2P
 * (and adopting peers' blocks) while it mines. One persistent worker is
 * reused across searches; an abort is a flag in shared memory the worker
 * polls every few hundred hashes, so it never needs to be killed.
 */
export class WorkerMiner implements BlockMiner {
  private worker: Worker | undefined;
  private current: { reject: (err: Error) => void } | undefined;
  private closed = false;

  mine(header: BlockHeader, signal?: AbortSignal): Promise<MinedHeader> {
    if (this.closed) return Promise.reject(new MiningAbortedError("miner closed"));
    if (signal?.aborted) return Promise.reject(new MiningAbortedError());
    if (this.current) return Promise.reject(new Error("miner busy: one search at a time"));

    const abortFlag = new SharedArrayBuffer(4);
    const flag = new Int32Array(abortFlag);
    const worker = this.ensureWorker();

    return new Promise<MinedHeader>((resolve, reject) => {
      const finish = (): void => {
        worker.unref(); // idle again: must not keep a stopping process alive
        worker.off("message", onMessage);
        worker.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
        this.current = undefined;
      };
      const onMessage = (reply: MineReply): void => {
        finish();
        if ("found" in reply) resolve(reply.found);
        else reject(new MiningAbortedError());
      };
      const onError = (err: Error): void => {
        finish();
        // A crashed worker is not reusable; the next search spawns a new one.
        this.worker = undefined;
        reject(err);
      };
      const onAbort = (): void => {
        Atomics.store(flag, 0, 1);
      };

      this.current = {
        reject: (err) => {
          finish();
          reject(err);
        },
      };
      worker.ref(); // a search in progress is real work
      worker.on("message", onMessage);
      worker.on("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ header, abortFlag } satisfies MineRequest);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.current?.reject(new MiningAbortedError("miner closed"));
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const here = fileURLToPath(import.meta.url);
    const worker = here.endsWith(".ts")
      ? // Development and tests: this module is TypeScript, so the worker
        // entry is too. Worker threads do not inherit the parent's loader,
        // so a tiny CommonJS bootstrap registers tsx inside the worker and
        // then imports the real entry.
        new Worker(
          `const { register } = require("tsx/esm/api"); register();
           import(${JSON.stringify(new URL("./powWorker.ts", import.meta.url).href)}).catch((err) => { throw err; });`,
          { eval: true },
        )
      : // Compiled (dist/, Docker): plain JavaScript, no loader needed.
        new Worker(new URL("./powWorker.js", import.meta.url));
    worker.unref();
    this.worker = worker;
    return worker;
  }
}
