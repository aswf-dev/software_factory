# verify-lean.sh - build gate, guardrails, axiom audit and Rule-4 metrics dashboard

`verify-lean.sh` is the continuous-execution + terminal-dashboard asset of the
`lean-formal-verification` skill. It answers one question in one screenful:
*is this Lean 4 verification project still trustworthy, and how is the proof
shaping up?*

It runs four checks, in order:

1. **Build gate** - `lake build` must pass in the Lean project directory.
2. **Guardrail scan** - no `sorry`, `admit`, `native_decide`, new
   `axiom`/`constant` declarations, `unsafe`, `extern`, `@[implemented_by]`,
   or `set_option warn.sorry false` anywhere in the project's `.lean` sources.
3. **Axiom audit** (optional, recommended) - runs an `Audit.lean` that calls
   `#print axioms` on every headline theorem and checks the axiom lists.
4. **Rule-4 metrics** - Size / Proof API / Branching / Plumbing / Automation /
   Representation counts for the main proof file, printed as an aligned table
   with an optional baseline and delta column.

Exit code `0` means: build green, no banned construct, and every audited
theorem depends only on the allowlisted axioms. Anything else is a failure
worth stopping for.

## Requirements

* `bash` - tested with macOS `/bin/bash` **3.2.57** (no associative arrays,
  no `mapfile`, no GNU-only flags; guard checks use `command -v`).
* `coreutils`/BSD userland: `awk`, `sed`, `grep`, `find`, `sort`, `tail`,
  `mktemp`, `date`. `git` is optional (used only for the commit line).
* Lean 4 via [elan](https://leanprover-community.github.io/get_started.html):
  `lake` and `lean` must be resolvable. If they are not on `PATH`:

  ```sh
  export PATH="$HOME/.elan/bin:$PATH"
  ```

  (`verify-lean.sh` also falls back to `$HOME/.elan/bin` itself, and honours
  `$LAKE` / `$LEAN` overrides.)
* No network access and no Python/Node/jq are needed to run the script.

## Quick start

From the repository that contains the Lean project (default `specs/lean`):

```sh
# one-shot gate; audit file recommended
bash scripts/verify-lean.sh --dir specs/lean --audit specs/lean/Audit.lean

# record the first green run as a baseline, then compare future runs against it
bash scripts/verify-lean.sh --dir specs/lean --audit specs/lean/Audit.lean \
    --save-baseline specs/lean/.verify-baseline
bash scripts/verify-lean.sh --dir specs/lean --audit specs/lean/Audit.lean \
    --baseline specs/lean/.verify-baseline

# continuous mode: rerun on every .lean change, Ctrl-C to stop
bash scripts/verify-lean.sh --dir specs/lean --audit specs/lean/Audit.lean --watch
```

`--main` is auto-detected when omitted: the largest `.lean` file (by bytes)
that has at least one Lean-code line, ignoring the `--audit` file. Pass it
explicitly when the proof file should be pinned.

## Options

| Option | Meaning |
|---|---|
| `--dir <dir>` | Lean project root (`default: specs/lean`). Relative to the current cwd. |
| `--main <file>` | Main proof file whose Rule-4 metrics are reported. Relative paths resolve against the cwd first, then against `--dir`. |
| `--audit <Audit.lean>` | File with `#print axioms` lines. Same path resolution as `--main`. Optional, but recommended. |
| `--baseline <file>` | `key=value` baseline file; adds Baseline and Delta columns. Same path resolution as `--main`. |
| `--save-baseline <file>` | Write the current metrics as a baseline after the run. The parent directory must exist. |
| `--json <file>` | Write a flat JSON results object (also on failure). The parent directory must exist. |
| `--once` | Single run (default). |
| `--watch` | Poll for `.lean` changes and rerun; `--interval` sets the poll period. If both `--once` and `--watch` are given, the last one wins. |
| `--interval <sec>` | Watch poll interval, positive whole seconds (`default: 2`). |
| `-h`, `--help` | Usage text, exit `0`. |

`--` terminates option parsing; anything after it is a usage error because the
script takes no positional arguments. Option values are taken literally, so
quote paths with spaces: `--dir "specs/my lean project"`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | PASS: build + guardrails + axiom audit (when configured) all clean. |
| `1` | FAIL: build failure, guardrail hit, axiom failure, missing Lean toolchain, no `.lean` files under `--dir`, or an I/O failure while writing `--json` / `--save-baseline`. |
| `2` | Usage error: unknown/malformed option, missing project directory, missing `--main`/`--audit`/`--baseline` file, bad `--interval`, unwritable output parent directory. |

Watch mode keeps running after failed checks (that is the point: fix, see the
dashboard go green) and exits `0` when stopped with `INT`/`TERM`, printing
`verify-lean: watch stopped (...); exiting.`

## Guardrails

Scanned files: every `*.lean` file under `--dir`, recursively, skipping
`.lake/` and `.git/`. Hits are reported as `file:line: [category] token | line
text`; one hit is enough to fail the run.

| Category | Pattern |
|---|---|
| `sorry` | `sorry` as a whole word |
| `admit` | `admit` as a whole word |
| `native_decide` | `native_decide` as a whole word |
| `unsafe` | `unsafe` as a whole word |
| `extern` | `extern` as a whole word |
| `implemented_by` | `implemented_by` (covers `@[implemented_by ...]`) |
| `axiom_decl` | `axiom <name>` declaration |
| `constant_decl` | `constant <name>` declaration |
| `warn_sorry_off` | `set_option warn.sorry false` |

Matching is done on **comment-stripped, string-masked** source: `--` line
comments, `/- ... -/` block comments (nesting tracked across lines) and
string-literal contents are removed before matching. Documentation may
therefore talk about `sorry` or `axiom cheat : False` without tripping the
scan. `axiom`/`constant` count only as declarations: the line must start the
command (optionally after attributes/modifiers) and be followed by a declared
name, so structure fields like `constant : Nat` are not flagged.

**Per-line exemption:** if a line contains the literal marker
`-- guardrail-ok:`, the line is skipped (counted in the dashboard as "exempt
line(s)"). Use it only for deliberate fixtures, e.g.

```lean
theorem fixture : 1 + 1 = 2 := by native_decide -- guardrail-ok: guardrail self-test fixture
```

## Axiom audit

`--audit` is a normal `.lean` file, executed with `lake env lean <file>` from
`--dir`, that prints the trusted axioms of each headline theorem:

```lean
import MyProof

#print axioms MyProof.main_theorem
```

Output lines of the form `'name' depends on axioms: [propext, ...]` (Lean wraps
long lists over several lines; the parser handles that) and
`'name' does not depend on any axioms` are parsed. The audit **fails** if:

* the audit file does not run (non-zero `lean` exit),
* no `#print axioms` lines were produced at all,
* a forbidden axiom appears: `sorryAx`, `Lean.ofReduceBool`,
  `Lean.trustCompiler`, or any axiom whose name hints at `native_decide`
  compiler trust,
* an axiom is outside the allowlist `propext`, `Classical.choice`,
  `Quot.sound` (any other name fails the run; there is no wildcard).

Every parsed theorem is reported as `'name' [axioms] OK` or `FAIL` plus the
reason. When the build gate fails, the audit is skipped (`SKIP`) because the
project cannot be loaded; the run already fails on the build.

## Rule-4 dashboard

Example (baseline shown; `-` when no baseline is configured):

```
[RULE-4 METRICS]
  comparing against baseline: specs/lean/.verify-baseline
| Metric                           |   Current |  Baseline |     Delta |
|----------------------------------|-----------|-----------|-----------|
| whole_project.lean_files         |         3 |         3 |         0 |
| whole_project.total_lines        |       412 |       390 |       +22 |
| whole_project.lean_code_lines    |       231 |       220 |       +11 |
| main.total_lines                 |       180 |       170 |       +10 |
| main.lean_code_lines             |       120 |       115 |        +5 |
| main.proof_api.public            |        14 |        12 |        +2 |
| main.proof_api.private           |         2 |         2 |         0 |
| main.proof_branching.cases       |         6 |         6 |         0 |
| main.proof_branching.by_cases    |         3 |         3 |         0 |
| main.proof_branching.induction   |         4 |         4 |         0 |
| main.proof_branching.total       |        13 |        13 |         0 |
| main.proof_plumbing.have         |        11 |        11 |         0 |
| main.proof_plumbing.show         |         2 |         2 |         0 |
| main.proof_plumbing.suffices     |         1 |         1 |         0 |
| main.proof_plumbing.rw           |         8 |         8 |         0 |
| main.proof_plumbing.total        |        22 |        22 |         0 |
| main.automation.simp             |        19 |        15 |        +4 |
| main.automation.simpa            |         3 |         3 |         0 |
| main.automation.omega            |         1 |         1 |         0 |
| main.automation.linarith         |         0 |         0 |         0 |
| main.automation.grind            |         0 |         0 |         0 |
| main.automation.total            |        23 |        19 |        +4 |
| main.representation.List_span    |         1 |         1 |         0 |
| main.representation.takeWhile    |         1 |         1 |         0 |
| main.representation.dropWhile    |         0 |         0 |         0 |
| main.representation.getLast?     |         1 |         1 |         0 |
| main.representation.dropLast     |         0 |         0 |         0 |
| main.representation.total        |         3 |         3 |         0 |
```

Metric widths are computed from the key set, so `whole_project.lean_code_lines`
always fits. Output is plain ASCII; no colour, no cursor tricks outside watch
mode's optional screen clear. The run ends with a summary block:

```
SUMMARY
  build      : PASS
  guardrails : PASS
  axioms     : PASS
  toolchain  : Lean (version 4.35.0, ...)
  lake dir   : /abs/path/specs/lean
  git commit : 1a2b3c4 (dirty)
  duration   : 3s
  RESULT     : PASS
```

`git commit` reads `git rev-parse --short HEAD` inside `--dir` (scoped dirty
check); it says `not a git repository` when `--dir` is outside a git work tree.

### Metric definitions

`whole_project.*` covers every scanned `.lean` file under `--dir`.

| Metric | Definition |
|---|---|
| `whole_project.lean_files` | Number of `.lean` files scanned (`.lake/`, `.git/` excluded). |
| `whole_project.total_lines` | Raw line count of all scanned files. |
| `whole_project.lean_code_lines` | Lines that still contain code after masking comments/strings (see below). |
| `main.total_lines` | Raw line count of the main proof file. |
| `main.lean_code_lines` | Code-bearing lines in the main proof file. |
| `main.proof_api.public` | Public `theorem`/`lemma` declarations in the main file. |
| `main.proof_api.private` | `private theorem`/`private lemma` declarations. |
| `main.proof_branching.cases` | Occurrences of the `cases` tactic token. |
| `main.proof_branching.by_cases` | Occurrences of `by_cases`. |
| `main.proof_branching.induction` | Occurrences of `induction`. |
| `main.proof_branching.total` | Sum of the three branching rows. |
| `main.proof_plumbing.have` / `.show` / `.suffices` / `.rw` | Occurrences of each plumbing token. |
| `main.proof_plumbing.total` | Sum of the four plumbing rows. |
| `main.automation.simp` / `.simpa` / `.omega` / `.linarith` / `.grind` | Occurrences of each automation token. |
| `main.automation.total` | Sum of the five automation rows. |
| `main.representation.List_span` | `List.span` references (also method/qualified forms such as `xs.span`; bare `span` is not counted). |
| `main.representation.takeWhile` / `.dropWhile` / `.getLast?` / `.dropLast` | Occurrences of each representation helper, bare or qualified (`xs.takeWhile`, `List.dropLast`, ...). |
| `main.representation.total` | Sum of the five representation rows. |

### Counting rules (and their heuristics)

These are lexical metrics meant to reveal trends, not a semantic analysis of
the proof. The rules are deliberately explicit:

* **Lean code line.** A line counts if, after removing `--` line comments,
  `/- ... -/` block comments (nesting tracked across lines), and the contents
  of string literals, at least one non-whitespace character remains. Blank
  lines and comment-only lines are excluded. This is a heuristic: a line with
  only punctuation is counted, and a multi-line term's continuation line is
  counted (correctly - it is code).
* **Tokens.** Code lines are split into tokens that are maximal runs of
  `[A-Za-z0-9_.'?#]`; everything else (spaces, `[`, `]`, `(`, `,`, `:` ...)
  separates tokens. A row is incremented for each token that matches exactly:
  * `simpa` never counts as `simp`, `simp_all` is neither (`simp_all` is not
    one of the counted tokens), `#show` does not count as `show`, and `rw?` /
    `simp?` do not count as `rw` / `simp` (the `?` is part of the token);
  * representation helpers also match qualified tokens ending in
    `.<name>` (e.g. `xs.takeWhile`, `List.getLast?`);
  * `List.span` matches `List.span` and qualified `*.span` forms.
* **Declarations.** A line containing a `theorem` or `lemma` token counts one
  declaration (line-level heuristic - Lean allows only one per command line in
  practice). It is *private* when a `private` token appears earlier on the same
  line, otherwise *public*. Attributes/modifiers on the same line are fine
  (`private theorem ...`). An attribute on the previous line is fine because
  the declaration keyword still starts its own line. A `private` keyword split
  onto its own line is not counted as private (rare; documented limitation).
* **Comments/strings.** Metrics are computed on the same comment-stripped,
  string-masked text as the guardrail scan, so documentation and string
  literals do not inflate proof-size counts.

## Baseline files

`--baseline` / `--save-baseline` use a plain `key=value` file with integer
values (lines starting with `#` are comments):

```
# verify-lean.sh metric baseline (key=value; integer counts)
whole_project.lean_files=3
whole_project.lean_code_lines=231
main.proof_api.public=14
main.proof_branching.total=13
...
```

`--save-baseline` writes today's metrics after a run (including failing runs -
record a green baseline). `--baseline` compares; keys missing from the
baseline show `-`, and `Delta = Current - Baseline` (`+` = growth, `-` =
reduction; a zero delta prints `0`). Not every metric must fall: use the
dashboard to see whether a refactor moved the proof towards the intended shape
(more `proof_api` and representation clarity, less branching/plumbing).

## JSON output

`--json <file>` writes a **flat** JSON object: every value is a string, number
or boolean (no nested objects/arrays; details are indexed flat keys):

```json
{
  "status": "pass",
  "exit_code": 0,
  "timestamp": "2026-10-23T23:50:00+0800",
  "duration_seconds": 2,
  "mode": "once",
  "toolchain": "Lean (version 4.35.0, ...)",
  "lake_bin": "/Users/me/.elan/bin/lake",
  "lean_bin": "/Users/me/.elan/bin/lean",
  "lake_dir": "/abs/specs/lean",
  "main": "specs/lean/Proof.lean",
  "audit": "specs/lean/Audit.lean",
  "git_commit": "1a2b3c4 (dirty)",
  "build_status": "pass",
  "build_ok": true,
  "build_exit_code": 0,
  "guardrails_status": "pass",
  "guardrails_ok": true,
  "guardrail_hits": 0,
  "guardrail_files_scanned": 3,
  "guardrail_exempt_lines": 0,
  "axioms_status": "pass",
  "axioms_ok": true,
  "axiom_theorems": 4,
  "axiom_failures": 0,
  "axioms_note": "4 theorem(s) checked",
  "axiom_theorem.0": "'Proof.main_theorem' [propext, Classical.choice] OK",
  "metric.whole_project.lean_files": 3,
  "metric.main.proof_api.public": 14
}
```

Status fields are lowercase `pass` / `fail` / `skip`. Guardrail details appear
as `guardrail_hit.N` strings (`file:line: [category] token | line text`), axiom
details as `axiom_theorem.N` and failure reasons as `axiom_failure.N`; every
metric is `metric.<metric-key>`. The file is written on failures too. No
external tool is used to build the JSON (only `sed` for escaping).

## Watch mode

`--watch` runs the whole gate once, then polls every `--interval` seconds for
changes and reruns on the first change:

* changed files are detected with mtime stamps - every `*.lean` under `--dir`
  (`.lake/`/`.git/` excluded), plus `--audit` and `--main` (they may live
  outside `--dir`);
* a timestamp is touched before each run, so edits made while the build is
  running trigger another run on the next poll (no lost updates);
* the screen is cleared before each rerun only when stdout is a terminal
  (`tput clear` when available, else `clear`); redirected logs stay complete;
* `INT`/`TERM` stop the loop with a message and exit `0`; the exit code of the
  last check is not used as the watch-mode exit status;
* `--json` is rewritten on every run; `--main` auto-detection happens once at
  startup (pin it with `--main` if files are added/removed dynamically).

## Toolchain resolution

For each of `lake` and `lean`, in order:

1. `$LAKE` / `$LEAN` when set (must be executable or resolvable on `PATH`),
2. `PATH` (`command -v`),
3. `$HOME/.elan/bin/lake` / `$HOME/.elan/bin/lean`.

A missing `lake` prints an actionable error with the install URL
(<https://leanprover-community.github.io/get_started.html>) and

```sh
export PATH="$HOME/.elan/bin:$PATH"
```

then exits `1`. The resolved Lean version (first line of `lean --version`, or
`lake --version` when only lake is available) is printed in the dashboard
header and summary.

## Known limitations / deliberate non-goals

* **Lexical, not semantic.** Tokens inside macros, syntax quotations, custom
  notation or multi-line tactic blocks are counted textually. Tactics reused
  through `macro`/`notation` are invisible; `simp_all` is not folded into
  `simp`; `#show` and `*?` suggestion variants are excluded by the token rule.
  Read the dashboard as a trend signal, not an exact tactic census.
* **Declaration heuristics** are line-based (see Counting rules). Multi-line
  `private` is not attributed, and a `theorem` token in an unusual position can
  be miscounted in principle.
* Comments/strings are masked with a hand-written scanner: `--` and `/- -/`
  (nested) and `"..."` are handled; character literals containing a double
  quote are not special-cased (vanishingly rare in Lean sources). File names
  containing newlines are unsupported; `.lean` symlinks under `--dir` are not
  followed by `find` (regular files only).
* **Guardrail scope is `--dir`** (plus nothing else). An `--audit` or `--main`
  file outside the project directory is executed/measured but not scanned for
  banned constructs - keep them inside `--dir` to benefit from the scan.
* The **build gate** runs plain `lake build` (default targets). A custom
  target list is out of scope; run such builds yourself first.
* Axiom parsing expects the Lean 4 `#print axioms` output shape. If the audit
  file only produces warnings/errors, the run fails with "no '#print axioms'
  output produced" rather than silently passing.
* **Duration** is whole seconds. **Watch mode** has no debounce (a burst of
  saves can trigger a run per change) and does not watch non-`.lean` inputs
  (e.g. `lakefile.toml`, `lean-toolchain`); rerun manually after changing the
  project configuration.
* No ANSI colour, by design: the dashboard is meant to paste into issues, CI
  logs and PR descriptions unchanged.

## Sanity check

```sh
bash -n verify-lean.sh            # syntax
bash verify-lean.sh --help        # usage, exit 0
bash -u verify-lean.sh --dir <lean-project>   # already uses set -u internally
```

A clean fixture project with a passing `Audit.lean` should exit `0`; injecting
`sorry`, `axiom`, or a `sorryAx`-dependent theorem should exit `1` with the
offending `file:line`.
