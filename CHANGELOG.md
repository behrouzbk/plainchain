# Changelog

All notable changes, newest first. Consensus-affecting changes name the
`RULES_VERSION` they introduce: nodes on different rule versions refuse to
peer, so such a change is a coordinated upgrade for every node of a chain.

## Unreleased

Rules version **5** (a coordinated upgrade: every node of a chain must run
it; existing data directories and genesis stay valid).

- **Record anchoring.** A transaction may carry up to 80 bytes of `data`
  (lowercase hex, usually a document's sha256), covered by its signatures
  and id; transactions without it hash exactly as before. Nodes index
  anchored records (reorg-safe, in the adoption batch) and answer JSON-RPC
  `getAnchors(data, limit)`. Wallet: `anchor --file|--hash` and
  `find-anchor --file|--hash`, which re-hashes the transaction and checks
  its merkle proof against SPV-verified headers instead of trusting the
  node. `bump` keeps the record. Guide: `docs/ANCHORING.md`; threat model
  §4.8.

## v0.1.1 — 2026-09-21

- **Renamed to PlainChain** (`behrouzbk/plainchain`, formerly `l1-node-engine`).
  Images now publish to `ghcr.io/behrouzbk/plainchain`; the devnet
  `networkId` is `plainchain-devnet` (handshake identity only — genesis and
  rules are unchanged, so no `RULES_VERSION` bump). Package name
  `plainchain`.
- Apache 2.0 licence, README.
- Kubernetes README notes for managed clusters.

## v0.1.0 — 2026-09-21

First tagged release (under the project's former name).
Rules version **4**.

### Stage 4 — beyond one laptop

- BIP-39 recovery phrases (all 24 reference vectors), keystore v3, watch-only
  wallet files; `wallet create` / `restore` / `watch-only`.
- Address-index pruning: `--addrindex-depth`, `--no-addrindex`,
  `getInfo.addressIndex`, RPC `-32005`.
- Pluggable consensus: `ConsensusEngine` with proof of work (default) and
  Clique-style proof of authority (`consensus.mode: "poa"`, `--signer-key`,
  `npm run gen-authority`); `--config` for a chain's own config; rules
  version 3.
- CI on every pull request, image published to GHCR on `main` and semver
  tags, `k8s/base` StatefulSet mesh + `k8s/kind` overlay.
- Security review preparation: `docs/REVIEW-BRIEF.md`, `SECURITY.md`,
  findings template. Self-audit fixes at the P2P boundary — claimed-hash
  poisoning (F6), the PoA signature moved inside the block hash (F7, rules
  version **4**), wire-shape validation of every peer payload (F8).

### Stage 3 — deployable

- RPC over TLS with an openssl-free certificate generator; wallet `--ca`.
- `/health`, Prometheus `/metrics`, structured text/JSON logs.
- Incremental SPV: persisted header store, fork-aware sync, `wallet sync`.
- Docker one-command testnet, `L1_*` env configuration, TLS overlay.
- Periodic peer re-discovery and reconnection with a persisted address book.
- Replace-by-fee (full RBF) and `wallet bump`.
- Mining on a worker thread, outside the chain lock.
- Configurable monetary policy (halvings, tail emission, genesis
  allocations), rules hash in the handshake.
- Threat model with code/test references for every mitigation; its
  findings fixed: block size limits, retarget window off-by-one and
  `RULES_VERSION` (, rules version 2), per-address inbound cap,
  proxy-aware rate limiting, checksummed addresses + HD accounts +
  transaction history.

### Stage 2 — hardened devnet

- Coinbase maturity, mempool limits and eviction; orphan handling and
  peer discovery; block validation layer and crash-proof message
  handling; JSON-RPC 2.0 and `listUnspent`; incremental reorgs
  with undo records and locator-based sync; crash-atomic adoption and
  the chain lock; RPC auth, rate limiting, loopback binding; P2P
  connection limits, capped sync, reputation and bans; encrypted
  keystore and wallet CLI; header-first sync, header index with chain
  work, checkpoints; SPV merkle proofs and a reorg-safe tx index.

### Stage 1 — the engine

Crypto primitives, UTXO ledger, LevelDB state, mempool, proof-of-work
consensus with difficulty retargeting and fork choice, WebSocket gossip,
JSON-RPC, and the three-process simulation. Rules version 1.
