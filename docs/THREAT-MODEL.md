# Threat model

Status: living document, first written 2026-09-21 against `main` at the
end of Stage 3 (issue ). Every mitigation below names the code that
implements it and the test that demonstrates the attack it stops; every
gap is stated as a gap. When a rule changes, this file changes in the same
PR. A third-party reviewer should start here, then at §8.

## 1. What is being protected

| Asset | Why it matters | Where it lives |
|---|---|---|
| **Ledger integrity** — every node given the same blocks reaches byte-identical UTXO state; no coins are created outside the emission schedule; no coin is spent twice | The whole point of the system | `src/ledger/`, `src/consensus/`, `src/state/` |
| **Coins** — an output can only be spent by the holder of its key | Users' money | `src/state/utxoSet.ts`, `src/crypto/signature.ts` |
| **Private keys** — the wallet keystore | Loss = theft of everything the key controls | `src/wallet/keystore.ts` |
| **Node availability** — a node keeps validating, relaying and answering RPC under hostile input | A node that can be crashed or stalled cannot defend the ledger | `src/network/`, `src/rpc/`, `src/consensus/miner.ts` |
| **RPC control** — only the operator can make the node mine | Miner rewards go to `--miner-address`; an attacker who can call `mine` burns the operator's CPU | `src/rpc/auth.ts` |
| **Peer-view honesty** — a light client (SPV) is not lied to about confirmations | Wallets act on `verify` | `src/wallet/spv.ts` |

## 2. System boundaries

```
   operator ──(flags / L1_* env, config/default.json)──▶ node process
                                                            │
   wallet / curl ──(JSON-RPC, HTTP or HTTPS, bearer token)──▶ rpc/  ──▶ node/node.ts ──▶ state/ (LevelDB, data/<id>/)
                                                            │
   other nodes ◀──(WebSocket frames, JSON messages)──────▶ network/ ◀──┘
```

Trust boundaries crossed by untrusted data:

1. **P2P**: every frame from a peer (`network/peer.ts` → `protocol.ts#decodeMessage` → `network/wireShapes.ts`). Every payload is type-checked field by field and rebuilt canonically before a handler sees it; a block's claimed hash is recomputed from its header. Peers are anonymous; a nodeId is self-declared.
2. **RPC**: every request body (`rpc/server.ts`, `rpc/jsonRpc.ts`). Reads and `sendRawTransaction` are public by design; `mine` needs the bearer token.
3. **Disk**: `data/<id>/` (LevelDB) and the wallet's `headers.json` cache. The chain database is trusted (it is what the node wrote); the header cache is *not* (re-verified on load).
4. **Configuration**: trusted. A wrong config is an operator error, not an attack — but see §7 on rules mismatches between operators.

## 3. Attackers considered

| Attacker | Capabilities | Not assumed |
|---|---|---|
| **A1 Remote peer** | Connects over WebSocket, sends any bytes, any number of connections from any number of addresses, any claimed nodeId/listenAddress, relays valid or invalid blocks/txs/headers/addresses | Cannot forge signatures or proof of work faster than its hash rate |
| **A2 Minority miner** | Mines valid blocks on any parent, withholds them, picks timestamps within the drift bound, orders and selects transactions | < 50 % of network hash rate |
| **A3 Majority miner** | Everything A2 can do, with > 50 % | — (see §6: this attacker wins by construction in Nakamoto consensus) |
| **A4 RPC client, unauthenticated** | Any HTTP request to the RPC port it can reach | Does not hold the bearer token |
| **A5 RPC client, authenticated** | A4 plus `mine` | Is the operator or has the operator's token |
| **A6 Network man-in-the-middle** | Intercepts / alters traffic between wallet and node, or between nodes | Cannot break TLS or Ed25519 |
| **A7 Local attacker, disk** | Reads or modifies files in `data/` and the wallet keystore / header cache | Does not have the wallet passphrase |
| **A8 Operator error** | Misconfigures a node (wrong rules, exposed RPC, throwaway miner key) | Not malicious |

## 4. Threat catalogue

Legend: **M** = mitigation (code), **T** = test that demonstrates the attack failing (`tests/…`, title quoted so it can be grepped), **R** = residual risk.

### 4.1 Consensus and ledger (A1, A2, A3)

| # | Threat | M | T | R |
|---|---|---|---|---|
| C1 | **Inflation via coinbase**: a block pays its miner more than the schedule + fees | `consensus/blockValidator.ts#validateBlock` compares coinbase output to `blockRewardAt(height) + fees` (`consensus/monetary.ts`) | `blockValidator: "rejects a coinbase that claims more than reward + fees"`; `node: "rejects a block with an inflated coinbase and keeps its state intact"`; `node: "attack: a block paying the pre-halving reward after the halving is rejected"` | None known |
| C2 | **Inflation via multiple coinbases** or a coinbase not at index 0 | exactly-one-coinbase-at-index-0 rule | `blockValidator: "rejects a block with more than one coinbase (inflation)"`, `"…first transaction is not a coinbase"` | None known |
| C3 | **Inflation via negative or zero amounts / negative fee** | `ledger/transaction.ts#validateTransactionStructure` — shared by mempool *and* block path, so a peer's block cannot bypass it | `blockValidator: "rejects a block containing a structurally invalid transaction (negative amount)"`; `ledger/transaction` tests | None known |
| C4 | **Double spend within a block** or the same tx twice | intra-block outpoint set and tx-id set | `blockValidator: "rejects two transactions in one block spending the same outpoint"`, `"…the same transaction twice"` | None known |
| C5 | **Double spend across blocks** / spending a non-existent or foreign output / value out > in | `state/utxoSet.ts#validateTransaction` against persisted + staged state; signatures over `getSigningPayload` per input | `state/utxoSet` tests; `mempool: "rejects a transaction with an invalid signature"` | None known |
| C6 | **Spending immature coinbase** (a miner spends a reward, then the block is reorged away, orphaning the spend) | `coinbaseMaturity` enforced with the spending height | `node: "rejects spending the genesis coinbase before it matures…"`; `mempool: "rejects spending an immature coinbase output…"` | None known |
| C7 | **Fake proof of work** or claiming an easier target | hash must match header; hash ≤ target; target must equal what `retargetDifficulty` dictates *on the block's own ancestry* (fork-aware `expectedTargetFor`) | `blockValidator: "rejects a block whose hash does not meet its own target"`, `"…claims an easier target than the retarget rule dictates"`; `node: "rejects a block claiming an easier difficulty target…"` | None known |
| C8 | **Difficulty manipulation via timestamps**: a miner skews timestamps to drive the target up or down | Timestamps are **strictly increasing** (> parent) and ≤ now + `maxFutureDriftMs` (2 h); the retarget measures a full `interval` of block gaps (`difficulty.ts#retargetWindow` / `nextTarget`, shared by node and light client) and is clamped to `maxDifficultyAdjustmentFactor` (4×) per period | `blockValidator: "rejects timestamps not after the parent's, or too far in the future"`; `difficulty: "keeps the target constant when every block arrives exactly on time, at every retarget"`; `node: "accepts a 35-header chain built with the shared rule across three retargets, and rejects the old off-by-one window"` | **R1** Because timestamps can never go backwards, a miner cannot "time-warp"; it can only run block time up to 2 h *ahead of real time in total* (not per block), which inflates one period's apparent timespan by ≤ 2 h → at most one 4× drop, followed by a compensating rise. Median-time-past would add nothing here (the parent is always the maximum of any window); see F3 |
| C9 | **Chain rewrite (long-range / history attack)**: an attacker with enough hash rate builds a heavier fork from far back | Heaviest-cumulative-work fork choice (`consensus/forkChoice.ts`), atomic reorg (`node#adoptBlock` + `state/db.ts#commitAtomic`); optional **checkpoints** (`consensus.checkpoints`) make everything at or below a verified checkpoint unreorgable | `node: "accepts the checkpointed chain and refuses a heavier fork that would reorg below a verified checkpoint"`, `"rejects and bans a peer whose block at a checkpointed height has a different hash"` | **R2** Without checkpoints, A3 can rewrite arbitrary depth (inherent to PoW). Checkpoints are opt-in and empty on the devnet |
| C10 | **Reorg leaves state corrupt** (crash mid-reorg, or a bad block half-applied) | staging overlay + single cross-sublevel batch; `ChainReplayError` rolls back; adoption serialized by `withChainLock` | `node: "commits a reorg as exactly one root-level batch…"`, `"leaves state untouched when the commit fails, and adopts the block on retry"`, `"rolls back cleanly when a block fails mid-replay…"` | None known |
| C11 | **Divergent rules on the same genesis** (two operators, different halving or maturity) fork silently at the first block where they disagree | `consensus/monetary.ts#rulesHash` in the handshake; mismatch is a refused peer | `node: "refuses to peer with a node whose emission schedule differs…"`; `monetary: "changes when any consensus or monetary parameter changes…"` | **R3** A peering guard, not consensus: a node that lies about its rules hash connects, then gets banned on the first invalid block. Blocks do not commit to the rules |
| C12 | **Merkle root mismatch** (block claims transactions it doesn't contain) | root recomputed from tx ids | `blockValidator: "rejects a merkle root that does not match the transactions"` | None known |
| C13 | **Oversized block** exhausts memory or validation time | Consensus limits `maxBlockBytes` (1 MB of canonical serialization) and `maxTransactionsPerBlock` (5000), checked in `validateBlock` before any per-transaction work and included in `rulesHash`; the block template fills by fee within them. The 4 MB P2P frame cap is a second, transport-level bound; the node warns at startup if the block limit exceeds half the frame cap | `blockValidator: "attack: rejects a block with more transactions than maxTransactionsPerBlock"`, `"attack: rejects a block whose canonical serialization exceeds maxBlockBytes"`; `node: "attack: a peer's block over the limits is rejected and the peer banned"`, `"mines within maxBlockBytes…"`; `p2pServer: "drops a peer that sends a frame larger than maxMessageBytes without crashing"` | None known (was R4 / F1, fixed in a later change) |

### 4.2 Peer-to-peer network (A1)

| # | Threat | M | T | R |
|---|---|---|---|---|
| N1 | **Crash the process** with malformed frames, wrong types, or a message before handshake | `protocol.ts#decodeMessage` validates the envelope and type set and, via `network/wireShapes.ts`, every payload field's type and shape (hex lengths, safe integers, bigint amounts); decode errors drop the peer; handler rejections are caught (`node#start` message handler) | `p2pServer: "drops a peer that sends malformed data instead of crashing…"`, `"…valid JSON that is not a message envelope"`, `"drops a peer that sends a protocol message before handshaking…"`; `node: "survives a peer that sends garbage and keeps serving good peers"` | None known |
| N2 | **Connection exhaustion**: open sockets and never handshake; or fill inbound so the victim cannot dial | inbound counted from accept; handshake deadline frees the slot; inbound and outbound limits are separate; `maxInboundPerIp` caps accepted sockets per remote address (refused at accept, before any handshake; IPv4-mapped IPv6 normalised) — off by default for single-host devnets, `4` in `docker-compose.yml`, `--max-inbound-per-ip` / `L1_MAX_INBOUND_PER_IP` elsewhere | `p2pServer: "frees an inbound slot when a peer never completes the handshake in time"`, `"inbound slots are separate from outbound slots…"`, `"attack: caps inbound connections per remote address when maxInboundPerIp is set, and frees them on close"` | **R5** With the cap on, A1 needs one address per slot it wants to hold (32 by default); with it off (devnet default) one address suffices. Outbound dialing is unaffected either way |
| N3 | **Invalid-data spam**: relay invalid blocks / txs / headers repeatedly | `network/reputation.ts` scoring via `P2PServer.penalize`: invalid block = instant ban; structurally invalid txs accumulate; state/policy rejections and future-timestamp-only rejections are *not* penalized (honest races, clock skew) | `node: "bans a peer that sends an invalid block, and refuses it when it reconnects"`, `"bans a peer that keeps relaying structurally invalid transactions"`, `"does not penalize a peer for a block that is merely too far in the future…"`, `"does not penalize a peer for a transaction that is only rejected by local policy or state"` | **R6** Bans are keyed by self-declared nodeId + advertised address, not IP: A1 rotates nodeIds to evade. This is a cost-of-CPU issue, not a safety issue |
| N4 | **Sync amplification**: ask for the whole chain, or send a huge locator / INV | `GET_BLOCKS` capped at `maxBlocksPerResponse` with `INV_BLOCKS` continuation; `GET_HEADERS` at `maxHeadersPerResponse`; locator and INV lists truncated to 64 | `node: "caps a GET_BLOCKS response at maxBlocksPerResponse…"`, `"bounds the work a huge junk locator can cause…"` | None known |
| N5 | **Bandwidth waste via fake heavy chains** (headers that claim work they don't have) | header-first sync: headers are validated (PoW, target, linkage) and indexed with cumulative work; bodies fetched only if the header chain is heavier | `node: "downloads bodies only after the peer's headers prove a heavier valid chain…"`, `"bans a peer whose headers fail consensus (wrong target) without downloading anything"`, `"does not download bodies for a header chain that is not heavier than ours"` | None known |
| N6 | **Orphan flood** (blocks with unknown parents to fill memory) | orphan pool capped at 50; never adopted without a resolved ancestry | `node: "never adopts an orphan whose parent never arrives"` | None known |
| N7 | **Address-book poisoning / dial storm** via `PEERS` | `network/addressBook.ts` capped at `maxAddressBookSize`; at most `maxDialsPerTick` dials per tick or per `PEERS` message; backoff per address; `PEERS` never triggers another `GET_PEERS` | `node: "attack: a PEERS flood of bogus addresses is bounded in memory and in dials per tick"`; `addressBook: "attack: refuses to grow past maxSize…"` | **R7 Eclipse**: all of a node's outbound slots (8) can be filled with attacker addresses learned via `PEERS` if the operator gave no `--peers` anchors. Anchors are always dialed first and never forgotten, so an operator with even one honest anchor is not eclipsed |
| N8 | **Wrong network / genesis** (a peer on another chain wastes our time or feeds us its history) | `networkId` + `genesisHash` in the handshake; mismatch refused before any other message | `p2pServer: "rejects a peer on a different network…"`, `"rejects a peer that declares no identity when this node has one"` | None known |
| N10 | **Hash poisoning**: a junk block that *claims* a legitimate block's hash, so the rejection marks the real hash invalid and the real block is refused when it arrives (`invalidBlockHashes` / `processedBlockHashes` / the orphan pool are keyed by hash) | a block's hash is recomputed from its header at the boundary (`wireShapes.ts#parseWireBlock`); a mismatch is a malformed message and the sender is dropped before anything is recorded | `protocol: "a block whose claimed hash is not the hash of its header is refused (a claimed hash could poison a real block)"`; `node: "attack: a junk block claiming a legitimate block's hash cannot poison that hash (the real block still adopts)"` | Self-audit finding F6 |
| N11 | **Type confusion through the wire**: a header field of the wrong JS type that hashes identically (a numeric-string `timestamp` is `toString`-equal), passes coercing comparisons, is stored, and corrupts later arithmetic (the next block template's `parent.timestamp + 1` becomes string concatenation) | `ledger/serialize.ts#parseWireHeader` / `wireShapes.ts#parseP2PTransaction`: every field type-checked, headers rebuilt in canonical key order with unknown keys dropped (block size is measured on the serialized header); the wallet applies the same check to `getHeaders` replies | `protocol: "a header field of the wrong type (a numeric string timestamp hashes identically) is refused"`; `node: "attack: a header with a numeric-string timestamp (same hash) is refused at the boundary, so it cannot corrupt the next block template"`; `serialize: "attack: a numeric-string timestamp hashes like the real header but is refused"` | Self-audit finding F8 |
| N9 | **Self-connection / duplicate links** confusing bookkeeping | own nodeId and duplicate remoteNodeId collapse | `p2pServer: "rejects a connection to itself"`; discovery mesh test | None known |

### 4.3 Mempool (A1, A4)

| # | Threat | M | T | R |
|---|---|---|---|---|
| M1 | **Mempool memory exhaustion** | `maxSize` with lowest-fee eviction; incoming must beat the lowest fee once full | `mempool: "rejects a new transaction once the mempool is full…"`, `"evicts the lowest-fee pending transaction…"` | None known |
| M2 | **Free relay / re-validation churn** via replace-by-fee | replacement must pay Σ(displaced fees) + `minFee` — strictly more each time; at most `maxReplacements` evictions; eviction only after full validation | `mempool: "attack: a conflicting transaction that does not pay for the replacement is rejected…"`, `"attack: refuses a replacement that would evict more than maxReplacements…"`, `"a replacement is still subject to full validation…"` | **R8** Fees are absolute, not per byte: a large replacement pays the same bump as a small one, and block space (now bounded by `maxBlockBytes`) is not priced per byte |
| M3 | **Zero-conf double spend**: pay a merchant, then replace the payment (RBF) or mine a conflicting tx | *Not prevented, by design* — full RBF. A merchant must wait for confirmations; `wallet verify` proves inclusion against proof of work | `node: "a replace-by-fee bump propagates…"` (shows peers switch to the replacement) | **R9** Unconfirmed transactions are not final. Documented in `docs/L1-NODE-ENGINE.md` |
| M4 | **Poisoned template**: a pending tx becomes invalid (its inputs mined elsewhere) and makes the next mined block invalid | `node#adoptBlock` purges mempool txs whose inputs the new blocks spent | `node: "purges mempool transactions made invalid by an adopted block…"` | None known |
| M5 | **Coinbase-style tx submitted directly** | no-input txs refused at the mempool | `mempool: "rejects a coinbase-style transaction (no inputs) submitted directly"` | None known |

### 4.4 RPC (A4, A5, A6)

| # | Threat | M | T | R |
|---|---|---|---|---|
| R1 | **Unauthorized mining** (burn the operator's CPU, direct rewards — no: rewards always go to the configured address) | `mine` requires `Authorization: Bearer`; token explicit or a generated `<dataDir>/rpc-token` cookie (0600 where supported); constant-time compare | `rpc/server: "a batch mixing public and protected methods only rejects the protected ones"`; `rpc/auth` tests | None known |
| R2 | **Token disclosure on the wire** | RPC binds `127.0.0.1` by default; TLS (`--rpc-tls-cert/key`, `rpc/tls.ts`); **cleartext on a non-loopback bind is refused** unless `--rpc-allow-insecure` | `tls: "refuses to expose cleartext RPC (and its bearer token) beyond the host unless explicitly overridden"` | **R10** `docker-compose.yml` sets `L1_RPC_ALLOW_INSECURE=true` because it publishes on host loopback only; an operator who changes the port mapping to `0.0.0.0` exposes cleartext. The TLS overlay exists for that case |
| R3 | **Man-in-the-middle between wallet and node** (fake balances, fake proofs, swallowed transactions) | wallet pins the node cert with `--ca`; hostname verification; no silent fallback to the system store | `rpcClient: "attack: an impostor certificate for the same host is refused…"`, `"attack: a trusted certificate issued for a different host is refused"`; `serverTls: "attack: a man-in-the-middle presenting its own certificate…"` | **R11** No client authentication (mTLS); the token is the only client credential. Cleartext to a *remote* node only warns (`warning: … cleartext`) |
| R4 | **Request flooding** | per-client fixed-window rate limit (`rpc/rateLimit.ts`), batches charged per call, refused requests not charged; 1 MB body cap; `/health` exempt so probes never flap | `rpc/server: "a JSON-RPC batch counts as one request per call, so batching cannot bypass the limit"`; `rateLimit: "bounds memory by evicting stale clients"`; `ops: "GET /health is not rate limited…"` | **R12** Keyed by `req.ip`. Behind a reverse proxy, set `rpc.trustProxy` / `--rpc-trust-proxy <hops>` so the key is the address the last trusted proxy appended to `X-Forwarded-For` (entries a client prepends are ignored: `ops: "attack: with trustProxy hops, a client cannot spoof its address by prepending entries the proxy did not add"`); with it unset the header is ignored entirely (`ops: "ignores X-Forwarded-For unless trustProxy is set…"`). Residual: a node that trusts a hop but is *also* reachable directly lets direct clients pick their bucket — only enable it when the proxy is the sole path; and a client with many real IPs still multiplies its budget |
| R5 | **Malformed JSON-RPC / wire transactions crash the node** | text body parsed under try/catch → `-32700`; `ledger/serialize.ts#parseWireTransaction` shape-validates before consensus code sees it | `rpc/server` parse-error and invalid-tx tests | None known |
| R6 | **Metrics label-cardinality blow-up** via arbitrary method names | dispatcher maps unknown methods to `"unknown"` before they become labels; label values escaped | `ops: "attack: unknown method names do not become metric labels (bounded cardinality)"`; `registry: "attack: label values are escaped…"` | None known |
| R7 | **Information disclosure** via public reads | Balances, UTXOs, mempool, `/health`, `/metrics` are public by design (the ledger is public) | — | **R13** `/metrics` and `/health` reveal node id, version, peer count and uptime to anyone who can reach the port. Keep the port private or behind the proxy if that matters |

### 4.5 Wallet and light client (A6, A7)

| # | Threat | M | T | R |
|---|---|---|---|---|
| W1 | **Keystore theft** | scrypt (N = 2¹⁵, r = 8) → AES-256-GCM; wrong passphrase and tampering are indistinguishable; address re-derived from the decrypted key so a swapped header can't misdirect a payment. A v3 file seals the BIP-39 phrase's entropy, never the words | `wallet/keystore` tests; `keystore: "seals the phrase's entropy and derives accounts from the BIP-39 seed"` | **R14** Offline brute force is bounded only by passphrase strength and scrypt cost. `--passphrase` on the command line lands in shell history (the CLI says so; env var or prompt preferred). The recovery phrase printed by `create` is the wallet: whoever reads the terminal or a saved log has the coins (`--mnemonic` on a command line lands in history too; the hidden prompt is preferred) |
| W2 | **Typo'd recipient** (coins to an unowned address are gone) | Addresses are shown and entered in a bech32m form with a 6-character checksum (`ledger/address.ts`); a typo, a dropped/added character or a foreign prefix fails before the passphrase is asked. Raw 64-hex is still accepted for scripts | `ledger/addressCodec: "attack/typo: any single-character substitution is detected"`; `cli/wallet: "refuses a checksummed --to with a typo, and accepts both address forms"` | **R15** A raw-hex address typed by hand has no checksum; the CLI prints the checksummed form so copies carry it |
| W3 | **Node lies about confirmation** (fake proof, fake chain) | `wallet/spv.ts`: header chain verified from a locally trusted genesis (PoW, targets, timestamps, total work); merkle proof checked against the *header's* root; the node's UTXO state is never trusted | `cli/wallet: "verify: refuses to trust a node whose genesis differs…"`; `spv` tests; `merkle: "rejects a proof for a different leaf, a tampered sibling, or a flipped position"` | **R16** SPV trusts the most-work chain it has seen: A3 can feed a light client a heavier fake history. Inherent to SPV |
| W4 | **Cheap-fork confirmation**: the node serves a lighter fork on which the tx "is confirmed" | `syncHeaders` replaces stored headers only with strictly more work; a lighter fork is refused and the proof rejected | `cli/wallet: "verify: follows a heavier fork (reorg) and refuses a lighter one from another node"`; `spvSync: "attack: refuses a fork that is not heavier…"` | None known |
| W5 | **Tampered header cache** (`headers.json`) | re-verified from genesis on load; discarded with a warning if anything fails | `headerStore: "attack: a tampered store is discarded rather than trusted…"` | None known |
| W6 | **Bumping someone else's transaction** / draining the recipient via `bump` | `bumpFee` refuses inputs not signed by this key; only the change output shrinks | `txBuilder: "refuses to bump a transaction whose inputs are not signed by this key…"` | None known |
| W7 | **Mistyped recovery phrase** restores an empty wallet the user then pays into; **watch-only file misused** — a keyless copy on a shared machine is edited to carry a secret so the CLI signs for the watched addresses | `wallet/mnemonic.ts`: an off-list word, a wrong word count or a checksum mismatch is refused before a passphrase is asked or a file written; a watch-only file has no `kdf`/`cipher` and `unlockAccount` throws `WatchOnlyError` before any prompt or node call; a file edited into a `mnemonic` file with another wallet's secret fails the account-record re-derivation check at unlock | `mnemonic: "attack: a phrase with one word changed fails the checksum…"`; `cli/wallet: "restore refuses a phrase with a wrong word or a bad checksum before asking for a passphrase or writing a file"`; `keystore: "attack: a watch-only file given a stolen secret from another wallet cannot sign for its addresses"`; `cli/wallet: "attack: a watch-only file edited to carry another wallet's secret cannot sign for the watched addresses"` | A 12-word phrase has 4 checksum bits: a single wrong word slips through with probability 1/16 (`--words 24` gives 8 bits). The optional BIP-39 passphrase is not supported, so the phrase alone is the full secret |

### 4.6 Process and operations (A7, A8)

| # | Threat | M | T | R |
|---|---|---|---|---|
| O1 | **Mining stalls the node** (no validation, no RPC while searching) | PoW on a worker thread, outside the chain lock; tip change aborts the search | `miner: "does not block the event loop…"`; `node: "keeps serving reads and timers while a hard block is being mined"` | None known |
| O2 | **Crash mid-write corrupts the database** | all state moves in one LevelDB batch; header cache written via temp file + rename | C10 tests; `headerStore: "saves atomically…"` | None known |
| O3 | **Container runs as root / exposes cleartext by default** | non-root `node` user (the Kubernetes pod also drops all capabilities, forbids privilege escalation and keeps RPC on a ClusterIP service); image refuses cleartext on `0.0.0.0` without `L1_RPC_ALLOW_INSECURE` | `settings` + `tls` tests; verified live in PR | see R10 |
| O4 | **Rewards to a throwaway key** (operator forgets `--miner-address`) | logged at startup with an explicit note | — | **R17** Operator error remains possible; nothing stops mining without a miner address |
| O5 | **Log injection / unparseable logs** | JSON logs: fixed keys cannot be overwritten by fields; text logs quote and escape values | `logger: "…a field cannot overwrite the fixed keys"`, `"…newlines escaped"` | None known |
| O6 | **Unbounded index growth**: the address index gains an entry per (address, transaction) forever, so a spammer paying many fresh addresses grows the operator's disk faster than the chain itself | `--addrindex-depth n` keeps exactly the last n canonical blocks (pruned in the adoption batch; a changed setting is swept or rebuilt at startup), `--no-addrindex` keeps none; `getInfo` reports the covered range so wallets are not told "no history" when the node simply forgot | `node: "keeps only the last … blocks of history: older entries are deleted as the chain grows, and getInfo says where history starts"`; `node: "reorg with pruning: the window follows the new tip, abandoned entries never come back, and pruned entries are not needed to disconnect"` | **R18** Off by default (a devnet wants full history). Blocks, undo records and the tx index are never pruned: the chain itself still grows without bound (block size limits, C13, bound the rate) |

### 4.7 Proof of authority (A1, A2; `consensus.mode: "poa"`)

A consortium chain replaces hash power with a fixed, ordered set of signing
keys (`consensus/engine.ts#PoaEngine`). Every rule below is checked from
headers alone, so header-first sync and the light client apply them too.

| # | Threat | M | T | R |
|---|---|---|---|---|
| P1 | **Block from a non-authority** (anyone with a key seals a block) | `header.signer` must be in the configured set and `header.signature` must be that key's signature over the block hash; the signer is part of the hash, so a block cannot be re-attributed | `engine: "attack: a block signed by a key outside the authority set is rejected"`; `node: "attack: a block sealed by a key outside the authority set is rejected and the sender banned"` | **R19** The authority set is static configuration: adding or removing an authority is a coordinated config change (a new rules hash), not an on-chain vote |
| P2 | **Body altered after signing** (keep an authority's seal, change the coinbase or transactions); **mangled-seal copy** (the real header with a garbage signature, to get the real block's identity refused) | the signature is over the seal hash (every header field but the signature); the block hash covers the seal too, so a copy with another signature is a different block and its rejection cannot poison the real one (N10) | `engine: "attack: a tampered header, a missing or forged signature, and a signature by another authority's key are rejected"`; `node: "attack: an authority's block with its body altered after signing is rejected (the signature covers the hash)"`; `node: "attack: a copy of an authority's block with a mangled signature is a different block and cannot poison the real one"` | None known |
| P3 | **One authority runs away with the chain** (a compromised or malicious authority produces blocks alone, censoring or rewriting) | no signer may sign more than one of any floor(n/2)+1 consecutive blocks: extending the chain needs a majority of authorities; the in-turn authority's block weighs 2 against 1, so when a scheduled block exists it wins fork choice | `engine: "attack: one authority cannot monopolize the chain -- a signer may sign once per floor(n/2)+1 blocks"`; `node: "fork choice: the in-turn authority's block beats an out-of-turn block at the same height"` | **R20** A colluding majority of authorities controls the chain outright (inherent to PoA; choose the set accordingly). A minority of offline authorities halts the chain when fewer than floor(n/2)+1 remain (liveness needs a majority). No block-pacing rule: an in-turn authority with willing peers can produce blocks as fast as the turn rule allows |
| P4 | **Mixed-mode network** (a proof-of-work node and a proof-of-authority node, or two authority sets, on the same genesis) | mode and the ordered authority set are in the handshake `rulesHash` (`RULES_VERSION` 3); such peers refuse each other instead of forking | `engine: "rulesHash covers the mode and the ordered authority set, so mixed-mode or differently governed peers refuse each other"`; `node: "refuses to peer with a proof-of-work node, and with a proof-of-authority node whose authority set differs"` | None known |
| P5 | **Signer key theft** (the key file on an authority's host) | `--signer-key` is a plain file the operator protects like a TLS key (mode 0600 from `gen-authority`); the node derives the public key from it, so a wrong or swapped file is refused at startup rather than silently signing as nobody | `signerKey` tests; `node: "a node without a signer key follows the chain but cannot produce blocks; a key outside the set is refused at startup"` | **R21** The key is not encrypted at rest; a stolen key is a stolen authority until the set is rotated (a config change on every node) |

### 4.8 Record anchoring (A1, A6)

A transaction may carry up to 80 bytes of record data (`Transaction.data`,
usually the sha256 of a document). The node indexes it (`anchors`
sublevel) and answers `getAnchors`; `wallet find-anchor` proves an anchor
without trusting the node. `RULES_VERSION` 5. A node started with
`--anchor-key` also answers `anchorRecord`, signing and paying for the
anchor itself (D8, D9).

| # | Threat | M | T | R |
|---|---|---|---|---|
| D1 | **Chain used as bulk storage** (large data in many transactions) | `ledger/transaction.ts#validateTransactionStructure`: data is 1..`MAX_TX_DATA_BYTES` (80) bytes, on the mempool *and* block path; block limits (C13) bound the total | `ledger/transaction: "attack: a record one byte over the limit is refused (no free bulk storage)"`; `node: "attack: a record over the size limit is refused by the node"` | **R22** Anyone with coins can write 80 bytes of their choice, and nothing on chain can be deleted. The fee is flat per transaction (as R8). On a private ledger, whoever holds coins decides who can anchor |
| D2 | **Record swapped after signing** (keep the signature, change the data, recompute the id) | data is part of `getSigningPayload` and of the transaction id | `ledger/transaction: "attack: swapping the record after signing breaks the signature"`; `node: "attack: a record swapped after signing (id recomputed to match) is refused and nothing is indexed"` | None known |
| D3 | **Two spellings of one record** (upper- and lower-case hex) so a lookup misses an anchor | only lowercase hex is valid on chain; `getAnchors` and the CLI lower-case what they are given | `ledger/transaction: "attack: uppercase hex is refused, so one record cannot be anchored under two spellings"`; `rpc/server: "getAnchors finds a record sent with sendRawTransaction once it is mined, and accepts the record in upper case"` | None known |
| D4 | **Node lies about an anchor** (points the record at an unrelated transaction, a block it doesn't have, or a fork) | `wallet find-anchor` fetches the block, recomputes the transaction id from its content, checks the transaction's data equals the record, then checks the merkle proof against a header on the SPV-verified chain (W3, W4) | `cli/wallet: "attack: a node that points the record at an unrelated confirmed transaction is caught"`; `cli/wallet: "anchor --file sends the file's sha256 as a record; find-anchor proves it…"` | **R23** A node can *hide* an anchor ("not anchored") or show a later one instead of the earliest; SPV cannot prove absence. For a disputed record, ask more than one node |
| D5 | **Record dropped in transit** (a peer strips the field, so an honest transaction looks forged and its sender is penalized) | `network/wireShapes.ts#parseP2PTransaction` and `ledger/serialize.ts` carry and type-check `data` | `protocol: "a transaction's record data survives the trip…"`; `node: "a record reaches peers intact and is indexed there too"` | None known |
| D6 | **Anchor in an abandoned block still reported** after a reorg | the anchor index is written in the same atomic adoption batch as the tx index: added on connect, removed on disconnect | `node: "follows reorgs: an anchor in an abandoned block disappears and returns when re-mined"` | None known |
| D7 | **Backdated anchor**: the block producer sets an early block time | block time must be later than the parent's and at most `maxFutureDriftMs` ahead (C8) | `blockValidator: "rejects timestamps not after the parent's, or too far in the future"` | **R24** A block's time can be earlier than the real time by up to the gap since its parent (a miner, or a proof-of-authority signer, picks it). "Existed by block time" is as strong as the producers are honest; later blocks confirm it is not rewritten |
| D8 | **Draining the anchor key** (anyone who can reach RPC makes the node pay fees) | `anchorRecord` requires the bearer token (`requiresAuth`), like `mine`; it is rate limited like every call; each anchor pays only the minimum fee, and change returns to the anchor address | `rpc/server: "needs the bearer token: it spends the operator's coins"` | **R25** A token holder can spend the anchor address's balance on fees, one minimum fee per distinct record. The key is read unencrypted at startup (a hot key, like `--signer-key`); keep only what fees need on it |
| D9 | **Paying twice for one record** (a client retries after a timeout; concurrent calls pick the same coin and replace each other) | `node#anchorRecord` returns a confirmed or a pending anchor of the same record from the same key instead of paying again; coin selection skips coins pending transactions spend (`mempool#isClaimed`) and runs under the chain lock | `node: "a retried request for a pending record returns the same transaction instead of paying twice"`; `node: "splits its change into a pool of coins, so many records can be anchored in the next block, even concurrently"` | None known |

## 5. What is deliberately public

Balances, UTXOs, blocks, headers, the mempool, `/health`, `/metrics` and
`sendRawTransaction` need no credential. A public ledger has no
confidentiality; `sendRawTransaction` carries its own authorization (the
signatures). The bearer token protects the one thing that costs the
operator something: `mine`.

Anchored records are public too. A record is usually a hash, which hides
the document only if the document can't be guessed: the hash of "yes",
of a short ID or of a known template can be found by trying candidates.
Add a random salt to such documents before anchoring (see
`docs/ANCHORING.md`).

## 6. Accepted risks (inherent to the design)

- **Majority hash rate (A3)** can reorg any depth not protected by a
  checkpoint, censor transactions, and feed light clients a false history.
  This is Nakamoto consensus; the mitigations are checkpoints (opt-in) and
  waiting for more confirmations.
- **Unconfirmed transactions are not final** (full RBF, R9).
- **Sybil identities are free** (R6): the protocol authenticates chains,
  not peers. Reputation limits waste, not identity.
- **SPV trusts work, not truth** (R16).
- **Proof of authority trusts its authorities** (R20): a colluding majority
  of the configured signers controls the chain, and liveness needs a
  majority online. Choose the set for the deployment, not the code.

## 7. Findings from writing this document (tracked)

Writing the catalogue surfaced gaps that were not previously stated
anywhere. Each is a GitHub issue; none is exploitable for theft or
inflation, but F1 and F2 are availability weaknesses.

| # | Finding | Severity | Follow-up |
|---|---|---|---|
| **F1** | ~~No consensus limit on block size or transaction count (C13/R4).~~ **Fixed**: `consensus.maxBlockBytes` / `maxTransactionsPerBlock`, enforced in `validateBlock`, honoured by the template, part of `rulesHash`. | — | Closed |
| **F2** | ~~RPC rate limiting keys on `req.ip` without proxy awareness (R12).~~ **Fixed**: `rpc.trustProxy` / `--rpc-trust-proxy <hops>`, off by default; hop-counted so prepended `X-Forwarded-For` entries are ignored. | — | Closed |
| **F3** | ~~No median-time-past~~ **Analysis corrected**: MTP is a rule for chains that allow non-monotonic timestamps; ours are strictly increasing, so the median of any window is below the parent and the rule could never bind. The "2 h per block" claim was wrong — the wall-clock bound caps the forward walk at 2 h total. **Found instead**: the retarget window measured `interval − 1` gaps against `interval × blockTime`, so a perfectly timed chain raised difficulty ~1/interval every period (10 % on the devnet). Fixed; `RULES_VERSION` added to `rulesHash`. | — | Closed |
| **F4** | ~~Addresses carry no checksum (W2/R15).~~ **Fixed**: bech32m display/entry form with checksum; raw hex still accepted; RPC rejects malformed addresses instead of reporting an empty balance. | — | Closed |
| **F5** | ~~No per-IP inbound connection limit (N2/R5).~~ **Fixed**: `network.maxInboundPerIp` / `--max-inbound-per-ip`, off by default, `4` in the compose file. | — | Closed |

The self-audit done while preparing `REVIEW-BRIEF.md` (Stage 4) found three
more, all at the P2P boundary, all fixed in the same PR with the attack
test written first:

| # | Finding | Severity | Follow-up |
|---|---|---|---|
| **F6** | ~~`rejectBlock` recorded the hash the *sender claimed*: `{ header: junk, hash: <real hash> }` was rejected for "hash does not match header" and the real hash landed in `invalidBlockHashes`, so the legitimate block was refused when it arrived (N10).~~ **Fixed**: the hash is recomputed at the boundary; a mismatch is a malformed message. | High (a peer could make a victim refuse chosen blocks until restart) | Closed |
| **F7** | ~~The proof-of-authority signature was outside the block hash, so a copy of a real block with a garbage signature had the real block's identity and could poison it the same way (P2).~~ **Fixed**: the signature is inside the block hash; the signer signs the seal hash (`computeSealHash`). `RULES_VERSION` 4. | High (PoA only) | Closed |
| **F8** | ~~Peer-supplied headers, blocks and transactions were never type-checked; a numeric-string `timestamp` hashed identically, was stored, and corrupted the next block template (N11).~~ **Fixed**: `parseWireHeader` / `wireShapes.ts` type-check and canonicalize every payload; the wallet checks `getHeaders` replies the same way. | Medium (a peer could desync a *mining* node's own blocks) | Closed |

## 8. Guidance for a third-party review

`REVIEW-BRIEF.md` is the reviewer package (scope, setup, risk areas in
priority order, reporting, severity scale); the notes below are the short
version.

1. **Read the rules, not the prose**: `src/ledger/transaction.ts`
   (structure), `src/consensus/blockValidator.ts` (header + block),
   `src/state/utxoSet.ts` (state), `src/consensus/monetary.ts`
   (emission), `src/node/node.ts#adoptBlock` (reorg). Everything a block
   must satisfy is in those five places.
2. **Run the attack tests**: `npm test`. Every test whose title starts
   with `attack:` or `rejects`/`refuses`/`bans` is a claim in §4; grep the
   quoted title to find it. `npm run simulate` and `npm run testnet:check`
   exercise real processes.
3. **Try to add an attack**: the convention (`CONTRIBUTING.md`) is that a rule
   is only added together with a test showing the attack it prevents.
   Write the attack first in `tests/<module>/`; if it passes without a
   code change, that is a finding.
4. **Check the boundaries in §2**: anything that reaches
   `node/node.ts` from a peer should have passed `decodeMessage`;
   anything from RPC should have passed `parseWireTransaction` or the
   JSON-RPC param checks.
5. **What we most want challenged**: the fork-aware target computation
   (`expectedTargetFor`), reorg atomicity, the RBF fee rule, the
   header-first sync's "heavier before bodies" logic, and the SPV
   lighter-fork refusal.

## 9. Out of scope

Smart contracts and scripting (none exist), privacy of transaction graph
(none is claimed), physical/host security, supply-chain security of npm
dependencies beyond `npm ci` with a lockfile, and NAT traversal (nodes
behind NAT need `--advertise-url` and a port forward).
