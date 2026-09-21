---
name: Security finding
about: A weakness found while reviewing the node, wallet or deployment (non-exploitable; exploitable ones go through SECURITY.md)
title: "[finding] "
labels: security-review
---

<!-- For anything exploitable on a running network use the private path in SECURITY.md instead. -->

**Severity** (docs/REVIEW-BRIEF.md §8): Critical / High / Medium / Low

**Component**: e.g. `consensus/engine.ts#PoaEngine.verifySeal`

**Threat-model row**: e.g. P3, or "none — new threat"

**Summary**: one or two sentences: what an attacker can do, from where.

**Reproduction**: a failing test in `tests/<module>/` following the `attack:` convention, or exact steps.

**Suggested fix or acceptance**: what to change, or why it should be an accepted risk (with the R-number to add).
