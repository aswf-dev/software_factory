# Property-based testing library survey (checked 2026-10-04)

Everything below was pulled live from GitHub (`gh api`), npm, PyPI/pypistats, crates.io, Maven Central metadata, NuGet, proxy.golang.org and hex.pm on 2026-10-04. "Issues" is GitHub's `open_issues_count`, which also counts open PRs. I didn't measure how the issue counts changed over time, so the counts are current only. Anything marked **(unverified)** comes from memory and was not checked against a source.

## Libraries

| Lang | Library | Latest (date) | License | Activity: last commit / open issues+PRs | Adoption | Shrinking | Stateful/model-based | Runner | Native deps / notes |
|---|---|---|---|---|---|---|---|---|---|
| TS/JS | [fast-check](https://github.com/dubzzz/fast-check) | 4.10.2 (2026-09-19) | MIT | 2026-10-04 / 90 | 5.2k★, ~58M dl/wk ([npm](https://api.npmjs.org/downloads/point/last-week/fast-check)) | integrated (generator-carried shrink trees) **(unverified detail)** | yes: `fc.commands` + `modelRun` | `@fast-check/vitest` 0.5.0, `@fast-check/jest` 2.3.0 | pure JS |
| TS/JS | [hegel-typescript](https://github.com/hegeldev/hegel-typescript) `@hegeldev/hegel` | 0.4.7 (2026-09-24) | MIT | 2026-09-28 / 12 | 69★ | integrated (Hypothesis-style, in libhegel) | no stateful API found in `src/` | vitest example | native libhegel via Koffi per-platform pkgs; Node 20.11+/Bun/Deno; Wasm for browsers |
| Python | [Hypothesis](https://github.com/HypothesisWorks/hypothesis) | 6.168.3 (2026-09-28) | MPL-2.0 | 2026-10-04 / 53 | 9.0k★, 13.3M dl/wk ([pypistats](https://pypistats.org/api/packages/hypothesis/recent)) | integrated (choice-sequence), the reference design | `RuleBasedStateMachine` | pytest, unittest | pure Python, ≥3.10 |
| Java | [jqwik](https://github.com/jqwik-team/jqwik) | 1.10.1 (2026-05-29) | EPL-2.0 | 2026-10-04 / 49 | 853★ | integrated | yes: actions/state machines | own JUnit Platform engine | **README: "pure maintenance mode"** (dependency bumps and crucial fixes only) |
| Java | [junit-quickcheck](https://github.com/pholser/junit-quickcheck) | 1.0 (2020-11-22) | MIT | 2024-08 / 39 | 982★ | type-based | no **(unverified)** | JUnit 4 runner | effectively dormant |
| Java | [hegel-java](https://github.com/hegeldev/hegel-java) `dev.hegel:hegel` | 0.10.0 (2026-10-01) | MIT | 2026-10-01 / 0 | 24★ | integrated | `Stateful.java` | `@HegelTest` (JUnit 5) | bundled native engine, FFM (Java 22+) or `hegel-jna` (17+); [compat page](https://hegel.dev/compatibility) says Linux/macOS only (README also lists Windows) |
| Kotlin | [Kotest property](https://github.com/kotest/kotest) `kotest-property` | 6.2.5 (2026-09-10) | Apache-2.0 | 2026-09-26 / 52 | 4.8k★ (whole Kotest) | type-based `Shrinker` ([docs](https://github.com/kotest/kotest/blob/master/documentation/docs/proptest/shrinking.md)) | none in proptest docs | Kotest; also usable standalone | multiplatform |
| Scala | [ScalaCheck](https://github.com/typelevel/scalacheck) | 1.20.0 (2026-08-27) | BSD-3 | 2026-09-29 / 76 | 2.0k★ | type-based `Shrink` | `org.scalacheck.commands` **(unverified this release)** | sbt, munit-/ScalaTest integration | – |
| Go | [rapid](https://github.com/flyingmutant/rapid) `pgregory.net/rapid` | v1.3.0 (proxy 2026-03-30) | MPL-2.0 | 2026-09-04 / 19 | 891★ | integrated (Hypothesis-style) | `StateMachine` / `t.Repeat` **(unverified API name)** | `go test` | pure Go |
| Go | [gopter](https://github.com/leanovate/gopter) | v0.2.11 (2024-04-03) | MIT | 2026-04 / 14 | 639★ | type-based | `commands` pkg | `go test` | slow-moving |
| Go | [testing/quick](https://pkg.go.dev/testing/quick) | stdlib | BSD | "frozen and is not accepting new features" | – | **none** | no | `go test` | avoid |
| Go | [hegel-go](https://github.com/hegeldev/hegel-go) `hegel.dev/go/hegel` | v0.9.13 (2026-10-02) | MIT | 2026-10-02 / 6 | 101★ | integrated | yes (`stateful.go`, `Rule*`/`Invariant*` methods) | `go test` | libhegel embedded via `go:embed` (git-lfs) |
| Rust | [proptest](https://github.com/proptest-rs/proptest) | 1.11.0 (2026-03-24) | MIT/Apache-2.0 | 2026-10-03 / 150 | 2.3k★, 52.6M dl/90d | integrated (value trees) | [`proptest-state-machine`](https://crates.io/crates/proptest-state-machine) 0.8.0 | `cargo test` | pure Rust |
| Rust | [quickcheck](https://github.com/BurntSushi/quickcheck) | 1.1.0 (2026-02-10) | Unlicense/MIT | 2026-04 / 33 | 2.8k★, 12.3M dl/90d | type-based `Arbitrary::shrink` | no | `cargo test` | minimal |
| Rust | [bolero](https://github.com/camshaft/bolero) | 0.13.7 (2026-10-03) | MIT | 2026-10-03 / 52 | 258★, 1.5M dl/90d | engine-dependent | no dedicated API **(unverified)** | `cargo test` / `cargo-bolero` (libFuzzer/AFL/honggfuzz/Kani) | fuzz engines need a C toolchain **(unverified)** |
| Rust | [hegel-rust](https://github.com/hegeldev/hegel-rust) `hegeltest` | 0.48.1 (2026-09-28) | MIT | 2026-09-28 / 34 | 389★, 0.7M dl/90d | integrated | yes (`src/stateful.rs` + macros) | `#[hegel::test]` | hosts libhegel (Rust); Windows support "somewhat experimental" |
| C#/.NET | [FsCheck](https://github.com/fscheck/FsCheck) | 3.4.0 (2026-08-20) | BSD-3 | 2026-08-20 / 22 | 1.25k★, 17.0M total dl | type-based | experimental state machine **(unverified)** | xUnit/NUnit pkgs | – |
| C#/.NET | [CsCheck](https://github.com/AnthonyLloyd/CsCheck) | 4.9.1 (2026-09-17) | Apache-2.0 | 2026-10-03 / 4 | 251★, 1.0M total dl | integrated, PCG seed-based, parallel | model-based + concurrency testing | any runner | – |
| C#/.NET | [Hedgehog](https://www.nuget.org/packages/Hedgehog) | 2.0.4 (2026-06-29) | Apache-2.0 | – | 0.36M dl | integrated | – | – | F#-first |
| C++ | [RapidCheck](https://github.com/emil-e/rapidcheck) | no tagged release ever | BSD-2 | 2026-08-06 / 121 | 1.1k★ | integrated | command-based | GTest/Boost.Test/GMock | vendor via git |
| C++ | [hegel-cpp](https://github.com/hegeldev/hegel-cpp) | v0.13.1 (2026-09-28) | MIT | 2026-09-28 / 3 | 21★ | integrated | `stateful.h` | – | libhegel |
| Erlang | [PropEr](https://github.com/proper-testing/proper) | 1.5.0 (2025-03/04) | **GPL-3.0** | 2026-06 / 50 | 919★, 6.8M hex dl | generator-driven | `proper_statem`, `proper_fsm` | rebar3/EUnit | GPL |
| Elixir | [StreamData](https://github.com/whatyouhide/stream_data) | 1.4.0 (2026-07-14) | Apache-2.0 | 2026-09-08 / 4 | 947★, 37.7M hex dl | integrated (lazy trees) | none; use [PropCheck](https://hex.pm/packages/propcheck) (GPL, wraps PropEr) | ExUnit | – |

## Recommendations: the most mature default, and how Hegel compares

Hegel ([hegel.dev](https://hegel.dev)) is in beta. Every library is 0.x, and minor bumps may break APIs ([compat](https://hegel.dev/compatibility)). The architecture has changed: the Python-server `hegel-core` is now **archived** ("old implementation… migrate to the new FFI based approach"). All libraries now call **libhegel**, a Rust engine, in-process ([how it works](https://hegel.dev/explanation/how-hegel-works)). There are prebuilt binaries for linux amd64/arm64, darwin/arm64 and windows. There is **no Intel macOS** binary. The repos have moved from `antithesishq` to `hegeldev`.

- **TS/JS: fast-check.** It is the clear choice, with huge adoption, active development, `fc.commands` and a vitest plugin. Hegel-TS is far behind: it has a native dependency and I found no stateful API.
- **Python: Hypothesis.** It has no real rival. Hegel has no Python library because it *is* Hypothesis, ported.
- **Java: jqwik** is the most capable, but it is in maintenance mode. That's acceptable if you only need it to keep working. junit-quickcheck is dormant. hegel-java already has a JUnit 5 annotation and stateful testing, but it is two months old and needs the native-access flag. It's the long-term option to watch.
- **Kotlin: Kotest property.** It has type-based shrinking and no stateful testing. Calling jqwik or hegel-java from Kotlin should work but **(unverified)**. There is no Hegel library for Kotlin.
- **Scala: ScalaCheck.** No Hegel library.
- **Go: rapid.** It has integrated shrinking and a state machine, and it's pure Go. gopter is slow-moving, and testing/quick is frozen with no shrinking. hegel-go is the strongest Hegel port: it has stateful testing, an embedded engine and frequent releases. It is still beta, and since rapid is already Hypothesis-style, switching gains little.
- **Rust: proptest.** It has integrated shrinking and `proptest-state-machine`, and it's pure Rust. Use bolero when you also want fuzzing or Kani. quickcheck is fine for simple cases. hegel-rust is the flagship and getting real downloads (0.7M/90d), but its 0.x churn is fast (v0.48).
- **.NET: FsCheck** is the most adopted. **CsCheck** has better shrinking and concurrency testing, so pick it for C#-first codebases. No Hegel library.
- **C++:** RapidCheck still has the most features, but it has never had a release. hegel-cpp is young but versioned.
- **Erlang:** PropEr (watch the GPL). **Elixir:** StreamData.

## Quint / TLA+ / ITF integration

**None of the PBT libraries above has built-in support for Quint, TLA+ or ITF.** Trace-driven model-based testing is handled by separate "connect" packages:

- [quint-connect](https://github.com/quint-co/quint-connect) (Rust, crate 0.1.2, 2026-05-25, Apache-2.0). It runs `quint` to generate traces, replays the ITF traces through a `Driver`, and diffs the spec state against the implementation state. It needs the Quint CLI on PATH, and its dependencies are `itf`, `rand` and `serde` (no proptest).
- [quint-connect-ts / `@firfi/quint-connect`](https://github.com/dearlordylord/quint-connect-ts) (2.1.0, 2026-07-19). It runs `quint run --mbt`, parses ITF, and replays through a driver, with a `vitest` helper and Effect/Zod schemas. It has 13★ and about 60 dl/wk.
- [tla-connect](https://github.com/wiggum-cc/tla-connect) (Rust 0.0.4). It does TLA+/Apalache trace validation, MBT and counterexample replay, using `itf` and the Apalache JSON-RPC.
- [itf-rs](https://github.com/informalsystems/itf-rs) (crate `itf` 0.4.0) is the ITF parser.
- There are one-person community ports with 0–6★ for Elixir, Java, OCaml, Clojure, Go and others ([GitHub search](https://github.com/search?q=quint-connect&type=repositories)).

To combine trace replay with PBT, use the PBT library's stateful/command API to drive the system under test, and use the connect package's driver and state-diff for the external traces. Doing this in one harness is a do-it-yourself job; no package does it for you.
