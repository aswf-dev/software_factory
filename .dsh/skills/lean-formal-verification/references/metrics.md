# Metrics: the slop dashboard (Rule 4)

Line count alone can be gamed; a short proof can be wrong or vacuous. The dashboard tracks several families and the goal is to simplify **on balance**, not to minimize every number. `scripts/verify-lean.sh` computes these and prints a terminal dashboard (`--json` for machine-readable output, `--save-baseline`/`--baseline` for before/after, `--watch` for continuous runs).

## Metric families

| Family | Metric (dashboard key) | Counting rule |
|---|---|---|
| Size | `total_lines` | all lines in the main proof file |
| Size | `lean_code_lines` | non-empty lines after stripping comments the same way the guardrail scan does (`--` line comments; `/- … -/` blocks approximated) |
| Size | `whole_project_lean_code_lines` | same but across every `.lean` file outside `.lake/` — guards against making the main file smaller by moving code elsewhere |
| Proof API | `public_lemmas_theorems` | top-level `theorem`/`lemma` declarations, including `protected` and attribute-prefixed ones (`@[simp] theorem …`) |
| Proof API | `private_lemmas_theorems` | the same, counting `private` declarations |
| Proof branching | `cases`, `by_cases`, `induction` | word-boundary occurrences |
| Proof plumbing | `have`, `show`, `suffices`, `rw` | word-boundary occurrences |
| Automation | `simp`, `simpa`, `omega`, `linarith`, `grind` | word-boundary occurrences; `simpa` counts once, not as `simp` |
| Representation | `List.span`, `takeWhile`, `dropWhile`, `getLast?`, `dropLast` | word-boundary occurrences |

Counting is textual: it is a *slop indicator*, not a semantic measure. Keep the rule stable across runs so the before/after comparison is meaningful; record any change to the counting rule in the commit/message.

## Baseline workflow

All paths passed to the script are relative to `--dir` (the Lean project root). Full flag/exit-code contract: `references/guardrails.md`.

```bash
# first green run — record the "before"
bash <skill-dir>/scripts/verify-lean.sh --dir specs/lean --main Specs/Proofs.lean \
  --audit Audit.lean --theorems headline-theorems.txt \
  --save-baseline metrics-baseline.txt

# after each refactoring pass
bash <skill-dir>/scripts/verify-lean.sh --dir specs/lean --main Specs/Proofs.lean \
  --audit Audit.lean --theorems headline-theorems.txt --baseline metrics-baseline.txt
```

Update the baseline only when the proof has genuinely stabilized at a better shape (or when a deliberate change — e.g. adding a rule — is accepted). Note in the message which metrics rose and why. Refactoring must not change the statement snapshots recorded in `MODEL-MAP.md`.

## Reading the dashboard

From the source article's cleanup (main proof file):

| Metric | Before | After | Change |
|---|---|---|---|
| Total lines | 3,320 | 942 | −72% |
| Lines containing Lean code | 1,983 | 777 | −61% |
| Whole project Lean-code lines | 3,252 | 2,057 | −37% |
| Public lemmas/theorems | 6 | 6 | 0% |
| Private lemmas/theorems | 36 | 17 | −53% |
| cases | 56 | 6 | −89% |
| by_cases | 17 | 5 | −71% |
| induction | 23 | 3 | −87% |
| have | 471 | 133 | −72% |
| show | 8 | 3 | −63% |
| suffices | 1 | 0 | −100% |
| rw | 172 | 41 | −76% |
| simp | 203 | 50 | −75% |
| simpa | 18 | 27 | +50% |
| omega | 15 | 5 | −67% |
| linarith | 3 | 0 | −100% |
| grind | 0 | 0 | 0% |
| List.span | 44 | 22 | −50% |
| takeWhile | 81 | 24 | −70% |
| dropWhile | 66 | 7 | −89% |
| getLast? | 7 | 8 | +14% |
| dropLast | 10 | 2 | −80% |

`simpa` and `getLast?` rose — that is acceptable. The public API count stayed flat, which is usually desirable: refactoring should not reshape the interface the rest of the project imports.

Interpretation guide:

- **Size falls but whole-project size does not** → code was moved, not removed.
- **`have`/`rw` high** → manual goal manipulation; look for Higher-Level steps.
- **`simp` high** → brittle automation; a named lemma may be clearer.
- **Branch counts high** → proof is case-weary; a shared lemma or a better invariant may collapse cases.
- **Private lemmas growing** while public stays flat → proof library is progressing (Rule 9), but run Rule 2 cleanup periodically.
- **Every metric rising after adding a rule** is normal — compare like for like (same rule set).

## Anti-gaming

The dashboard exists to guide refactoring, not to be optimized. Do not delete needed lemmas to hit a number, do not move code to another file to shrink the Size row (the whole-project row exists for that), and never weaken a theorem to reduce proof plumbing. Guardrails (Rule 3) and the review (Rule 7) are what keep the proof honest; the dashboard only makes slop visible.
