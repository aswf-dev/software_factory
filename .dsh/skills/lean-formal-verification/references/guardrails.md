# Guardrails and the verification script contract

Rule 3 of the nine rules. Everything here is required **before** the word "verified" is used. `scripts/verify-lean.sh` automates the mechanical part; the manual gate items are not automatable and must be recorded in `MODEL-MAP.md`.

## Script contract (single source of truth)

```bash
bash <skill-dir>/scripts/verify-lean.sh \
  --dir specs/lean --main Specs/Proofs.lean \
  --audit Audit.lean --theorems headline-theorems.txt \
  --baseline metrics-baseline.txt [--save-baseline <file>] [--json <file>] \
  [--once | --watch] [--interval <sec>] [--help]
```

| Flag | Default | Meaning |
|---|---|---|
| `--dir` | `specs/lean` | Lean project root (contains `lakefile.toml`). All paths below are relative to it. |
| `--main` | largest code-bearing `.lean` not in `.lake/` | main proof file; must compile directly |
| `--audit` | `<dir>/Audit.lean` if present | axiom-audit file (`#print axioms` lines) |
| `--theorems` | none | file with one fully-qualified headline theorem per line; audit FAILS if any has no output line |
| `--baseline` / `--save-baseline` | none | metric comparison / snapshot (first green run) |
| `--json` | none | machine-readable results |
| `--once` / `--watch` | `--once` | single run / continuous re-run on `.lean` mtime change (Ctrl-C exits cleanly) |
| `--interval` | `2` | watch poll seconds |
| exit codes | — | `0` all mechanical checks pass · `1` build/guardrail/audit failure · `2` usage error |

Automated: toolchain resolution, clean build, direct compile, guardrail scan, axiom audit, audit completeness, metrics dashboard, JSON.
**Not automated (manual gate, record in `MODEL-MAP.md`):** owner sign-off, statement stability, non-vacuity reasoning, abstraction safety, adversarial review, port audit.

## Toolchain

Lean is installed by elan but usually not on `PATH` in non-interactive shells:

```bash
export PATH="$HOME/.elan/bin:$PATH"
lean --version && lake --version
```

Pin with `lean-toolchain` (`leanprover/lean4:v4.35.0`). Default: **core Lean, no Mathlib** (offline, seconds). Mathlib is an explicit owner decision recorded in `MODEL-MAP.md` — do not add it by default, and do not silently drop standard-library opportunities either: under Rule 2 "Local", prefer core-stdlib replacements; Mathlib only when approved.

## 1. Clean build + direct compile

```bash
cd specs/lean && rm -rf .lake && lake build     # must succeed from scratch
lake env lean Specs/Proofs.lean                  # main proof file compiles directly
```

Use a library named after the source directory with `globs = ["Specs.*"]` in `lakefile.toml` so **every** module is built (an unimported file is not checked). Keep `Specs.lean` as the root. `lake-manifest.json` is normally committed (it pins dependencies); ignore only `.lake/`.

## 2. Guardrail scan (no fakes)

The script strips comments first (`--` to end of line and `/- … -/` blocks) and then scans code only. There is **no exemption marker** — documentation comments may mention banned words freely; real code may not contain them. Manual equivalent (after comment stripping):

```bash
# placeholders, cheat tactics, hidden warnings
grep -nE '\b(sorry|native_decide)\b|set_option[[:space:]]+warn\.sorry' <stripped code>
# axiom-like and trust escape hatches
grep -nE '^[[:space:]]*(private[[:space:]]+|protected[[:space:]]+)?axiom\b' <stripped code>
grep -nE '^[[:space:]]*(private[[:space:]]+|protected[[:space:]]+)?opaque\b[^:]*$' <stripped code>   # opaque WITHOUT a body
grep -nE '^[[:space:]]*unsafe\b|\bextern\b|@\[(extern|implemented_by)' <stripped code>
# #eval / examples are allowed ONLY in Examples.lean
grep -nE '^[[:space:]]*#eval\b' --include='*.lean' . | grep -v 'Examples.lean'
```

| Banned | Why |
|---|---|
| `sorry` | Theorem asserted, not proved. Phase-2 scaffolding only; final state zero. |
| `axiom`, `private axiom`, `protected axiom` | Unproved assumption; raises no warning. One is a silent failure of validation. |
| bodyless `opaque` | Hides the implementation from the kernel; can make trivial theorems look meaningful. A bodyless `opaque` is FAIL; `opaque x : T := term` is allowed and must be logged in `MODEL-MAP.md` (with the reason it cannot be modeled as a `def`). |
| `native_decide` | Trusts the compiler (appears in the audit as `_native.native_decide…`). |
| `unsafe`, `extern`, `@[extern …]`, `@[implemented_by]` | Escape hatches outside kernel checking. |
| `set_option warn.sorry false` | Hides `sorry`s. |
| `#eval` outside `Examples.lean` | Demonstrations are tests, not proofs. |

`by decide` is allowed for small closed computable facts (kernel-checked); it is not a substitute for a general theorem. `admit`/`constant` are not Lean 4 constructs — do not list them as Lean bans.

## 3. Axiom audit (both output forms)

`Audit.lean` imports the proof root and prints axioms for every headline theorem:

```lean
import Specs
#print axioms OrderLifecycle.never_lost_update   -- namespace-qualified
```

```bash
cd specs/lean && lake env lean Audit.lean
```

Lean 4.35 prints one of:

```
'OrderLifecycle.never_lost_update' does not depend on any axioms          -> PASS (best)
'OrderLifecycle.monotone_total' depends on axioms: [propext, Classical.choice, Quot.sound]
                                                                          -> PASS if all names allowlisted
'OrderLifecycle.bad' depends on axioms: [sorryAx]                         -> FAIL
'OrderLifecycle.bad2' depends on axioms: [Specs.bad2._native.native_decide.ax_1_1]  -> FAIL
```

- Allowlist: `propext`, `Classical.choice`, `Quot.sound`.
- FAIL: `sorryAx`, names matching `_native.native_decide`, `Lean.ofReduceBool`, `Lean.trustCompiler`, and any other name not in the allowlist.
- **Completeness:** every theorem listed in `headline-theorems.txt` must have exactly one output line. A missing line means the audit did not check it → FAIL. No lines at all → FAIL.

## 4. Non-vacuity and honesty checks (manual, per theorem)

- **Witness:** for every headline theorem with hypotheses, `Examples.lean` has at least one concrete instantiation (`example : <instantiated conclusion> := by decide` or a term). If no input satisfies the hypotheses, the theorem proves nothing — fix the statement.
- **Not a restatement:** reject `P → P`, `True`, and theorems that only unfold a definition. The statement should relate a business property to the model.
- **Statement snapshot:** phase 2 records each exact theorem statement in `MODEL-MAP.md` (or a `Statements.lean` of `example : <type>` lines). Refactoring may not change it; any change needs an owner-approved delta in the review log.
- **Abstraction ledger:** each modeled definition has a source `file:line`; each dropped detail has a safety argument. A mechanism that matters (e.g. optimistic locking, counters, rounding) must not be silently "dropped as persistence".
- **Traceability:** every theorem maps to a rule ID in `RULES.md`, and every rule has at least one headline theorem (or an explicit owner-approved exclusion).

## 5. Bounded port audit (replaces building a harness)

For each rule, compare the Lean model to the real code and record in `MODEL-MAP.md`:

| Check | Question |
|---|---|
| Guards | Does every branch condition in the source appear in the model with the same sense? |
| Order | Does the model preserve the order of guards / short-circuit behavior? |
| Outcomes | Does each source path map to the same modeled outcome (value, error, no-op)? |
| Boundaries | Do enum defaults, null/undefined, overflow, rounding, time zone, string normalization map explicitly? |
| Dropped details | Is each dropped detail provably irrelevant to this rule (not merely "persistence")? |

This audit, the model map, and the adversarial review are the model↔code link. **Do not build an oracle/differential harness unless the owner explicitly asks and records approval in `RULES.md`.**

## 6. Mathlib and dependencies

Core Lean by default. Adding Mathlib requires: owner approval recorded in `MODEL-MAP.md`, `lake-manifest.json` committed, and a note on CI/build cost. Never let `.lake/` contents (including Mathlib sources) into metrics or scans.

## 7. Reporting

Report mechanical evidence verbatim (build output, scan result, audit lines, dashboard). Report manual gate items as a checklist with evidence links. If any item is missing: **partial verification** with the missing list — never "verified". State assumptions that the proof cannot see (DB isolation semantics, library behavior, integer overflow policy) in the `MODEL-MAP.md` not-covered list.
