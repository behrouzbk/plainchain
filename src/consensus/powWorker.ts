/**
 * Worker-thread body for proof-of-work: searches nonces for one header
 * until a hash meets the target or the shared abort flag is raised.
 * Started by WorkerMiner (miner.ts); never imported by anything else.
 */
import { parentPort } from "node:worker_threads";
import { computeBlockHash } from "../ledger/block.js";
import type { BlockHeader } from "../ledger/types.js";
import { meetsTarget } from "./pow.js";

export interface MineRequest {
  header: BlockHeader;
  /** Int32 at index 0 set to 1 by the parent to abort. */
  abortFlag: SharedArrayBuffer;
}

export type MineReply = { found: { header: BlockHeader; hash: string } } | { aborted: true };

/** Hashes between abort-flag checks: cheap enough to keep aborts prompt. */
const CHECK_EVERY = 1024;

if (!parentPort) throw new Error("powWorker must run as a worker thread");
const port = parentPort;

port.on("message", (request: MineRequest) => {
  const stop = new Int32Array(request.abortFlag);
  for (let nonce = 0; nonce <= Number.MAX_SAFE_INTEGER; nonce++) {
    if (nonce % CHECK_EVERY === 0 && Atomics.load(stop, 0) === 1) {
      port.postMessage({ aborted: true } satisfies MineReply);
      return;
    }
    const candidate: BlockHeader = { ...request.header, nonce };
    const hash = computeBlockHash(candidate);
    if (meetsTarget(hash, candidate.difficultyTarget)) {
      port.postMessage({ found: { header: candidate, hash } } satisfies MineReply);
      return;
    }
  }
  port.postMessage({ aborted: true } satisfies MineReply);
});
