---
name: lean-formal-verification
description: Use when asked to prove program logic, business rules, algorithms, state machines, or invariants correct with Lean 4 — formal verification, AI-written Lean proofs, "verify/prove this code", Lean 證明, or keeping existing proofs in sync after code changes. Also use when a green Lean build must be shown to say something about shipping code, or when proofs are suspected of sorry/axiom shortcuts. Applies to Java, TypeScript, Rust, Python and other implementation languages.
---

# Lean Formal Verification (nine rules)

## Overview

**Core principle: Lean checks the proof, not your program.** A Lean project can build green while proving a true theorem about a model that is *not* your code, under assumptions that never hold, or with the hard parts faked. This skill runs Carl M. Kadie's 2026 nine rules ("Vibe Validation": AI-written Lean validating AI-written code) as a workflow with three reviewable artifacts: **confirmed rules**, a **model↔code mapping**, and a **machine-checked proof**.

The output is not "Lean proofs". It is a **structured, gated claim**: *the code implements the owner-confirmed rules, this model preserves the decisions that matter, these theorems hold for every input in scope, and nothing was faked.*

## When to use / not use

- **Use:** business rules, state machines, pure functions, algorithms, protocol invariants written in any language — especially AI-written code, or proofs that must survive code changes.
- **Use when suspicious:** a green build is being presented as "verified", proofs may contain `sorry`/axioms, or the theorem statement was never read by the owner.
- **Not for:** timing, memory, IO, concurrency liveness, performance, library/DB semantics — use a model checker (`quint-modeling`) or property tests (`hegel`); for Rust memory safety consider Kani/Miri/Aeneas/Verus. Lean validates the *algorithm*, never every line of an implementation.

## Phases

| Phase | Rule(s) | Do | Exit artifact |
|---|---|---|---|
| 0. Confirm | addition | **REQUIRED SUB-SKILL:** Use `grilling`. Interview the owner on rules, boundaries, negative examples, allowed abstraction, acceptance. **If an owner-confirmed rule file already exists, transcribe it and record provenance instead of re-interviewing.** Never invent rules. Owner unreachable → `RULES.md` draft + stop; report "not verified — owner sign-off pending". | `RULES.md` (confirmed-by, acceptance/sign-off, grilling log) |
| 1. Code + Abstract | 5 (Code), 6 | If the code does not exist yet: write/test it first. Then find the real code path and decisions; write a Lean model that preserves every decision that can change behavior and drops only plumbing. | `MODEL-MAP.md` + model definitions |
| 2. Specify | 8 | **Theorem statements first**, `sorry` bodies, build, then show the owner. Record each exact statement in `MODEL-MAP.md` (statement snapshot). | statements + snapshot |
| 3. Review | 7 | Human reads the top-level statement and transitions. Independent adversarial agent (fresh context; different model if possible) tries to break the claim. | review log entries |
| 4. Prove | 8 | Replace `sorry` one target at a time. Stuck? Move the gap to the call site. Never axiomize. | zero `sorry` |
| 5. Guardrails + slop | 2, 3, 4 | Run `scripts/verify-lean.sh`. Refactor Local → Shared → Higher-Level, re-read the dashboard. Stop when green and no metric regressed without a stated reason. | dashboard + baseline |
| 6. Prove in sequence | 9 | Prove related results one after another; let lemmas become shared infrastructure; periodically run Rule 2 cleanup. | library = the model + lemma modules |
| 7. Re-sync | addition | On code change: diff verified sources, update model, re-run phases 2–5, log it. | updated map + proofs |

**Rule 1 (meta-prompt)** is cross-cutting: keep strategy in `RULES.md` + `MODEL-MAP.md`, not in chat context; send each proof target to a fresh session/sub-agent with a clean prompt (`references/workflow-prompts.md`).

## The verification gate — required before saying "verified"

All of the following, with evidence. The script checks what is mechanical; the rest must be in `MODEL-MAP.md`:

1. `RULES.md` has `confirmed-by` (owner), date, provenance, acceptance criteria — and every rule has a negative example.
2. `MODEL-MAP.md` has: verified-at commit; every modeled decision mapped to `file:line`; abstraction ledger (each dropped detail + why it cannot affect the property); explicit **not covered** list.
3. Every headline theorem has in `MODEL-MAP.md`: rule ID, exact statement (snapshot), source `file:line`, non-vacuity witness, and an adversarial-review entry.
4. **Statement stability:** statements recorded in phase 2 are unchanged; any change has an owner-approved delta logged.
5. Script green: clean build, direct compile of the main proof file, guardrail scan zero, axiom audit all-allowlisted, audit completeness (every headline theorem has a `#print axioms` line).
6. Dashboard snapshot recorded (baseline + current) with any metric regression explained.
7. A human/owner entry shows the top-level statements were read and accepted.

If any item is missing, report **partial verification** with the missing items — never "verified". A green build alone is never evidence.

## Guardrails (Rule 3)

`scripts/verify-lean.sh` enforces: clean `lake build`; direct compile; **no `sorry`**; **no new axioms** (`axiom`, `private axiom`, bodyless `opaque`, `unsafe`, `extern`, `@[extern]`, `@[implemented_by]`); no `native_decide`; no `set_option warn.sorry false`; `#print axioms` only `propext`, `Classical.choice`, `Quot.sound` (or "does not depend on any axioms"). Exact commands and edge cases: `references/guardrails.md`.

`by decide` is allowed for small closed computable facts; `#eval`/examples only in `Examples.lean` (non-vacuity), never as the claim.

## Dashboard (Rule 4)

```bash
bash <skill-dir>/scripts/verify-lean.sh --dir specs/lean --main Specs/Proofs.lean \
  --audit Audit.lean --theorems headline-theorems.txt --baseline metrics-baseline.txt
```

Prints Size / Proof API / Branching / Plumbing / Automation / Representation metrics; `--watch` for continuous runs, `--json` for machines, `--save-baseline` for the first green run. Definitions and interpretation: `references/metrics.md`.

## Rationalization table (observed in baseline testing without this skill)

| Excuse | Reality |
|---|---|
| "Build is green, so the code is verified." | Lean never saw the code. Model↔code is a review claim — write it in `MODEL-MAP.md`. |
| "Docs state the rules; skip grilling." | Docs drift and hide ambiguity. Transcribe a *confirmed* artifact only, with provenance; otherwise interview. |
| "I'll write the spec after looking at the code/tests." | Then you proved the implementation, not the requirement. Rules first. |
| "Model the implementation line by line." | Rule 6: model decisions/transitions, not navigation. More detail = more mismatch surface, no more trust. |
| "`sorry` is scaffolding, it's fine." | Only in phase 2; the final claim requires zero. |
| "Replace `sorry` with an axiom / bodyless `opaque`." | Silent failure. Keep gaps visible and local at the call site. |
| "Use `native_decide` to close it fast." | Banned: trusts the compiler. Use kernel `by decide` for small closed facts only. |
| "We ship in two hours; just make it compile." | Green-that-proves-nothing launders trust. Report unfinished work honestly. |
| "The theorem failed, so I weakened it." | Weakening without owner re-confirmation is how proofs become lies. |
| "Hand-picked examples show it works." | Examples are tests. The rule needs the general theorem. |
| "Owner is unavailable, I'll infer the rules." | Hard stop: draft + open questions, report "not verified". Never invent rules. |
| "I reviewed it myself." | Phase 3 needs an independent fresh-context adversarial pass; log it. |
| "The human can't read Lean, skip the statement review." | The statement is translated into business terms for them; no sign-off, no "verified". |
| "Prove all rules at once in one giant file." | Rule 9: theorem by theorem, shared library, periodic cleanup. |
| "I'll also build an oracle/conformance harness." | Do not. If truly needed, stop and get explicit owner approval recorded in `RULES.md`. Default: bounded port audit + `MODEL-MAP.md`. |

## Red flags — stop before reporting

- Any `sorry`, `axiom`/`private axiom`, bodyless `opaque`, `native_decide`, `unsafe`, `extern`, `@[implemented_by]` in the submitted project.
- A theorem that mirrors the implementation, is `P → P`, or whose hypotheses are unsatisfiable.
- Missing/unconfirmed `RULES.md`, incomplete `MODEL-MAP.md`, or no statement snapshot.
- No independent adversarial review entry; no owner sign-off entry.
- Dashboard never run; guardrail or axiom audit red; audit missing headline theorems.
- Statement changed after phase 2 without an owner-approved delta.
- Code changed and phases 2–5 were not revisited.

## Reference files and artifacts

- `references/nine-rules.md` — the nine rules verbatim (2026), operational meaning, 2025 predecessor appendix (paraphrase, clearly labelled), citations, "what the article does not provide".
- `references/porting.md` — abstraction-function discipline, Java/TypeScript/Rust → Lean type mapping, state-machine recipe, optimistic-locking model, pitfalls.
- `references/workflow-prompts.md` — prompt templates: grilling frontier, model, **theorem-first**, adversarial review, sorry elimination, refactor, re-sync, **fallbacks when the owner/reviewer is unavailable**, self-doubt.
- `references/guardrails.md` — script contract (flags, paths, exit codes), exact audit commands, banned constructs, axiom output forms, non-vacuity and bounded port-audit checklists.
- `references/metrics.md` — metric definitions, counting rules, baseline workflow.
- `examples/java-order-status/` — one complete, compilable worked example (Java source → model → theorems → proofs → witnesses → audit).
- `templates/` — `Specs.lean` root, `Specs/Model.lean` + `Specs/Examples.lean`, `RULES.md`, `MODEL-MAP.md`, `Audit.lean`, `headline-theorems.txt`, `lakefile.toml`, `lean-toolchain`, `.gitignore` (copy as-is; keep `lake-manifest.json` in version control).
- `scripts/verify-lean.sh` — build + direct compile + guardrail scan + axiom audit + completeness + terminal dashboard; `--watch`.
