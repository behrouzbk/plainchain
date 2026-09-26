import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWalletCli, type CliIo } from "../../src/cli/wallet.js";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { deriveAddress } from "../../src/ledger/address.js";
import { Node } from "../../src/node/node.js";
import { createRpcServer, listenRpc, type RpcListener } from "../../src/rpc/server.js";
import { generateSelfSignedCertificate, type TlsCredentials } from "../../src/rpc/tls.js";
import { keystoreAccounts, parseKeystore } from "../../src/wallet/keystore.js";
import { validateMnemonic } from "../../src/wallet/mnemonic.js";
import { decodeAddress, encodeAddress } from "../../src/ledger/address.js";

const EASY_TARGET = "f".repeat(64);
const REWARD = 5000000000n;
const PASS = "test-passphrase";

describe("wallet CLI (end-to-end over JSON-RPC)", () => {
  let dir: string;
  let node: Node | undefined;
  let server: RpcListener | undefined;
  let rpcUrl = "";
  let genesisAddress: string;
  /** Extra nodes started by a test (fork scenarios), stopped in afterEach. */
  const extras: { node: Node; server: RpcListener }[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-wallet-cli-test-"));
    genesisAddress = deriveAddress(generateKeyPair().publicKey);
  });

  afterEach(async () => {
    for (const extra of extras.splice(0)) {
      await extra.server.close();
      await extra.node.stop();
    }
    if (server) await server.close();
    if (node) await node.stop();
    server = undefined;
    node = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function startNode(minerAddress: string, coinbaseMaturity = 0, tls?: TlsCredentials, addressIndex?: { depth: number }): Promise<Node> {
    node = await makeNode("cli-test-node", minerAddress, coinbaseMaturity, addressIndex);
    const app = createRpcServer(node, { authToken: "tok", rateLimit: { maxRequests: 10_000, windowMs: 60_000 } });
    server = await listenRpc(app, { port: 0, bind: "127.0.0.1", tls });
    rpcUrl = server.url;
    return node;
  }

  /** A second, independent node with its own RPC URL (not peered with the first). */
  async function startExtraNode(id: string, minerAddress: string): Promise<{ node: Node; url: string }> {
    const extra = await makeNode(id, minerAddress, 0);
    const app = createRpcServer(extra, { authToken: "tok", rateLimit: { maxRequests: 10_000, windowMs: 60_000 } });
    const extraServer = await listenRpc(app, { port: 0, bind: "127.0.0.1" });
    extras.push({ node: extra, server: extraServer });
    return { node: extra, url: extraServer.url };
  }

  async function makeNode(id: string, minerAddress: string, coinbaseMaturity: number, addressIndex?: { depth: number }): Promise<Node> {
    const created = new Node({
      nodeId: id,
      networkId: "test-net",
      dataDir: join(dir, id),
      port: 0,
      genesis: { timestamp: 1700000000000, difficultyTarget: EASY_TARGET, reward: REWARD, genesisAddress },
      consensus: {
        targetBlockTimeMs: 10_000,
        difficultyRetargetInterval: 10,
        maxDifficultyAdjustmentFactor: 4,
        coinbaseMaturity,
        maxFutureDriftMs: 2 * 60 * 60 * 1000,
      },
      mempool: { maxSize: Infinity, minFee: 1n },
      minerAddress,
      blockReward: REWARD,
      logger: { warn: () => {} },
      addressIndex,
    });
    await created.start();
    return created;
  }

  interface Run {
    code: number;
    out: string;
    err: string;
  }

  /** Runs the CLI in-process with a scripted environment (no TTY prompts). */
  async function cli(
    args: string[],
    opts: { passphrase?: string; prompts?: string[]; rpc?: string; env?: Record<string, string> } = {},
  ): Promise<Run> {
    let out = "";
    let err = "";
    const prompts = [...(opts.prompts ?? [])];
    const io: CliIo = {
      stdout: (line) => (out += line + "\n"),
      stderr: (line) => (err += line + "\n"),
      env: {
        L1_WALLET_PASSPHRASE: opts.passphrase,
        L1_RPC_URL: opts.rpc ?? rpcUrl,
        // Never let a test touch the repo's default data/headers.json.
        L1_HEADERS_PATH: join(dir, "headers.json"),
        ...opts.env,
      },
      promptPassphrase: async () => {
        const next = prompts.shift();
        if (next === undefined) throw new Error("test: unexpected passphrase prompt");
        return next;
      },
    };
    const code = await runWalletCli(args, io);
    return { code, out, err };
  }

  const walletPath = () => join(dir, "alice.json");
  /** Raw (on-chain) address of the wallet's account 0. */
  const aliceRaw = (): string => keystoreAccounts(parseKeystore(readFileSync(walletPath(), "utf8")))[0]!.address;

  it("create writes an encrypted keystore and prints the address; address re-reads it without a passphrase", async () => {
    const created = await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    expect(created.code).toBe(0);
    expect(existsSync(walletPath())).toBe(true);

    const raw = aliceRaw();
    expect(created.out).toContain(encodeAddress(raw)); // checksummed form is what people copy
    expect(readFileSync(walletPath(), "utf8")).not.toContain("privateKey");

    const shown = await cli(["address", "--wallet", walletPath()]);
    expect(shown.code).toBe(0);
    expect(decodeAddress(shown.out.trim())).toBe(raw);
    const rawShown = await cli(["address", "--wallet", walletPath(), "--raw"]);
    expect(rawShown.out.trim()).toBe(raw);
  });

  it("create refuses to overwrite an existing wallet file", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const before = readFileSync(walletPath(), "utf8");
    const again = await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    expect(again.code).not.toBe(0);
    expect(again.err).toMatch(/exists/i);
    expect(readFileSync(walletPath(), "utf8")).toBe(before);
  });

  it("create prompts for the passphrase twice when none is given, and rejects a mismatch", async () => {
    const mismatch = await cli(["create", "--wallet", walletPath()], { prompts: ["one", "two"] });
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.err).toMatch(/match/i);
    expect(existsSync(walletPath())).toBe(false);

    const ok = await cli(["create", "--wallet", walletPath()], { prompts: ["same", "same"] });
    expect(ok.code).toBe(0);
  });

  it("sends coins end-to-end: balance, send, mine, recipient balance", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const bob = deriveAddress(generateKeyPair().publicKey);
    const n = await startNode(alice);
    await n.mineBlock();
    await n.mineBlock();

    const balance = await cli(["balance", "--wallet", walletPath()]);
    expect(balance.code).toBe(0);
    expect(balance.out).toContain((REWARD * 2n).toString());

    const sent = await cli(["send", "--wallet", walletPath(), "--to", bob, "--amount", "1000"], { passphrase: PASS });
    expect(sent.code).toBe(0);
    const txId = /txId:\s*([0-9a-f]{64})/.exec(sent.out)?.[1];
    expect(txId).toBeDefined();
    expect(n.getMempoolTransactions().map((t) => t.id)).toEqual([txId]);

    const mined = await n.mineBlock();
    const bobBalance = await cli(["balance", "--address", bob]);
    expect(bobBalance.out).toContain("1000");
    expect(await n.getBalance(bob)).toBe(1000n);
    // The default fee is the node's minimum (1), collected by the miner.
    expect(mined.transactions[0]!.outputs[0]!.amount).toBe(REWARD + 1n);
    // Alice is also the miner here, so the fee comes straight back to her.
    expect(await n.getBalance(alice)).toBe(REWARD * 3n - 1000n);
  });

  it("bump replaces a pending payment with a higher-fee copy; the recipient is paid once", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const bob = deriveAddress(generateKeyPair().publicKey);
    const n = await startNode(alice);
    await n.mineBlock();

    const sent = await cli(["send", "--wallet", walletPath(), "--to", bob, "--amount", "1000", "--fee", "5"], { passphrase: PASS });
    const txId = /txId:\s*([0-9a-f]{64})/.exec(sent.out)![1]!;

    // Not higher: a bad --fee value, refused before anything is signed.
    const same = await cli(["bump", "--wallet", walletPath(), "--tx", txId, "--fee", "5"], { passphrase: PASS });
    expect(same.code).toBe(2);
    expect(same.err).toMatch(/higher than/);

    const bumped = await cli(["bump", "--wallet", walletPath(), "--tx", txId, "--fee", "20"], { passphrase: PASS });
    expect(bumped.code).toBe(0);
    expect(bumped.out).toMatch(/replaced/);
    const newId = /txId:\s*([0-9a-f]{64})/.exec(bumped.out)![1]!;
    expect(newId).not.toBe(txId);
    expect(n.getMempoolTransactions().map((t) => t.id)).toEqual([newId]);

    // Bumping the now-replaced original again: it is gone from the mempool.
    const stale = await cli(["bump", "--wallet", walletPath(), "--tx", txId, "--fee", "30"], { passphrase: PASS });
    expect(stale.code).toBe(1);
    expect(stale.err).toMatch(/not in the mempool|not pending/i);

    const block = await n.mineBlock();
    expect(block.transactions.map((t) => t.id)).toContain(newId);
    expect(await n.getBalance(bob)).toBe(1000n);
    expect(block.transactions[0]!.outputs[0]!.amount).toBe(REWARD + 20n); // miner collected the bumped fee
  });

  it("send honours an explicit --fee", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    await n.mineBlock();
    const sent = await cli(["send", "--wallet", walletPath(), "--to", genesisAddress, "--amount", "10", "--fee", "7"], {
      passphrase: PASS,
    });
    expect(sent.code).toBe(0);
    expect(n.getMempoolTransactions()[0]?.fee).toBe(7n);
  });

  it("a wrong passphrase fails cleanly and nothing is broadcast", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    await n.mineBlock();
    const sent = await cli(["send", "--wallet", walletPath(), "--to", genesisAddress, "--amount", "10"], {
      passphrase: "wrong",
    });
    expect(sent.code).not.toBe(0);
    expect(sent.err).toMatch(/passphrase/i);
    expect(n.getMempoolTransactions()).toEqual([]);
  });

  it("insufficient funds fails before anything is signed or sent, and says how much is available", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    await n.mineBlock();
    const sent = await cli(["send", "--wallet", walletPath(), "--to", genesisAddress, "--amount", (REWARD * 5n).toString()], {
      passphrase: PASS,
    });
    expect(sent.code).not.toBe(0);
    expect(sent.err).toMatch(/insufficient funds/i);
    expect(sent.err).toContain(REWARD.toString());
    expect(n.getMempoolTransactions()).toEqual([]);
  });

  it("does not try to spend immature coinbase rewards, and balance shows them as immature", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice, 5);
    await n.mineBlock();

    const balance = await cli(["balance", "--wallet", walletPath()]);
    expect(balance.out).toMatch(/immature/i);
    expect(balance.out).toMatch(/spendable:\s*0\b/i);

    const sent = await cli(["send", "--wallet", walletPath(), "--to", genesisAddress, "--amount", "10"], { passphrase: PASS });
    expect(sent.code).not.toBe(0);
    expect(sent.err).toMatch(/not yet mature/i);
    expect(n.getMempoolTransactions()).toEqual([]);
  });

  it("unspent lists the wallet's outpoints; info reports the chain", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    const block = await n.mineBlock();

    const unspent = await cli(["unspent", "--wallet", walletPath()]);
    expect(unspent.code).toBe(0);
    expect(unspent.out).toContain(`${block.transactions[0]!.id}:0`);
    expect(unspent.out).toContain(REWARD.toString());

    const info = await cli(["info"]);
    expect(info.code).toBe(0);
    expect(info.out).toContain("test-net");
    expect(info.out).toContain("height: 1");
  });

  it("rejects a malformed amount and a missing recipient before contacting the node", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const bad = await cli(["send", "--wallet", walletPath(), "--to", "a".repeat(64), "--amount", "1.5"], { passphrase: PASS, rpc: "http://127.0.0.1:1" });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/amount/i);
    const missing = await cli(["send", "--wallet", walletPath(), "--amount", "1"], { passphrase: PASS, rpc: "http://127.0.0.1:1" });
    expect(missing.code).not.toBe(0);
    expect(missing.err).toMatch(/--to/);
  });

  it("refuses a malformed recipient address (coins sent to a typo are unrecoverable)", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    await n.mineBlock();
    for (const bad of ["abc", alice.slice(1), alice + "0", alice.replace(/[0-9a-f]/, "g")]) {
      const sent = await cli(["send", "--wallet", walletPath(), "--to", bad, "--amount", "10"], { passphrase: PASS });
      expect(sent.code).toBe(2);
      expect(sent.err).toMatch(/address/i);
    }
    expect(n.getMempoolTransactions()).toEqual([]);
  });

  it("verify: proves a transaction is confirmed using only headers + a merkle proof, trusting the genesis hash", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    const genesis = (await n.getBlockByHeight(0))!;
    await n.mineBlock();
    const sent = await cli(["send", "--wallet", walletPath(), "--to", genesisAddress, "--amount", "10"], { passphrase: PASS });
    const txId = /txId:\s*([0-9a-f]{64})/.exec(sent.out)![1]!;

    // Not mined yet: nothing to prove.
    const pending = await cli(["verify", "--tx", txId, "--genesis-hash", genesis.hash]);
    expect(pending.code).toBe(1);
    expect(pending.err).toMatch(/not confirmed|not found/i);

    // Mine it, then enough blocks to cross a retarget boundary (interval 10)
    // so the client's target rule is exercised too.
    for (let i = 0; i < 11; i++) await n.mineBlock();
    const verified = await cli(["verify", "--tx", txId, "--genesis-hash", genesis.hash]);
    expect(verified.code).toBe(0);
    expect(verified.out).toMatch(/confirmed in block .* at height 2/);
    expect(verified.out).toMatch(/confirmations:\s*11\b/);
    expect(verified.out).toMatch(/header chain valid .*13 headers/i);
    expect(verified.out).toMatch(/inclusion proof valid/i);
  });

  it("verify: reuses locally stored headers and downloads only what is new", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    const genesis = (await n.getBlockByHeight(0))!;
    const first = await n.mineBlock();
    for (let i = 0; i < 4; i++) await n.mineBlock();
    const headersCalls = (): number => {
      const line = n.metrics.render().split("\n").find((l) => l.startsWith('l1_rpc_calls_total{method="getHeaders"'));
      return line ? Number(line.split(" ")[1]) : 0;
    };

    const cold = await cli(["verify", "--tx", first.transactions[0]!.id, "--genesis-hash", genesis.hash]);
    expect(cold.code).toBe(0);
    expect(cold.out).toMatch(/6 headers, 6 downloaded/i);
    expect(existsSync(join(dir, "headers.json"))).toBe(true);
    const callsAfterCold = headersCalls();

    for (let i = 0; i < 3; i++) await n.mineBlock();
    const warm = await cli(["verify", "--tx", first.transactions[0]!.id, "--genesis-hash", genesis.hash]);
    expect(warm.code).toBe(0);
    expect(warm.out).toMatch(/9 headers, 3 downloaded/i);
    expect(warm.out).toMatch(/confirmations:\s*8\b/); // tip height 8, tx at height 1
    // One paged fetch of the tail, no probing, no re-download of the 6 stored headers.
    expect(headersCalls() - callsAfterCold).toBe(1);

    // Nothing new: the store alone is enough, and it still verifies.
    const same = await cli(["verify", "--tx", first.transactions[0]!.id, "--genesis-hash", genesis.hash]);
    expect(same.code).toBe(0);
    expect(same.out).toMatch(/9 headers, 0 downloaded/i);
  });

  it("sync: updates the header store and reports the verified tip; --headers picks the file", async () => {
    await startNode(genesisAddress);
    for (let i = 0; i < 3; i++) await node!.mineBlock();
    const genesis = (await node!.getBlockByHeight(0))!;
    const custom = join(dir, "custom", "h.json");
    const res = await cli(["sync", "--genesis-hash", genesis.hash, "--headers", custom]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/verified tip: height 3/);
    expect(res.out).toMatch(/4 downloaded/);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(join(dir, "headers.json"))).toBe(false);
  });

  it("verify: follows a heavier fork (reorg) and refuses a lighter one from another node", async () => {
    // Two unpeered nodes diverge from genesis: A mines 2, B mines 4.
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const a = await startNode(alice);
    const genesis = (await a.getBlockByHeight(0))!;
    const a1 = await a.mineBlock();
    await a.mineBlock();
    const b = await startExtraNode("cli-test-node-b", genesisAddress);
    let bTip = await b.node.mineBlock();
    for (let i = 0; i < 3; i++) bTip = await b.node.mineBlock();

    // Wallet learns A's chain (3 headers), then is pointed at B: B is
    // heavier, so the wallet reorgs its store and verifies B's block.
    const onA = await cli(["verify", "--tx", a1.transactions[0]!.id, "--genesis-hash", genesis.hash]);
    expect(onA.code).toBe(0);
    const onB = await cli(["verify", "--tx", bTip.transactions[0]!.id, "--genesis-hash", genesis.hash], { rpc: b.url });
    expect(onB.code).toBe(0);
    expect(onB.out).toMatch(/reorg: 2 stored headers? abandoned/i);
    expect(onB.out).toMatch(/5 headers, 4 downloaded/i);

    // Back to A, whose chain is now lighter than what the wallet verified:
    // A's block is NOT accepted as confirmed.
    const backOnA = await cli(["verify", "--tx", a1.transactions[0]!.id, "--genesis-hash", genesis.hash]);
    expect(backOnA.code).toBe(1);
    expect(backOnA.err).toMatch(/lighter fork/i);
  });

  it("verify: refuses to trust a node whose genesis differs from the one the client trusts", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    const n = await startNode(alice);
    const block = await n.mineBlock();
    const res = await cli(["verify", "--tx", block.transactions[0]!.id, "--genesis-hash", "e".repeat(64)]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/genesis/i);
  });

  it("reports an unreachable node as a clear error, not a stack trace", async () => {
    const res = await cli(["info"], { rpc: "http://127.0.0.1:1" });
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/could not reach node/i);
    expect(res.err).not.toMatch(/at .*\.ts:\d+/);
  });

  it("talks to a TLS node when --ca (or $L1_RPC_CA) points at its certificate", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const caPath = join(dir, "node.crt");
    writeFileSync(caPath, tls.cert);
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const alice = aliceRaw();
    await startNode(alice, 0, tls);
    expect(rpcUrl.startsWith("https://")).toBe(true);

    const viaFlag = await cli(["info", "--ca", caPath]);
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.out).toMatch(/network:\s*test-net/);

    const viaEnv = await cli(["balance", "--wallet", walletPath()], { env: { L1_RPC_CA: caPath } });
    expect(viaEnv.code).toBe(0);
    expect(viaEnv.err).not.toMatch(/warning/i);
  });

  it("refuses a TLS node whose certificate is not trusted, and points at --ca", async () => {
    const tls = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    await startNode(genesisAddress, 0, tls);
    const res = await cli(["info"]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/self-signed/i);
    expect(res.err).toMatch(/--ca/);
  });

  it("attack: an impostor node with its own certificate is refused when the real one is pinned", async () => {
    const real = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const impostor = generateSelfSignedCertificate({ hosts: ["127.0.0.1"] });
    const caPath = join(dir, "real.crt");
    writeFileSync(caPath, real.cert);
    await startNode(genesisAddress, 0, impostor);
    const res = await cli(["info", "--ca", caPath]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/could not reach node|certificate/i);
  });

  it("a missing --ca file is a usage error, not a silent fallback to the system trust store", async () => {
    await startNode(genesisAddress);
    const res = await cli(["info", "--ca", join(dir, "missing.crt")]);
    expect(res.code).toBe(2);
    expect(res.err).toMatch(/missing\.crt/);
  });

  it("warns when sending requests in cleartext to a node that is not on this host", async () => {
    const local = await cli(["info"], { rpc: "http://127.0.0.1:1" });
    expect(local.err).not.toMatch(/warning/i);
    // `.invalid` never resolves (RFC 2606), so this fails fast; the warning
    // is printed before the connection is attempted.
    const remote = await cli(["info"], { rpc: "http://node.invalid:1" });
    expect(remote.err).toMatch(/warning: .*cleartext/i);
    expect(remote.code).toBe(1);
  });

  it("refuses a checksummed --to with a typo, and accepts both address forms", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const n = await startNode(aliceRaw());
    await n.mineBlock();
    const bobRaw = deriveAddress(generateKeyPair().publicKey);
    const bob = encodeAddress(bobRaw);
    const typo = bob.slice(0, -1) + (bob.endsWith("q") ? "p" : "q");
    const bad = await cli(["send", "--wallet", walletPath(), "--to", typo, "--amount", "5"], { passphrase: PASS });
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/checksum/i);
    expect(n.getMempoolTransactions()).toEqual([]);

    const okChecked = await cli(["send", "--wallet", walletPath(), "--to", bob, "--amount", "5"], { passphrase: PASS });
    expect(okChecked.code).toBe(0);
    expect(okChecked.out).toContain(`sent 5 to ${bob}`);
    await n.mineBlock();
    const balanceByRaw = await cli(["balance", "--address", bobRaw]);
    const balanceByChecked = await cli(["balance", "--address", bob]);
    expect(balanceByRaw.out).toContain("total:     5");
    expect(balanceByChecked.out).toContain("total:     5");
    expect(balanceByChecked.out).toContain(`address:   ${bob}`);
  });

  it("accounts: derives more accounts, sends from a chosen one, lists them, and the seed restores them", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const n = await startNode(aliceRaw());
    await n.mineBlock();

    const created = await cli(["account", "new", "--wallet", walletPath(), "--label", "savings"], { passphrase: PASS });
    expect(created.code).toBe(0);
    expect(created.out).toMatch(/^account 1 \(savings\): l11/);
    const list = await cli(["account", "list", "--wallet", walletPath(), "--raw"]);
    expect(list.out.trim().split("\n")).toHaveLength(2);
    const savingsRaw = list.out.trim().split("\n")[1]!.split(/\s+/)[1]!;
    expect(savingsRaw).toMatch(/^[0-9a-f]{64}$/);

    // Fund account 1 from account 0, then spend from account 1.
    const fund = await cli(["send", "--wallet", walletPath(), "--to", savingsRaw, "--amount", "700"], { passphrase: PASS });
    expect(fund.code).toBe(0);
    await n.mineBlock();
    expect((await cli(["balance", "--wallet", walletPath(), "--account", "1"])).out).toContain("spendable: 700");
    const bob = deriveAddress(generateKeyPair().publicKey);
    const spend = await cli(["send", "--wallet", walletPath(), "--account", "1", "--to", bob, "--amount", "100"], { passphrase: PASS });
    expect(spend.code).toBe(0);
    await n.mineBlock();
    expect(await n.getBalance(bob)).toBe(100n);
    expect((await cli(["send", "--wallet", walletPath(), "--account", "7", "--to", bob, "--amount", "1"], { passphrase: PASS })).err).toMatch(/account 7/);

    // Restore into a new wallet from the recovery phrase: same accounts, same addresses.
    const seed = await cli(["seed", "--wallet", walletPath()], { passphrase: PASS });
    expect(seed.code).toBe(0);
    expect(seed.out.trim().split(" ")).toHaveLength(12);
    const restoredPath = join(dir, "restored.json");
    expect((await cli(["restore", "--wallet", restoredPath, "--mnemonic", seed.out.trim()], { passphrase: "other" })).code).toBe(0);
    await cli(["account", "new", "--wallet", restoredPath], { passphrase: "other" });
    const restoredList = await cli(["account", "list", "--wallet", restoredPath, "--raw"]);
    expect(restoredList.out).toBe(list.out.replace("  savings", ""));
  });

  it("create prints a recovery phrase once; restore --mnemonic rebuilds the same wallet; --words 24 is honoured", async () => {
    const created = await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    expect(created.code).toBe(0);
    const phrase = /^recovery phrase: (.+)$/m.exec(created.out)?.[1];
    expect(phrase).toBeDefined();
    expect(phrase!.split(" ")).toHaveLength(12);
    expect(validateMnemonic(phrase!).valid).toBe(true);
    expect(created.err).toMatch(/write .* down/i);
    // The file holds the phrase only encrypted.
    expect(readFileSync(walletPath(), "utf8")).not.toContain(phrase!.split(" ")[0]);

    const restoredPath = join(dir, "restored.json");
    const restored = await cli(["restore", "--wallet", restoredPath, "--mnemonic", phrase!.toUpperCase()], { passphrase: "other" });
    expect(restored.code).toBe(0);
    expect(restored.out).toContain("restored from recovery phrase");
    expect((await cli(["address", "--wallet", restoredPath])).out).toBe((await cli(["address", "--wallet", walletPath()])).out);
    expect((await cli(["seed", "--wallet", restoredPath], { passphrase: "other" })).out.trim()).toBe(phrase);

    const long = await cli(["create", "--wallet", join(dir, "long.json"), "--words", "24"], { passphrase: PASS });
    expect(long.code).toBe(0);
    expect(/^recovery phrase: (.+)$/m.exec(long.out)![1]!.split(" ")).toHaveLength(24);
    expect((await cli(["create", "--wallet", join(dir, "odd.json"), "--words", "13"], { passphrase: PASS })).code).toBe(2);
  });

  it("restore refuses a phrase with a wrong word or a bad checksum before asking for a passphrase or writing a file", async () => {
    const phrase = /^recovery phrase: (.+)$/m.exec((await cli(["create", "--wallet", walletPath()], { passphrase: PASS })).out)![1]!;
    const words = phrase.split(" ");
    const target = join(dir, "restored.json");
    // No passphrase in the env and no scripted prompt: reaching the prompt would fail the test.
    const typo = await cli(["restore", "--wallet", target, "--mnemonic", phrase.replace(words[0]!, words[0] + "x")]);
    expect(typo.code).toBe(2);
    expect(typo.err).toMatch(/is not a BIP-39 word/);
    // A swapped word passes the 4-bit checksum 1 time in 16: pick one that does not.
    const swapped = ["zoo", "zone", "zebra", "youth", "young", "yellow", "year", "yard"]
      .map((w) => words.map((x, i) => (i === 5 ? w : x)).join(" "))
      .find((phrase) => !validateMnemonic(phrase).valid)!;
    const bad = await cli(["restore", "--wallet", target, "--mnemonic", swapped]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/checksum/);
    const short = await cli(["restore", "--wallet", target, "--mnemonic", words.slice(0, 11).join(" ")]);
    expect(short.code).toBe(2);
    expect(short.err).toMatch(/12, 15, 18, 21 or 24 words/);
    expect(existsSync(target)).toBe(false);
    // The phrase can also be typed at a hidden prompt.
    const prompted = await cli(["restore", "--wallet", target], { passphrase: PASS, prompts: [phrase] });
    expect(prompted.code).toBe(0);
    expect((await cli(["address", "--wallet", target])).out).toBe((await cli(["address", "--wallet", walletPath()])).out);
  });

  it("watch-only: a copy with no keys shows balances and history but can never send, bump, derive or reveal a seed", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    await cli(["account", "new", "--wallet", walletPath(), "--label", "savings"], { passphrase: PASS });
    const n = await startNode(aliceRaw());
    await n.mineBlock();

    const watchPath = join(dir, "watch.json");
    const exported = await cli(["watch-only", "--wallet", walletPath(), "--out", watchPath]);
    expect(exported.code).toBe(0);
    expect(exported.out).toContain(`watch-only wallet written: ${watchPath}`);
    const file = readFileSync(watchPath, "utf8");
    expect(file).not.toMatch(/kdf|cipher/);
    expect(parseKeystore(file)).toMatchObject({ version: 3, type: "watch-only" });
    expect((await cli(["watch-only", "--wallet", walletPath(), "--out", watchPath])).code).toBe(2); // refuses to overwrite

    // Read-only commands work without a passphrase.
    expect((await cli(["address", "--wallet", watchPath])).out).toBe((await cli(["address", "--wallet", walletPath()])).out);
    const list = await cli(["account", "list", "--wallet", watchPath]);
    expect(list.out.trim().split("\n")).toHaveLength(2);
    expect(list.out).toContain("savings");
    expect((await cli(["balance", "--wallet", watchPath])).out).toContain(`spendable: ${REWARD}`);
    expect((await cli(["unspent", "--wallet", watchPath])).out).toContain("coinbase");
    expect((await cli(["history", "--wallet", watchPath])).out).toContain(`+${REWARD}`);

    // Spending paths are refused before any passphrase prompt (none is scripted) and nothing reaches the node.
    const bob = deriveAddress(generateKeyPair().publicKey);
    const send = await cli(["send", "--wallet", watchPath, "--to", bob, "--amount", "5"]);
    expect(send.code).toBe(2);
    expect(send.err).toMatch(/watch-only/);
    expect(n.getMempoolTransactions()).toHaveLength(0);
    for (const args of [["bump", "--tx", "a".repeat(64), "--fee", "9"], ["account", "new"], ["seed"]]) {
      const run = await cli([...args, "--wallet", watchPath]);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.err, args.join(" ")).toMatch(/watch-only/);
    }
  });

  it("attack: a watch-only file edited to carry another wallet's secret cannot sign for the watched addresses", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const n = await startNode(aliceRaw());
    await n.mineBlock();
    const watchPath = join(dir, "watch.json");
    await cli(["watch-only", "--wallet", walletPath(), "--out", watchPath]);
    const theirsPath = join(dir, "theirs.json");
    await cli(["create", "--wallet", theirsPath], { passphrase: "theirs" });
    const theirs = JSON.parse(readFileSync(theirsPath, "utf8")) as { kdf: unknown; cipher: unknown };
    const watch = JSON.parse(readFileSync(watchPath, "utf8")) as Record<string, unknown>;
    writeFileSync(watchPath, JSON.stringify({ ...watch, type: "mnemonic", kdf: theirs.kdf, cipher: theirs.cipher }));

    const bob = deriveAddress(generateKeyPair().publicKey);
    const send = await cli(["send", "--wallet", watchPath, "--to", bob, "--amount", "5"], { passphrase: "theirs" });
    expect(send.code).toBe(1);
    expect(send.err).toMatch(/does not match/);
    expect(n.getMempoolTransactions()).toHaveLength(0);
  });

  it("history: lists confirmed transactions for an account, newest first, with net amounts", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const n = await startNode(aliceRaw());
    await n.mineBlock();
    const bobRaw = deriveAddress(generateKeyPair().publicKey);
    const sent = await cli(["send", "--wallet", walletPath(), "--to", bobRaw, "--amount", "250", "--fee", "3"], { passphrase: PASS });
    const txId = /txId:\s*([0-9a-f]{64})/.exec(sent.out)![1]!;
    // Pending payments are not history: only the mining reward is listed so far.
    expect((await cli(["history", "--wallet", walletPath()])).out).not.toContain(txId);
    expect((await cli(["history", "--address", encodeAddress(bobRaw)])).out).toContain("(no confirmed transactions)");
    await n.mineBlock();

    const history = await cli(["history", "--wallet", walletPath()]);
    expect(history.code).toBe(0);
    const lines = history.out.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3); // two coinbases + the payment
    // Newest first: both height-2 entries precede the height-1 coinbase (order within a height is by txId).
    expect(lines.slice(0, 2).every((l) => l.includes("height=2"))).toBe(true);
    expect(lines[lines.length - 1]).toContain("height=1");
    expect(lines.some((l) => l.includes(`+${REWARD + 3n}  (in ${REWARD + 3n}, out 0)`))).toBe(true); // coinbase incl. the fee
    expect(lines.some((l) => l.includes(txId) && l.includes("-253  (in"))).toBe(true); // paid 250 + fee 3, change back
    const bobHistory = await cli(["history", "--address", encodeAddress(bobRaw), "--limit", "1"]);
    expect(bobHistory.out.trim().split("\n")).toHaveLength(1);
    expect(bobHistory.out).toContain("+250");
  });

  it("history on a node that prunes its address index says which heights it covers", async () => {
    await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
    const n = await startNode(aliceRaw(), 0, undefined, { depth: 2 });
    for (let h = 1; h <= 4; h++) await n.mineBlock();
    const history = await cli(["history", "--wallet", walletPath()]);
    expect(history.code).toBe(0);
    expect(history.out.trim().split("\n")).toHaveLength(2);
    expect(history.out).toMatch(/height=4/);
    expect(history.err).toMatch(/heights 3 and above.*last 2 blocks/);
  });

  describe("record anchoring", () => {
    const docPath = () => join(dir, "contract.pdf");
    const docHash = () => createHash("sha256").update(readFileSync(docPath())).digest("hex");

    async function fundedAlice(): Promise<{ n: Node; genesisHash: string }> {
      await cli(["create", "--wallet", walletPath()], { passphrase: PASS });
      const n = await startNode(aliceRaw());
      await n.mineBlock();
      writeFileSync(docPath(), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x0a])); // binary content, hashed as bytes
      return { n, genesisHash: (await n.getBlockByHeight(0))!.hash };
    }

    it("anchor --file sends the file's sha256 as a record; find-anchor proves it (headers + merkle proof + the tx really carries it)", async () => {
      const { n, genesisHash } = await fundedAlice();
      const sent = await cli(["anchor", "--wallet", walletPath(), "--file", docPath()], { passphrase: PASS });
      expect(sent.code, sent.err).toBe(0);
      expect(sent.out).toContain(`record: ${docHash()}`);
      const txId = /txId:\s*([0-9a-f]{64})/.exec(sent.out)![1]!;
      expect(n.getMempoolTransactions().find((t) => t.id === txId)?.data).toBe(docHash());

      const pending = await cli(["find-anchor", "--file", docPath(), "--genesis-hash", genesisHash]);
      expect(pending.code).toBe(1);
      expect(pending.err).toMatch(/not anchored/i);

      const block = await n.mineBlock();
      await n.mineBlock();
      const found = await cli(["find-anchor", "--file", docPath(), "--genesis-hash", genesisHash]);
      expect(found.code, found.err).toBe(0);
      expect(found.out).toContain(`record: ${docHash()}`);
      expect(found.out).toContain(`anchored in block ${block.hash} at height 2`);
      expect(found.out).toContain(new Date(block.header.timestamp).toISOString());
      expect(found.out).toMatch(/confirmations:\s*2\b/);
      expect(found.out).toMatch(/transaction carries the record/i);
      expect(found.out).toMatch(/inclusion proof valid/i);

      // --hash takes the digest directly (any case), e.g. computed elsewhere.
      const byHash = await cli(["find-anchor", "--hash", docHash().toUpperCase(), "--genesis-hash", genesisHash]);
      expect(byHash.code).toBe(0);
    });

    it("a record nobody anchored is reported as not anchored (exit 1)", async () => {
      const { genesisHash } = await fundedAlice();
      const res = await cli(["find-anchor", "--hash", "cd".repeat(32), "--genesis-hash", genesisHash]);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/not anchored/i);
    });

    it("refuses a bad record before asking for the passphrase: not hex, too long, no source, or two sources", async () => {
      await fundedAlice();
      for (const args of [["--hash", "xyz"], ["--hash", "00".repeat(81)], [], ["--hash", "ab", "--file", docPath()], ["--file", join(dir, "missing.pdf")]]) {
        const res = await cli(["anchor", "--wallet", walletPath(), ...args]); // no passphrase: a prompt would throw
        expect(res.code, args.join(" ")).toBe(2);
      }
    });

    it("a watch-only wallet can look a record up but cannot anchor one", async () => {
      await fundedAlice();
      const watchPath = join(dir, "watch.json");
      await cli(["watch-only", "--wallet", walletPath(), "--out", watchPath]);
      const res = await cli(["anchor", "--wallet", watchPath, "--file", docPath()]);
      expect(res.code).toBe(2);
      expect(res.err).toMatch(/watch-only/i);
    });

    it("attack: a node that points the record at an unrelated confirmed transaction is caught", async () => {
      const { n, genesisHash } = await fundedAlice();
      const block1 = (await n.getBlockByHeight(1))!;
      // A proxy that answers getAnchors with a real, provable transaction
      // (block 1's coinbase) that does not carry the record.
      const liar = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          const call = JSON.parse(body) as { method: string; id: number };
          const reply = call.method === "getAnchors"
            ? { jsonrpc: "2.0", id: call.id, result: [{ txId: block1.transactions[0]!.id, height: 1, blockHash: block1.hash, blockTimestamp: block1.header.timestamp, confirmations: 1 }] }
            : await (await fetch(`${rpcUrl}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).json();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(reply));
        });
      });
      await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
      try {
        const port = (liar.address() as { port: number }).port;
        const res = await cli(["find-anchor", "--file", docPath(), "--genesis-hash", genesisHash], { rpc: `http://127.0.0.1:${port}` });
        expect(res.code).toBe(1);
        expect(res.err).toMatch(/does not carry the record/i);
      } finally {
        await new Promise<void>((resolve) => liar.close(() => resolve()));
      }
    });
  });

  it("prints usage for an unknown or missing command", async () => {
    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/usage/i);
    const unknown = await cli(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unknown command/i);
  });
});
