# Security policy

## Reporting a vulnerability

If a finding is exploitable against a running network — theft, inflation,
divergent state between honest nodes, remote denial of service, key or seed
disclosure — please report it **privately**:

1. Use GitHub's private vulnerability reporting on this repository
   ("Security" tab → "Report a vulnerability"), or
2. email the maintainer listed in the repository's GitHub profile with the
   subject `plainchain security`.

Include a reproduction (ideally a failing test in `tests/<module>/` — see
`docs/REVIEW-BRIEF.md` §7), the commit reviewed, and your severity estimate
(`docs/REVIEW-BRIEF.md` §8). You will get an acknowledgement within 3
working days and a triage decision — *fixed* or *explicitly accepted in
`docs/THREAT-MODEL.md`* — within 14 days. Nothing is closed silently.

Findings that are not exploitable against a running network (hardening,
documentation, defence-in-depth) can be opened as ordinary issues with the
**Security finding** template.

## Scope

Everything under `src/`, `scripts/`, `config/`, `k8s/`, the Docker files
and the GitHub workflows. Out of scope: host and cloud security around a
deployment, npm supply-chain beyond the pinned lockfile, and the accepted
risks in `docs/THREAT-MODEL.md` §6 (reporting those again is welcome only
with a new angle).

## Supported versions

There is no release line yet; `main` is the supported version. Consensus
rule changes are tracked by `RULES_VERSION` (`src/consensus/monetary.ts`),
and nodes on different rules refuse each other at handshake, so a fix that
changes a rule is a coordinated upgrade for every node of a chain.

## Disclosure

Please allow a fix to land before publishing. We credit reporters in the
threat model's findings table unless asked not to.
