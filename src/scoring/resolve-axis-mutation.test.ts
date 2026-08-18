import { describe, expect, it } from 'vitest'
import { resolveAxis } from './score.js'
import { BUSINESS_CRITICALITY, COMPLEXITY, RISK_PROFILE } from './types.js'
import type { BusinessCriticality, Complexity, RiskProfile } from './types.js'

/**
 * Mutation-strength tests for `resolveAxis` (docs/06 §3, §5.1; docs/11 §6.1).
 *
 * `resolveAxis` is the fail-safe gate that turns an absent or mis-spelled axis
 * into the STRICTEST value so a typo in an annotation can never lower oversight.
 * It is the single most dangerous function in `score.ts` (docs/03 §7): the whole
 * "缺資訊 → 採最高風險值" contract rests on it. Line coverage proves nothing for
 * this function, so — exactly as `rescore-mutation.test.ts` and
 * `match-hard-rules-mutation.test.ts` do for their targets — these tests prove
 * each fail-safe guard clause has TEETH by anchoring the *direction* of the
 * score and the human-readable audit reason.
 *
 * Every mutation below was verified by hand-editing `src/scoring/score.ts`,
 * running `npx vitest run src/scoring`, then reverting (GREEN → RED → GREEN):
 *
 *  | ID | Mutation                                                        | score.test | This file |
 *  |----|-----------------------------------------------------------------|------------|-----------|
 *  | M-1 | `undefined`/blank guard returns `0` instead of `2`              | RED        | RED       |
 *  | M-2 | invalid value returns `0` instead of `2` (錯字不再 fail-safe)     | RED        | RED       |
 *  | M-3 | `.toLowerCase()` dropped (區分大小寫，`'Low'` 被當成非法)        | RED        | RED       |
 *  | M-4 | invalid branch leaks a legal axis score (非法→任一字面值)        | RED        | RED       |
 *
 * Unlike M1/M3 of `rescore-mutation.test.ts`, no mutant here survives the
 * pre-existing `score.test.ts` fail-safe cases (docs/03 §7 is already tested
 * there). That is the point, not a weakness: `resolveAxis` is the security-
 * critical gate, so these four mutations are anchored here in a dedicated,
 * SINGLE-AXIS, reason-aware form — the same explicit-anchoring role as M2/M4 in
 * `rescore-mutation.test.ts` and M-A/M-D in `match-hard-rules-mutation.test.ts`.
 * If any earlier test is later refactored or moved, this file independently
 * keeps every fail-safe guard clause (缺值 → 2、錯字 → 2、大小寫折疊、非法不洩漏
 * 合法分數) observably RED when mutated, and now that `resolveAxis` is exported
 * it does so at the unit level with the audit reason asserted (docs/06 §5.1).
 */

const CRITICALITY_SCORE: Record<BusinessCriticality, 0 | 1 | 2> = {
  tactical: 0,
  operational: 1,
  strategic: 2,
}
const RISK: Record<RiskProfile, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 }
const COMPLEXITY_SCORE: Record<Complexity, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 }

describe('M-1 變異：缺值（undefined / 空白）不再 fail-safe', () => {
  /**
   * The first guard clause is the whole point of the module: an un-annotated
   * axis must score 2 (最高風險). Mutating `value: 2` → `value: 0` in that
   * branch silently promotes a missing annotation to a permissive score.
   */
  it('undefined → 採最高風險值 2，而非 0', () => {
    const r = resolveAxis(undefined, RISK_PROFILE, RISK, 'risk-profile')
    expect(r.value).toBe(2)
    expect(r.reason).toContain('未標註')
  })

  it('僅空白 → 視同未標註，採 2，理由帶 fail-safe', () => {
    const r = resolveAxis('   ', COMPLEXITY, COMPLEXITY_SCORE, 'complexity')
    expect(r.value).toBe(2)
    expect(r.reason).toContain('未標註')
  })
})

describe('M-2 變異：非法值不再 fail-safe（錯字靜默降權）', () => {
  /**
   * The headline security case (the function's own comment): "if an
   * unrecognised string scored 0, misspelling an annotation would silently
   * reduce oversight." Mutating this branch to `0` turns a typo into a
   * permission downgrade — exactly what the module must never do.
   */
  it('非法字面值 → 採最高風險值 2，理由標明非法', () => {
    const r = resolveAxis(
      'tactial' as string, // typo of 'tactical'
      BUSINESS_CRITICALITY,
      CRITICALITY_SCORE,
      'business-criticality',
    )
    expect(r.value).toBe(2)
    expect(r.reason).toContain('非法')
  })
})

describe('M-3 變異：大小寫折疊被移除（合法 low 被誤判非法）', () => {
  /**
   * `raw.trim().toLowerCase()` is what lets `' LOW '` match the legal axis
   * `low`. Dropping `.toLowerCase()` makes `'Low'`/`'low'` and mixed-case inputs
   * fall through to the invalid branch — a *spurious* fail-safe that flags real
   * annotations as errors and muddies the reason (docs/06 §5.1).
   */
  it('大寫 的 low → 仍匹配合法值 low 並得 0 分', () => {
    const r = resolveAxis('Low', COMPLEXITY, COMPLEXITY_SCORE, 'complexity')
    expect(r.value).toBe(0)
    expect(r.reason).toContain('= low')
  })

  it('前後空白並混合大小寫 → 仍視為合法 high', () => {
    const r = resolveAxis('  HIGH ', RISK_PROFILE, RISK, 'risk-profile')
    expect(r.value).toBe(2)
    expect(r.reason).toContain('= high')
    expect(r.reason).not.toContain('非法')
  })
})

describe('M-4 變異：非法值回傳合法分數（fail-safe 失效於任一字面值）', () => {
  /**
   * Independently of M-2's score: the invalid branch must NOT return a value
   * that maps from the `scores` map at all (e.g. a mutant returning
   * `scores[allowed[0]]`). Any legal-value leak here silently treats a misspelled
   * axis as if it were the first legal one.
   */
  it('非法值不得拿到任一字面值的分數', () => {
    const r = resolveAxis('strategik' as string, BUSINESS_CRITICALITY, CRITICALITY_SCORE, 'business-criticality')
    expect(r.value).toBe(2)
    expect(r.reason).toContain('非法')
  })
})
