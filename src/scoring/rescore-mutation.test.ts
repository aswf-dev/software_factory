import { describe, expect, it } from 'vitest'
import { AUTOMERGE_MAX_LINES, rescore, score } from './score.js'
import type { HardRuleId, ScoreInput, ScoreResult } from './types.js'

/**
 * Mutation-strength tests for `rescore` (docs/06 §5.3).
 *
 * These tests exist to prove the suite has TEETH, not merely line coverage.
 * Each block below documents a concrete mutation of `rescore`, and asserts the
 * behaviour that mutation would break. Two of these mutants SURVIVED the
 * pre-existing suite (M1 and M3) — they are the reason this file exists.
 *
 * Mutation log (verified by hand-editing src/scoring/score.ts and re-running
 * `npx vitest run src/scoring`, then reverting):
 *
 *  | ID | Mutation                                                    | Before | After  |
 *  |----|-------------------------------------------------------------|--------|--------|
 *  | M1 | `updated.total <= initial.total` → `<`                       | GREEN  | RED    |
 *  | M2 | `initial.automergeAllowed && updated.automergeAllowed` → `initial.automergeAllowed` | RED | RED |
 *  | M3 | blocker union → `...initial.automergeBlockers` only          | GREEN  | RED    |
 *  | M4 | guard removed (`if (false)`) → always return `updated`       | RED    | RED    |
 *
 * "Before" = pre-existing suite alone. "After" = with this file added.
 * M1/M3 flipping GREEN→RED is the value this file adds; M2/M4 are anchored
 * here so the coverage cannot silently regress if the older tests move.
 */

/** Mirrors the shape of .github/factory/risk-paths.yml (docs/06 §5.2). */
const PATTERNS: Partial<Record<HardRuleId, readonly string[]>> = {
  H1: ['src/auth/**', '**/authorization*'],
  H2: ['src/payment/**', 'src/billing/**'],
  H3: ['**/crypto/**', '**/*secret*'],
  H4: ['src/shared/**', 'src/core/**'],
  H5: ['.github/**', 'CODEOWNERS', 'catalog-info.yaml', '.dsh/skills/**'],
  H6: ['migrations/**'],
  H7: ['api/**', 'openapi.yaml'],
}

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    annotations: {
      businessCriticality: 'tactical',
      riskProfile: 'low',
      complexity: 'low',
    },
    hardRulePatterns: PATTERNS,
    ...over,
  }
}

describe('M1 變異：equal-total 時放寬為可降級（<= 改為 <）', () => {
  /**
   * The pre-existing suite only compared totals on a tie, and a tie of EQUAL
   * numbers is invariant under swapping which side is returned. So `<` vs `<=`
   * was invisible. The distinguishing observation is a tie where the two sides
   * differ in a NON-total field: the tier/label/axis reasons must stay those of
   * `initial`, because `rescore` may only escalate.
   */
  it('分數持平但 updated 較寬鬆 → 必須保留 initial 的層級與理由', () => {
    // initial: strategic + low risk + low complexity = 2 + 0 + 0 = 2 → review
    const initial = score(
      input({
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'low',
          complexity: 'low',
        },
        changedLines: 10,
      }),
    )
    // updated: tactical + medium + medium = 0 + 1 + 1 = 2 → same total, review
    const updated = score(
      input({
        annotations: {
          businessCriticality: 'tactical',
          riskProfile: 'medium',
          complexity: 'medium',
        },
        changedLines: 10,
      }),
    )
    expect(initial.total).toBe(updated.total)

    const final = rescore(initial, updated)

    // Under M1 (`<`), rescore returns `updated`, so businessCriticality would
    // drop from 2 (strategic) to 0 (tactical). The one-way rule forbids that.
    expect(final.businessCriticality.value).toBe(initial.businessCriticality.value)
    expect(final.businessCriticality.value).toBe(2)
    expect(final.businessCriticality.reason).toBe(initial.businessCriticality.reason)
    expect(final.riskProfile.value).toBe(initial.riskProfile.value)
    expect(final.complexity.value).toBe(initial.complexity.value)
  })

  it('分數持平時，最嚴格的既有判定不得被較寬鬆的重判取代', () => {
    // in-loop on both sides but composed differently: 2+2+1 = 5 vs 1+2+2 = 5.
    const initial = score(
      input({
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'high',
          complexity: 'medium',
        },
      }),
    )
    const updated = score(
      input({
        annotations: {
          businessCriticality: 'operational',
          riskProfile: 'high',
          complexity: 'high',
        },
      }),
    )
    expect(initial.total).toBe(updated.total)

    const final = rescore(initial, updated)

    // The returned object must be the initial judgement, field for field.
    expect(final.businessCriticality).toEqual(initial.businessCriticality)
    expect(final.complexity).toEqual(initial.complexity)
    expect(final.tier).toBe(initial.tier)
    expect(final.label).toBe(initial.label)
  })
})

describe('M3 變異：合併 blockers 的聯集被改為只取 initial', () => {
  /**
   * The pre-existing tie test asserted only `automergeAllowed === false`, which
   * M2 already covers. Dropping the union keeps the boolean correct while
   * silently LOSING the updated side's human-readable reason — the audit trail
   * required by docs/06 §5.1. These tests assert the reasons survive.
   */
  it('持平時 updated 端新增的阻擋理由必須出現在最終結果', () => {
    const initial = score(input({ changedLines: 10 }))
    expect(initial.automergeAllowed).toBe(true)
    expect(initial.automergeBlockers).toEqual([])

    const updated = score(input({ changedLines: AUTOMERGE_MAX_LINES + 50 }))
    expect(initial.total).toBe(updated.total)

    const final = rescore(initial, updated)

    expect(final.automergeAllowed).toBe(false)
    // Under M3 the blocker list would be `[]` — false with no stated reason.
    expect(final.automergeBlockers.length).toBeGreaterThan(0)
    expect(final.automergeBlockers).toEqual(expect.arrayContaining(updated.automergeBlockers))
    expect(final.automergeBlockers.join()).toContain('上限')
  })

  it('兩端各有不同阻擋理由 → 最終結果同時保留兩者且不重複', () => {
    // initial blocked by owner veto; updated blocked by the line ceiling.
    const initial = score(
      input({
        annotations: {
          businessCriticality: 'tactical',
          riskProfile: 'low',
          complexity: 'low',
          agentAutomerge: 'false',
        },
        changedLines: 10,
      }),
    )
    const updated = score(input({ changedLines: AUTOMERGE_MAX_LINES + 1 }))
    expect(initial.total).toBe(updated.total)
    expect(initial.automergeBlockers.length).toBeGreaterThan(0)
    expect(updated.automergeBlockers.length).toBeGreaterThan(0)

    const final = rescore(initial, updated)

    expect(final.automergeAllowed).toBe(false)
    expect(final.automergeBlockers).toEqual(expect.arrayContaining(initial.automergeBlockers))
    expect(final.automergeBlockers).toEqual(expect.arrayContaining(updated.automergeBlockers))
    // Union semantics: de-duplicated, never a plain concatenation.
    expect(new Set(final.automergeBlockers).size).toBe(final.automergeBlockers.length)
  })

  it('兩端有相同阻擋理由 → 去重後只出現一次', () => {
    const initial = score(input({ changedLines: AUTOMERGE_MAX_LINES + 7 }))
    const updated = score(input({ changedLines: AUTOMERGE_MAX_LINES + 7 }))

    const final = rescore(initial, updated)

    const ceilingReasons = final.automergeBlockers.filter((b) => b.includes('上限'))
    expect(ceilingReasons).toHaveLength(1)
  })
})

describe('M2 變異：hard-rule 追加時 automerge 阻擋失效', () => {
  /**
   * Anchors the behaviour that the pre-existing suite already killed, so the
   * protection cannot regress if those older tests are refactored away.
   */
  it('持平但 updated 觸發硬性規則 → automerge 必須被撤銷', () => {
    // Both sides total 0; only `updated` trips a hard rule via changed paths.
    const initial = score(input({ changedLines: 20 }))
    expect(initial.automergeAllowed).toBe(true)

    const updated = score(
      input({ changedPaths: ['src/payment/invoice.ts'], changedLines: 20 }),
    )
    expect(updated.triggeredHardRules).toContain('H2')

    const final = rescore(initial, updated)

    expect(final.automergeAllowed).toBe(false)
    expect(final.automergeBlockers.join()).toContain('H2')
  })

  it('initial 允許但 updated 否決 → 合併後不得仍為允許', () => {
    const initial = score(input({ changedLines: 5 }))
    const updated = score(
      input({
        annotations: {
          businessCriticality: 'tactical',
          riskProfile: 'low',
          complexity: 'low',
          agentAutomerge: 'false',
        },
        changedLines: 5,
      }),
    )

    const final = rescore(initial, updated)

    expect(initial.automergeAllowed).toBe(true)
    expect(final.automergeAllowed).toBe(false)
  })
})

describe('M4 變異：單向不降級的守衛被移除', () => {
  /**
   * Anchors the escalation direction itself: whenever the updated total is
   * strictly lower, the final result must still be the initial judgement.
   */
  it('updated 分數嚴格較低 → 一律維持 initial，不得降級', () => {
    const initial = score(
      input({
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'high',
          complexity: 'high',
        },
      }),
    )
    const updated = score(input())
    expect(updated.total).toBeLessThan(initial.total)

    const final = rescore(initial, updated)

    expect(final.total).toBe(initial.total)
    expect(final.tier).toBe('in-loop')
    expect(final.label).toBe(initial.label)
  })

  it('updated 分數較高 → 必須升級為 updated 的判定', () => {
    const initial = score(input({ changedLines: 20 }))
    const updated = score(
      input({
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'high',
          complexity: 'high',
        },
        changedLines: 20,
      }),
    )

    const final = rescore(initial, updated)

    expect(final.total).toBe(updated.total)
    expect(final.tier).toBe('in-loop')
  })

  it('rescore 對相同輸入具冪等性', () => {
    const initial = score(input({ changedLines: 20 }))
    const updated = score(input({ changedPaths: ['src/auth/session.ts'], changedLines: 20 }))

    const once: ScoreResult = rescore(initial, updated)
    const twice: ScoreResult = rescore(once, updated)

    expect(twice.total).toBe(once.total)
    expect(twice.tier).toBe(once.tier)
    expect(twice.automergeAllowed).toBe(once.automergeAllowed)
    expect(new Set(twice.automergeBlockers)).toEqual(new Set(once.automergeBlockers))
  })
})
