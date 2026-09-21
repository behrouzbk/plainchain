import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Invoke tsx's CLI script directly via node.exe rather than through
// npx/npx.cmd: spawning a .cmd file on Windows requires shell: true, which
// wraps the real process in cmd.exe and makes it unkillable via a plain
// kill() on the tracked PID (see killTree below).
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface SimNode {
  id: string;
  p2pPort: number;
  rpcPort: number;
  dataDir: string;
  peers: string[];
  proc?: ChildProcess;
}

/** Shared token so the script can call protected RPC methods (mine). */
const SIM_RPC_TOKEN = "simulate-rpc-token";

const NODES: SimNode[] = [
  { id: "sim-node1", p2pPort: 8001, rpcPort: 9001, dataDir: "data/sim-node1", peers: [] },
  { id: "sim-node2", p2pPort: 8002, rpcPort: 9002, dataDir: "data/sim-node2", peers: ["ws://localhost:8001"] },
  {
    id: "sim-node3",
    p2pPort: 8003,
    rpcPort: 9003,
    dataDir: "data/sim-node3",
    peers: ["ws://localhost:8001", "ws://localhost:8002"],
  },
];

function log(source: string, line: string): void {
  console.log(`[${source}] ${line}`);
}

function spawnNode(node: SimNode): ChildProcess {
  const args = [
    tsxCli,
    join(projectRoot, "src", "node", "main.ts"),
    "--node-id",
    node.id,
    "--port",
    String(node.p2pPort),
    "--rpc-port",
    String(node.rpcPort),
    "--data-dir",
    join(projectRoot, node.dataDir),
    "--rpc-token",
    SIM_RPC_TOKEN,
  ];
  if (node.peers.length > 0) {
    args.push("--peers", node.peers.join(","));
  }

  const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: projectRoot });
  proc.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) log(node.id, line.trim());
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) log(`${node.id}:err`, line.trim());
    }
  });
  return proc;
}

async function waitForRpc(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/chain/tip`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`RPC on port ${port} did not become ready within ${timeoutMs}ms`);
}

async function waitForTipHash(port: number, expectedHash: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`http://localhost:${port}/chain/tip`);
    const tip = (await res.json()) as { hash: string; height: number } | null;
    if (tip?.hash === expectedHash) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`node on RPC port ${port} did not converge to tip ${expectedHash} within ${timeoutMs}ms`);
}

function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  if (process.platform === "win32") {
    // A plain kill() only signals npx.cmd's own process, not the node.exe
    // it launches; /t kills the whole tree so ports/LevelDB locks are freed.
    spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
  } else {
    proc.kill("SIGTERM");
  }
}

async function shutdown(nodes: SimNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.proc) killTree(node.proc);
  }
  await new Promise((r) => setTimeout(r, 500));
}

async function main(): Promise<void> {
  for (const node of NODES) {
    rmSync(join(projectRoot, node.dataDir), { recursive: true, force: true });
  }

  console.log("=== Starting 3 node processes ===");
  for (const node of NODES) {
    node.proc = spawnNode(node);
    await waitForRpc(node.rpcPort);
    log("simulate", `${node.id} ready (p2p :${node.p2pPort}, rpc :${node.rpcPort})`);
  }

  console.log("=== Waiting for mesh handshakes to settle ===");
  await new Promise((r) => setTimeout(r, 1000));

  console.log("=== Mining one block on sim-node1 ===");
  const mineRes = await fetch(`http://localhost:${NODES[0]!.rpcPort}/mine`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SIM_RPC_TOKEN}` },
  });
  if (!mineRes.ok) {
    throw new Error(`mine request failed: ${mineRes.status} ${await mineRes.text()}`);
  }
  const mined = (await mineRes.json()) as { hash: string; height: number };
  log("simulate", `sim-node1 mined block ${mined.hash} at height ${mined.height}`);

  console.log("=== Waiting for sim-node2 and sim-node3 to converge ===");
  await waitForTipHash(NODES[1]!.rpcPort, mined.hash);
  log("simulate", "sim-node2 converged");
  await waitForTipHash(NODES[2]!.rpcPort, mined.hash);
  log("simulate", "sim-node3 converged");

  console.log("=== Verifying block bodies match across all nodes ===");
  const bodies = await Promise.all(
    NODES.map((n) => fetch(`http://localhost:${n.rpcPort}/block/hash/${mined.hash}`).then((r) => r.json())),
  );
  const [b1, b2, b3] = bodies as [unknown, unknown, unknown];
  const same = JSON.stringify(b1) === JSON.stringify(b2) && JSON.stringify(b2) === JSON.stringify(b3);
  if (!same) {
    throw new Error("block bodies diverged across nodes");
  }

  console.log("\n✅ SUCCESS: all 3 nodes converged on the same block after propagation.\n");
  await shutdown(NODES);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\n❌ SIMULATION FAILED:", err);
  await shutdown(NODES);
  process.exit(1);
});
