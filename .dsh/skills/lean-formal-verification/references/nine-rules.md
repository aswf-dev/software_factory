# The Nine Rules (verbatim) and what they mean operationally

Primary source: Carl M. Kadie, **"Nine Rules for Vibe Validation of Vibe-Coded Algorithms — Using AI-Written Lean to Validate AI-Written Rust"**, *Level Up Coding*, 2026-09-22.
<https://levelup.gitconnected.com/nine-rules-for-vibe-validation-of-vibe-coded-algorithms-20db019f5583>
Companion Lean code: <https://github.com/CarlKCarlK/range-set-blaze-vibe-validation>

The article's scope statement matters as much as the rules: *"I'm validating a high-level algorithm, not every detail of its Rust implementation. I translate the algorithm into Lean, have AI write a proof that the Lean version does what I expect, and have Lean check the proof. I separately test and review whether the Rust and Lean versions match."* Rust and Lean are incidental; the method applies to any implementation language.

## The nine rules (2026), verbatim

1. Don't prompt. Meta-prompt.
2. Reduce slop with aggressive but safe three-step vibe refactoring: Local, Shared, Higher-Level.
3. Enforce correctness guardrails.
4. Measure slop with a dashboard of metrics, rather than lines of code alone.
5. Vibe Code. Vibe Specify. Vibe & Human Review. Vibe Validate.
6. Preserve the algorithm; abstract the details.
7. Review adversarially with both human and AI eyes.
8. Set up the theorem first; prove it second.
9. Prove related results in sequence and build a shared library as you go.

## What each rule means when you execute the workflow

### 1. Don't prompt. Meta-prompt.

Have one long-running context write focused prompts for fresh, clean coding sessions. The strategist keeps the project memory; the executor gets one target at a time without the accumulated conversation.

Operationally here: keep the strategist memory in `RULES.md` + `MODEL-MAP.md`, not in chat history. Every proof attempt is a fresh sub-agent/session with a self-contained prompt (`references/workflow-prompts.md`). The article reports finishing several proof targets in one or two focused prompts (its own hedge: *"Perhaps this proof simply happened to be much easier"*). Treat that as an observation, not a guarantee.

### 2. Reduce slop with aggressive but safe three-step vibe refactoring

1. **Local** — simplify one file/proof; replace home-grown machinery with standard-library results. (Default to core Lean; Mathlib only with explicit owner approval recorded in `MODEL-MAP.md` — the article's "using Mathlib where possible" assumes a Mathlib workspace.)
2. **Shared** — find common structure across proofs and extract reusable lemmas.
3. **Higher-Level** — replace detailed proof steps with larger steps Lean can infer.

"Safe" means Rule 3 guardrails stay green after every change: the same theorem statements must still check, still with no `sorry` and no new axioms. In the article the main proof file went 3,320 → 942 total lines (−72%) and 1,983 → 777 Lean-code lines (−61%), while the rest of the project gained only 11 code lines — the reduction was real, not code moved elsewhere.

### 3. Enforce correctness guardrails

- Project builds.
- Main proof file compiles directly (it is the real root, not an orphan file).
- No `sorry` in the finished proof.
- No new axioms.
- `#print axioms` shows only Lean's standard axioms (`propext`, `Classical.choice`, `Quot.sound`).

Without guardrails "vibe refactoring" can make a proof short by making it wrong or vacuous.

### 4. Measure slop with a dashboard of metrics, rather than lines of code alone

The article's metric families (implemented by `scripts/verify-lean.sh`):

| Family | Metrics |
|---|---|
| Size | total lines; lines containing Lean code; whole-project Lean-code lines |
| Proof API shape | public lemmas/theorems; private lemmas/theorems |
| Proof branching | `cases`, `by_cases`, `induction` |
| Proof plumbing | `have`, `show`, `suffices`, `rw` |
| Automation | `simp`, `simpa`, `omega`, `linarith`, `grind` |
| Representation machinery | `List.span`, `takeWhile`, `dropWhile`, `getLast?`, `dropLast` |

Interpretation rules from the article: *"The goal was not to minimize every metric, but to simplify the proof on balance."* Some counts may rise. The whole-project Size row exists so the main file cannot shrink by pushing code elsewhere. Add or drop metrics when they stop earning their keep, and record why.

### 5. Vibe Code. Vibe Specify. Vibe & Human Review. Vibe Validate.

The four-stage loop for one target:

- **Code** — the implementation exists (AI-written or human-written). If this skill is used to verify existing code, this stage is "locate and understand the code path".
- **Specify** — translate the *algorithm/decisions* into a provable form and state the specification.
- **Review** — human + adversarial AI review of implementation, model, and specification before proving.
- **Validate** — prove, then audit the proof (see Rules 7–9).

### 6. Preserve the algorithm; abstract the details

Model the decisions and state transitions, not the plumbing. In the article a `BTreeMap` cursor became a pair of lists and the tree-navigation details disappeared; integers were treated as arbitrary-precision `Int` in that first scope, while the cached-length bookkeeping was validated separately later (and switched to `Nat` so underflow had to be proved). Cloning and overflow were declared out of scope for the algorithm validation — not silently ignored.

The abstraction is the point *and* the risk: the Lean version must stay close enough to review against the original code. `MODEL-MAP.md` is where that review is recorded — every dropped detail, every modeled decision, and why the dropped details cannot affect the proven property.

### 7. Review adversarially with both human and AI eyes

Before proving, ask of each of the three artifacts:

- Implementation: is this actually the algorithm claimed, or something that merely passes tests?
- Model: did the translation preserve every decision that matters?
- Specification: could the theorem be true while the algorithm still does something wrong?

Use a **fresh session, preferably a different strong model**, and ask it to be adversarial — *"find a counterexample, a missing assumption, a mismatch, or a specification that is too weak"* — never *"does this look correct?"*. Human review should cover the level the owner actually needs to understand: the top-level transition/decision and the theorem statement.

### 8. Set up the theorem first; prove it second

Land the theorem statement plus the proof structure with `sorry` where needed, build it, run the concrete examples, review the statement — only then fill the holes, one tiny target at a time. The article's Rule 8 stage went from weeks (2025) to *tens of minutes and two prompts* (2026) — with the author's own caveat that the cursor proof may simply have been easier.

### 9. Prove related results in sequence and build a shared library as you go

Get one result, then let its definitions/lemmas become infrastructure for the next. Periodically return to Rule 2 and clean the accumulated slop (duplicate lemmas, obsolete adapters, temporary abstractions that outlived their purpose). The article's coda applies the same cycle to progressively harder proofs, reaching multiple production algorithms within days.

## Appendix — the 2025 predecessor (different nine rules)

> Paraphrase, not a verbatim quotation. The 2025 pages are paywalled/archived and were not fully re-verified for this skill; the rule list below is a faithful summary of the 2025 series. Treat the "still-load-bearing lessons" as reported practice, not as quotes from the 2026 article (they are absent from it).

2025 article: **"Vibe Validation with Lean, ChatGPT-5, & Claude 4.5"**, parts 1 and 2 (Oct 2025):
<https://medium.com/@carlmkadie/vibe-validation-with-lean-chatgpt-5-claude-4-5-part-1-c57b430b3d7a> ·
<https://medium.com/@carlmkadie/vibe-validation-with-lean-chatgpt-5-claude-4-5-part-2-081e0f06886d> ·
companion code: <https://github.com/CarlKCarlK/range-set-blaze-lean>

Its nine rules were: (1) Don't use Lean. (2) Use Lean but don't learn it. (3) Drive Claude Sonnet 4.5 (or Codex) with ChatGPT-5. (4) Define your algorithm's basic concepts. (5) Redo your concepts — this time the Lean way. (6) Let the AI invent and prove a toy algorithm — simple, slow, but correct. (7) Specify a simplified, realistic algorithm and have the AI validate it. (8) Trust the AI to port your algorithm to Lean. Then distrustfully audit the port. (9) Trust the AI to validate the algorithm and audit again.

Still-load-bearing lessons from 2025 (kept in this skill's discipline):

- **Two audits.** Audit the port (model vs real code), then audit again after the proof — re-read the top-level code paths and confirm that refactoring during proof work did not change behavior. *"If the Lean algorithm isn't the same as your Rust algorithm, then any proof only validates the Lean code, not your Rust code."*
- **`sorry` discipline.** `sorry` is legitimate scaffolding — get the big structure running, then replace each one — but the finished proof has zero. Never "fix" warnings by `set_option warn.sorry false`.
- **Never replace a `sorry` with an axiom.** *"Keep gaps in reasoning visible and local until they're filled with real proofs."* Moving the `sorry` to the call site is the correct move; axiomatizing is a silent failure of validation.
- **AI failure modes are adversarial.** The 2025 author reports AI hiding `sorry`s with options and proposing axioms instead of proofs. Guardrails + axiom audit + human reading-level audit are the countermeasures.
- **Git discipline.** Commit whenever losing the current state would hurt; the proof is a contract that must be re-checked after every change.

## What the article does *not* provide (do not overclaim)

- No automatic implementation↔Lean bridge and no oracle. (The coda does use ordinary comparison tests between two implementations; those are tests, not proofs.) The gap is closed by review plus separate tests of the real implementation.
- No explicit sync protocol after code changes. The 2026 follow-up only establishes that theorem statements are re-checked on every edit and lists guardrails. This skill adds a manual re-sync protocol (`SKILL.md` phase 7) because production code changes.
- No proof of Rust/Java/TS implementation details: memory, overflow, I/O, library semantics and performance are out of scope unless explicitly modeled and declared.
