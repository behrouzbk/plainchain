/**
 * Builds the genesis section of a chain config from an explicit allocation
 * and prints the resulting genesis hash -- what a new private chain needs
 * before its first node starts.
 *
 *   npm run genesis -- --allocations <addr>:<amount>,<addr>:<amount> [--timestamp <ms>] [--target <hex>]
 *   (from PowerShell: npx tsx scripts/genesis.ts ...)
 *
 * Amounts are integers in base units; addresses are 64 hex characters
 * (`wallet address`). Paste the printed `genesis` object into
 * config/default.json (every node of the chain must use the same one) and
 * give wallets the printed hash via --genesis-hash if they verify against
 * a config they don't otherwise trust.
 */
import { parseArgs } from "../src/config/args.js";
import { loadConfig } from "../src/config/index.js";
import { createGenesisBlock, genesisAllocationTotal, type GenesisAllocation } from "../src/ledger/block.js";

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const defaults = loadConfig().genesis;
  const raw = flags.allocations;
  if (!raw) throw new Error("--allocations <addr>:<amount>[,<addr>:<amount>...] is required");

  const allocations: GenesisAllocation[] = raw.split(",").map((entry) => {
    const [address, amount, ...rest] = entry.trim().split(":");
    if (!address || amount === undefined || rest.length > 0) throw new Error(`malformed allocation "${entry}": expected <addr>:<amount>`);
    if (!/^[0-9a-f]{64}$/.test(address)) throw new Error(`"${address}" is not a wallet address (64 hex characters)`);
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error(`amount for ${address} must be a positive integer, got "${amount}"`);
    return { address, amount: BigInt(amount) };
  });
  const timestamp = Number(flags.timestamp ?? defaults.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error(`--timestamp must be a positive integer (ms), got "${flags.timestamp}"`);
  const difficultyTarget = flags.target ?? defaults.difficultyTarget;
  if (!/^[0-9a-f]{64}$/.test(difficultyTarget)) throw new Error(`--target must be 64 hex characters, got "${difficultyTarget}"`);

  const config = { timestamp, difficultyTarget, reward: 0n, genesisAddress: "", allocations };
  const genesis = createGenesisBlock(config);

  console.log("genesis config (paste into config/default.json):");
  console.log(
    JSON.stringify(
      {
        genesis: {
          timestamp,
          difficultyTarget,
          reward: allocations[0]!.amount.toString(),
          genesisAddress: allocations[0]!.address,
          allocations: allocations.map((a) => ({ address: a.address, amount: a.amount.toString() })),
        },
      },
      null,
      2,
    ),
  );
  console.log(`\ntotal allocation: ${genesisAllocationTotal(config)} across ${allocations.length} output(s)`);
  console.log(`genesis hash:     ${genesis.hash}`);
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
