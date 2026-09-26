# PlainChain (L1 Node Engine) — project document

_Last updated: 2026-09-19. Reflects `main` plus a pull request (in review)._

## Contents

1. [Executive summary](#1-executive-summary)
2. [What the project is](#2-what-the-project-is)
3. [Architecture](#3-architecture)
4. [Stages and tasks](#4-stages-and-tasks)
5. [How to run](#5-how-to-run)
6. [How to test](#6-how-to-test)
7. [Roadmap](#7-roadmap)

---

## 1. Executive summary

PlainChain (the L1 Node Engine) is a standalone Layer 1 blockchain node written from
scratch in TypeScript on Node.js, with **no external blockchain SDKs** — every
cryptographic primitive, ledger rule, consensus mechanism, and network
protocol is implemented in the repository from Node's native `crypto` module
and general-purpose libraries (LevelDB, `ws`, `express`). It runs entirely on
local infrastructure at $0 cost.

It is a complete, working chain: nodes seal blocks by proof of work or, for
consortium deployments, by a Clique-style proof of authority; gossip blocks
and transactions over WebSockets; validate every consensus rule; resolve
forks by heaviest chain with incremental crash-atomic reorgs; expose a
JSON-RPC 2.0 interface to wallets; and converge on byte-identical state.
Every component was built test-first; the suite stands at **576 tests**, a
large share of which are explicit adversarial cases (coin-minting attempts,
inflated coinbases, forged targets and seals, malformed peer traffic,
hash poisoning, mid-reorg failures). Behaviour is additionally verified
live by spawning multiple real OS processes, and on Docker and Kubernetes.

**Stage 1** (the six-area scope), **Stage 2** (hardening, the tracking issue),
**Stage 3** (deployability, the tracking issue) and the code slices of **Stage 4**
(the tracking issue: recovery phrases and watch-only wallets, address-index pruning,
pluggable consensus with proof of authority, CI with a published image and
Kubernetes manifests, security-review preparation) are complete and tagged
as **v0.1.0**. What remains is external: an independent security review
against `docs/THREAT-MODEL.md`, for which `docs/REVIEW-BRIEF.md` is the
package.

## 2. What the project is

### 2.1 Scope (as originally set)

| # | Area | Status |
|---|---|---|
| 1 | Cryptographic ledger primitives — transactions, inputs/outputs, Ed25519 signatures, Merkle trees, SHA-256 blocks | ✅ |
| 2 | Local state management — UTXO database and state-transition validation on LevelDB | ✅ |
| 3 | In-memory mempool — validation, fee prioritisation, duplicate rejection | ✅ (+ size limits, eviction, min fee) |
| 4 | L1 consensus engine — PoW mining, difficulty retarget, fork resolution by heaviest chain | ✅ (+ full block validation, incremental crash-atomic reorg) |
| 5 | P2P gossip networking — WebSocket node-to-node block/tx broadcast | ✅ (+ discovery, orphan handling, identity check, cross-fork sync) |
| 6 | External JSON-RPC interface for wallet interactions | ✅ (JSON-RPC 2.0 + `listUnspent`; auth + rate limiting in a pull request) |

### 2.2 Hard constraints honoured

- **Zero external blockchain libraries.** No `ethers`, `web3`, `bitcoinjs`.
- **Deterministic execution.** All hashing and serialisation is canonical
  (fixed field order, explicit `bigint` encoding). Any two nodes given the
  same blocks reach byte-identical UTXO state; this is asserted by the
  multi-node tests and the live simulation.
- **High test coverage on the risky parts.** Core math, signatures, block
  rules, fork/reorg behaviour, and network robustness all have dedicated
  tests, including the attack each rule prevents.

### 2.3 What it is not (yet)

A public, internet-facing mainnet. It is a devnet-grade engine with a
credible path to a private/consortium chain or a public testnet. The gaps
are enumerated in §7.

## 3. Architecture

### 3.1 Component diagram

```
                         ┌─────────────────────────────────────────┐
                         │                Node Process               │
                         │                                           │
   Wallet / CLI          │   ┌───────────┐        ┌───────────────┐ │      Peer Node
   client          ───── │──▶│  RPC Layer │◀──────▶│  Node Facade   │ │      (same
        (HTTP)           │   │ (express)  │        │  (orchestrator)│ │       shape)
                         │   └───────────┘        └──────┬────────┘ │
                         │                                 │          │
                         │        ┌────────────────────────┼───────┐  │
                         │        ▼                         ▼       │  │
                         │  ┌───────────┐            ┌─────────────┐│  │
                         │  │  Mempool   │◀──────────▶│  Consensus  ││  │
                         │  │ (pending   │  tx/block  │ PoW miner,  ││  │
                         │  │  txs, fee  │  validation│ retarget,   ││  │
                         │  │  policy)   │            │ fork choice,││  │
                         │  └─────┬─────┘            │ block rules ││  │
                         │        ▼                   └──────┬──────┘│  │
                         │  ┌────────────────────────────────────┐   │  │
                         │  │        Ledger / State Layer         │   │  │
                         │  │  - Block & Tx primitives + rules    │   │  │
                         │  │  - UTXO set (validate + apply)      │   │  │
                         │  │  - Merkle tree                      │   │  │
                         │  │  - Chain index (height, tip, reorg) │   │  │
                         │  └────────────────┬────────────────────┘   │  │
                         │                   ▼                        │  │
                         │           ┌─────────────────┐              │  │
                         │           │  Persistence    │              │  │
                         │           │  (LevelDB)      │              │  │
                         │           │  blocks / utxo  │              │  │
                         │           │  meta / undo    │              │  │
                         │           └─────────────────┘              │  │
                         │   ┌───────────────────────────────────┐    │  │
                         │   │        P2P Network Layer          │◀───┼──┘
                         │   │  ws server + client, gossip,      │    │
                         │   │  identity check, peer discovery   │    │
                         │   └───────────────────────────────────┘    │
                         └─────────────────────────────────────────┘
```

### 3.2 Layers and their rules

| Layer | Directory | Responsibility | May depend on |
|---|---|---|---|
| Crypto | `src/crypto/` | SHA-256, Ed25519 keys/sign/verify, Merkle root | — |
| Metrics | `src/metrics/` | Prometheus-style counter/gauge registry and text exposition | — |
| Ledger | `src/ledger/` | Transaction/block types, ids, signing payload, structural rules, addresses, wire serialisation | crypto |
| State | `src/state/` | LevelDB handle and sublevels; UTXO set (validate/apply/undo, staging overlay); chain index (blocks, tip, heights, undo records, headers with cumulative work); atomic commit | ledger, crypto |
| Mempool | `src/mempool/` | Pending transactions: fee ordering, duplicate rejection, min fee, capacity with eviction, replace-by-fee (conflicts must outbid combined fees + min fee; bounded evictions) | state |
| Consensus | `src/consensus/` | PoW target check and worker-thread miner; difficulty retarget; cumulative-work fork choice; context-free block validation | state |
| Network | `src/network/` | Message protocol; per-peer socket wrapper; WebSocket server/client, gossip, chain-identity check, duplicate-link collapse | all above |
| RPC | `src/rpc/` | JSON-RPC 2.0 dispatcher, REST routes, bearer-token auth, rate limiting, TLS, `/health` + `/metrics` | all above |
| Node | `src/node/` | The only module that wires everything: block adoption and reorgs, orphan pool, sync, discovery policy, mining, CLI entrypoint | everything |

Layering is enforced by convention (documented in `CONTRIBUTING.md`) and is one-way
top to bottom.

### 3.3 Data model

```
TxOutput     { address, amount: bigint }
TxInput      { txId, outputIndex, signature, publicKey }
Transaction  { id, inputs[], outputs[], timestamp, fee: bigint, data? }
BlockHeader  { version, previousHash, merkleRoot, timestamp, difficultyTarget, nonce, height }
Block        { header, transactions[], hash }
```

Every input signs one payload (referenced outpoints + outputs + timestamp +
fee + `data` when present). `data` is an optional record of up to 80 bytes
of lowercase hex, usually a document's sha256 (see `docs/ANCHORING.md`);
a transaction without it serialises exactly as before. A transaction's `id` is the SHA-256 of its full serialisation including
signatures. A block's `hash` is the SHA-256 of its serialised header. An
address is the SHA-256 of a public key. Money is always a `bigint`.

### 3.4 Consensus rules (as enforced)

**Transaction** (`ledger/transaction.ts`, `state/utxoSet.ts`): id matches
content; at least one output; every amount positive; fee non-negative; no
outpoint referenced twice; `data`, if present, is 1–80 bytes of lowercase
hex; every input exists, is owned by the signing key
(address = hash of the presented public key), and its signature verifies;
inputs ≥ outputs + fee; coinbase outputs are unspendable for
`coinbaseMaturity` blocks.

**Block** (`consensus/blockValidator.ts`): hash matches header; difficulty
target equals what the retarget rule dictates for that height _on the
block's own ancestry_ (so forks validate correctly); hash meets target;
`previousHash`/`height` chain to the parent; timestamp strictly after the
parent's and no more than `maxFutureDriftMs` ahead of local time; exactly
one coinbase, at index 0; Merkle root matches; no duplicate transaction ids;
no outpoint spent twice within the block; coinbase ≤ the scheduled reward for
that height + fees; at most 5000 transactions and 1 MB of canonical bytes. Emission: `monetary.initialReward`, halved every
`halvingInterval` blocks, floored at `tailEmission`; genesis mints only its
allocation. Nodes hash these rules into the handshake and refuse peers whose
rules differ.

**Seal** (`consensus/engine.ts`): proof of work by default — the hash meets
the target. With `consensus.mode: "poa"` a fixed, ordered set of
authorities signs instead: the header's `signer` (part of the hash) must be
an authority whose `signature` over the hash verifies; no signer may sign
more than one of any floor(n/2)+1 consecutive blocks; the block of the
authority whose turn it is (`height mod n`) weighs 2, any other 1. Mode and
authority set are part of the handshake rules hash.

**Chain**: heaviest cumulative work wins (work per block = 2²⁵⁶/(target+1)
under proof of work, 2 or 1 under proof of authority),
strictly greater to switch. Bitcoin-style linear difficulty retarget every
`difficultyRetargetInterval` blocks, clamped to `maxDifficultyAdjustmentFactor`.

### 3.5 Block adoption and reorgs

Adopting a tip is incremental and crash-atomic. Each connected block has an
undo record (outputs created, full entries consumed). A reorg walks both
chains to the fork point, disconnects the old blocks above it via their undo
records, and connects the new ones — O(fork depth). Nothing touches disk
during this: UTXO changes stage in an in-memory overlay (reads see it, so
chained spends validate), and UTXO + undo + height index + tip are committed
as **one cross-sublevel LevelDB batch**, which LevelDB applies all-or-nothing.
A block that fails against state simply discards the overlay. Non-coinbase
transactions from abandoned blocks return to the mempool. All chain/UTXO
mutations are serialised through a single lock.

### 3.6 P2P protocol

JSON envelopes `{ type, payload }` over WebSockets, bigints tagged for a
lossless round-trip. Malformed frames drop the peer.

| Message | Purpose |
|---|---|
| `HANDSHAKE { version, nodeId, height, listenAddress, networkId, genesisHash }` | Sent by both sides on connect. Mismatched `networkId`/`genesisHash` → rejected. Duplicate links and self-connections are collapsed. |
| `GET_BLOCKS { fromHeight, locator[] }` | Catch-up and gap fill. The block locator (dense near the tip, then exponentially sparser, ending at genesis) lets the responder find a shared ancestor across forks. Replies are capped at 500 blocks. |
| `INV_BLOCKS { hashes[] }` | Continuation of a capped `GET_BLOCKS` reply: "the rest starts here". The requester pulls the next batch, so no single request can make a node stream its whole chain. |
| `NEW_BLOCK { block }` / `NEW_TX { transaction }` | Gossip; relayed onward only if accepted. |
| `GET_PEERS {}` / `PEERS { addresses[] }` | Peer discovery, on connect and every 30 s. Learned addresses go into a persisted, bounded address book with per-address backoff; a few are dialled per tick while outbound room remains, so dropped peers are re-dialled and late joiners found. |

Orphans (blocks whose parent is unknown) are queued (capped) and re-evaluated
when the parent arrives.

**Transport limits and peer reputation.** Inbound and outbound connection
slots are separate (32 / 8 by default), so an attacker filling the inbound
side can't stop a node from choosing its own peers. Inbound slots are
counted from socket accept and freed by a handshake deadline, so silent
connections can't hold them. Frames over 4 MB close the connection before
parsing. The node reports misbehavior to the transport, which bans a peer
(by nodeId and advertised address, for 10 minutes) once its score reaches
the threshold: an invalid block is an instant ban, structurally invalid
transactions accumulate, and rejections an honest peer could produce
(unknown outpoint, low fee, a timestamp that's only ahead by our clock)
are never penalized. Bans are deliberately not IP-based: on a single-host
devnet every peer shares 127.0.0.1. `--advertise-url` lets a node behind a
port-forward announce a reachable address; there is no automatic NAT
traversal.

### 3.7 RPC interface

**JSON-RPC 2.0 at `POST /rpc`** — single, batch, and notification requests;
positional or named params; bigints returned as decimal strings.

| Method | Params | Auth |
|---|---|---|
| `getTip` | — | public |
| `getBlockByHeight` / `getBlockByHash` | `height` / `hash` | public |
| `getBalance` | `address` | public |
| `listUnspent` | `address` | public |
| `listTransactions` | `address, limit` | public |
| `getAnchors` | `data, limit` | public — confirmed transactions carrying the record, oldest first |
| `anchorRecord` | `data` | **bearer token** — the node signs and pays for the anchor with `--anchor-key`; idempotent (`pending` / `confirmed`) |
| `getSupply` | — | public |
| `getMempool` | — | public |
| `sendRawTransaction` | `transaction` (wire format) | public — must carry valid signatures |
| `mine` | — | **bearer token** |

Error codes: `-32700` parse, `-32600` invalid request, `-32601` method not
found, `-32602` invalid params, `-32603` internal, `-32000` transaction
rejected (with reason), `-32001` not found, `-32004` unauthorized.

REST equivalents exist for scripting: `GET /chain/tip`,
`/block/height/:h`, `/block/hash/:hash`, `/balance/:addr`, `/utxos/:addr`,
`/mempool`; `POST /tx`, `POST /mine`. Operators get `GET /health` (JSON
liveness, exempt from rate limiting) and `GET /metrics` (Prometheus text:
chain height, mempool, peers by direction, block/reorg/tx/message
counters, RPC calls by method and outcome, process gauges, build info),
plus `--log-format json` for log shippers.

With a pull request: RPC binds to `127.0.0.1` by default; a bearer token is generated
on first start into `<dataDir>/rpc-token` (or set via `--rpc-token` /
`L1_RPC_TOKEN`); per-client rate limiting with batch-aware accounting; 1 MB
body cap.

With Stage 3 / RPC TLS: `--rpc-tls-cert` + `--rpc-tls-key` serve HTTPS;
`npm run gen-cert` produces a self-signed pair without openssl; a
non-loopback bind without TLS is refused unless `--rpc-allow-insecure`.
Wallets pin the node's certificate with `--ca` / `L1_RPC_CA`.

## 4. Stages and tasks

### 4.1 Stage 1 — build the engine (complete)

| Task | Deliverable | Outcome |
|---|---|---|
| 1. Environment & repo bootstrap | `/src`, `/tests`, `/config`, dependencies (`level`, `ws`, `express`), Vitest | Done. Vitest chosen over Jest; Ed25519 (Node-native) over secp256k1; express over fastify — all approved up front. |
| 2. Ledger & crypto primitives | Types; SHA-256; Merkle root; keypair + sign/verify; deterministic tx ids and genesis block | Done, TDD. |
| 3. UTXO state & LevelDB persistence | Blocks/UTXO/tip persisted; double-spend prevention; signature-vs-owner check | Done, TDD. |
| 4. Consensus & mempool | Mempool rules; PoW nonce loop; difficulty retarget; heaviest-chain fork choice | Done, TDD. |
| 5. P2P & multi-node simulation | `HANDSHAKE`/`GET_BLOCKS`/`NEW_BLOCK`/`NEW_TX`; `npm run simulate` launching three real processes on 8001–8003 | Done. Two bugs found only by running real processes: a handshake race and a miner that couldn't retrieve its own block. |

### 4.2 Stage 2 — harden toward production (complete, the tracking issue)

| Slice | PR | Status | What it delivered |
|---|---|---|---|
| Coinbase maturity + mempool policy | | merged | Maturity tracking per UTXO; mempool `maxSize` with fee-based eviction; `minFee` actually enforced. |
| Orphan blocks + peer discovery | | merged | Orphan pool with gap requests; handshake-advertised addresses; `GET_PEERS`; duplicate-link collapse. Verified live across processes. |
| Consensus & robustness hardening | | merged | Architecture review found 7 holes (negative-amount minting, duplicate inputs, unbounded coinbase, unvalidated target/timestamps, process crash on garbage, non-atomic reorg, unused `networkId`). All closed with adversarial tests; `blockValidator` introduced. |
| JSON-RPC 2.0 + `listUnspent` | | merged | Standard wallet interface; wallets can now discover spendable outputs. |
| Incremental reorg | | merged | Undo log; O(fork depth). Found that `GET_BLOCKS` could never sync across a fork; fixed with a block locator. |
| Crash-atomic adoption | | merged | Single LevelDB batch per adoption; chain-mutation lock (fixed a latent race). |
| RPC auth + rate limiting | | merged | Loopback binding; cookie-style bearer token; batch-aware rate limits. |
| P2P hardening | | merged | Inbound/outbound connection limits, handshake deadline, frame-size cap, capped `GET_BLOCKS` + `INV_BLOCKS` continuation, peer reputation/banning, `--advertise-url`. Exposed a latent outbound-handshake race. |
| Wallet / CLI | | merged | Encrypted keystore (scrypt + AES-256-GCM), deterministic coin selection, `npm run wallet` (create/address/balance/unspent/send/info) as a pure JSON-RPC client; `getInfo` RPC; `--miner-address` for the node. Live check found rewards previously went to a throwaway key. |
| Header-first sync + checkpoints | | merged | `GET_HEADERS`/`HEADERS`; bodies fetched only for a heavier, header-valid chain; header index with cumulative work (sync was O(n²) in reads, now O(n)); `consensus.checkpoints` with a verified-checkpoint reorg guard. |
| SPV | | merged | Merkle inclusion proofs; `txindex` maintained in the adoption batch (reorg-safe); `getMerkleProof` + `getHeaders` RPC; `wallet verify --tx` checks the header chain from a trusted genesis and the proof, trusting PoW rather than the node. |

### 4.3 Stage 3 — make it deployable (complete, the tracking issue)

| Slice | PR | Status | What it delivered |
|---|---|---|---|
| RPC TLS | | merged | HTTPS for RPC with operator-supplied or generated certificates; startup validation of the PEM pair; cleartext refused off-loopback unless overridden; wallet `--ca` pinning with MITM tests; `JsonRpcClient` moved off `fetch` so a CA can be pinned. |
| Operator tooling | | merged | `/health` and Prometheus `/metrics` (chain, mempool, peers, reorgs, P2P messages, RPC calls by method/outcome with bounded cardinality, process gauges, build info); structured text/JSON logs with levels and fields. |
| Incremental SPV | | merged | Wallet keeps verified headers on disk and downloads only what is new; fork point found in O(log n) probes; a fork is followed only with strictly more work (a lighter fork is refused); the store is re-verified on load so tampering is caught; `wallet sync` command. |
| Docker testnet | | merged | Multi-stage image (non-root, healthcheck, secure default); every flag as an `L1_*` env var; `docker compose up` brings up a health-gated 3-node mesh on host loopback; TLS overlay with generated certs; `npm run testnet:check` smoke test. |
| Peer maintenance | | merged | Persisted address book with backoff; periodic `GET_PEERS` refresh and bounded re-dialling; nodes reconnect after peer restarts and restart without `--peers`; a `PEERS` flood is bounded in memory and dials. |
| Replace-by-fee | | merged | Full RBF in the mempool (outbid combined fees + min fee, bounded evictions, eviction after validation); replacements relay; `wallet bump` re-signs a pending payment with a higher fee from its change. |
| Worker-thread mining | | merged | Proof-of-work runs on a worker thread outside the chain lock; RPC and block adoption stay live while mining; a moved tip aborts and re-templates the search, a late solution is discarded as stale; adopted blocks purge invalidated mempool transactions. |
| Monetary policy | | merged | Configurable emission (initial reward, halving interval, tail emission) enforced on every coinbase; genesis premine via `allocations` + `npm run genesis`; `getSupply` RPC; a rules hash in the handshake refuses peers with different consensus/emission parameters. |
| Threat model | | merged | `docs/THREAT-MODEL.md`: assets, attackers, threat catalogue with code + test references for every mitigation, accepted risks, five tracked findings , reviewer guidance. |
| Block size limits | | merged | Threat-model finding F1 : `maxBlockBytes` and `maxTransactionsPerBlock` as consensus rules, enforced before per-transaction work, part of the rules hash; the block template fills by fee within them. |
| Retarget window fix | | merged | Threat-model F3  re-analysed (median-time-past cannot bind under strictly increasing timestamps); found and fixed the retarget off-by-one that raised difficulty ~10 % per period on a perfectly timed devnet chain; one shared rule for node and light client; `RULES_VERSION` in the handshake rules hash. |
| Per-address inbound cap | | merged | Threat-model F5 : `maxInboundPerIp`, refused at accept before any handshake; off by default for single-host devnets, on in the compose file; accept-time refusals are now logged. |
| Proxy-aware rate limiting | | merged | Threat-model F2 : `rpc.trustProxy` hop count (default 0) keys the rate limiter on the address the last trusted proxy appended to `X-Forwarded-For`; prepended entries are ignored; header ignored entirely when off. |
| Wallet UX | | merged | Checksummed (bech32m `l1…`) addresses accepted everywhere alongside raw hex ; SLIP-0010 HD keys with a v2 keystore (encrypted seed, accounts, seed backup/restore); reorg-safe address index with `listTransactions` RPC and `wallet history`. |

That closes the Stage 3 checklist (the tracking issue); third-party review is an
external step, with `docs/THREAT-MODEL.md` §8 as the brief.

### 4.4 Stage 4 — beyond one laptop (the tracking issue, in progress)

| Slice | PR | Status | What landed |
|---|---|---|---|
| BIP-39 mnemonics + watch-only wallets | | merged | Dependency-free BIP-39 (English list, checksum, PBKDF2 seed; all 24 reference vectors); `create` prints a recovery phrase, `restore` takes it back (typos refused by the checksum before anything is written); v3 keystore seals the phrase's entropy; `watch-only --out` writes a keyless copy that reads balances/history and refuses signing before any prompt. |
| Pluggable consensus (PoA) | | merged | `ConsensusEngine` (`consensus/engine.ts`) behind `validateHeader`, fork choice and `mineBlock`; `PoaEngine`: signed headers (signer in the hash), Clique-style once-per-floor(n/2)+1 rule, in-turn weight; mode + ordered authority set in the rules hash; `--signer-key`, `npm run gen-authority`, `--config` for a chain's own config; SPV verifies signed chains from a trusted authority set. |
| CI + published image + Kubernetes | | merged | GitHub Actions: typecheck + full suite + build, image build-and-boot, manifests rendered, on every PR; `ghcr.io/behrouzbk/plainchain` published on pushes to main and semver tags (tag must match `package.json`); `k8s/base` StatefulSet mesh (headless peer DNS, per-pod PVC, health probes, non-root) + `k8s/kind` overlay; live-verified on kind with `testnet:check` and a pod restart. |
| Address-index pruning | | merged | `--addrindex-depth n` keeps exactly the last n canonical blocks of wallet history (pruning rides in the adoption batch as the disconnect path; reorg-safe because deletes are idempotent), `--no-addrindex` keeps none; a changed depth is reconciled at startup (sweep or rebuild from the tx index); `getInfo.addressIndex` tells wallets what history covers and `wallet history` says so. |
| Record anchoring | | merged | Optional `data` field on transactions (≤ 80 bytes, signed, in the id; `RULES_VERSION` 5); reorg-safe `anchors` index; `getAnchors` RPC; `wallet anchor` / `find-anchor` (re-hashes the transaction, checks the merkle proof against SPV headers); `docs/ANCHORING.md`; threat model §4.8. |
| Node-paid anchoring | | in review | `--anchor-key` (`npm run gen-anchor-key`) + protected `anchorRecord(data)`: idempotent (a retry never pays twice), coin selection under the chain lock skipping coins pending transactions spend, change split into a pool of coins so many records fit in one block; `getInfo.anchoring`; `l1_anchor_requests_total`; threat model D8–D9. |
| External security review | — | prep in review; engagement pending | `docs/REVIEW-BRIEF.md` (reviewer package), `SECURITY.md`, findings issue template; the self-audit that preceded it found and fixed three P2P-boundary bugs (threat model F6–F8: claimed-hash poisoning, PoA signature outside the block hash, no wire type checks). |

## 5. How to run

For a scripted walkthrough with expected output at every step (automated
checks, the simulation, and a two-wallet mine → pay → SPV-verify session in
two terminals), see **[docs/HANDS-ON-TESTING.md](HANDS-ON-TESTING.md)**.

### 5.1 Prerequisites

Node.js ≥ 20 (developed on 25), npm. Windows, macOS, and Linux all work; on
Windows, behaviour-based antivirus may flag the multi-process simulation —
add a folder exclusion for the repository.

```bash
git clone https://github.com/behrouzbk/plainchain.git
cd plainchain
npm install
```

### 5.2 Single node

```bash
npm run node -- --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1
```

Flags: `--node-id`, `--port` (P2P), `--rpc-port`, `--data-dir`, `--peers`
(comma-separated `ws://host:port`), `--advertise-url`, `--miner-address`
(where block rewards go — a wallet address; otherwise a throwaway key),
`--rpc-token`, `--rpc-bind`. The RPC bearer token is printed as a file path
on first start (`<data-dir>/rpc-token`).

### 5.3 A local network by hand

```bash
npm run node -- --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1
npm run node -- --node-id n2 --port 8002 --rpc-port 9002 --data-dir data/n2 --peers ws://localhost:8001
npm run node -- --node-id n3 --port 8003 --rpc-port 9003 --data-dir data/n3 --peers ws://localhost:8001
```

Node 3 only knows node 1; peer discovery will connect it to node 2 as well.

### 5.4 Talking to a node

```bash
TOKEN=$(cat data/n1/rpc-token)

# Chain tip
curl -s localhost:9001/rpc -d '{"jsonrpc":"2.0","method":"getTip","id":1}'

# Mine a block (protected)
curl -s -H "Authorization: Bearer $TOKEN" localhost:9001/rpc \
  -d '{"jsonrpc":"2.0","method":"mine","id":2}'

# Spendable outputs for an address
curl -s localhost:9001/rpc \
  -d '{"jsonrpc":"2.0","method":"listUnspent","params":["<address>"],"id":3}'
```

A wallet builds a spend by calling `getInfo` and `listUnspent`, signing the
payload from `ledger/transaction.ts#getSigningPayload` with each input's
key, computing the id with `computeTransactionId`, and submitting via
`sendRawTransaction`. The bundled wallet does exactly that:

### 5.5 The wallet CLI

```bash
# Create two wallets (passphrase prompted without echo, or $L1_WALLET_PASSPHRASE)
npm run wallet -- create --wallet data/alice.json
npm run wallet -- create --wallet data/bob.json

# Run a node that mines to Alice
npm run node -- --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1 \
  --miner-address $(npm run -s wallet -- address --wallet data/alice.json)

# Mine a few blocks (see 5.4), then:
npm run wallet -- balance --wallet data/alice.json     # total / spendable / immature
npm run wallet -- send --wallet data/alice.json \
  --to $(npm run -s wallet -- address --wallet data/bob.json) --amount 1000
npm run wallet -- bump --wallet data/alice.json --tx <txId> --fee 20   # replace-by-fee while pending
npm run wallet -- balance --wallet data/bob.json        # after the next block
npm run wallet -- info                                  # network, tip, min fee, maturity
npm run wallet -- verify --tx <txId>                    # SPV: header chain (incremental, local store) + merkle proof
npm run wallet -- sync                                  # just update the local header store
```

The keystore file holds the wallet's recovery-phrase entropy encrypted with
scrypt + AES-256-GCM (`create` shows the 12-word phrase once; `restore
--mnemonic` rebuilds the wallet from it; `watch-only --out` writes a copy
without keys for a machine that should only read balances);
`send` refuses malformed addresses (a typo'd address has no owner), checks
funds before asking for the passphrase, and never spends immature coinbase
rewards. `--rpc` / `$L1_RPC_URL` point it at a node (default
`http://127.0.0.1:9001`).

### 5.5a A consortium chain (proof of authority)

```bash
npm run gen-authority -- --out data/a.key     # prints authority public key A
npm run gen-authority -- --out data/b.key     # prints authority public key B
# chain.json: { "networkId": "consortium", "consensus": { "mode": "poa", "authorities": ["<A>", "<B>"] } }
npm run node -- --config chain.json --node-id a --port 8001 --signer-key data/a.key
npm run node -- --config chain.json --node-id b --port 8002 --signer-key data/b.key --peers ws://localhost:8001
npm run node -- --config chain.json --node-id c --port 8003 --peers ws://localhost:8001   # validates only
```

`mine` on an authority signs a block at once (no hash search); an authority
that signed too recently gets `cannot produce a block: authority signed too
recently`, and node `c` gets `this node has no signer key`. Wallets pass the
same `--config` to `verify`/`sync` so the authority set is their root of
trust.

### 5.6 The automated simulation

```bash
npm run simulate
```

Spawns three real node processes on 8001–8003, mesh-connects them, mines a
block on node 1, and asserts nodes 2 and 3 converge on the identical block.
Cleans up its own processes and data directories.

### 5.7 Docker: one-command testnet

```bash
docker compose up --build -d      # three nodes in a mesh, RPC on 127.0.0.1:9001-9003
npm run testnet:check             # /health on all, mine on node1, others converge
docker compose logs -f
docker compose down -v            # -v wipes the chain volumes
```

The image (`Dockerfile`, multi-stage on `node:22-bookworm-slim`, runs as
the unprivileged `node` user, ships compiled JS + production deps only) is
configured entirely through `L1_*` environment variables — every `npm run
node` flag has one (`src/node/settings.ts`; flag beats env beats default).
Each container's `HEALTHCHECK` probes its own `/health`; `node2` and `node3`
start only once their peers are healthy, so the one-shot peer discovery
always finds a live mesh. Inside the containers RPC binds `0.0.0.0`, which
the node refuses in cleartext unless `L1_RPC_ALLOW_INSECURE=true`; the
compose file sets it because RPC is published on the host's loopback only.
For TLS instead: `npm run testnet:tls` writes a self-signed cert per node
under `testnet/tls/` (gitignored) plus a `ca-bundle.pem`, and
`docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d`
mounts them; then `L1_RPC_CA=testnet/tls/ca-bundle.pem` for the wallet and
`testnet:check`. Optional `.env`: `L1_RPC_TOKEN`, `L1_MINER_ADDRESS`,
`L1_LOG_FORMAT=json`, `L1_LOG_LEVEL`.

### 5.8 Kubernetes

```bash
kubectl apply -k k8s/base                        # any cluster: 3-node StatefulSet, image from GHCR
kubectl -n l1 rollout status statefulset/l1-node
kubectl -n l1 port-forward pod/l1-node-0 9001:9001 &   # …-1 9002, …-2 9003
L1_RPC_TOKEN=<token> npm run testnet:check
```

`k8s/README.md` covers the image pull secret (the GHCR package is private
while the repo is), replacing the placeholder RPC token, exposing RPC over
TLS, mounting a chain config and authority keys, and the `k8s/kind` overlay
for a local cluster with a locally built image. The image is published by
`.github/workflows/release.yml`; `ci.yml` runs the suite, boots the image
and renders the manifests on every pull request.

## 6. How to test

| Command | What it does |
|---|---|
| `npm test` | Full Vitest suite (221 tests), ~3 s. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run typecheck` | `tsc --noEmit`; must be clean. |
| `npm run simulate` | Live three-process convergence check. |

### 6.1 Test layout and conventions

`tests/` mirrors `src/` one-to-one. Unit tests for crypto/ledger/consensus
are pure; state and mempool tests use a temp LevelDB per test; network and
node tests use real sockets on ephemeral ports. Every consensus or network
rule has a test that demonstrates the attack it prevents — this is a
documented convention, and adding a rule starts with writing the attack.

Highlights of what is covered:

- Ledger: signature tampering, forged ids, negative and zero amounts,
  duplicate inputs.
- Block validation (17 cases): forged hash, wrong/easier target, bad
  parent/height, timestamp ordering and drift, missing/multiple/misplaced
  coinbase, inflated coinbase, bad Merkle root, duplicate txs, intra-block
  double spends.
- State: double spends, maturity, undo/redo exactness, staged-write
  semantics, listUnspent.
- Network: handshake race, dedup, self-connect rejection, identity
  mismatch, malformed frames, discovery convergence.
- Node integration: two- and three-node convergence, gossip, orphans,
  fork switches, mempool return after reorg, deep reorgs, a spy-based proof
  that a reorg is incremental (exactly 2 UTXO applications on a 9-block
  chain), a spy-based proof that adoption is one root batch with no direct
  sublevel writes, commit-failure rollback, garbage-resilience, and the
  full adversarial block set.
- RPC: every JSON-RPC method and error code, batches, notifications, auth
  paths, rate limiting including batch accounting.

### 6.2 Live verification recipes

Beyond the suite, these have been run against real processes and are worth
repeating after significant changes:

1. **Discovery**: start three nodes where node 3 knows only node 1; confirm
   with `netstat` that node 3 opens a connection to node 2.
2. **Cross-process reorg**: start two isolated nodes, mine 2 on A and 3 on
   B, restart B with `--peers` pointing at A; A must adopt B's chain and A's
   abandoned miner balance must read 0.
3. **Restart consistency**: kill the reorged node and restart it from its
   data directory; tip and balances must be unchanged.
4. **Auth and limits**: `POST /mine` without a token → 401; JSON-RPC `mine`
   without a token → `-32004`; a 201-call batch → 429 with `Retry-After`.

## 7. Roadmap

| Horizon | Items |
|---|---|
| Now | External security review against `docs/THREAT-MODEL.md`; keep deployments private/consortium until it is done. |
| Stage 4 (the tracking issue, in progress) | BIP-39 mnemonics and watch-only wallets (landed); address-index pruning (landed); pluggable consensus / proof of authority (landed); CI, published image and Kubernetes manifests (landed); external security review; optionally ACME for RPC TLS and NAT traversal. Smart-contract or scripting layer only if a market pulls for it. |
