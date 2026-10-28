#!/usr/bin/env bash
# =============================================================================
# verify-lean.sh - build gate, direct compile, guardrails, axiom audit and
#                  Rule-4 metrics dashboard, with optional continuous watch.
#
# Part of the lean-formal-verification skill. It is the executable form of the
# Rule 3 mechanical gates (no sorry/axiom/trust shortcuts, completeness of the
# axiom audit) plus Rule 4 (measure the proof, not the vibes).
#
# DESIGN CONSTRAINTS
#   * bash, POSIX-flavoured, macOS /bin/bash 3.2.57 compatible:
#     no associative arrays, no mapfile/readarray, no bash-4 case conversion,
#     no GNU-only sed/stat/find flags.
#   * Dependencies: bash, coreutils/BSD userland (grep/awk/sed/find/sort/tail/
#     mv/mktemp), git (optional), and a Lean 4 toolchain (lake/lean).
#   * No `set -e` (failure statuses are values, never surprises). `set -u` on.
#
# Contract: see references/guardrails.md in the skill and README.md here.
# =============================================================================

set -u

SCRIPT_NAME="verify-lean.sh"
SCRIPT_VERSION="2.0.0"

DEFAULT_DIR="specs/lean"
DEFAULT_AUDIT_NAME="Audit.lean"
EXAMPLES_FILE_NAME="Examples.lean"
LAKEFILE_FILE_NAME="lakefile.lean"

# ---------------------------------------------------------------------------
# Raw command-line options
# ---------------------------------------------------------------------------
OPT_DIR=""
OPT_MAIN=""
OPT_AUDIT=""
OPT_THEOREMS=""
OPT_BASELINE=""
OPT_SAVE_BASELINE=""
OPT_JSON=""
OPT_INTERVAL=""
MODE="once"
DIR_GIVEN=0
MAIN_GIVEN=0
AUDIT_GIVEN=0
THEOREMS_GIVEN=0
BASELINE_GIVEN=0
SAVE_BASELINE_GIVEN=0
JSON_GIVEN=0
INTERVAL=2

# ---------------------------------------------------------------------------
# Resolved paths
# ---------------------------------------------------------------------------
ABS_DIR=""
ABS_MAIN=""
ABS_AUDIT=""
ABS_THEOREMS=""
ABS_BASELINE=""
AUDIT_EFFECTIVE=0
AUDIT_AUTO=0

# Display paths
MAIN_DISPLAY=""
AUDIT_DISPLAY=""
THEOREMS_DISPLAY=""
BASELINE_DISPLAY=""
SAVE_BASELINE_DISPLAY=""
JSON_DISPLAY=""

# Toolchain
LAKE_BIN=""
LEAN_BIN=""
TOOLCHAIN_DESC=""
LAKE_VERSION_DESC=""

# Scratch space
TMP_PARENT=""
TMP_DIR=""
AWK_SCANNER=""
AWK_GUARD=""
AWK_AUDIT=""
LEANFILES_LIST=""
METRICS_FILE=""
BASE_NORM=""

# Check results (PASS/FAIL/SKIP strings and boolean-ish flags)
BUILD_STATUS="SKIP"
BUILD_OK=1
BUILD_RC=0
BUILD_LOG=""
DIRECT_STATUS="SKIP"
DIRECT_OK=1
DIRECT_RC=0
DIRECT_LOG=""
COVERAGE_STATUS="SKIP"
COVERAGE_OK=1
COVERAGE_FILES=0
COVERAGE_FAILED=0
GUARD_STATUS="SKIP"
GUARD_OK=1
GUARD_HITS=0
GUARD_INFO=0
GUARD_FILES=0
AXIOM_STATUS="SKIP"
AXIOM_OK=1
AXIOM_THEOREMS=0
AXIOM_FAILURES=0
AXIOM_MISSING=0
AXIOM_DUPLICATE=0
AXIOM_RUN_FAILED=0
AXIOM_NOTE=""
THEOREMS_EXPECTED=0

# Metrics
WHOLE_FILES=0
WHOLE_TOTAL_LINES=0
WHOLE_CODE_LINES=0
MAIN_TOTAL_LINES=0
MAIN_CODE_LINES=0
TOK_cases=0
TOK_by_cases=0
TOK_induction=0
TOK_have=0
TOK_show=0
TOK_suffices=0
TOK_rw=0
TOK_simp=0
TOK_simpa=0
TOK_omega=0
TOK_linarith=0
TOK_grind=0
TOK_list_span=0
TOK_takewhile=0
TOK_dropwhile=0
TOK_getlast=0
TOK_droplast=0
TOK_public_decls=0
TOK_private_decls=0

# Verdict / bookkeeping
RESULT="PASS"
EXIT_CODE=0
DURATION=0
GIT_INFO="not a git repository"
RUN_NUMBER=0
WATCH_STAMP=""
LOGICAL_PWD=""
PHYSICAL_PWD=""

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

usage_error() {
  printf 'verify-lean: error: %s\n' "$1" >&2
  printf "Try '%s --help' for usage.\n" "$SCRIPT_NAME" >&2
  exit 2
}

fatal_env() {
  printf 'verify-lean: error: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'verify-lean: warning: %s\n' "$1" >&2
}

# Path relative to the invocation cwd when possible. Both the logical and the
# physical cwd are tried so /tmp-vs-/private/tmp symlinks stay compact.
display_path() {
  case "$1" in
    "$LOGICAL_PWD"/*) printf '%s' "${1#"$LOGICAL_PWD"/}" ;;
    "$PHYSICAL_PWD"/*) printf '%s' "${1#"$PHYSICAL_PWD"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Absolute, symlink-normalised file path; returns 1 when the file is missing.
normalize_file_path() {
  [ -f "$1" ] || return 1
  ( cd "$(dirname -- "$1")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename -- "$1")" )
}

# Absolute path for an already-existing executable (falls back to the name).
absolute_bin_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    */*) ( cd "$(dirname -- "$1")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename -- "$1")" ) ;;
    *) printf '%s' "$1" ;;
  esac
}

# Resolve an input path relative to --dir first, then the invocation cwd.
# Used for --main, --audit and --theorems.
resolve_dir_relative_path() {
  case "$1" in
    /*)
      normalize_file_path "$1" && return 0
      return 1
      ;;
  esac
  if [ -f "$ABS_DIR/$1" ]; then
    normalize_file_path "$ABS_DIR/$1"
    return 0
  fi
  if [ -f "$1" ]; then
    normalize_file_path "$1"
    return 0
  fi
  return 1
}

# Resolve an input path relative to the invocation cwd first, then --dir.
# Used for --baseline (kept cwd-relative so baseline files can live anywhere).
resolve_cwd_relative_path() {
  case "$1" in
    /*)
      normalize_file_path "$1" && return 0
      return 1
      ;;
  esac
  if [ -f "$1" ]; then
    normalize_file_path "$1"
    return 0
  fi
  if [ -f "$ABS_DIR/$1" ]; then
    normalize_file_path "$ABS_DIR/$1"
    return 0
  fi
  return 1
}

cleanup() {
  [ -n "${TMP_DIR:-}" ] || return 0
  case "$TMP_DIR" in
    */verify-lean.*) rm -rf "$TMP_DIR" ;;
  esac
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
$SCRIPT_NAME $SCRIPT_VERSION - Lean formal-verification gate and Rule-4 dashboard

Runs, in order: a lake build gate, a direct compile of the main proof file, a
compile-coverage pass over every other .lean file, a comment-stripped
banned-construct guardrail scan, an axiom audit (with optional completeness
check), and a Rule-4 metrics dashboard. Exit 0 means every configured
mechanical gate passed.

Usage:
  bash $SCRIPT_NAME [options]

Options:
  --dir <lean-project-dir>   Lean project root (default: $DEFAULT_DIR)
  --main <proof-file>        Main proof file, used for Rule-4 metrics and the
                             direct-compile gate. Relative paths resolve against
                             <dir> first, then the cwd.
                             Default: largest code-bearing .lean file under <dir>.
  --audit <Audit.lean>       Axiom-audit file with '#print axioms' lines.
                             Relative paths resolve against <dir> first, then
                             the cwd. Default: <dir>/$DEFAULT_AUDIT_NAME when
                             that file exists.
  --theorems <file>          One fully-qualified headline theorem name per line.
                             Relative to <dir> first, then the cwd. The audit
                             FAILS if any listed theorem has no '#print axioms'
                             output line. Requires an audit file.
  --baseline <file>          Baseline metrics file (key=value) for comparison.
                             Relative paths resolve against the cwd first, then
                             <dir>.
  --save-baseline <file>     Write the current metrics as a baseline after the
                             run (cwd-relative, parent directory must exist).
  --json <file>              Write a flat machine-readable JSON result file
                             (cwd-relative, parent directory must exist).
  --once                     Single run (default).
  --watch                    Keep running; re-run when .lean files change.
                             Ctrl-C stops cleanly. Last of --once/--watch wins.
  --interval <sec>           Watch poll interval in whole seconds (default: 2).
  -h, --help                 Print this help and exit 0.

Checks:
  build gate       lake build must succeed in <dir>.
  direct compile   lake env lean <main> must exit 0 (main is not dead code).
  coverage         every other .lean file under <dir> (except .lake/ and
                   lakefile.lean) must compile directly: an unimported file
                   cannot hide. The audit file is compiled by the audit run.
  guardrails       comments and string contents are stripped, then the code is
                   scanned for: sorry, native_decide, axiom declarations
                   (including private/protected), bodyless opaque, unsafe,
                   extern / @[extern], @[implemented_by],
                   set_option warn.sorry false, and #eval outside $EXAMPLES_FILE_NAME.
                   There is no per-line exemption marker.
  axiom audit      #print axioms output is parsed; both "does not depend on any
                   axioms" and "depends on axioms: [...]" are handled. Allowlist:
                   propext, Classical.choice, Quot.sound. sorryAx,
                   _native.native_decide*, Lean.ofReduceBool, Lean.trustCompiler
                   and any other name FAIL.
  completeness     with --theorems, every listed theorem must have an output
                   line; without it, at least one result line is required.
  metrics          Rule-4 counts for <main> plus whole-project code lines,
                   printed as a Metric | Current | Baseline | Delta table.

Exit codes:
  0  pass (all configured mechanical checks)
  1  build / direct-compile / coverage / guardrail / axiom failure, missing
     toolchain, no .lean files, or an I/O failure writing --json/--baseline
  2  usage error

Examples:
  bash $SCRIPT_NAME --dir specs/lean --audit Audit.lean \
      --theorems headline-theorems.txt
  bash $SCRIPT_NAME --dir specs/lean --save-baseline metrics-baseline.txt
  bash $SCRIPT_NAME --dir specs/lean --watch --interval 1
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
need_value() { # $1 = option name, $2 = remaining argc
  if [ "$2" -lt 2 ]; then
    usage_error "option $1 requires a value"
  fi
}

set_option_value() { # $1 = option, $2 = value
  if [ -z "$2" ]; then
    usage_error "option $1 requires a non-empty value"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        need_value "$1" "$#"; OPT_DIR="$2"; DIR_GIVEN=1; set_option_value "--dir" "$OPT_DIR"; shift 2 ;;
      --dir=*)
        OPT_DIR=${1#--dir=}; DIR_GIVEN=1; set_option_value "--dir" "$OPT_DIR"; shift ;;
      --main)
        need_value "$1" "$#"; OPT_MAIN="$2"; MAIN_GIVEN=1; set_option_value "--main" "$OPT_MAIN"; shift 2 ;;
      --main=*)
        OPT_MAIN=${1#--main=}; MAIN_GIVEN=1; set_option_value "--main" "$OPT_MAIN"; shift ;;
      --audit)
        need_value "$1" "$#"; OPT_AUDIT="$2"; AUDIT_GIVEN=1; set_option_value "--audit" "$OPT_AUDIT"; shift 2 ;;
      --audit=*)
        OPT_AUDIT=${1#--audit=}; AUDIT_GIVEN=1; set_option_value "--audit" "$OPT_AUDIT"; shift ;;
      --theorems)
        need_value "$1" "$#"; OPT_THEOREMS="$2"; THEOREMS_GIVEN=1; set_option_value "--theorems" "$OPT_THEOREMS"; shift 2 ;;
      --theorems=*)
        OPT_THEOREMS=${1#--theorems=}; THEOREMS_GIVEN=1; set_option_value "--theorems" "$OPT_THEOREMS"; shift ;;
      --baseline)
        need_value "$1" "$#"; OPT_BASELINE="$2"; BASELINE_GIVEN=1; set_option_value "--baseline" "$OPT_BASELINE"; shift 2 ;;
      --baseline=*)
        OPT_BASELINE=${1#--baseline=}; BASELINE_GIVEN=1; set_option_value "--baseline" "$OPT_BASELINE"; shift ;;
      --save-baseline)
        need_value "$1" "$#"; OPT_SAVE_BASELINE="$2"; SAVE_BASELINE_GIVEN=1; set_option_value "--save-baseline" "$OPT_SAVE_BASELINE"; shift 2 ;;
      --save-baseline=*)
        OPT_SAVE_BASELINE=${1#--save-baseline=}; SAVE_BASELINE_GIVEN=1; set_option_value "--save-baseline" "$OPT_SAVE_BASELINE"; shift ;;
      --json)
        need_value "$1" "$#"; OPT_JSON="$2"; JSON_GIVEN=1; set_option_value "--json" "$OPT_JSON"; shift 2 ;;
      --json=*)
        OPT_JSON=${1#--json=}; JSON_GIVEN=1; set_option_value "--json" "$OPT_JSON"; shift ;;
      --interval)
        need_value "$1" "$#"; OPT_INTERVAL="$2"; set_option_value "--interval" "$OPT_INTERVAL"; shift 2 ;;
      --interval=*)
        OPT_INTERVAL=${1#--interval=}; set_option_value "--interval" "$OPT_INTERVAL"; shift ;;
      --once)
        MODE="once"; shift ;;
      --watch)
        MODE="watch"; shift ;;
      -h|--help)
        usage; exit 0 ;;
      --)
        shift
        if [ $# -gt 0 ]; then
          usage_error "unexpected argument after --: $1"
        fi
        break ;;
      -*)
        usage_error "unknown option: $1" ;;
      *)
        usage_error "unexpected argument: $1" ;;
    esac
  done

  [ -n "$OPT_DIR" ] || OPT_DIR="$DEFAULT_DIR"

  if [ -n "${OPT_INTERVAL:-}" ]; then
    case "$OPT_INTERVAL" in
      *[!0-9]*) usage_error "--interval must be a positive whole number of seconds: $OPT_INTERVAL" ;;
    esac
    if [ "$OPT_INTERVAL" -lt 1 ]; then
      usage_error "--interval must be >= 1: $OPT_INTERVAL"
    fi
    INTERVAL="$OPT_INTERVAL"
  fi
}

# ---------------------------------------------------------------------------
# Validation / resolution of inputs (usage errors exit 2)
# ---------------------------------------------------------------------------
validate_and_resolve_inputs() {
  if [ ! -d "$OPT_DIR" ]; then
    usage_error "Lean project directory not found: $OPT_DIR"
  fi
  ABS_DIR=$(cd "$OPT_DIR" 2>/dev/null && pwd -P)
  if [ -z "$ABS_DIR" ] || [ ! -d "$ABS_DIR" ]; then
    usage_error "cannot enter Lean project directory: $OPT_DIR"
  fi
  if [ ! -r "$ABS_DIR" ]; then
    usage_error "Lean project directory is not readable: $ABS_DIR"
  fi

  if [ "$MAIN_GIVEN" -eq 1 ]; then
    case "$OPT_MAIN" in
      *.lean) ;;
      *) usage_error "--main must point to a .lean file: $OPT_MAIN" ;;
    esac
    ABS_MAIN=$(resolve_dir_relative_path "$OPT_MAIN") || ABS_MAIN=""
    [ -n "$ABS_MAIN" ] || usage_error "--main file not found (tried <dir>/$OPT_MAIN and cwd/$OPT_MAIN)"
    [ -r "$ABS_MAIN" ] || usage_error "--main file is not readable: $OPT_MAIN"
  fi

  if [ "$AUDIT_GIVEN" -eq 1 ]; then
    case "$OPT_AUDIT" in
      *.lean) ;;
      *) usage_error "--audit must point to a .lean file: $OPT_AUDIT" ;;
    esac
    ABS_AUDIT=$(resolve_dir_relative_path "$OPT_AUDIT") || ABS_AUDIT=""
    [ -n "$ABS_AUDIT" ] || usage_error "--audit file not found (tried <dir>/$OPT_AUDIT and cwd/$OPT_AUDIT)"
    [ -r "$ABS_AUDIT" ] || usage_error "--audit file is not readable: $OPT_AUDIT"
    AUDIT_EFFECTIVE=1
  else
    if [ -f "$ABS_DIR/$DEFAULT_AUDIT_NAME" ]; then
      ABS_AUDIT=$(normalize_file_path "$ABS_DIR/$DEFAULT_AUDIT_NAME") || ABS_AUDIT=""
      if [ -n "$ABS_AUDIT" ]; then
        AUDIT_EFFECTIVE=1
        AUDIT_AUTO=1
      fi
    fi
  fi

  if [ "$THEOREMS_GIVEN" -eq 1 ]; then
    ABS_THEOREMS=$(resolve_dir_relative_path "$OPT_THEOREMS") || ABS_THEOREMS=""
    [ -n "$ABS_THEOREMS" ] || usage_error "--theorems file not found (tried <dir>/$OPT_THEOREMS and cwd/$OPT_THEOREMS)"
    [ -r "$ABS_THEOREMS" ] || usage_error "--theorems file is not readable: $OPT_THEOREMS"
    if [ "$AUDIT_EFFECTIVE" -eq 0 ]; then
      usage_error "--theorems requires an axiom audit; pass --audit or add $DEFAULT_AUDIT_NAME to $ABS_DIR"
    fi
    theorems_line_count=$(awk '/^[[:space:]]*#/ { next } /^[[:space:]]*$/ { next } { n++ } END { print n + 0 }' "$ABS_THEOREMS")
    if [ "${theorems_line_count:-0}" -lt 1 ]; then
      usage_error "--theorems file contains no theorem names: $OPT_THEOREMS"
    fi
  fi

  if [ "$BASELINE_GIVEN" -eq 1 ]; then
    ABS_BASELINE=$(resolve_cwd_relative_path "$OPT_BASELINE") || ABS_BASELINE=""
    [ -n "$ABS_BASELINE" ] || usage_error "--baseline file not found: $OPT_BASELINE"
    [ -r "$ABS_BASELINE" ] || usage_error "--baseline file is not readable: $OPT_BASELINE"
  fi

  if [ "$SAVE_BASELINE_GIVEN" -eq 1 ]; then
    if [ -d "$OPT_SAVE_BASELINE" ]; then
      usage_error "--save-baseline points to a directory: $OPT_SAVE_BASELINE"
    fi
    if [ ! -d "$(dirname -- "$OPT_SAVE_BASELINE")" ]; then
      usage_error "directory for --save-baseline does not exist: $OPT_SAVE_BASELINE"
    fi
  fi

  if [ "$JSON_GIVEN" -eq 1 ]; then
    if [ -d "$OPT_JSON" ]; then
      usage_error "--json points to a directory: $OPT_JSON"
    fi
    if [ ! -d "$(dirname -- "$OPT_JSON")" ]; then
      usage_error "directory for --json does not exist: $OPT_JSON"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Toolchain resolution: $LAKE/$LEAN -> PATH -> $HOME/.elan/bin
# ---------------------------------------------------------------------------
resolve_toolchain() {
  local candidate=""

  LAKE_BIN=""
  if [ -n "${LAKE:-}" ]; then
    if [ -x "$LAKE" ]; then
      candidate="$LAKE"
    elif has_cmd "$LAKE"; then
      candidate=$(command -v "$LAKE")
    fi
    if [ -z "$candidate" ]; then
      printf 'verify-lean: error: $LAKE is set to "%s" but no executable was found there.\n' "$LAKE" >&2
      printf 'Fix or unset LAKE (for example: LAKE="%s/.elan/bin/lake").\n' "${HOME:-}" >&2
      exit 1
    fi
    LAKE_BIN="$candidate"
  fi
  if [ -z "$LAKE_BIN" ] && has_cmd lake; then
    LAKE_BIN=$(command -v lake)
  fi
  if [ -z "$LAKE_BIN" ] && [ -x "${HOME:-/nonexistent}/.elan/bin/lake" ]; then
    LAKE_BIN="${HOME}/.elan/bin/lake"
  fi

  LEAN_BIN=""
  if [ -n "${LEAN:-}" ]; then
    if [ -x "$LEAN" ]; then
      LEAN_BIN="$LEAN"
    elif has_cmd "$LEAN"; then
      LEAN_BIN=$(command -v "$LEAN")
    else
      warn "\$LEAN is set to \"$LEAN\" but no executable was found there; asking lake for the version instead"
    fi
  fi
  if [ -z "$LEAN_BIN" ] && has_cmd lean; then
    LEAN_BIN=$(command -v lean)
  fi
  if [ -z "$LEAN_BIN" ] && [ -x "${HOME:-/nonexistent}/.elan/bin/lean" ]; then
    LEAN_BIN="${HOME}/.elan/bin/lean"
  fi

  if [ -z "$LAKE_BIN" ]; then
    cat >&2 <<EOF
verify-lean: error: Lean 4 toolchain not found (no 'lake' in PATH).
Install Lean 4 with elan:
    https://leanprover-community.github.io/get_started.html
Then add the default elan location to PATH for this shell:
    export PATH="\$HOME/.elan/bin:\$PATH"
Or point this script at existing binaries explicitly:
    LAKE=/path/to/lake LEAN=/path/to/lean bash $SCRIPT_NAME --dir $DEFAULT_DIR
EOF
    exit 1
  fi

  LAKE_BIN=$(absolute_bin_path "$LAKE_BIN")
  if [ -n "$LEAN_BIN" ]; then
    LEAN_BIN=$(absolute_bin_path "$LEAN_BIN")
  fi

  if [ -n "$LEAN_BIN" ]; then
    TOOLCHAIN_DESC=$("$LEAN_BIN" --version 2>/dev/null | head -n 1)
  fi
  if [ -z "${TOOLCHAIN_DESC:-}" ]; then
    LAKE_VERSION_DESC=$("$LAKE_BIN" --version 2>/dev/null | head -n 1)
    TOOLCHAIN_DESC="$LAKE_VERSION_DESC"
  fi
  if [ -z "${TOOLCHAIN_DESC:-}" ]; then
    TOOLCHAIN_DESC="unknown (Lean version query failed)"
  fi
}

# ---------------------------------------------------------------------------
# Scratch space + generated awk programs
# ---------------------------------------------------------------------------
create_scratch_space() {
  TMP_PARENT="${TMPDIR:-/tmp}"
  TMP_PARENT=${TMP_PARENT%/}
  [ -n "$TMP_PARENT" ] || TMP_PARENT="/tmp"
  TMP_DIR=$(mktemp -d "$TMP_PARENT/verify-lean.XXXXXX" 2>/dev/null)
  if [ -z "${TMP_DIR:-}" ] || [ ! -d "$TMP_DIR" ]; then
    fatal_env "cannot create a temporary directory under $TMP_PARENT"
  fi
  LEANFILES_LIST="$TMP_DIR/lean-files.txt"
  METRICS_FILE="$TMP_DIR/metrics.txt"
  BASE_NORM="$TMP_DIR/baseline.norm"
  BUILD_LOG="$TMP_DIR/build.log"
  DIRECT_LOG="$TMP_DIR/direct-compile.log"
  : > "$LEANFILES_LIST"
  : > "$METRICS_FILE"
  : > "$BASE_NORM"
}

write_scanner_awk() {
  AWK_SCANNER="$TMP_DIR/scanner.awk"
  cat > "$AWK_SCANNER" <<'AWK_EOF'
# verify-lean comment/string masker (generated by verify-lean.sh).
#
# Modes (-v mode=...):
#   guard-strip : output "<line-number>\t<masked-code>" for every source line.
#                 Masking removes `--` line comments, `/- ... -/` block
#                 comments (nesting tracked across lines) and string-literal
#                 contents. Documentation can mention banned words freely.
#   metrics     : Rule-4 counts for a single file:
#                 G <total-lines> <lean-code-lines>
#                 T <token-key> <count>
#
# A "Lean code line" is a line with at least one non-whitespace character left
# after masking.
BEGIN { OFMT = "%.0f"; BLOCK_DEPTH = 0 }

function has_suffix(s, suf) {
  return (length(s) >= length(suf)) && (substr(s, length(s) - length(suf) + 1) == suf)
}

function mask_line(src,    n, i, c, nxt, out, in_str) {
  n = length(src); out = ""; in_str = 0; i = 1
  while (i <= n) {
    c = substr(src, i, 1)
    if (BLOCK_DEPTH > 0) {
      nxt = (i < n) ? substr(src, i + 1, 1) : ""
      if (c == "/" && nxt == "-") { BLOCK_DEPTH++; i += 2; continue }
      if (c == "-" && nxt == "/") { BLOCK_DEPTH--; i += 2; continue }
      i++; continue
    }
    if (in_str) {
      if (c == "\\") { i += 2; continue }
      if (c == "\"") in_str = 0
      i++; continue
    }
    nxt = (i < n) ? substr(src, i + 1, 1) : ""
    if (c == "\"") { in_str = 1; i++; continue }
    if (c == "-" && nxt == "-") break
    if (c == "/" && nxt == "-") { BLOCK_DEPTH = 1; i += 2; continue }
    out = out c
    i++
  }
  return out
}

# Token counting for the Rule-4 metrics. Tokens are maximal runs of
# [A-Za-z0-9_.'?#]; everything else separates. Exact matches only, so `simpa`
# never counts as `simp`, `#show` is not `show`, and `simp_all` is not `simp`.
function count_tokens(code,    n, i, t, toks, priv, decl_seen) {
  n = split(code, toks, /[^A-Za-z0-9_.'?#]+/)
  priv = 0
  decl_seen = 0
  for (i = 1; i <= n; i++) {
    t = toks[i]
    if (t == "") continue
    if (t == "cases") T_cases++
    else if (t == "by_cases") T_by_cases++
    else if (t == "induction") T_induction++
    else if (t == "have") T_have++
    else if (t == "show") T_show++
    else if (t == "suffices") T_suffices++
    else if (t == "rw") T_rw++
    else if (t == "simp") T_simp++
    else if (t == "simpa") T_simpa++
    else if (t == "omega") T_omega++
    else if (t == "linarith") T_linarith++
    else if (t == "grind") T_grind++
    else if (t == "List.span" || has_suffix(t, ".List.span") || has_suffix(t, ".span")) T_list_span++
    else if (t == "takeWhile" || has_suffix(t, ".takeWhile")) T_takewhile++
    else if (t == "dropWhile" || has_suffix(t, ".dropWhile")) T_dropwhile++
    else if (t == "getLast?" || has_suffix(t, ".getLast?")) T_getlast++
    else if (t == "dropLast" || has_suffix(t, ".dropLast")) T_droplast++
    if (t == "private") priv = 1
    if (!decl_seen && (t == "theorem" || t == "lemma")) {
      decl_seen = 1
      if (priv) T_private_decls++
      else T_public_decls++
    }
  }
}

{
  total++
  code = mask_line($0)
  if (mode == "metrics") {
    if (code ~ /[^[:space:]]/) {
      code_lines++
      count_tokens(code)
    }
  } else {
    gsub(/\t/, " ", code)
    print NR "\t" code
  }
}

END {
  if (mode == "metrics") {
    print "G\t" total "\t" code_lines
    print "T\tcases\t" T_cases
    print "T\tby_cases\t" T_by_cases
    print "T\tinduction\t" T_induction
    print "T\thave\t" T_have
    print "T\tshow\t" T_show
    print "T\tsuffices\t" T_suffices
    print "T\trw\t" T_rw
    print "T\tsimp\t" T_simp
    print "T\tsimpa\t" T_simpa
    print "T\tomega\t" T_omega
    print "T\tlinarith\t" T_linarith
    print "T\tgrind\t" T_grind
    print "T\tlist_span\t" T_list_span
    print "T\ttakewhile\t" T_takewhile
    print "T\tdropwhile\t" T_dropwhile
    print "T\tgetlast\t" T_getlast
    print "T\tdroplast\t" T_droplast
    print "T\tpublic_decls\t" T_public_decls
    print "T\tprivate_decls\t" T_private_decls
  }
}
AWK_EOF

  AWK_GUARD="$TMP_DIR/guard.awk"
  cat > "$AWK_GUARD" <<'AWK_EOF'
# verify-lean guardrail matcher (generated by verify-lean.sh).
# Input: output of the scanner's guard-strip mode: "<line>\t<comment/string-free code>".
# Emits:
#   H <file> <line> <category> <token> <code-text>     (failure)
#   I <file> <line> <category> <token> <code-text>     (informational, allowed)
#   F <file> <total-lines> <lean-code-lines>
BEGIN { pending_line = 0; pending_name = ""; pending_text = ""; total = 0; code_lines = 0 }

function trim(s) {
  sub(/^[[:space:]]+/, "", s)
  sub(/[[:space:]]+$/, "", s)
  return s
}

function clean(text,    t) {
  t = text
  gsub(/\t/, " ", t)
  return trim(t)
}

function emit_hit(cat, token, ln, text) {
  print "H\t" f "\t" ln "\t" cat "\t" token "\t" clean(text)
}

function emit_info(cat, token, ln, text) {
  print "I\t" f "\t" ln "\t" cat "\t" token "\t" clean(text)
}

# Strip leading attributes and declaration modifiers.
function decl_prefix_strip(line,    tmp) {
  tmp = line
  sub(/^[[:space:]]+/, "", tmp)
  while (match(tmp, /^@\[[^]]*\][[:space:]]*/)) tmp = substr(tmp, RLENGTH + 1)
  while (match(tmp, /^(private|protected|noncomputable|unsafe|partial)[[:space:]]+/)) tmp = substr(tmp, RLENGTH + 1)
  return tmp
}

# Set DECL_NAME / DECL_REST and return "axiom" or "opaque" for a declaration
# line, or "" otherwise.
function decl_kind(line,    tmp, rest) {
  tmp = decl_prefix_strip(line)
  DECL_NAME = ""
  DECL_REST = ""
  if (tmp ~ /^axiom[[:space:]]+/) {
    rest = substr(tmp, 6)
  } else if (tmp ~ /^opaque[[:space:]]+/) {
    rest = substr(tmp, 7)
  } else {
    return ""
  }
  sub(/^[[:space:]]+/, "", rest)
  match(rest, /^[^[:space:]:(\[{]+/)
  DECL_NAME = substr(rest, RSTART, RLENGTH)
  DECL_REST = rest
  return substr(tmp, 1, 5) == "axiom" ? "axiom" : "opaque"
}

{
  ln = $1 + 0
  text = substr($0, index($0, "\t") + 1)
  total++
  if (text ~ /[^[:space:]]/) code_lines++

  # A bodyless opaque may have its body start on the next line with "=:".
  if (pending_line > 0) {
    nxt = text
    sub(/^[[:space:]]+/, "", nxt)
    if (nxt ~ /^:=/) {
      emit_info("opaque_with_body", pending_name, pending_line, pending_text)
    } else {
      emit_hit("opaque_bodyless", pending_name, pending_line, pending_text)
    }
    pending_line = 0
  }

  if (text !~ /[^[:space:]]/) next

  if (text ~ /(^|[^A-Za-z0-9_'])sorry([^A-Za-z0-9_']|$)/) emit_hit("sorry", "sorry", ln, text)
  if (text ~ /(^|[^A-Za-z0-9_'])native_decide([^A-Za-z0-9_']|$)/) emit_hit("native_decide", "native_decide", ln, text)
  if (text ~ /(^|[^A-Za-z0-9_'])unsafe([^A-Za-z0-9_']|$)/) emit_hit("unsafe", "unsafe", ln, text)
  if (text ~ /(^|[^A-Za-z0-9_'])extern([^A-Za-z0-9_']|$)/) emit_hit("extern", "extern", ln, text)
  if (text ~ /(^|[^A-Za-z0-9_'])implemented_by([^A-Za-z0-9_']|$)/) emit_hit("implemented_by", "implemented_by", ln, text)
  if (text ~ /set_option[[:space:]]+warn\.sorry[[:space:]]+false/) emit_hit("warn_sorry_off", "set_option warn.sorry false", ln, text)
  if (base != "Examples.lean") {
    if (text ~ /(^|[^A-Za-z0-9_'.])#eval([^A-Za-z0-9_']|$)/) emit_hit("eval", "#eval", ln, text)
  }

  kind = decl_kind(text)
  if (kind == "axiom") {
    emit_hit("axiom_decl", DECL_NAME, ln, text)
  } else if (kind == "opaque") {
    if (DECL_REST ~ /:=/) {
      emit_info("opaque_with_body", DECL_NAME, ln, text)
    } else {
      pending_line = ln
      pending_name = DECL_NAME
      pending_text = text
    }
  }
}

END {
  if (pending_line > 0) emit_hit("opaque_bodyless", pending_name, pending_line, pending_text)
  print "F\t" f "\t" total "\t" code_lines
}
AWK_EOF

  AWK_AUDIT="$TMP_DIR/audit.awk"
  cat > "$AWK_AUDIT" <<'AWK_EOF'
# Parse Lean '#print axioms' output (generated by verify-lean.sh).
# Emits: A<TAB>theorem<TAB>comma-separated axiom names
# Handles both Lean 4.35 output forms and multi-line wrapping of long lists:
#   'thm' does not depend on any axioms
#   'thm' depends on axioms: [propext, Classical.choice, Quot.sound]
function emit(line,    q1, rest, q2, name, b, list, e, n, i, ax, csv) {
  q1 = index(line, "'")
  rest = substr(line, q1 + 1)
  q2 = index(rest, "'")
  name = substr(rest, 1, q2 - 1)
  b = index(line, "[")
  csv = ""
  if (b > 0) {
    list = substr(line, b + 1)
    e = index(list, "]")
    if (e > 0) list = substr(list, 1, e - 1)
    n = split(list, parts, ",")
    for (i = 1; i <= n; i++) {
      ax = parts[i]
      sub(/^[[:space:]]+/, "", ax)
      sub(/[[:space:]]+$/, "", ax)
      if (ax == "") continue
      if (csv != "") csv = csv ", "
      csv = csv ax
    }
  }
  print "A\t" name "\t" csv
}
BEGIN { in_list = 0; joined = "" }
{
  line = $0
  sub(/^[[:space:]]+/, "", line)
  sub(/^info:[[:space:]]+/, "", line)
  if (in_list) {
    joined = joined " " line
    if (line ~ /\]/) { in_list = 0; emit(joined) }
    next
  }
  if (line ~ /^'[^']*' depends on axioms: \[/) {
    if (line ~ /\]/) emit(line)
    else { in_list = 1; joined = line }
    next
  }
  if (line ~ /^'[^']*' does not depend on any axioms/) { emit(line); next }
}
AWK_EOF

  if ! awk -f "$AWK_SCANNER" /dev/null >/dev/null 2>"$TMP_DIR/awk-check.err"; then
    fatal_env "internal error: generated scanner awk does not parse: $(cat "$TMP_DIR/awk-check.err")"
  fi
  if ! awk -f "$AWK_GUARD" /dev/null >/dev/null 2>"$TMP_DIR/awk-check.err"; then
    fatal_env "internal error: generated guardrail awk does not parse: $(cat "$TMP_DIR/awk-check.err")"
  fi
  if ! awk -f "$AWK_AUDIT" /dev/null >/dev/null 2>"$TMP_DIR/awk-check.err"; then
    fatal_env "internal error: generated audit awk does not parse: $(cat "$TMP_DIR/awk-check.err")"
  fi
}

# ---------------------------------------------------------------------------
# Lean project file discovery, main detection, theorem list
# ---------------------------------------------------------------------------
list_lean_files() {
  : > "$LEANFILES_LIST"
  find "$ABS_DIR" \( -name .lake -o -name .git \) -prune -o -type f -name '*.lean' -print 2>/dev/null \
    | LC_ALL=C sort > "$LEANFILES_LIST"
  if [ ! -s "$LEANFILES_LIST" ]; then
    fatal_env "no .lean files found under $ABS_DIR"
  fi
}

detect_main_file() {
  : > "$TMP_DIR/candidates.txt"
  while IFS= read -r candidate_file; do
    [ -n "$candidate_file" ] || continue
    if [ -n "$ABS_AUDIT" ] && [ "$candidate_file" = "$ABS_AUDIT" ]; then
      continue
    fi
    file_size=$(wc -c < "$candidate_file" 2>/dev/null | tr -d '[:space:]')
    [ -n "$file_size" ] || file_size=0
    printf '%s\t%s\n' "$file_size" "$candidate_file" >> "$TMP_DIR/candidates.txt"
  done < "$LEANFILES_LIST"
  if [ ! -s "$TMP_DIR/candidates.txt" ]; then
    return 1
  fi
  LC_ALL=C sort -rn "$TMP_DIR/candidates.txt" > "$TMP_DIR/candidates.sorted"
  while IFS=$'\t' read -r candidate_size candidate_file2; do
    [ -n "$candidate_file2" ] || continue
    code_lines=$(awk -v mode=metrics -f "$AWK_SCANNER" "$candidate_file2" 2>/dev/null | awk -F'\t' '$1 == "G" { print $3 }')
    if [ -n "$code_lines" ] && [ "$code_lines" -gt 0 ] 2>/dev/null; then
      ABS_MAIN="$candidate_file2"
      return 0
    fi
  done < "$TMP_DIR/candidates.sorted"
  return 1
}

resolve_main_file() {
  if [ "$MAIN_GIVEN" -eq 1 ]; then
    MAIN_DISPLAY=$(display_path "$ABS_MAIN")
    return 0
  fi
  if ! detect_main_file; then
    fatal_env "could not auto-detect a code-bearing .lean file under $ABS_DIR; pass --main <file>"
  fi
  MAIN_DISPLAY=$(display_path "$ABS_MAIN")
}

load_theorems_expected() {
  THEOREMS_EXPECTED=0
  if [ "$THEOREMS_GIVEN" -eq 0 ]; then
    return 0
  fi
  : > "$TMP_DIR/theorems-expected.txt"
  while IFS= read -r theorem_line || [ -n "$theorem_line" ]; do
    theorem_line=$(printf '%s' "$theorem_line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/\r$//')
    case "$theorem_line" in
      ''|'#'*) continue ;;
    esac
    printf '%s\n' "$theorem_line" >> "$TMP_DIR/theorems-expected.txt"
    THEOREMS_EXPECTED=$((THEOREMS_EXPECTED + 1))
  done < "$ABS_THEOREMS"
  if [ "$THEOREMS_EXPECTED" -lt 1 ]; then
    usage_error "--theorems file contains no theorem names: $OPT_THEOREMS"
  fi
}

# ---------------------------------------------------------------------------
# Build gate: lake build
# ---------------------------------------------------------------------------
run_build() {
  BUILD_LOG="$TMP_DIR/build.log"
  ( cd "$ABS_DIR" && "$LAKE_BIN" build ) > "$BUILD_LOG" 2>&1
  BUILD_RC=$?
  if [ "$BUILD_RC" -eq 0 ]; then
    BUILD_STATUS="PASS"
    BUILD_OK=1
  else
    BUILD_STATUS="FAIL"
    BUILD_OK=0
  fi
}

# ---------------------------------------------------------------------------
# Direct compile of the main proof file (must not be dead code)
# ---------------------------------------------------------------------------
run_direct_compile() {
  DIRECT_LOG="$TMP_DIR/direct-compile.log"
  ( cd "$ABS_DIR" && "$LAKE_BIN" env lean "$ABS_MAIN" ) > "$DIRECT_LOG" 2>&1
  DIRECT_RC=$?
  if [ "$DIRECT_RC" -eq 0 ]; then
    DIRECT_STATUS="PASS"
    DIRECT_OK=1
  else
    DIRECT_STATUS="FAIL"
    DIRECT_OK=0
  fi
}

# ---------------------------------------------------------------------------
# Compile coverage: every other .lean file compiles directly, so an unimported
# file (not covered by lake globs) cannot hide broken code.
# ---------------------------------------------------------------------------
run_coverage() {
  : > "$TMP_DIR/coverage-failures.txt"
  COVERAGE_FILES=0
  COVERAGE_FAILED=0
  if [ "$BUILD_OK" -ne 1 ]; then
    COVERAGE_STATUS="SKIP"
    COVERAGE_OK=1
    return 0
  fi
  while IFS= read -r lean_file; do
    [ -n "$lean_file" ] || continue
    [ "$lean_file" = "$ABS_MAIN" ] && continue
    if [ "$AUDIT_EFFECTIVE" -eq 1 ] && [ -n "$ABS_AUDIT" ] && [ "$lean_file" = "$ABS_AUDIT" ]; then
      continue
    fi
    file_base=${lean_file##*/}
    [ "$file_base" = "$LAKEFILE_FILE_NAME" ] && continue
    COVERAGE_FILES=$((COVERAGE_FILES + 1))
    case "$lean_file" in
      "$ABS_DIR"/*) rel_file=${lean_file#"$ABS_DIR"/} ;;
      *) rel_file="$lean_file" ;;
    esac
    ( cd "$ABS_DIR" && "$LAKE_BIN" env lean "$lean_file" ) > "$TMP_DIR/coverage-one.log" 2>&1
    if [ $? -ne 0 ]; then
      COVERAGE_FAILED=$((COVERAGE_FAILED + 1))
      printf '    %s\n' "$rel_file" >> "$TMP_DIR/coverage-failures.txt"
      tail -n 10 "$TMP_DIR/coverage-one.log" | sed -e 's/^/      | /' >> "$TMP_DIR/coverage-failures.txt"
    fi
  done < "$LEANFILES_LIST"
  if [ "$COVERAGE_FAILED" -eq 0 ]; then
    COVERAGE_STATUS="PASS"
    COVERAGE_OK=1
  else
    COVERAGE_STATUS="FAIL"
    COVERAGE_OK=0
  fi
}

# ---------------------------------------------------------------------------
# Guardrail scan: comments/strings stripped, then code scanned
# ---------------------------------------------------------------------------
scan_guardrails() {
  : > "$TMP_DIR/guard-hits.txt"
  : > "$TMP_DIR/guard-infos.txt"
  GUARD_HITS=0
  GUARD_INFO=0
  GUARD_FILES=0
  WHOLE_FILES=0
  WHOLE_TOTAL_LINES=0
  WHOLE_CODE_LINES=0

  while IFS= read -r lean_file; do
    [ -n "$lean_file" ] || continue
    GUARD_FILES=$((GUARD_FILES + 1))
    case "$lean_file" in
      "$ABS_DIR"/*) rel_file=${lean_file#"$ABS_DIR"/} ;;
      *) rel_file="$lean_file" ;;
    esac
    file_base=${rel_file##*/}
    if ! awk -v mode=guard-strip -f "$AWK_SCANNER" "$lean_file" > "$TMP_DIR/stripped.txt" 2>"$TMP_DIR/awk-strip.err"; then
      fatal_env "comment-stripping filter failed on $lean_file: $(cat "$TMP_DIR/awk-strip.err")"
    fi
    if ! awk -v f="$rel_file" -v base="$file_base" -f "$AWK_GUARD" "$TMP_DIR/stripped.txt" > "$TMP_DIR/guard.out" 2>"$TMP_DIR/awk-guard.err"; then
      fatal_env "guardrail scanner failed on $lean_file: $(cat "$TMP_DIR/awk-guard.err")"
    fi
    while IFS=$'\t' read -r rec_kind rec_a rec_b rec_c rec_d rec_e; do
      case "$rec_kind" in
        H)
          GUARD_HITS=$((GUARD_HITS + 1))
          printf '%s:%s: [%s] %s | %s\n' "$rec_a" "$rec_b" "$rec_c" "$rec_d" "$rec_e" >> "$TMP_DIR/guard-hits.txt"
          ;;
        I)
          GUARD_INFO=$((GUARD_INFO + 1))
          printf '%s:%s: [%s] %s | %s\n' "$rec_a" "$rec_b" "$rec_c" "$rec_d" "$rec_e" >> "$TMP_DIR/guard-infos.txt"
          ;;
        F)
          WHOLE_FILES=$((WHOLE_FILES + 1))
          WHOLE_TOTAL_LINES=$((WHOLE_TOTAL_LINES + rec_b))
          WHOLE_CODE_LINES=$((WHOLE_CODE_LINES + rec_c))
          ;;
      esac
    done < "$TMP_DIR/guard.out"
  done < "$LEANFILES_LIST"

  if [ "$GUARD_HITS" -eq 0 ]; then
    GUARD_STATUS="PASS"
    GUARD_OK=1
  else
    GUARD_STATUS="FAIL"
    GUARD_OK=0
  fi
}

# ---------------------------------------------------------------------------
# Axiom audit
# ---------------------------------------------------------------------------
run_axiom_audit() {
  : > "$TMP_DIR/axiom-report.txt"
  : > "$TMP_DIR/axiom-failures.txt"
  : > "$TMP_DIR/axiom-names.txt"
  AXIOM_THEOREMS=0
  AXIOM_FAILURES=0
  AXIOM_MISSING=0
  AXIOM_DUPLICATE=0
  AXIOM_STATUS="SKIP"
  AXIOM_OK=1
  AXIOM_RUN_FAILED=0
  AXIOM_NOTE=""

  if [ "$AUDIT_EFFECTIVE" -eq 0 ]; then
    AXIOM_NOTE="no --audit file given (and no $DEFAULT_AUDIT_NAME in --dir)"
    return 0
  fi
  if [ "$BUILD_OK" -ne 1 ]; then
    AXIOM_NOTE="build gate failed; axiom audit skipped"
    return 0
  fi

  ( cd "$ABS_DIR" && "$LAKE_BIN" env lean "$ABS_AUDIT" ) > "$TMP_DIR/audit.log" 2>&1
  audit_rc=$?
  if [ "$audit_rc" -ne 0 ]; then
    AXIOM_STATUS="FAIL"
    AXIOM_OK=0
    AXIOM_RUN_FAILED=1
    AXIOM_NOTE="audit file failed to run (lean exited $audit_rc)"
    return 0
  fi

  awk -f "$AWK_AUDIT" "$TMP_DIR/audit.log" > "$TMP_DIR/axiom.parsed" 2>"$TMP_DIR/awk-check.err"
  if [ ! -s "$TMP_DIR/axiom.parsed" ]; then
    AXIOM_STATUS="FAIL"
    AXIOM_OK=0
    AXIOM_RUN_FAILED=1
    AXIOM_NOTE="no '#print axioms' output produced (did the audit file run and print axioms?)"
    return 0
  fi

  while IFS=$'\t' read -r rec_kind theorem_name axiom_csv; do
    [ "$rec_kind" = "A" ] || continue
    AXIOM_THEOREMS=$((AXIOM_THEOREMS + 1))
    printf '%s\n' "$theorem_name" >> "$TMP_DIR/axiom-names.txt"
    failure_reason=""
    axiom_list=$(printf '%s' "$axiom_csv" | tr ',' '\n')
    while IFS= read -r axiom_name; do
      axiom_name=$(printf '%s' "$axiom_name" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
      [ -n "$axiom_name" ] || continue
      case "$axiom_name" in
        propext|Classical.choice|Quot.sound) ;;
        sorryAx)
          failure_reason="${failure_reason}forbidden axiom 'sorryAx' (proof contains sorry); " ;;
        Lean.ofReduceBool)
          failure_reason="${failure_reason}forbidden axiom 'Lean.ofReduceBool' (compiler-trust shortcut); " ;;
        Lean.trustCompiler)
          failure_reason="${failure_reason}forbidden axiom 'Lean.trustCompiler' (compiler-trust shortcut); " ;;
        *native_decide*)
          failure_reason="${failure_reason}forbidden compiler-trust axiom '$axiom_name' (_native.native_decide); " ;;
        *)
          failure_reason="${failure_reason}axiom '$axiom_name' is outside the allowlist {propext, Classical.choice, Quot.sound}; " ;;
      esac
    done <<< "$axiom_list"
    failure_reason=$(printf '%s' "$failure_reason" | sed -e 's/; $//')

    axiom_display=$(printf '%s' "$axiom_csv" | sed -e 's/[[:space:]]*,[[:space:]]*/, /g')
    if [ -n "$failure_reason" ]; then
      AXIOM_FAILURES=$((AXIOM_FAILURES + 1))
      printf "'%s' [%s] FAIL\n" "$theorem_name" "$axiom_display" >> "$TMP_DIR/axiom-report.txt"
      printf "'%s': %s\n" "$theorem_name" "$failure_reason" >> "$TMP_DIR/axiom-failures.txt"
    else
      [ -n "$axiom_display" ] || axiom_display="no axioms"
      printf "'%s' [%s] OK\n" "$theorem_name" "$axiom_display" >> "$TMP_DIR/axiom-report.txt"
    fi
  done < "$TMP_DIR/axiom.parsed"

  # Audit completeness: every theorem listed via --theorems must be reported
  # exactly once. Without --theorems at least one result line is required.
  if [ "$THEOREMS_GIVEN" -eq 1 ]; then
    while IFS= read -r expected_name; do
      [ -n "$expected_name" ] || continue
      occurrences=$(awk -v n="$expected_name" '$0 == n { c++ } END { print c + 0 }' "$TMP_DIR/axiom-names.txt")
      if [ "${occurrences:-0}" -eq 0 ]; then
        AXIOM_MISSING=$((AXIOM_MISSING + 1))
        printf "missing theorem '%s': no '#print axioms' output line in the audit run\n" "$expected_name" >> "$TMP_DIR/axiom-failures.txt"
      elif [ "$occurrences" -gt 1 ]; then
        AXIOM_DUPLICATE=$((AXIOM_DUPLICATE + 1))
        printf "duplicate output for theorem '%s': %s lines in the audit run\n" "$expected_name" "$occurrences" >> "$TMP_DIR/axiom-failures.txt"
      fi
    done < "$TMP_DIR/theorems-expected.txt"
  fi

  if [ "$AXIOM_THEOREMS" -eq 0 ]; then
    AXIOM_STATUS="FAIL"
    AXIOM_OK=0
    AXIOM_RUN_FAILED=1
    if [ "$THEOREMS_GIVEN" -eq 1 ]; then
      AXIOM_MISSING=$THEOREMS_EXPECTED
      while IFS= read -r expected_name; do
        [ -n "$expected_name" ] || continue
        printf "missing theorem '%s': no '#print axioms' output line in the audit run\n" "$expected_name" >> "$TMP_DIR/axiom-failures.txt"
      done < "$TMP_DIR/theorems-expected.txt"
    fi
    AXIOM_NOTE="no '#print axioms' theorem lines parsed from audit output"
    return 0
  fi

  if [ "$AXIOM_FAILURES" -gt 0 ] || [ "$AXIOM_MISSING" -gt 0 ] || [ "$AXIOM_DUPLICATE" -gt 0 ]; then
    AXIOM_STATUS="FAIL"
    AXIOM_OK=0
    AXIOM_NOTE="$AXIOM_FAILURES axiom violation(s)"
    if [ "$AXIOM_MISSING" -gt 0 ] || [ "$AXIOM_DUPLICATE" -gt 0 ]; then
      AXIOM_NOTE="$AXIOM_NOTE, $AXIOM_MISSING missing/$AXIOM_DUPLICATE duplicate theorem(s)"
    fi
    AXIOM_NOTE="$AXIOM_NOTE; $AXIOM_THEOREMS result line(s) parsed"
  else
    AXIOM_STATUS="PASS"
    AXIOM_OK=1
    AXIOM_NOTE="$AXIOM_THEOREMS theorem(s) checked"
    if [ "$THEOREMS_GIVEN" -eq 1 ]; then
      AXIOM_NOTE="$AXIOM_NOTE; $THEOREMS_EXPECTED/$THEOREMS_EXPECTED expected theorem(s) reported"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Rule-4 metrics
# ---------------------------------------------------------------------------
compute_main_metrics() {
  if ! awk -v mode=metrics -f "$AWK_SCANNER" "$ABS_MAIN" > "$TMP_DIR/main-metrics.out" 2>"$TMP_DIR/metrics.err"; then
    fatal_env "metric scanner failed on $ABS_MAIN: $(cat "$TMP_DIR/metrics.err")"
  fi
  MAIN_TOTAL_LINES=0
  MAIN_CODE_LINES=0
  while IFS=$'\t' read -r rec_kind rec_a rec_b; do
    case "$rec_kind" in
      G)
        MAIN_TOTAL_LINES=$rec_a
        MAIN_CODE_LINES=$rec_b
        ;;
      T)
        case "$rec_a" in
          cases|by_cases|induction|have|show|suffices|rw|simp|simpa|omega|linarith|grind|list_span|takewhile|dropwhile|getlast|droplast|public_decls|private_decls)
            printf -v "TOK_$rec_a" '%s' "$rec_b"
            ;;
        esac
        ;;
    esac
  done < "$TMP_DIR/main-metrics.out"
}

write_metrics_file() {
  {
    printf 'whole_project.lean_files=%d\n' "$WHOLE_FILES"
    printf 'whole_project.total_lines=%d\n' "$WHOLE_TOTAL_LINES"
    printf 'whole_project.lean_code_lines=%d\n' "$WHOLE_CODE_LINES"
    printf 'main.total_lines=%d\n' "$MAIN_TOTAL_LINES"
    printf 'main.lean_code_lines=%d\n' "$MAIN_CODE_LINES"
    printf 'main.proof_api.public=%d\n' "$TOK_public_decls"
    printf 'main.proof_api.private=%d\n' "$TOK_private_decls"
    printf 'main.proof_branching.cases=%d\n' "$TOK_cases"
    printf 'main.proof_branching.by_cases=%d\n' "$TOK_by_cases"
    printf 'main.proof_branching.induction=%d\n' "$TOK_induction"
    printf 'main.proof_branching.total=%d\n' "$((TOK_cases + TOK_by_cases + TOK_induction))"
    printf 'main.proof_plumbing.have=%d\n' "$TOK_have"
    printf 'main.proof_plumbing.show=%d\n' "$TOK_show"
    printf 'main.proof_plumbing.suffices=%d\n' "$TOK_suffices"
    printf 'main.proof_plumbing.rw=%d\n' "$TOK_rw"
    printf 'main.proof_plumbing.total=%d\n' "$((TOK_have + TOK_show + TOK_suffices + TOK_rw))"
    printf 'main.automation.simp=%d\n' "$TOK_simp"
    printf 'main.automation.simpa=%d\n' "$TOK_simpa"
    printf 'main.automation.omega=%d\n' "$TOK_omega"
    printf 'main.automation.linarith=%d\n' "$TOK_linarith"
    printf 'main.automation.grind=%d\n' "$TOK_grind"
    printf 'main.automation.total=%d\n' "$((TOK_simp + TOK_simpa + TOK_omega + TOK_linarith + TOK_grind))"
    printf 'main.representation.List_span=%d\n' "$TOK_list_span"
    printf 'main.representation.takeWhile=%d\n' "$TOK_takewhile"
    printf 'main.representation.dropWhile=%d\n' "$TOK_dropwhile"
    printf 'main.representation.getLast?=%d\n' "$TOK_getlast"
    printf 'main.representation.dropLast=%d\n' "$TOK_droplast"
    printf 'main.representation.total=%d\n' "$((TOK_list_span + TOK_takewhile + TOK_dropwhile + TOK_getlast + TOK_droplast))"
  } > "$METRICS_FILE"
}

# ---------------------------------------------------------------------------
# Baseline load / save
# ---------------------------------------------------------------------------
load_baseline() {
  : > "$BASE_NORM"
  if [ "$BASELINE_GIVEN" -eq 0 ]; then
    return 0
  fi
  if [ ! -f "$ABS_BASELINE" ]; then
    warn "baseline file disappeared: $OPT_BASELINE (continuing without a baseline)"
    return 0
  fi
  awk -F= '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      key = $1; val = $2
      sub(/^[[:space:]]+/, "", key); sub(/[[:space:]]+$/, "", key)
      sub(/^[[:space:]]+/, "", val); sub(/[[:space:]]+$/, "", val)
      if (key != "" && val ~ /^-?[0-9]+$/)
        print key "=" val
      else
        print "verify-lean: warning: ignoring malformed baseline line: " $0 > "/dev/stderr"
    }
  ' "$ABS_BASELINE" > "$BASE_NORM"
  if [ ! -s "$BASE_NORM" ]; then
    warn "baseline file has no usable key=value lines: $OPT_BASELINE"
  fi
}

baseline_lookup() {
  awk -F= -v k="$1" '$1 == k { print $2; exit }' "$BASE_NORM"
}

save_baseline_file() {
  if [ "$SAVE_BASELINE_GIVEN" -eq 0 ]; then
    return 0
  fi
  baseline_tmp="$TMP_DIR/baseline-new.tmp"
  {
    printf '# verify-lean.sh metric baseline (key=value; integer counts)\n'
    printf '# generated: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf '# project: %s\n' "$ABS_DIR"
    printf '# main: %s\n' "$MAIN_DISPLAY"
    cat "$METRICS_FILE"
  } > "$baseline_tmp" 2>/dev/null
  if [ ! -s "$baseline_tmp" ] || ! mv "$baseline_tmp" "$OPT_SAVE_BASELINE" 2>/dev/null; then
    fatal_env "cannot write baseline file: $OPT_SAVE_BASELINE"
  fi
}

# ---------------------------------------------------------------------------
# JSON output (flat object; printf/sed only, no external JSON tool)
# ---------------------------------------------------------------------------
json_escape() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' -e 's/\r/ /g' | tr -d '\n'
}

json_pair() {
  if [ -s "$JSON_TMP" ]; then
    printf ',\n' >> "$JSON_TMP"
  fi
  printf '%s' "$1" >> "$JSON_TMP"
}

json_string() {
  json_pair "  \"$1\": \"$(json_escape "$2")\""
}

json_number() {
  json_pair "  \"$1\": $2"
}

json_bool() {
  if [ "$2" -eq 1 ]; then
    json_pair "  \"$1\": true"
  else
    json_pair "  \"$1\": false"
  fi
}

lower_status() {
  case "$1" in
    PASS) printf 'pass' ;;
    FAIL) printf 'fail' ;;
    SKIP) printf 'skip' ;;
    *) printf '%s' "$1" ;;
  esac
}

write_json_file() {
  if [ "$JSON_GIVEN" -eq 0 ]; then
    return 0
  fi
  JSON_TMP="$TMP_DIR/json.tmp"
  : > "$JSON_TMP"

  if [ "$RESULT" = "PASS" ]; then result_lower="pass"; else result_lower="fail"; fi

  json_string "status" "$result_lower"
  json_number "exit_code" "$EXIT_CODE"
  json_string "timestamp" "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  json_number "duration_seconds" "$DURATION"
  json_string "mode" "$MODE"
  json_string "toolchain" "$TOOLCHAIN_DESC"
  json_string "lake_bin" "$LAKE_BIN"
  json_string "lean_bin" "$LEAN_BIN"
  json_string "lake_dir" "$ABS_DIR"
  json_string "main" "$MAIN_DISPLAY"
  json_string "audit" "${AUDIT_DISPLAY:-}"
  json_string "theorems_file" "${THEOREMS_DISPLAY:-}"
  json_string "git_commit" "$GIT_INFO"
  json_string "build_status" "$(lower_status "$BUILD_STATUS")"
  json_bool "build_ok" "$BUILD_OK"
  json_number "build_exit_code" "$BUILD_RC"
  json_string "direct_compile_status" "$(lower_status "$DIRECT_STATUS")"
  json_bool "direct_compile_ok" "$DIRECT_OK"
  json_number "direct_compile_exit_code" "$DIRECT_RC"
  json_string "coverage_status" "$(lower_status "$COVERAGE_STATUS")"
  json_bool "coverage_ok" "$COVERAGE_OK"
  json_number "coverage_files_checked" "$COVERAGE_FILES"
  json_number "coverage_files_failed" "$COVERAGE_FAILED"
  json_string "guardrails_status" "$(lower_status "$GUARD_STATUS")"
  json_bool "guardrails_ok" "$GUARD_OK"
  json_number "guardrail_hits" "$GUARD_HITS"
  json_number "guardrail_files_scanned" "$GUARD_FILES"
  json_number "guardrail_info" "$GUARD_INFO"
  json_string "axioms_status" "$(lower_status "$AXIOM_STATUS")"
  json_bool "axioms_ok" "$AXIOM_OK"
  json_number "axiom_theorems" "$AXIOM_THEOREMS"
  json_number "axiom_failures" "$AXIOM_FAILURES"
  json_number "theorems_expected" "$THEOREMS_EXPECTED"
  json_number "theorems_missing" "$AXIOM_MISSING"
  json_number "theorems_duplicate" "$AXIOM_DUPLICATE"
  json_string "axioms_note" "$AXIOM_NOTE"

  detail_idx=0
  if [ -s "$TMP_DIR/guard-hits.txt" ]; then
    while IFS= read -r detail_line; do
      json_string "guardrail_hit.$detail_idx" "$detail_line"
      detail_idx=$((detail_idx + 1))
    done < "$TMP_DIR/guard-hits.txt"
  fi
  detail_idx=0
  if [ -s "$TMP_DIR/guard-infos.txt" ]; then
    while IFS= read -r detail_line; do
      json_string "guardrail_info.$detail_idx" "$detail_line"
      detail_idx=$((detail_idx + 1))
    done < "$TMP_DIR/guard-infos.txt"
  fi
  detail_idx=0
  if [ -s "$TMP_DIR/axiom-report.txt" ]; then
    while IFS= read -r detail_line; do
      json_string "axiom_theorem.$detail_idx" "$detail_line"
      detail_idx=$((detail_idx + 1))
    done < "$TMP_DIR/axiom-report.txt"
  fi
  detail_idx=0
  if [ -s "$TMP_DIR/axiom-failures.txt" ]; then
    while IFS= read -r detail_line; do
      json_string "axiom_failure.$detail_idx" "$detail_line"
      detail_idx=$((detail_idx + 1))
    done < "$TMP_DIR/axiom-failures.txt"
  fi
  detail_idx=0
  if [ -s "$TMP_DIR/coverage-failures.txt" ]; then
    while IFS= read -r detail_line; do
      json_string "coverage_failure.$detail_idx" "$(printf '%s' "$detail_line" | sed -e 's/^[[:space:]]*//')"
      detail_idx=$((detail_idx + 1))
    done < "$TMP_DIR/coverage-failures.txt"
  fi

  while IFS='=' read -r metric_key metric_value; do
    [ -n "$metric_key" ] || continue
    json_number "metric.$metric_key" "$metric_value"
  done < "$METRICS_FILE"

  {
    printf '{\n'
    cat "$JSON_TMP"
    printf '\n}\n'
  } > "$TMP_DIR/json.final" 2>/dev/null
  if [ ! -s "$TMP_DIR/json.final" ] || ! mv "$TMP_DIR/json.final" "$OPT_JSON" 2>/dev/null; then
    fatal_env "cannot write JSON results file: $OPT_JSON"
  fi
}

# ---------------------------------------------------------------------------
# Git context
# ---------------------------------------------------------------------------
gather_git_info() {
  GIT_INFO="not a git repository"
  if ! has_cmd git; then
    GIT_INFO="unavailable (git not installed)"
    return 0
  fi
  inside=$( cd "$ABS_DIR" 2>/dev/null && git rev-parse --is-inside-work-tree 2>/dev/null )
  if [ "${inside:-}" != "true" ]; then
    return 0
  fi
  commit_sha=$( cd "$ABS_DIR" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null | head -n 1 )
  if [ -z "${commit_sha:-}" ]; then
    GIT_INFO="repository has no commits yet"
    return 0
  fi
  dirty=""
  if [ -n "$( cd "$ABS_DIR" 2>/dev/null && git status --porcelain -- . 2>/dev/null | head -n 1 )" ]; then
    dirty=" (dirty)"
  fi
  GIT_INFO="$commit_sha$dirty"
}

# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------
print_header() {
  printf '================================================================================\n'
  printf '%s %s - Lean formal-verification gate\n' "$SCRIPT_NAME" "$SCRIPT_VERSION"
  printf '================================================================================\n'
  printf 'Timestamp : %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  printf 'Toolchain : %s\n' "$TOOLCHAIN_DESC"
  printf 'Lake      : %s\n' "$LAKE_BIN"
  if [ -n "$LEAN_BIN" ]; then
    printf 'Lean      : %s\n' "$LEAN_BIN"
  fi
  printf 'Project   : %s\n' "$ABS_DIR"
  printf 'Main file : %s\n' "$MAIN_DISPLAY"
  if [ -n "$AUDIT_DISPLAY" ]; then
    if [ "$AUDIT_AUTO" -eq 1 ]; then
      printf 'Audit file: %s (auto-detected)\n' "$AUDIT_DISPLAY"
    else
      printf 'Audit file: %s\n' "$AUDIT_DISPLAY"
    fi
  else
    printf 'Audit file: (none; pass --audit or add %s)\n' "$DEFAULT_AUDIT_NAME"
  fi
  if [ -n "$THEOREMS_DISPLAY" ]; then
    printf 'Theorems  : %s (%s expected)\n' "$THEOREMS_DISPLAY" "$THEOREMS_EXPECTED"
  fi
  if [ "$MODE" = "watch" ]; then
    printf 'Mode      : watch (interval %ss, run #%s)\n' "$INTERVAL" "$RUN_NUMBER"
  else
    printf 'Mode      : once\n'
  fi
  if [ -n "$BASELINE_DISPLAY" ]; then
    printf 'Baseline  : %s\n' "$BASELINE_DISPLAY"
  fi
  if [ -n "$SAVE_BASELINE_DISPLAY" ]; then
    printf 'Saving    : %s\n' "$SAVE_BASELINE_DISPLAY"
  fi
  if [ -n "$JSON_DISPLAY" ]; then
    printf 'JSON      : %s\n' "$JSON_DISPLAY"
  fi
}

print_build_section() {
  printf '\n[BUILD GATE] lake build (dir: %s)\n' "$ABS_DIR"
  if [ "$BUILD_OK" -eq 1 ]; then
    build_tail=""
    if [ -s "$BUILD_LOG" ]; then
      build_tail=$(tail -n 1 "$BUILD_LOG")
    fi
    if [ -n "$build_tail" ]; then
      printf '  PASS - %s\n' "$build_tail"
    else
      printf '  PASS\n'
    fi
  else
    printf '  FAIL (lake exit %s) - last 40 lines of build output:\n' "$BUILD_RC"
    if [ -s "$BUILD_LOG" ]; then
      tail -n 40 "$BUILD_LOG" | sed -e 's/^/  | /'
    else
      printf '  | (no output captured)\n'
    fi
  fi
}

print_compile_sections() {
  printf '\n[DIRECT COMPILE] lake env lean %s\n' "$MAIN_DISPLAY"
  if [ "$DIRECT_OK" -eq 1 ]; then
    printf '  PASS - the main proof file compiles directly (not dead code)\n'
  else
    printf '  FAIL (lean exit %s) - last 20 lines:\n' "$DIRECT_RC"
    if [ -s "$DIRECT_LOG" ]; then
      tail -n 20 "$DIRECT_LOG" | sed -e 's/^/  | /'
    else
      printf '  | (no output captured)\n'
    fi
  fi

  printf '\n[COMPILE COVERAGE] every other .lean file under %s\n' "$ABS_DIR"
  if [ "$COVERAGE_STATUS" = "SKIP" ]; then
    printf '  SKIP - build gate failed, coverage not attempted\n'
  elif [ "$COVERAGE_STATUS" = "PASS" ]; then
    printf '  PASS - %s file(s) compile directly (unimported files cannot hide)\n' "$COVERAGE_FILES"
  else
    printf '  FAIL - %s of %s file(s) failed to compile:\n' "$COVERAGE_FAILED" "$COVERAGE_FILES"
    if [ -s "$TMP_DIR/coverage-failures.txt" ]; then
      cat "$TMP_DIR/coverage-failures.txt"
    fi
  fi
}

print_guardrail_section() {
  printf '\n[GUARDRAILS] banned constructs in %s .lean file(s) after comment/string stripping\n' "$GUARD_FILES"
  if [ "$GUARD_HITS" -eq 0 ]; then
    printf '  PASS - 0 hits\n'
  else
    printf '  FAIL - %s hit(s):\n' "$GUARD_HITS"
    sed -e 's/^/  /' "$TMP_DIR/guard-hits.txt"
  fi
  if [ "$GUARD_INFO" -gt 0 ]; then
    printf '  INFO - %s allowed construct(s); record each in MODEL-MAP.md:\n' "$GUARD_INFO"
    sed -e 's/^/  /' "$TMP_DIR/guard-infos.txt"
  fi
}

print_axiom_section() {
  printf '\n[AXIOM AUDIT] %s\n' "${AUDIT_DISPLAY:-(no audit file)}"
  if [ "$AXIOM_STATUS" = "SKIP" ]; then
    printf '  SKIP - %s\n' "$AXIOM_NOTE"
    return 0
  fi
  if [ "$AXIOM_STATUS" = "FAIL" ]; then
    printf '  FAIL - %s\n' "$AXIOM_NOTE"
  else
    printf '  PASS - %s\n' "$AXIOM_NOTE"
  fi
  if [ -s "$TMP_DIR/axiom-report.txt" ]; then
    sed -e 's/^/    /' "$TMP_DIR/axiom-report.txt"
  fi
  if [ -s "$TMP_DIR/axiom-failures.txt" ]; then
    sed -e 's/^/    -> /' "$TMP_DIR/axiom-failures.txt"
  fi
  if [ "$AXIOM_RUN_FAILED" -eq 1 ] && [ -s "$TMP_DIR/audit.log" ]; then
    printf '    audit output (last 20 lines):\n'
    tail -n 20 "$TMP_DIR/audit.log" | sed -e 's/^/    | /'
  fi
}

print_metric_table() {
  printf '\n[RULE-4 METRICS]\n'
  if [ -n "$BASELINE_DISPLAY" ]; then
    printf '  comparing against baseline: %s\n' "$BASELINE_DISPLAY"
  else
    printf '  no baseline (use --baseline <file> to compare; --save-baseline to record)\n'
  fi
  metric_width=$(awk -F= 'length($1) > m { m = length($1) } END { print m + 2 }' "$METRICS_FILE")
  if [ -z "${metric_width:-}" ]; then metric_width=30; fi
  if [ "$metric_width" -lt 32 ]; then metric_width=32; fi
  dash_metric=$(awk -v w="$metric_width" 'BEGIN { s = ""; for (i = 0; i < w + 2; i++) s = s "-"; print s }')
  dash_cell="-----------"
  printf '| %-*s | %9s | %9s | %9s |\n' "$metric_width" "Metric" "Current" "Baseline" "Delta"
  printf '|%s|%s|%s|%s|\n' "$dash_metric" "$dash_cell" "$dash_cell" "$dash_cell"
  while IFS='=' read -r metric_key metric_current; do
    [ -n "$metric_key" ] || continue
    metric_baseline="-"
    metric_delta="-"
    if [ -n "$BASELINE_DISPLAY" ] && [ -s "$BASE_NORM" ]; then
      metric_baseline=$(baseline_lookup "$metric_key")
      if [ -n "$metric_baseline" ]; then
        metric_delta_value=$((metric_current - metric_baseline))
        if [ "$metric_delta_value" -gt 0 ]; then
          metric_delta="+$metric_delta_value"
        elif [ "$metric_delta_value" -lt 0 ]; then
          metric_delta="$metric_delta_value"
        else
          metric_delta="0"
        fi
      fi
    fi
    printf '| %-*s | %9s | %9s | %9s |\n' "$metric_width" "$metric_key" "$metric_current" "$metric_baseline" "$metric_delta"
  done < "$METRICS_FILE"
}

print_summary() {
  printf '\nSUMMARY\n'
  printf '  build          : %s\n' "$BUILD_STATUS"
  printf '  direct compile : %s\n' "$DIRECT_STATUS"
  printf '  coverage       : %s\n' "$COVERAGE_STATUS"
  printf '  guardrails     : %s\n' "$GUARD_STATUS"
  printf '  axioms         : %s\n' "$AXIOM_STATUS"
  printf '  toolchain      : %s\n' "$TOOLCHAIN_DESC"
  printf '  lake dir       : %s\n' "$ABS_DIR"
  printf '  git commit     : %s\n' "$GIT_INFO"
  printf '  duration       : %ss\n' "$DURATION"
  printf '  RESULT         : %s\n' "$RESULT"
}

print_report() {
  print_header
  print_build_section
  print_compile_sections
  print_guardrail_section
  print_axiom_section
  print_metric_table
  print_summary
}

# ---------------------------------------------------------------------------
# One verification run
# ---------------------------------------------------------------------------
determine_result() {
  EXIT_CODE=0
  RESULT="PASS"
  if [ "$BUILD_OK" -ne 1 ] || [ "$DIRECT_OK" -ne 1 ] || [ "$COVERAGE_OK" -ne 1 ] \
     || [ "$GUARD_OK" -ne 1 ] || [ "$AXIOM_OK" -ne 1 ]; then
    RESULT="FAIL"
    EXIT_CODE=1
  fi
}

execute_run() {
  run_start=$(date +%s)

  load_baseline
  run_build
  run_direct_compile
  run_coverage
  scan_guardrails
  run_axiom_audit
  compute_main_metrics
  write_metrics_file
  save_baseline_file
  determine_result
  DURATION=$(( $(date +%s) - run_start ))
  gather_git_info
  write_json_file
  print_report
}

# ---------------------------------------------------------------------------
# Watch mode
# ---------------------------------------------------------------------------
clear_screen() {
  # Only clear when attached to a terminal: redirected logs stay readable.
  [ -t 1 ] || return 0
  if has_cmd tput && [ -n "${TERM:-}" ] && tput clear >/dev/null 2>&1; then
    return 0
  fi
  if has_cmd clear && clear >/dev/null 2>&1; then
    return 0
  fi
  printf '\033[H\033[2J'
}

files_changed_since_stamp() {
  if [ -n "$ABS_AUDIT" ] && [ -f "$ABS_AUDIT" ] && [ "$ABS_AUDIT" -nt "$WATCH_STAMP" ]; then
    return 0
  fi
  if [ -n "$ABS_THEOREMS" ] && [ -f "$ABS_THEOREMS" ] && [ "$ABS_THEOREMS" -nt "$WATCH_STAMP" ]; then
    return 0
  fi
  if [ -n "$ABS_MAIN" ] && [ -f "$ABS_MAIN" ] && [ "$ABS_MAIN" -nt "$WATCH_STAMP" ]; then
    return 0
  fi
  if find "$ABS_DIR" \( -name .lake -o -name .git \) -prune -o -type f -name '*.lean' -newer "$WATCH_STAMP" -print 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

watch_signal() {
  printf '\nverify-lean: watch stopped (%s); exiting.\n' "${1:-signal}"
  exit 0
}

watch_loop() {
  WATCH_STAMP="$TMP_DIR/watch.stamp"
  : > "$WATCH_STAMP"
  RUN_NUMBER=0
  trap 'watch_signal INT' INT
  trap 'watch_signal TERM' TERM
  while :; do
    RUN_NUMBER=$((RUN_NUMBER + 1))
    touch "$WATCH_STAMP"
    if [ "$RUN_NUMBER" -gt 1 ]; then
      clear_screen
    fi
    execute_run
    printf '\nverify-lean: watching %s for .lean changes (interval %ss). Press Ctrl-C to stop.\n' "$ABS_DIR" "$INTERVAL"
    while :; do
      sleep "$INTERVAL" 2>/dev/null || true
      if files_changed_since_stamp; then
        break
      fi
    done
  done
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  LOGICAL_PWD="$PWD"
  PHYSICAL_PWD=$(pwd -P 2>/dev/null)
  [ -n "$PHYSICAL_PWD" ] || PHYSICAL_PWD="$LOGICAL_PWD"

  parse_args "$@"

  validate_and_resolve_inputs

  resolve_toolchain

  create_scratch_space
  write_scanner_awk

  list_lean_files
  resolve_main_file
  load_theorems_expected

  if [ -n "$ABS_AUDIT" ]; then
    AUDIT_DISPLAY=$(display_path "$ABS_AUDIT")
  fi
  if [ -n "$ABS_THEOREMS" ]; then
    THEOREMS_DISPLAY=$(display_path "$ABS_THEOREMS")
  fi
  if [ -n "$ABS_BASELINE" ]; then
    BASELINE_DISPLAY=$(display_path "$ABS_BASELINE")
  fi
  if [ "$SAVE_BASELINE_GIVEN" -eq 1 ]; then
    SAVE_BASELINE_DISPLAY="$OPT_SAVE_BASELINE"
  fi
  if [ "$JSON_GIVEN" -eq 1 ]; then
    JSON_DISPLAY="$OPT_JSON"
  fi

  if [ "$MODE" = "watch" ]; then
    watch_loop
  else
    RUN_NUMBER=1
    execute_run
    exit "$EXIT_CODE"
  fi
}

main "$@"
