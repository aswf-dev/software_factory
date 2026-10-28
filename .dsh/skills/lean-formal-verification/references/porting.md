# Porting Java / TypeScript / Rust code into a Lean model

Rule 6 ("preserve the algorithm; abstract the details") needs a defensible mapping from the implementation to the model. This reference gives the type-mapping table, the abstraction-function discipline, and the state-machine recipe. A complete, compilable worked example is in `examples/java-order-status/`.

## Abstraction function discipline

For each modeled component write down the correspondence in `MODEL-MAP.md`:

- **Inputs:** how a real value is represented in Lean (`toLean`), including normalization (trim, case, scale, timezone).
- **State:** which fields of the real state are modeled; which are dropped and why they cannot affect the property.
- **Decisions:** every guard that can change the outcome must appear in the model with the same sense and order.
- **Outcomes:** values, thrown errors, no-ops map to explicit Lean outcomes (`Except`, `Option`, sum types) — not to silent defaults.

If you cannot state the correspondence for a detail, either model it or list it under **Not covered**. "Persistence" is not a blanket exemption: `@Version`/optimistic locking is persistence *and* the mechanism that makes a concurrency rule true.

## Type mapping (typical)

| Source (Java / TypeScript / Rust) | Lean | Notes |
|---|---|---|
| enum / union of string literals | `inductive` + `deriving DecidableEq, Repr` | Model unknown/invalid values explicitly as `Option`/`Except`; do not reuse the enum type for "unparsed". |
| `boolean` | `Bool` | Theorems usually state `f x = true ↔ P`. |
| `int`, `long`, `short` | `Int` | Arbitrary precision: overflow is **excluded** — say so in Not covered, or model bounds explicitly with proof obligations. |
| counter / length / index (never negative, underflow is a real bug) | `Nat` | `Nat` truncates at 0; proving the subtractions are nonnegative is the point (as in the article's length proofs). |
| `BigDecimal`, `double`, `float`, money | `Int` at a fixed scale (e.g. cents) or `Rat` | Record the scale and rounding rule; if rounding matters, prove the rounding function's properties too. |
| `String` | usually a model-specific opaque type, or `String` only if trim/case/equality semantics matter | Normalize before modeling; state Unicode/normalization assumptions. |
| `null`, `undefined`, missing field | `Option α` | Absence and invalid values are different; decide which one the rule covers. |
| thrown exception / rejected request | `Except E α` or a sum type including the error | Model the guard that throws, not the exception machinery. |
| `List`, array, ordered collection | `List α` | Order-sensitive behavior must be preserved; document whether order is guaranteed. |
| `Set`, `Map` with no order guarantee | `Finset` / `List` + canonicalization lemma | HashMap iteration order is not part of the contract — if it affects output, that is a finding. |
| `UUID`, opaque identifier | an abstract `Id` type (or `String`) | Equality only; do not model generation randomness. |
| `LocalDate`, `Instant`, time zone | `Int` (epoch days/seconds) with a fixed zone | Time zones are data: model the zone or restrict scope; DST is a classic hidden assumption. |
| `@Version` optimistic lock | `Nat` version + commit guard (`readVersion = currentVersion`) | The version check is the rule; isolation/flush semantics become an explicit assumption in Not covered. |
| concurrency / transactions | commit-order trace (`List` of committed writes) | Prove no-lost-update and sequential consistency of committed writes; interleaving/liveness is typically out of scope. |

## State-machine recipe (the common case)

1. **States:** one `inductive` with the same constructors as the real enum; no extra constructors unless labeled as "invalid/unknown".
2. **Transition relation:** an executable `def allowed : State → State → Bool` that mirrors the real switch/if chain — same guards, same order, same defaults.
3. **Theorems** (at least one headline per rule):
   - **Initial state:** creation yields only the allowed initial state (model `create` as returning `Except`/`Option`).
   - **Single step / no jumps:** rank-based property, e.g. `allowed s t = true → rank t = rank s + 1` for the forward chain.
   - **Source restrictions:** `allowed s X = true ↔ s ∈ allowedSources(X)` for cancel/error-style transitions.
   - **Terminal states:** `allowed terminal s = false` for every `s`.
   - **Same-state rejection** if the code enforces it (and if the rule requires it).
   - **Characterization/closure:** `allowed s t = true ↔ (s,t) ∈ allowedPairs` — this is the theorem a human can read against the Java switch.
   - **Reachability (non-vacuity):** exhibit one concrete path to each state that the rule talks about (`Examples.lean`), so the transition relation is not accidentally empty.
4. **Versioned concurrency:** state = `(status, version)`; a transaction reads `(status, version)`; commit succeeds iff `readVersion = currentVersion ∧ allowed readStatus writeStatus`, then version increments. Headline theorems: successful commit implies an allowed transition; stale-version commit is rejected and leaves state unchanged (**no lost update**); two transactions that read the same version cannot both commit; committed traces are sequential (each committed write read the version/status of the previous commit — induction over the trace).
5. **Proof style:** `cases`/`decide`/`simp [allowed]` closes most characterization lemmas; use `omega` for arithmetic ranks. Keep the executable `allowed` for `decide` witnesses and state theorems about it — do not maintain a second `Prop` relation that can drift from the executable one.

## Pitfalls seen in practice

- Modeling the enum *plus* an "invalid" constructor and then never checking it (vacuous rule coverage).
- Using `Int` for counters and proving `x - k ≥ 0` trivially because `Int` is unbounded — the real code would underflow.
- Dropping the version/optimistic-lock mechanism as "persistence" and then "proving" a no-lost-update theorem about a model that has no versions.
- Restating the guard as the theorem (`theorem ok : allowed s t = true → allowed s t = true`).
- Proving properties of a `HashMap`-ordered `List` without stating that order is not contractual.
- Hand-picked examples in proof modules: use `Specs/Examples.lean` for witnesses, never as the claim.
