# Business rules to verify (owner-confirmed)

> Phase 0 output. Do not model or prove anything until every rule is confirmed by the owner.
> If an owner-confirmed artifact already exists (e.g. an approved spec file), transcribe it and record provenance instead of re-interviewing.

- **Module / entry point:** `<path/to/Source.java|ts|rs>` (read-only)
- **Owner:** `<name / handle>`
- **Confirmed by:** `<name>` on `<YYYY-MM-DD>` via `<issue # / PR / chat>`
- **Status:** `draft | confirmed`
- **Acceptance:** `<what must be shown for this to count as done: theorem statements, zero-sorry build, audit, dashboard, model map>`
- **Sign-off:** `<name>` on `<YYYY-MM-DD>` — owner read the phase-2 theorem statements and accepted them

## Scope

**In scope:** `<rules R1..Rn, behaviors, state machine>`

**Out of scope (explicit):** `<performance, IO, persistence, logging, retries, concurrency liveness, library semantics, ...>`

## Rules

### R1 — `<short name>`
- **Statement:** `<precise sentence; "for all inputs satisfying X, the result must satisfy Y">`
- **Source of truth:** `<doc § / issue # / spec file:lines>` — never derived from the implementation.
- **Positive example:** `<state/input → expected result>`
- **Negative example (violation):** `<state/input → must be rejected or must not happen>`
- **Boundaries:** `<initial state, same-state update, missing/invalid input, empty collections, overflow, null/undefined, numeric precision/BigDecimal scale, date/time zone, string normalization, concurrency assumptions>`

`<add R2..Rn the same way>`

## Grilling log (owner answers, one round per question set)

| # | Question | Owner answer | Date |
|---|---|---|---|
| Q1 | | | |

## Open questions (must be closed before phase 2)

| # | Question | Status | Owner answer |
|---|---|---|---|
| Q1 | | | |

## Change policy

When code changes and a theorem breaks: **never weaken a confirmed theorem to get green.** Stop, report which rule/statement changed, and get owner re-confirmation.
