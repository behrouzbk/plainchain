# Contributing

Thanks for looking. The conventions below are what keep a consensus
codebase safe to change; a pull request that follows them is easy to
review and merge.

## The rules that matter

- **No external blockchain libraries.** Hashing, signatures, Merkle trees,
  key derivation and TLS are built on Node's `crypto`. Do not add `ethers`,
  `web3`, `bitcoinjs-lib` or similar.
- **Determinism first.** Two nodes given the same blocks must reach
  byte-identical state. Everything that is hashed is serialized with a fixed
  field order; amounts are `bigint`, never `number`.
- **Layering.** `crypto/`, `metrics/` and `ops/` import nothing from the
  project. `ledger/` depends only on `crypto/`; `state/` on `ledger/` +
  `crypto/`; `mempool/` and `consensus/` on `state/`; `network/` and `rpc/`
  on the above but not on each other; `wallet/` on `crypto/` + `ledger/`;
  `cli/` talks to a node only over JSON-RPC. `node/node.ts` is the only
  module that wires everything together. All LevelDB access goes through
  `state/db.ts`.
- **Test first.** Write the failing test in `tests/<module>/` before the
  implementation in `src/<module>/`; the test tree mirrors the source tree.
- **One attack test per rule.** A consensus or network rule is only added
  together with a test that shows the attack it prevents (`attack: …`,
  `rejects …`, `refuses …`). If you can make an attack pass without a code
  change, that is a finding — see `SECURITY.md`.
- **Threat model in the same pull request.** A change to a consensus or
  network rule updates `docs/THREAT-MODEL.md` (the row's code and test
  references) in the same change. A change that alters what blocks are
  valid bumps `RULES_VERSION` in `src/consensus/monetary.ts`.

## Before you open a pull request

```bash
npm run typecheck     # zero errors
npm test              # the full suite; nothing is skipped in CI
npm run simulate      # three real processes converge (for consensus or network changes)
```

Keep the change to one thing. Describe the attack or bug the tests cover,
and how you verified it live if it touches consensus, networking or the
wallet.

## Reporting a vulnerability

Privately, per `SECURITY.md`. Non-exploitable hardening findings can be
ordinary issues using the *Security finding* template.
