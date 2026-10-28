# Workflow prompt templates

Copy/adapt these. Each prompt is self-contained because Rule 1 (meta-prompt) sends fresh sessions one focused target at a time. Replace `<...>` placeholders.

## Phase 0 — Grilling frontier (ask the owner, one round at a time)

Ask only decisions whose prerequisites are settled, each with a recommended answer.

**If the owner already confirmed a rules artifact** (approved spec file, signed issue): do not re-interview. Transcribe it into `RULES.md`, record provenance (`confirmed-by`, date, source link), close phase 0, and note the transcription in the grilling log.

A useful first frontier for formal verification:

1. **Which rules?** Exact rule IDs and statements, plus the authoritative source (doc/issue/§) — and which rules are explicitly out of scope.
2. **Boundaries:** for each rule, what are the edges — initial state, same-state writes, missing/partial input, unknown enum values, concurrent writers, retries?
3. **What counts as a violation?** The concrete scenario the owner would call a bug, in words, with one positive and one negative example per rule.
4. **Allowed abstraction:** which implementation details may be dropped (types, maps, caching, persistence, logging) and which decisions must be preserved because they change behavior?
5. **Acceptance:** what must be shown for this to count as done — theorem statements, zero-sorry build, audit, dashboard, model map? Who signs off?
6. **Change policy:** when the code changes and a theorem breaks, may the theorem be weakened, or must the owner re-confirm?

Do not derive rule statements from the implementation. If the owner cannot state a rule precisely, that is a finding: propose a candidate statement with examples and let the owner decide.

## Phase 1 — Model prompt (fresh sub-agent/session)

> Task: model an existing implementation in Lean 4 so a rule can be proved, following `RULES.md` and `MODEL-MAP.md`.
> Inputs: `RULES.md` (owner-confirmed rules, do not change), source files `<paths>` (read-only), this project's conventions.
> Do: identify the decisions and state transitions that can change behavior; write a lean, functional model that preserves those decisions; drop only plumbing (data structures, persistence, logging, caching, generics) and record every dropped detail in the abstraction ledger with why it cannot affect the proven property.
> Do not: restate the code line by line, invent behavior the code does not have, or touch the real source.
> Output: model module(s) that build; updated `MODEL-MAP.md` with source file:line references for every modeled decision; a list of decisions you were unsure about.

## Phase 2 — Theorem-first prompt (Rule 8)

> Task: state theorems for the rules in `RULES.md`; do not prove them yet.
> Inputs: `RULES.md` (confirmed), the Lean model from phase 1, `MODEL-MAP.md`.
> Do: one headline theorem per rule (a rule may need a small set — R6 usually needs freshness + no-lost-update + serializability); each statement must be readable in business terms and relate the model to the rule, not restate a definition. Give every theorem a `sorry` body and a proof-structure skeleton (the case split / induction plan in comments). Add at least one concrete `example` witness per statement in `Examples.lean` so the hypotheses are demonstrably satisfiable.
> Build: `lake build` must pass (with `sorry` warnings — that is expected here). Then record each exact statement in `MODEL-MAP.md` as a statement snapshot and show the list to the owner.
> Do not: attempt proofs, weaken statements to match the implementation, or add axioms.
> Output: `Specs/Proofs.lean` with statement + skeleton, `Examples.lean` witnesses, statement snapshots in `MODEL-MAP.md`, build green.

## Phase 3 — Adversarial review prompt (fresh session, different model preferred)

> You are an adversarial reviewer. Do not approve; try to break the claim.
> Artifacts: `RULES.md` (the rules the owner confirmed), `MODEL-MAP.md`, the Lean model and theorem statements, and the implementation at `<paths>`.
> Find any of: (a) a behavior the implementation allows that the theorem forbids, or vice versa; (b) a hypothesis that can never hold, making the theorem vacuous; (c) a theorem statement weaker than the rule it claims to cover; (d) a model abstraction that silently removes a decision; (e) a missing rule or case.
> For each finding give a concrete input/trace and the file:line. If you find nothing, list exactly what you checked and what assumption you had to accept. Answer in a short report, not prose.

## Phase 4 — Sorry-elimination prompt

> Eliminate exactly these `sorry`s in `<file>`: `<list>`. Do not change theorem statements or definitions. Do not introduce axioms, `native_decide`, `unsafe`, or `set_option` that hides warnings. If a statement is false or unsound, stop and report which one and why, with a counterexample. Take one target at a time; build after each. Keep new helpers private unless a later rule needs them.

## Phase 5 — Refactor prompt (Rules 2 + 4)

> Current metrics: `<dashboard>`. Refactor the proof in three passes: Local (simplify one file, prefer standard library), Shared (extract genuinely common lemmas), Higher-Level (replace detailed steps with steps Lean can infer). The same theorem statements must still check, with zero `sorry` and no new axioms. After each pass run the verify script and report the before/after dashboard. Do not minimize every metric; explain any metric you deliberately let rise.

## Phase 6 — Re-sync prompt (after code change)

> The verified sources changed: `<git diff --stat / list>`. Update the Lean verification to match, without weakening any owner-confirmed rule.
> 1. Map each changed file:line to the modeled decision it affects (use `MODEL-MAP.md`).
> 2. If only refactoring: update the mapping, re-run the checks, log it.
> 3. If behavior changed: determine which rule is affected. If the *rule* changed, stop and ask the owner before editing theorem statements.
> 4. Update the model, then theorem statements, then proofs; run guardrails + dashboard; update `MODEL-MAP.md` verified-at commit and review log.
> Report: what changed, which theorems were touched, what remains risky.

## Fallbacks when the ideal participant is unavailable

- **Owner unreachable:** do not invent rules. Produce `RULES.md` as `draft` with open questions and stop. Report **"not verified — owner sign-off pending"**, never "verified".
- **No second model / no subagent tool:** run the adversarial prompt yourself in a fresh context if possible (new session or sub-agent); otherwise do the checklist manually, record it as "self-review (weaker)" in the review log, and mark the gate item as not independently satisfied.
- **Owner cannot read Lean:** translate each headline statement into one business-language sentence ("a DELIVERED order can never change status") and get sign-off on that sentence plus the negative examples. The sign-off is on the statement, not on the proof script.
- **No Mathlib / no network:** use core Lean; if a proof is not feasible in core, record the gap and report partial verification rather than adding dependencies.

## Self-doubt prompt (optional, before claiming done)

> You are auditing a formal-verification claim before it ships. Assume it is wrong. Check: does every theorem trace to a confirmed rule? Is any hypothesis unreachable? Was any theorem weakened after a failure? Are there `sorry`/axiom/`native_decide`/`unsafe` escapes? Does `MODEL-MAP.md` really cover every modeled decision and every theorem? What is the strongest criticism a skeptical reviewer would make? List the top three risks in order.
