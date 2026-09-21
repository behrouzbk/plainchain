# Hands-On Testing Guide

A step-by-step script for exercising the node end to end on one machine:
the automated checks, the three-process simulation, and a two-wallet
walkthrough (mine → pay → SPV-verify) with the output you should see at
each step. Nothing here needs network access or any external service.

Commands are given for **PowerShell** (the default on Windows). A Git Bash
/ macOS / Linux variant is at the end.

---

## 0. Prerequisites

- Node.js ≥ 20 and npm
- The repository cloned and dependencies installed:

```powershell
cd C:\workspace\l1-node-engine
npm install
```

Everything the tests and walkthrough write goes under `data/`, which is
gitignored. You can delete it at any time.

---

## 1. Automated checks

```powershell
npm run typecheck     # tsc --noEmit — must print nothing
npm test              # full Vitest suite
```

Expected (test count grows as the project does):

```
 Test Files  28 passed (28)
      Tests  324 passed (324)
```

The suite includes real-socket multi-node tests, adversarial cases
(inflated coinbases, bogus proof-of-work, malformed peer frames,
connection floods, checkpoint conflicts, tampered keystores…), and a
CLI end-to-end test over a real HTTP JSON-RPC server. It takes roughly a
minute.

---

## 2. Three-process simulation

```powershell
npm run simulate
```

This spawns three separate node processes (P2P ports 8001–8003, RPC
9001–9003), connects them into a mesh, mines one block on node 1, and
asserts that nodes 2 and 3 converge on it and hold byte-identical block
bodies. The processes are killed and `data/sim-node*` is recreated on
every run.

Expected output (addresses and hashes will differ):

```
=== Starting 3 node processes ===
[sim-node1] [sim-node1] p2p listening on ws://localhost:8001 (miner address …, throwaway: pass --miner-address to keep rewards)
[sim-node1] [sim-node1] rpc listening on http://127.0.0.1:9001
[sim-node1] [sim-node1] rpc auth token provided explicitly
[simulate] sim-node1 ready (p2p :8001, rpc :9001)
[sim-node2] [sim-node2] p2p listening on ws://localhost:8002 (…)
[sim-node2] [sim-node2] connected to peer ws://localhost:8001
…
[simulate] sim-node3 ready (p2p :8003, rpc :9003)
=== Waiting for mesh handshakes to settle ===
=== Mining one block on sim-node1 ===
[simulate] sim-node1 mined block 0000… at height 1
=== Waiting for sim-node2 and sim-node3 to converge ===
[simulate] sim-node2 converged
[simulate] sim-node3 converged
=== Verifying block bodies match across all nodes ===

✅ SUCCESS: all 3 nodes converged on the same block after propagation.
```

"throwaway" in the first line is expected here: the simulation doesn't
care where rewards go. A real miner passes `--miner-address` (see below).

---

## 2b. The same network in Docker

Requires Docker Desktop. From the repository root:

```powershell
docker compose up --build -d
docker compose ps
```

All three services report `(healthy)` within ~20 s; `node2`/`node3` only
start once their peers are healthy. Then:

```powershell
npm run testnet:check
```

```
[check] http://127.0.0.1:9001 healthy: node1 height=0 peers=2
[check] http://127.0.0.1:9002 healthy: node2 height=0 peers=2
[check] http://127.0.0.1:9003 healthy: node3 height=0 peers=2
[check] http://127.0.0.1:9001 has 2 peer(s)
[check] mined 0000… at height 1 on http://127.0.0.1:9001
[check] http://127.0.0.1:9002 converged
[check] http://127.0.0.1:9003 converged

✅ SUCCESS: 3 nodes converged on 0000…
```

The wallet CLI works unchanged against `--rpc http://127.0.0.1:9002` (RPC
token is `testnet-rpc-token` unless you set `L1_RPC_TOKEN` in a `.env`).
`docker compose logs -f node3` shows the structured node logs;
`docker compose down -v` stops everything and wipes the chain volumes.

TLS variant: `npm run testnet:tls`, then
`docker compose -f docker-compose.yml -f docker-compose.tls.yml up --build -d`,
and pass `--ca testnet/tls/ca-bundle.pem` (or `$env:L1_RPC_CA`) to the
wallet; `testnet:check` needs
`$env:L1_TESTNET_RPC_URLS = "https://127.0.0.1:9001,https://127.0.0.1:9002,https://127.0.0.1:9003"`
and `$env:L1_RPC_CA = "testnet/tls/ca-bundle.pem"`.

## 3. Two-wallet walkthrough

This uses **two terminals**: one runs a node, the other drives the
wallet. Both are opened in the repository folder.

> **PowerShell note.** `npm run wallet -- create --wallet …` does *not*
> work from PowerShell: PowerShell strips the first `--`, so npm swallows
> `--wallet` as its own option. Call the CLI directly with
> `npx tsx src/cli/main.ts …` instead, as shown below. (`npm run wallet -- …`
> works from Git Bash and cmd.)

Addresses print in a checksummed form (`l11…`); a typo in one is refused
instead of sending coins to nobody. The raw 64-hex form is still accepted
everywhere. `wallet create` makes an HD wallet backed by a 12-word recovery
phrase: `account new` derives more accounts from it, `seed` prints the
phrase again, `restore --mnemonic "<words>"` rebuilds the wallet on another
machine, `watch-only --out <path>` writes a keyless copy that can only read,
and `history` lists confirmed transactions.

### Terminal 1 — create wallets, start a node that mines to Alice

```powershell
npx tsx src/cli/main.ts create --wallet data/alice.json
npx tsx src/cli/main.ts create --wallet data/bob.json
```

Each `create` prompts twice (`Wallet passphrase:` / `Confirm passphrase:`);
nothing is echoed while you type. Expected:

```
wallet created: data/alice.json
address: l11cy4yuued84u00tdv6pr4ud7sungyldv0xpqp3rc0fpmmcfzm77hs7lc49k
recovery phrase: output spread ball rapid thunder will enable slight calm assault antenna legal
write the recovery phrase down and keep it offline: it recreates every account of this wallet ("restore"), and anyone who has it has your coins
```

(Your phrase and address will differ.) The file holds the phrase's entropy
encrypted with your passphrase (scrypt + AES-256-GCM); the address and
public key are stored in the clear so `address`/`balance` don't need the
passphrase. To see the restore path work, rebuild Alice under a new name
from the phrase and check the address matches; a phrase with a typo is
refused before a passphrase is asked:

```powershell
npx tsx src/cli/main.ts restore --wallet data/alice2.json --mnemonic "output spread ball rapid thunder will enable slight calm assault antenna legal"
npx tsx src/cli/main.ts restore --wallet data/alice3.json --mnemonic "output spread ball rapid thunder will enable slight calm assault antenna legit"
```

```
wallet restored: data/alice2.json (restored from recovery phrase)
address: l11cy4yuued84u00tdv6pr4ud7sungyldv0xpqp3rc0fpmmcfzm77hs7lc49k
error: --mnemonic: "legit" is not a BIP-39 word
```

A watch-only copy holds the addresses and no keys; it can show balances
and history but every signing command is refused up front:

```powershell
npx tsx src/cli/main.ts watch-only --wallet data/alice.json --out data/alice-watch.json
npx tsx src/cli/main.ts send --wallet data/alice-watch.json --to <bob> --amount 1
```

```
watch-only wallet written: data/alice-watch.json (1 account, no keys)
error: this wallet is watch-only (addresses, no keys): it cannot sign a payment
```

Now start a node whose block rewards go to Alice:

```powershell
$alice = npx tsx src/cli/main.ts address --wallet data/alice.json
npx tsx src/node/main.ts --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1 --rpc-token t --miner-address $alice
```

Expected — and then the terminal stays busy running the node:

```
[n1] p2p listening on ws://localhost:8001 (miner address c655…161b)
[n1] rpc listening on http://127.0.0.1:9001
[n1] rpc auth token provided explicitly
```

Leave this terminal alone until the end.

### Terminal 2 — mine, pay, verify

Set up a few variables first. (Shell variables don't survive a new
terminal window — if `$bob` ever prints nothing, re-run these lines.)

```powershell
$alice = npx tsx src/cli/main.ts address --wallet data/alice.json
$bob   = npx tsx src/cli/main.ts address --wallet data/bob.json
$body  = '{"jsonrpc":"2.0","id":1,"method":"mine"}'
$hdr   = @{ "Content-Type" = "application/json"; Authorization = "Bearer t" }
```

`mine` is a protected RPC method, hence the bearer token (`t`, the value
passed as `--rpc-token` in terminal 1).

**Step 1 — mine one block; the reward exists but is immature**

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9001/rpc -Headers $hdr -Body $body | Out-Null
npx tsx src/cli/main.ts balance --wallet data/alice.json
```

```
address:   l11cy4y…lc49k
total:     5000000000
spendable: 0
immature:  5000000000 (coinbase outputs awaiting 10 confirmations)
```

Coinbase maturity is 10 (`config/default.json`): a reward mined at height
*h* can be spent once the next block would be at *h + 10*.

**Step 2 — mine ten more; the early rewards mature**

```powershell
1..10 | ForEach-Object { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9001/rpc -Headers $hdr -Body $body | Out-Null }
npx tsx src/cli/main.ts balance --wallet data/alice.json
```

```
address:   l11cy4y…lc49k
total:     55000000000
spendable: 10000000000
immature:  45000000000 (coinbase outputs awaiting 10 confirmations)
```

With the tip at height 11, the rewards from heights 1 and 2 are spendable
(1 + 10 ≤ 12 and 2 + 10 ≤ 12); the other nine are still locked.

**Step 3 — pay Bob**

```powershell
npx tsx src/cli/main.ts send --wallet data/alice.json --to $bob --amount 777
```

It asks for Alice's passphrase, then:

```
sent 777 to e006…c322 (fee 1, 1 input)
txId: 3db8a5baa67420d77568d5dcad8cb43e4c9142502c2c5c7b80bca2071e5eafa0
```

Keep the `txId`. The fee defaulted to the node's minimum (1). The wallet
picked one mature coinbase output as input and sent the change back to
Alice.

**Step 4 — mine it in, check Bob**

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9001/rpc -Headers $hdr -Body $body | Out-Null
npx tsx src/cli/main.ts balance --wallet data/bob.json
```

```
address:   l11e0…(bob)
total:     777
spendable: 777
immature:  0
```

**Step 5 — SPV-verify the payment**

Replace the id with the one `send` printed:

```powershell
npx tsx src/cli/main.ts verify --tx 3db8a5baa67420d77568d5dcad8cb43e4c9142502c2c5c7b80bca2071e5eafa0
```

```
transaction 3db8…afa0
confirmed in block 0000… at height 12 (index 1)
confirmations: 1
header chain valid from trusted genesis: 13 headers, 13 downloaded, 0 from local store; proof-of-work and retargets checked
inclusion proof valid: 1 sibling hashes fold to the header's merkle root
```

What just happened: the CLI downloaded every block *header* from the
node, checked that the chain starts at the genesis it trusts (computed
locally from `config/default.json`), that every header links to the
previous one and carries valid proof-of-work at the target the retarget
rule dictates (a retarget happened at height 10), then asked the node for
a merkle inclusion proof and folded the transaction id up to the merkle
root inside that proof-of-work-protected header. At no point did it trust
the node's balance or UTXO state.

**Step 6 — chain info**

```powershell
npx tsx src/cli/main.ts info
```

```
network:          plainchain-devnet
genesis:          5598…d559
tip:              height: 12  hash: 0000…
peers:            0
block reward:     5000000000
min fee:          1
coinbase maturity: 10
```

### The guards (each should fail with one line and a non-zero exit)

```powershell
# insufficient funds — fails BEFORE asking for the passphrase
npx tsx src/cli/main.ts send --wallet data/alice.json --to $bob --amount 999999999999
```
```
error: insufficient funds: need 1000000000000, have 14999999222 spendable (45000000001 more in coinbase outputs not yet mature)
hint: coinbase rewards are not yet mature; wait for more blocks
```
(The numbers reconcile: need = amount + fee 1; spendable = three matured
rewards − 777 − 1; immature includes the 1-unit fee Alice collected as
miner of block 12.)

```powershell
# typo in the recipient — the checksum catches it, so the CLI refuses
npx tsx src/cli/main.ts send --wallet data/alice.json --to ($bob.Substring(0, $bob.Length - 1) + "x") --amount 1
```
```
error: --to: address checksum does not match (typo?); coins sent to a typo are unrecoverable
```

```powershell
# wrong passphrase — nothing is broadcast
npx tsx src/cli/main.ts send --wallet data/alice.json --to $bob --amount 1
```
Type a wrong passphrase:
```
error: wrong passphrase or tampered keystore
```

```powershell
# a node whose genesis differs from the one the client trusts
npx tsx src/cli/main.ts verify --tx <txId> --genesis-hash ("e" * 64)
```
```
error: verification failed: node reports genesis 5598…d559, but the trusted genesis is eeee…eeee
```

```powershell
# a transaction that isn't confirmed (or doesn't exist)
npx tsx src/cli/main.ts verify --tx ("f" * 64)
```
```
error: node rejected the request (-32001): transaction not found in the canonical chain (unknown, not confirmed, or in an abandoned fork)
```

```powershell
# no node running on the given port
npx tsx src/cli/main.ts info --rpc http://127.0.0.1:1
```
```
error: could not reach node at http://127.0.0.1:1: bad port
```

Check the exit code of the last command with `$LASTEXITCODE`: `0` ok,
`1` the operation failed, `2` bad usage.

### Optional: a second node joining late (header-first sync)

In a third terminal, start a node that only knows about `n1`:

```powershell
npx tsx src/node/main.ts --node-id n2 --port 8002 --rpc-port 9002 --data-dir data/n2 --rpc-token t --peers ws://localhost:8001
```

Then, back in terminal 2, compare tips — they should match within a
second:

```powershell
Invoke-RestMethod http://127.0.0.1:9001/chain/tip
Invoke-RestMethod http://127.0.0.1:9002/chain/tip
```

`n2` asked `n1` for headers, validated them, saw a heavier chain, and only
then downloaded the bodies. `npx tsx src/cli/main.ts info --rpc http://127.0.0.1:9002`
shows `peers: 1`.

### Optional: bump a pending payment (replace-by-fee)

Send without mining, then raise the fee while it is still pending:

```powershell
npx tsx src/cli/main.ts send --wallet data/alice.json --to $bob --amount 5 --fee 1
npx tsx src/cli/main.ts bump --wallet data/alice.json --tx <txId printed above> --fee 20
Invoke-RestMethod http://127.0.0.1:9001/mempool | Select-Object id, fee
```

The mempool holds only the replacement (`fee: 20`); the original id is
gone. Bumping it again fails with `not in the mempool`. A bump whose fee
is not higher is refused before the passphrase is asked. Mine, and the
coinbase output shows the reward plus the bumped fee.

### Optional: incremental header sync

`verify` saved the headers it checked to `data/headers.json`. Mine a few
more blocks, then verify again:

```powershell
1..3 | ForEach-Object { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9001/rpc -Headers $hdr -Body $body | Out-Null }
npx tsx src/cli/main.ts verify --tx <txId printed by send>
```

The last two lines now read `16 headers, 3 downloaded, 13 from local
store` — only the new headers crossed the wire. `npx tsx src/cli/main.ts sync`
does the same update without a proof and prints the verified tip. Edit any
hash inside `data/headers.json` and run `sync` again: it prints `warning:
… failed verification … re-syncing from genesis` and downloads everything
afresh — the file is a cache, not something the wallet trusts.

### Optional: RPC over TLS

Generate a self-signed certificate (no openssl needed), then restart the
node with it. In the node terminal, **Ctrl+C**, then:

```powershell
npx tsx scripts/genCert.ts --out data/tls --hosts localhost,127.0.0.1
npx tsx src/node/main.ts --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1 --rpc-token t --miner-address $alice --rpc-tls-cert data/tls/rpc-cert.pem --rpc-tls-key data/tls/rpc-key.pem
```

Expected: `rpc listening on https://127.0.0.1:9001 (TLS)`. In terminal 2:

```powershell
npx tsx src/cli/main.ts info --rpc https://127.0.0.1:9001
```

fails with `self-signed certificate … pass --ca <node-cert.pem>` (exit 1) —
the wallet does not trust unknown certificates. Pin it:

```powershell
npx tsx src/cli/main.ts info --rpc https://127.0.0.1:9001 --ca data/tls/rpc-cert.pem
```

prints the same `info` output as before. `$env:L1_RPC_CA = "data/tls/rpc-cert.pem"`
and `$env:L1_RPC_URL = "https://127.0.0.1:9001"` make every later wallet
command use TLS without flags. Mining over TLS from PowerShell (the
certificate is self-signed, so skip the OS trust check):

```powershell
Invoke-RestMethod -Method Post -Uri https://127.0.0.1:9001/rpc -Headers $hdr -Body $body -SkipCertificateCheck
```

Two guards worth seeing once: starting the node with `--rpc-bind 0.0.0.0`
and no certificate is refused (`refusing to serve cleartext RPC on
0.0.0.0 …`), and a `--rpc-tls-key` that belongs to a different certificate
is refused (`private key … does not match certificate …`).

### Optional: a consortium chain (proof of authority)

Two authorities and one validating-only node, on a chain with its own
config. Generate the two keys (each prints its public key):

```powershell
npx tsx scripts/genAuthority.ts --out data/poa/a.key
npx tsx scripts/genAuthority.ts --out data/poa/b.key
```

Write `data/poa/chain.json`, pasting the two public keys **in this order**
(the order is the turn schedule; only what differs from `config/default.json`
needs to be stated):

```json
{
  "networkId": "consortium",
  "consensus": { "mode": "poa", "authorities": ["<public key A>", "<public key B>"], "coinbaseMaturity": 0 }
}
```

Three terminals:

```powershell
npx tsx src/node/main.ts --config data/poa/chain.json --node-id poa-a --port 8201 --rpc-port 9201 --data-dir data/poa/a --rpc-token t --signer-key data/poa/a.key
npx tsx src/node/main.ts --config data/poa/chain.json --node-id poa-b --port 8202 --rpc-port 9202 --data-dir data/poa/b --rpc-token t --signer-key data/poa/b.key --peers ws://localhost:8201
npx tsx src/node/main.ts --config data/poa/chain.json --node-id poa-c --port 8203 --rpc-port 9203 --data-dir data/poa/c --rpc-token t --peers ws://localhost:8201
```

Each logs its role at startup: `proof of authority: this node signs blocks
as authority 0 of 2` / `validating only (no --signer-key)`. Then, in a
fourth terminal, ask A to produce a block twice, B once, and C once:

```powershell
$h = @{ "content-type" = "application/json"; authorization = "Bearer t" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9201/rpc -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"mine"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9201/rpc -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"mine"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9202/rpc -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"mine"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9203/rpc -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"mine"}'
```

The first call returns a block at height 1 immediately (no hash search: the
header carries `signer` and `signature`, `nonce` is 0). The second is
refused — `cannot produce a block: authority signed too recently: at most
one block per 2 consecutive blocks` — because with two authorities they
must alternate. B's call returns height 2, and C's is refused with `this
node has no signer key`. All three `/health` endpoints report `height: 2`,
and `npx tsx src/cli/main.ts info --rpc http://127.0.0.1:9203` prints
`consensus: proof of authority`. A light client verifies the signed
chain with the same config as its root of trust:

```powershell
npx tsx src/cli/main.ts sync --rpc http://127.0.0.1:9203 --config data/poa/chain.json --headers data/poa/headers.json
```

```
verified tip: height 2 hash …
3 headers, 3 downloaded, 0 from local store; authority signatures and turns checked
```

### Cleanup

Press **Ctrl+C** in the node terminal(s). To start over from scratch:

```powershell
Remove-Item -Recurse -Force data
```

---

### Optional: health, metrics and JSON logs

With a node running (terminal 1), in terminal 2:

```powershell
Invoke-RestMethod http://127.0.0.1:9001/health
(Invoke-WebRequest http://127.0.0.1:9001/metrics).Content
```

`health` returns `status: ok` with the node id, network, height, tip hash,
peer count, mempool size and uptime. `metrics` is Prometheus text; look for
`l1_chain_height`, `l1_blocks_adopted_total`, `l1_peers_connected{direction="inbound"}`
and `l1_rpc_calls_total{method="mine",outcome="ok"}` — mine a block and
scrape again to watch them move. Point a Prometheus `scrape_config` at
`127.0.0.1:9001` with `metrics_path: /metrics` to graph them.

Restart the node with `--log-format json` and every log line becomes one
JSON object (`{"ts":…,"level":"info","node":"n1","msg":"block adopted","height":…}`);
`--log-level warn` keeps only rejections, reorgs and bans.

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm warn Unknown cli config "--wallet"` and the wallet ignores your flags | PowerShell removed the `--` separator. Use `npx tsx src/cli/main.ts …` directly. |
| `--to is not a valid address` although you passed `$bob` | `$bob` is empty (new terminal). Re-run the variable setup lines. |
| `simulate` prints nothing for a long time | Ports 8001–8003 still held by a previous run: `netstat -ano \| findstr 800` → `taskkill /F /PID <pid> /T`. On this machine, also check Bitdefender hasn't quarantined the spawned processes (add an exclusion for the repository folder). |
| `verify` says `header chain invalid: … timestamp is too far in the future` | The node's clock and yours differ by more than 2 hours. |
| `balance` shows everything under `immature` | Expected until the chain is 10+ blocks past the reward. Mine more. |
| `The '<' operator is reserved for future use` | You pasted a placeholder like `<txId>` literally. Substitute the real value. |
| `could not reach node … self-signed certificate` | The node is on TLS with a self-signed cert. Pass `--ca data/tls/rpc-cert.pem` (or set `L1_RPC_CA`). |
| `Hostname/IP does not match certificate's altnames` | You connected by a name/IP that isn't in the cert's `--hosts`. Use one that is, or regenerate the cert. |

---

## 5. Same walkthrough in Git Bash / macOS / Linux

Here `npm run wallet -- …` works, and `$(…)` replaces PowerShell variables.

```bash
npm run wallet -- create --wallet data/alice.json
npm run wallet -- create --wallet data/bob.json

# terminal 1
npm run node -- --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1 --rpc-token t \
  --miner-address $(npm run -s wallet -- address --wallet data/alice.json)

# terminal 2
BOB=$(npm run -s wallet -- address --wallet data/bob.json)
mine() { curl -s -X POST http://127.0.0.1:9001/rpc -H "Content-Type: application/json" \
  -H "Authorization: Bearer t" -d '{"jsonrpc":"2.0","id":1,"method":"mine"}' > /dev/null; }

mine; npm run wallet -- balance --wallet data/alice.json
for i in $(seq 1 10); do mine; done; npm run wallet -- balance --wallet data/alice.json
npm run wallet -- send --wallet data/alice.json --to $BOB --amount 777
mine; npm run wallet -- balance --wallet data/bob.json
npm run wallet -- verify --tx <txId printed by send>
```

`L1_WALLET_PASSPHRASE=…` and `L1_RPC_URL=…` in the environment replace the
passphrase prompt and `--rpc` respectively, in either shell
(`$env:L1_WALLET_PASSPHRASE = "…"` in PowerShell).
