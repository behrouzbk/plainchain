# Record anchoring

Anchoring puts a document's fingerprint on the chain so you can later
prove the document existed, unchanged, by a certain time.

- The **fingerprint** is the sha256 hash of the file (64 hex characters).
  Only the hash goes on chain. The file never leaves your machine.
- The **anchor** is an ordinary transaction that carries the hash in its
  `data` field and pays nobody. It costs one transaction fee.
- The **proof** is: the transaction is in a block, the block is in the
  chain, and the block has a time. Anyone with the same file can check it.

A change of one byte in the file gives a completely different hash, so a
match proves the file is the same one that was anchored.

---

## 1. Anchor a file (wallet CLI)

You need a wallet with a little spendable balance (the fee plus 1 unit).

```powershell
npx tsx src/cli/main.ts anchor --file contract.pdf
```

```
record: 2deeeea0e2076643661afec9722b33637546838e8aef816c9b9e721455f84c74
sent for anchoring (fee 1); it is anchored once mined
txId: af106083183af3624541366e04d503e3e2a2052d818416ab7ee0ca9c3c9e5b16
check with: find-anchor --hash 2deeeea0e2076643661afec9722b33637546838e8aef816c9b9e721455f84c74
```

- `--hash <hex>` instead of `--file` sends a hash you computed yourself.
- `--fee <n>` pays more than the node's minimum.
- If it is stuck unmined, `bump --tx <txId> --fee <n>` replaces it with a
  higher-fee copy that carries the same record.

(From Git Bash / macOS / Linux: `npm run wallet -- anchor --file contract.pdf`.)

## 2. Check a file

```powershell
npx tsx src/cli/main.ts find-anchor --file contract.pdf
```

```
record: 2deeeea0e2076643661afec9722b33637546838e8aef816c9b9e721455f84c74
anchored in block 00034309520db3c5a2a73eaec622f380f3a83b4ac6e17c2355c5b63873fe8ba8 at height 12
block time: 2026-09-26T02:36:42.034Z
confirmations: 1
txId: af106083183af3624541366e04d503e3e2a2052d818416ab7ee0ca9c3c9e5b16
transaction carries the record: its content hashes to its id
header chain valid from trusted genesis: 13 headers, 13 downloaded, 0 from local store; proof-of-work and retargets checked
inclusion proof valid: 1 sibling hashes fold to the header's merkle root
```

Exit code 0 means proven. Exit code 1 with `not anchored` means the node
knows no mined transaction carrying this record.

`find-anchor` does **not** take the node's word for it. It:

1. downloads the block and re-hashes the transaction, so it knows the
   transaction really carries the record;
2. checks the merkle proof that the transaction is in that block;
3. checks the block header is part of a valid chain from the genesis
   block it trusts (the same check as `wallet verify`).

No wallet file or passphrase is needed to check.

## 3. JSON-RPC (for your own software)

The node's JSON-RPC endpoint is `POST /rpc` (default
`http://127.0.0.1:9001/rpc`).

### Look up a record: `getAnchors`

Params: `data` (hex, upper or lower case), optional `limit` (1–1000,
default 100). Returns confirmed anchors, oldest first. Pending
(unmined) anchors are not listed.

```bash
curl -s http://127.0.0.1:9001/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"getAnchors","params":["2deeeea0e2076643661afec9722b33637546838e8aef816c9b9e721455f84c74"],"id":1}'
```

```json
{"jsonrpc":"2.0","id":1,"result":[{"txId":"af1060…5b16","height":12,
 "blockHash":"00034309…8ba8","blockTimestamp":1790390202034,"confirmations":1}]}
```

- `blockTimestamp` is milliseconds since 1970 (UTC).
- An empty list means "not anchored".
- A bad record (not hex, over 80 bytes) is error `-32602`.
- For an independent proof, call `getMerkleProof(txId)` and check it
  against headers from `getHeaders`, or run `wallet find-anchor`.

### Send an anchor: `sendRawTransaction`

A signed transaction with a `data` field. The wallet CLI builds these;
from code, the shape is:

```json
{
  "id": "<sha256 of the transaction, see ledger/transaction.ts>",
  "inputs": [{ "txId": "…", "outputIndex": 0, "signature": "…", "publicKey": "…" }],
  "outputs": [{ "address": "<your own address>", "amount": "4999999990" }],
  "timestamp": 1790390200000,
  "fee": "10",
  "data": "2deeeea0e2076643661afec9722b33637546838e8aef816c9b9e721455f84c74"
}
```

Rules for `data`:

- lowercase hex, 1 to 80 bytes (2 to 160 hex characters);
- it is covered by every input's signature and by the transaction id, so
  it cannot be changed after signing;
- the transaction still needs at least one output (change back to
  yourself is fine).

### Let the node pay: `anchorRecord`

For client systems that should not hold keys, the node can sign and pay
for anchors itself. The client sends only the hash.

**Operator setup (once):**

```powershell
npm run gen-anchor-key -- --out data/n1/anchor.key      # PowerShell: npx tsx scripts/genAnchorKey.ts --out data/n1/anchor.key
```

```
anchor key written: data/n1/anchor.key (keep it private; start the node with --anchor-key data/n1/anchor.key)
anchor address: l11tgqkx85lrsstt53xv8alpu5xvcu9kqrltqcj3a88ngka920er2ys3cm7aq
```

1. Send coins to that address (`wallet send --to <anchor address> --amount 1000`).
2. Start the node with `--anchor-key data/n1/anchor.key` (or
   `L1_ANCHOR_KEY`). The log says `anchoring: anchorRecord fees are paid
   from l11…`, and `getInfo` shows `"anchoring": { "address": … }`.

**Client call** (needs the RPC bearer token, because it spends the
operator's coins):

```bash
curl -s http://127.0.0.1:9001/rpc -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $L1_RPC_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"anchorRecord","params":["cccc…cccc"],"id":1}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"status":"pending","txId":"ac54ccdc…0ff7"}}
```

Call it again with the same hash at any time. It never pays twice:

- `"pending"`: sent, waiting for a block (same `txId` as before).
- `"confirmed"`: in a block, with `txId`, `height`, `blockHash`,
  `blockTimestamp` and `confirmations` (the same fields as `getAnchors`).

So a client can simply repeat the call until it answers `"confirmed"`.

Errors:

| Code | Meaning |
|---|---|
| `-32004` | no or wrong bearer token |
| `-32005` | the node has no `--anchor-key` |
| `-32602` | the record is not hex or is over 80 bytes |
| `-32000` | no free coins at the anchor address (the message names it) |

**How many per block.** Coins spent by a pending anchor can't be used
again until the next block. So the node keeps a pool of coins: when it
has fewer than 16 free coins, it splits its change into up to 8 coins.
With one funding payment you can anchor 1 record in the first block, up
to 8 in the next, and more after that. To anchor many records per block
from the start, send several separate payments to the anchor address.
Each anchor costs the node's minimum fee.

**Keep the anchor key small.** The node reads the key unencrypted at
startup (a "hot" key). Keep only what fees need on that address and top
it up. `/metrics` counts calls in `l1_anchor_requests_total{outcome}`.

## 4. Computing the hash yourself

Any sha256 tool gives the same value as `--file`:

```powershell
(Get-FileHash contract.pdf -Algorithm SHA256).Hash    # Windows (upper case is fine)
```

```bash
sha256sum contract.pdf        # Linux
shasum -a 256 contract.pdf    # macOS
```

## 5. Many documents, one fee

To anchor many files at once, write their hashes into one list file
(one per line, sorted), anchor the list file, and keep the list. To prove
one document later, show the document, the list that contains its hash,
and the anchor of the list.

## 6. What a proof means, and what it does not

It proves:

- this exact file existed no later than the block time (see the limit
  below);
- which address paid for the anchor (the transaction's inputs).

It does **not** prove:

- who wrote the document, or that its content is true;
- that no *earlier* copy was anchored somewhere else.

Limits to know about (threat model §4.8):

- **Block time is set by the block producer.** It must be later than the
  previous block and not more than 2 hours in the future, but it can be
  earlier than the real time by up to the gap since the previous block.
- **A node can hide an anchor.** It can answer "not anchored" or show a
  later anchor instead of the first. A proof that *is* shown is checked,
  but absence is not. For a disputed record, ask more than one node.
- **Records are public.** A hash hides a document only if the document
  can't be guessed. The hash of "approved", of an ID number or of a known
  template can be found by trying candidates. For such documents, add a
  random line (a salt) to the file before anchoring and keep that copy.
- **Records are permanent.** Nothing on chain can be deleted. Do not
  anchor anything you might need to remove (for example personal data in
  clear text); anchor its hash.

## 7. Upgrading a chain

Transactions with `data` are a consensus change (`RULES_VERSION` 5).
Every node of a chain must run this version: nodes on older code refuse
to connect to it. Existing data directories and the genesis block stay
valid; nothing needs to be wiped.
