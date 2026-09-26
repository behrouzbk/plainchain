# PlainChain

A complete Layer 1 blockchain node, small enough to read in an afternoon.

Formerly `l1-node-engine`.

Written from scratch in TypeScript on Node.js with **no blockchain SDKs**:
every hash, signature, Merkle tree, key derivation and TLS certificate comes
from Node's built-in `crypto`, and the only runtime dependencies are
`express`, `level` and `ws`. It runs a proof-of-work chain by default, or a
proof-of-authority chain for a group of companies that want a shared ledger
without a public token. About 17,000 lines under `src/`, 576 tests — a large
share of them explicit attacks that the rules are shown to stop.

**Status:** v0.1.1. Feature-complete for private and consortium use;
internally audited with a public threat model; **no external security
review yet** (see [Security](#security)).

## What is inside

| Area | What you get |
|---|---|
| Consensus | Proof of work with fork-aware difficulty retargeting, or Clique-style proof of authority (an ordered set of signers take turns). Block size limits, halving schedule, checkpoints. Nodes with different rules refuse to peer. |
| Ledger | UTXO accounting, coinbase maturity, crash-atomic reorganisations with undo records, reorg-safe transaction and address indexes (with optional pruning). |
| Network | WebSocket gossip, header-first sync, peer discovery with a persisted address book, reputation and bans, per-address connection caps, every payload type-checked at the boundary. |
| Mempool | Fee-ordered with eviction, full replace-by-fee. |
| Record anchoring | Put a document's sha256 on chain in a transaction (up to 80 bytes of data) and prove later that it existed by the block's time. `getAnchors` over JSON-RPC; `wallet anchor` / `find-anchor`, which checks the proof itself instead of trusting the node. |
| Wallet | BIP-39 recovery phrases, SLIP-0010 accounts, checksummed addresses, watch-only files, fee bumping, transaction history, and an SPV light client that verifies headers and Merkle proofs itself. |
| Operations | JSON-RPC 2.0 with bearer auth, rate limiting and TLS; `/health` and Prometheus `/metrics`; JSON logs; every setting as a flag or `L1_*` env var; Docker compose testnet; Kubernetes manifests. |

Not included, on purpose: smart contracts or scripting, a public token,
transaction privacy.

## Ten-minute start

Requires Node.js 20 or newer (22 recommended) and Git.

```bash
git clone https://github.com/behrouzbk/plainchain.git
cd plainchain
npm ci
npm test            # 576 tests, about three minutes
npm run simulate    # three real node processes: mine, propagate, agree
```

Run a node and talk to it with the wallet:

```bash
npm run node -- --node-id n1 --port 8001 --rpc-port 9001 --data-dir data/n1 --rpc-token t

# in another terminal
npm run wallet -- create --wallet data/alice.json     # prints a 12-word recovery phrase
npm run wallet -- info
```

To understand the code rather than just run it, read
[docs/READ-IN-AN-AFTERNOON.md](docs/READ-IN-AN-AFTERNOON.md): six modules,
four hours, an exercise each. To go deeper, the
[paid course](https://behrouzbk.github.io/plainchain/#course) removes the
key functions from this codebase and has you write them back, chapter by
chapter, with the node's own tests as the judge.

The step-by-step walkthrough with the expected output of every command —
paying between two wallets, mining, replace-by-fee, light-client
verification, TLS, proof of authority — is
[docs/HANDS-ON-TESTING.md](docs/HANDS-ON-TESTING.md).
(On PowerShell use `npx tsx src/cli/main.ts …` for the wallet; PowerShell
drops the `--` separator.)

## Run a network

```bash
docker compose up --build -d && npm run testnet:check   # three containers in a mesh
kubectl apply -k k8s/base                                # the same mesh on any Kubernetes cluster
```

See [k8s/README.md](k8s/README.md) for kind, GKE and production notes
(image pull secret, RPC token, TLS).

## Run your own chain

A chain is a config file that states only what differs from
`config/default.json` — its name, genesis allocation, block time, and how
blocks are made:

```bash
npm run genesis -- --allocations <address>:<amount>        # a premine and its genesis hash
npm run gen-authority -- --out data/a.key                  # a proof-of-authority signer key
npm run node -- --config chain.json --signer-key data/a.key
```

`{"consensus": {"mode": "poa", "authorities": ["<key A>", "<key B>"]}}` is
enough for a two-authority consortium chain. Wallets pass the same
`--config` so the authority set is their root of trust.

## Documentation

| Document | Read it for |
|---|---|
| [docs/READ-IN-AN-AFTERNOON.md](docs/READ-IN-AN-AFTERNOON.md) | **Start here.** A guided walk through the six modules in build order, with one test to run and one exercise per module |
| [docs/L1-NODE-ENGINE.md](docs/L1-NODE-ENGINE.md) | The architecture, every consensus rule as enforced, the P2P and RPC protocols, how to run and test |
| [docs/HANDS-ON-TESTING.md](docs/HANDS-ON-TESTING.md) | Every feature exercised by hand, with expected output |
| [docs/ANCHORING.md](docs/ANCHORING.md) | Record anchoring: anchor a file, check it, the JSON-RPC calls, and what a proof does and does not mean |
| [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) | About 60 threats, each tied to the code that stops it and the test that proves it; accepted risks; findings and fixes |
| [docs/REVIEW-BRIEF.md](docs/REVIEW-BRIEF.md) | The package for a security reviewer: scope, risk areas in priority order, how to report |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release, with the consensus rules version |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The engineering conventions: layering, test-first, one attack test per rule, how to send a change |

## Security

The threat model is public and every rule in it has an attack test. Three
self-audits have found and fixed eight issues (listed in the threat model's
findings table). An independent review has **not** been done yet; until it
has, treat this as pre-audit software and do not put value you cannot
afford to lose on a chain built with it.

Report a vulnerability privately per [SECURITY.md](SECURITY.md).

## Licence

[Apache License 2.0](LICENSE).
