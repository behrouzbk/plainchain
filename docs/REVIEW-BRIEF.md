# Security review brief

A self-contained package for a third-party reviewer. It says what to
review, how to run it, where the risk is, what has already been considered,
and how to report. Read it with `THREAT-MODEL.md`, which is the claim the
review is testing: *every rule the node enforces is named there, points at
its code, and quotes the test that shows the attack failing.*

## 1. What this is

A standalone Layer 1 blockchain node engine in TypeScript/Node.js
(≈17 000 lines under `src/`, three runtime dependencies: `express`,
`level`, `ws`). Everything cryptographic — hashing, Ed25519 signatures,
Merkle trees, key derivation (SLIP-0010, BIP-39), TLS certificate
generation — is built on Node's `node:crypto`; there is no blockchain SDK
in the dependency tree. It runs proof of work by default and proof of
authority for consortium deployments, with a UTXO ledger, header-first
sync, replace-by-fee mempool, an SPV light client in the wallet, JSON-RPC
over optional TLS, Docker and Kubernetes packaging.

Intended deployments: private and consortium ledgers, education, protocol
prototyping. There is no public token. See `L1-NODE-ENGINE.md` for the
architecture and `CONTRIBUTING.md` for the engineering conventions (one of which
matters for the review: a consensus or network rule is only ever added
together with a test showing the attack it prevents).

## 2. Scope

- **Commit**: tag `v0.1.0` (`302fbe6`) unless the engagement names a later
  tag; the reviewer pins it in the report. `CHANGELOG.md` lists what
  changes between tags, so a fix made during the review is visible.
- **In scope**: everything under `src/` and `scripts/`, the wire protocol,
  the RPC surface, the wallet and light client, `config/default.json`,
  `Dockerfile`, `docker-compose*.yml`, `k8s/`, `.github/workflows/`.
- **Out of scope** (`THREAT-MODEL.md` §9): smart contracts (none exist),
  transaction-graph privacy (none claimed), host security, npm
  supply-chain beyond `npm ci` with the lockfile, NAT traversal.
- **Not findings** — already accepted, `THREAT-MODEL.md` §6 and the R-column
  of every row: majority hash rate can reorg unprotected history; unconfirmed
  transactions are not final (full RBF); Sybil identities are free; SPV trusts
  work; a colluding majority of authorities controls a PoA chain; addresses
  and amounts are public. Reporting these again is welcome only with a new
  angle.

## 3. Ten-minute setup

```bash
git clone <repo> && cd plainchain && npm ci
npm test                       # 576 tests, ~3 min; nothing CI-specific
npm run simulate               # three real processes: mine, propagate, agree
docker compose up --build -d && npm run testnet:check && docker compose down -v
```

`docs/HANDS-ON-TESTING.md` walks every feature by hand with expected output
(wallet, RBF, SPV, TLS, metrics, proof of authority). `k8s/README.md` runs
the mesh on a local kind cluster.

## 4. Where the risk is, in priority order

| # | Area | Code | Why it is first |
|---|---|---|---|
| 1 | **Consensus rules** — what makes a block valid | `consensus/blockValidator.ts`, `ledger/transaction.ts`, `state/utxoSet.ts`, `consensus/monetary.ts`, `consensus/difficulty.ts` | An error here is theft or inflation. ~800 lines total; every rule has an `attack:` test. |
| 2 | **Proof of authority** (newest, never externally reviewed) | `consensus/engine.ts`, `ledger/block.ts#computeBlockHash`/`computeSealHash`, `node/node.ts#recentSignersFor` | Signed headers: signer and signature are inside the block hash, the signature is over the seal hash. Clique-style once-per-⌊n/2⌋+1 rule, in-turn weight 2. We want the turn rule and fork choice attacked (equivocation, out-of-turn floods, a stalled majority). |
| 3 | **Fork choice and reorgs** | `node/node.ts#handleIncomingBlock`, `#adoptBlock`, `#planReorg`, `#handleHeaders`, `consensus/forkChoice.ts` | Header-first sync decides "heavier" before downloading bodies; adoption is one atomic LevelDB batch with undo records. Checkpoints bound reorg depth. |
| 4 | **P2P boundary** | `network/protocol.ts#decodeMessage`, `network/wireShapes.ts`, `network/p2pServer.ts`, `network/reputation.ts` | Every payload is type-checked and canonicalized before a handler sees it; a block's claimed hash is recomputed. Self-audit found three boundary bugs here (§6) — look for a fourth. |
| 5 | **Mempool / RBF** | `mempool/mempool.ts` | Replacement must outbid the sum of conflicts plus `minFee`; at most `maxReplacements` evictions. |
| 6 | **Light client** | `wallet/spv.ts`, `wallet/headerStore.ts`, `cli/wallet.ts#syncVerifiedHeaders` | Verifies PoW/PoA headers from a trusted genesis (and authority set); refuses lighter forks; the header cache is re-verified on load. |
| 7 | **RPC** | `rpc/jsonRpc.ts`, `rpc/server.ts`, `rpc/auth.ts`, `rpc/rateLimit.ts`, `rpc/tls.ts` | Bearer token for `mine`, per-client rate limit with proxy hop counting, 1 MB body cap, hand-written X.509 encoder. |
| 8 | **Wallet keys** | `wallet/keystore.ts`, `wallet/hd.ts`, `wallet/mnemonic.ts`, `node/signerKey.ts` | scrypt→AES-GCM keystore, SLIP-0010, BIP-39 (all 24 reference vectors), watch-only files. |
| 9 | **Operations** | `node/settings.ts`, `Dockerfile`, `k8s/`, `.github/workflows/` | Secure defaults (loopback RPC, TLS or explicit opt-in), non-root image, capabilities dropped. |

## 5. What we most want challenged

1. Any way to make two honest nodes with the same blocks reach different
   state (determinism), or to make a node adopt a block another honest node
   rejects.
2. The proof-of-authority turn rule: can fewer than ⌊n/2⌋+1 authorities
   extend the chain, or can one authority make the in-turn chain lose?
3. Hash or identity poisoning at the P2P boundary: anything that lets a
   peer make a victim permanently refuse a legitimate block, header or
   transaction (`invalidBlockHashes`, `processedBlockHashes`, the orphan
   pool, the reputation table).
4. The fork-aware target computation (`expectedTargetFor`) and the retarget
   window shared with the light client.
5. Reorg atomicity under crash and under concurrent RPC (`withChainLock`).
6. The RBF fee rule as a relay-amplification vector.
7. Anything a malicious *node* can do to a wallet through JSON-RPC
   responses (the wallet trusts nothing but the genesis hash, the authority
   set and proof of work — verify that holds).
8. The hand-written X.509/DER encoder and the keystore format.

## 6. What has already been found and fixed

`THREAT-MODEL.md` §7 lists every finding with its fix. Five came from
writing the threat model (F1–F5, all fixed). Three more came from the
self-audit done while preparing this brief (F6–F8): a peer could poison any
block hash by *claiming* it on a junk header; the proof-of-authority
signature sat outside the block hash so a mangled copy shared the real
block's identity; peer-supplied headers were never type-checked, and a
numeric-string timestamp corrupted the next block template. All three had
attack tests written before the fix and are named in §4.2/§4.7.

## 7. How to work

- **Write the attack as a test** in `tests/<module>/` following the
  existing `attack:` convention; if it passes without a code change, that
  is a finding, and the test is the reproduction.
- **Use the seams**: `Node` takes an injectable `miner`, `logger`,
  `metrics`, `signerKey`; tests spin up real in-process nodes on ephemeral
  ports and a raw `P2PServer` "injector" that speaks the protocol without
  the rules (`tests/node/node.test.ts#makeInjector`).
- **Everything is observable**: `GET /metrics` (Prometheus), `GET /health`,
  JSON logs (`--log-format json`), `peer:rejected` / `peer:banned` events.

## 8. Reporting

Open one issue per finding using the **Security finding** issue template
(`.github/ISSUE_TEMPLATE/security-finding.md`), or send it privately per
`SECURITY.md` if it is exploitable on a running network. Each finding
should name: the affected component and threat-model row (or "none — new
threat"), severity on the scale below, a reproduction (ideally a failing
test), and the suggested fix or acceptance. We commit to triaging every
finding into *fixed* or *explicitly accepted in the threat model* — nothing
is closed silently.

| Severity | Meaning here |
|---|---|
| Critical | Theft, inflation, or divergent state between honest nodes |
| High | A remote peer can halt or permanently desync a node; key or seed disclosure |
| Medium | Resource exhaustion with bounded effect; a wallet misled about confirmation |
| Low | Defence-in-depth gaps, hardening, documentation errors |

## 9. Deliverable

A report listing findings by severity with reproductions, a statement of
what was reviewed (files, commit) and how (methods, time), and a short
assessment of the threat model itself: rows that are wrong, rows that are
missing, accepted risks that should not be accepted.
