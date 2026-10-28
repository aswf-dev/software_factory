# Model map — the verification claim ledger

> If a claim is not recorded here, it is not covered. This file is the human gate; `verify-lean.sh` checks only the mechanical part.

- **Verified at commit:** `<sha>` (`<YYYY-MM-DD>`, branch `<branch>`)
- **Rules of record:** `RULES.md` (confirmed `<YYYY-MM-DD>` by `<owner>`)
- **Toolchain:** Lean `<version>` from `lean-toolchain`; Mathlib: `no` / `yes — owner approval <link/date>`

## Verified sources (the code the model claims to describe)

| File | Lines | What is modeled |
|---|---|---|
| `<src/main/java/.../OrderService.java>` | `<90-150>` | `<transition guard function>` |
| `<src/orders/score.ts>` | `<12-60>` | `<scoring function>` |

## Rule coverage — every headline theorem needs a rule, a source location, and a statement snapshot

| Rule | Headline theorem | Statement (snapshot, phase 2) | Model definition | Source file:line | Why this statement covers the rule |
|---|---|---|---|---|---|
| R1 | `<theorem>` | `<exact signature>` | `<Lean def>` | `<file:120-140>` | `<one sentence>` |
| | | | | | |

Helper lemmas (not headline theorems): `<list or "none">`

## Non-vacuity witnesses (`Examples.lean`)

| Theorem | Witness (concrete instantiation) | Satisfiability note |
|---|---|---|
| `<theorem>` | `<example : ... := by decide>` | `<hypotheses hold for this input>` |

## Abstraction ledger — dropped details and why they cannot affect the proven property

| Dropped detail | Where (source file:lines) | Safety argument |
|---|---|---|
| `<logging / caches / events>` | `<...>` | `<cannot change the transition relation>` |
| `<JPA persistence>` | `<...>` | `<assumed; R6 is conditional on Hibernate @Version semantics — see Not covered>` |

## Explicitly not covered

- `<e.g. DB isolation/flush semantics, crash recovery, retries, performance>`
- `<e.g. library semantics replaced by a model assumption>`

## Verification gate checklist (all must be checked before saying "verified")

- [ ] `RULES.md` confirmed with provenance, acceptance, sign-off
- [ ] Verified sources mapped to `file:line`; abstraction ledger complete
- [ ] Statement snapshots recorded and unchanged (or owner-approved delta logged)
- [ ] Non-vacuity witness exists for every headline theorem with hypotheses
- [ ] Independent adversarial review entry exists (fresh context, different model if possible)
- [ ] Owner read the top-level statements; sign-off recorded
- [ ] `verify-lean.sh` green: build, direct compile, scan, axiom audit, audit completeness
- [ ] Dashboard baseline + current recorded; regressions explained
- [ ] Bounded port audit (guards, order, outcomes, boundaries, dropped details) done per rule

## Review log

| Date | Reviewer | Kind (human / adversarial AI) | Findings | Resolution |
|---|---|---|---|---|
| | | | | |

## Re-sync log

| Date | Commit | Sources changed | Rule affected | Theorems touched | Notes |
|---|---|---|---|---|---|
| | | | | | |
