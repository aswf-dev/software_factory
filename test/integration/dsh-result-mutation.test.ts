/**
 * Mutation-strength tests for `interpretDshResult` (docs/04 §4.2, docs/11 §4.1).
 *
 * These tests exist to prove the suite has TEETH, not merely line coverage.
 * Each block below documents a concrete mutation of `src/integration/dsh-result.ts`
 * and asserts the behaviour that mutation would break.
 *
 * The behavioural contract tests in `dsh-contract.test.ts` describe what DSH
 * is supposed to do. They are broad but blind in three places; the mutants
 * below all SURVIVED that suite (verified by hand-editing the source and
 * re-running `npx vitest run test/integration/dsh-contract.test.ts`, then
 * reverting):
 *
 *  | ID | Mutation                                                        | Before | After  |
 *  |----|-----------------------------------------------------------------|--------|--------|
 *  | M1 | `(invocation.stderr ?? '').trim()` → `(invocation.stderr ?? '')` | GREEN  | RED    |
 *  | M2 | timeout `errorDetail` fixed to `''` (drops stderr + default)    | GREEN  | RED    |
 *  | M4 | `timedOut === true` → `timedOut && exitCode === 0`              | GREEN  | RED    |
 *
 * A fourth candidate, dropping the `?? '(無)'` placeholder for a missing exit
 * code (M3), was also tried but the contract suite ALREADY kills it (its empty-
 * stderr test asserts 'exit code 1'), so it adds no tooth and is omitted.
 *
 * "Before" = `dsh-contract.test.ts` alone. "After" = with this file added.
 * Each of M1/M2/M4 flips GREEN→RED only because the new assertions check what
 * the contract tests left unsaid; they are the value this file adds.
 */

import { describe, expect, it } from 'vitest'
import { interpretDshResult } from '../../src/integration/dsh-result.js'

describe('M1 變異：stderr 去除前後空白被刪除', () => {
  /**
   * The contract tests assert `errorDetail === stderr` (docs/04 §4.2) but every
   * fixture passes already-trimmed stderr. Removing the `.trim()` therefore goes
   * unnoticed. The contract strings a padding full of whitespace and a trailing
   * newline into the handover copy, so the trim must be pinned down.
   */
  it('失敗時 stderr 的前後空白與換行會被去除', () => {
    const r = interpretDshResult({ exitCode: 1, stderr: '  boom  \n\n' })
    expect(r.errorDetail).toBe('boom')
  })

  it('逾時時 stderr 的前後空白與換行會被去除', () => {
    const r = interpretDshResult({ timedOut: true, stderr: '  killed  \n' })
    expect(r.errorDetail).toBe('killed')
  })
})

describe('M2 變異：逾時的 errorDetail 被固定為空字串', () => {
  /**
   * The contract test for timeout (`dsh-contract.test.ts` "逾時優先於 exit code
   * 判定") asserts only `outcome` and `shouldContinue` — never `errorDetail`.
   * So wiping the timeout error detail to '' survives. But a handover comment
   * with an empty error message is exactly what docs/04 §4.2 forbids: it would
   * give the human reviewer nothing to act on.
   */
  it('逾時附帶 stderr → errorDetail 保留該訊息供人接手', () => {
    const r = interpretDshResult({ timedOut: true, stderr: 'killed by cgroup' })
    expect(r.errorDetail).toBe('killed by cgroup')
  })

  it('逾時且無 stderr → 提供可讀的預設訊息，而非空白', () => {
    const r = interpretDshResult({ timedOut: true })
    expect(r.errorDetail).not.toBe('')
    expect(r.errorDetail).toContain('時間上限')
  })
})

describe('M4 變異：逾時優先權被限縮為只對 exit 0 生效', () => {
  /**
   * The existing timeout test passes `exitCode: 0` with `timedOut: true`, so a
   * mutant that only lets timeout win when the code happens to be 0 is invisible.
   * But a killed process (the reason timeout exists) almost never reports a
   * friendly code. The mutant must be pinned to the non-zero case: a run that is
   * BOTH timed out AND carrying a misleading non-zero code must still read as
   * 'timeout', not 'failed' (docs/04 §4.2 "逾時優先於 exit code 判定").
   */
  it('逾時即便 exit code 非零 → 仍判為 timeout，且不續行', () => {
    const r = interpretDshResult({ exitCode: 1, timedOut: true, stdout: 'partial' })
    expect(r.outcome).toBe('timeout')
    expect(r.shouldContinue).toBe(false)
  })
})
