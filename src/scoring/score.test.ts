import { describe, expect, it } from 'vitest'
import { AUTOMERGE_MAX_LINES, matchHardRules, rescore, score, tierForTotal } from './score.js'
import type { HardRuleId, ScoreInput } from './types.js'

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

describe('三軸計分（docs/06 §3）', () => {
  it('內部工具補測試 → 0 分 → on-loop', () => {
    const r = score(input())
    expect(r.total).toBe(0)
    expect(r.tier).toBe('on-loop')
    expect(r.label).toBe('oversight/on-loop')
  })

  it('客戶端服務改金流 → 5 分 → in-loop', () => {
    const r = score(
      input({
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'high',
          complexity: 'medium',
        },
        changedPaths: ['src/payment/calc.ts'],
      }),
    )
    expect(r.total).toBe(5)
    expect(r.tier).toBe('in-loop')
  })

  it('內部系統修一般 bug → 3 分 → review', () => {
    const r = score(
      input({
        annotations: {
          businessCriticality: 'operational',
          riskProfile: 'medium',
          complexity: 'medium',
        },
      }),
    )
    expect(r.total).toBe(3)
    expect(r.tier).toBe('review')
  })

  it('大小寫與前後空白不影響判定', () => {
    const r = score(
      input({
        annotations: {
          businessCriticality: '  Strategic ',
          riskProfile: 'HIGH',
          complexity: 'Low',
        },
      }),
    )
    expect(r.total).toBe(4)
  })
})

describe('fail-safe：缺資訊時偏保守（docs/03 §7）', () => {
  it('三軸全缺 → 6 分 → in-loop', () => {
    const r = score(input({ annotations: {} }))
    expect(r.total).toBe(6)
    expect(r.tier).toBe('in-loop')
  })

  it('單一軸缺失 → 該軸採 2 分', () => {
    const r = score(
      input({ annotations: { businessCriticality: 'tactical', complexity: 'low' } }),
    )
    expect(r.riskProfile.value).toBe(2)
    expect(r.riskProfile.reason).toContain('fail-safe')
  })

  it('空字串視同未標註', () => {
    const r = score(input({ annotations: { businessCriticality: '   ' } }))
    expect(r.businessCriticality.value).toBe(2)
  })

  // The security-critical case: a typo must not become a permission downgrade.
  it('非法值（打錯字）→ 採最高風險值，絕不當作 0 分', () => {
    const r = score(
      input({
        annotations: {
          businessCriticality: 'tactial', // typo
          riskProfile: 'low',
          complexity: 'low',
        },
      }),
    )
    expect(r.businessCriticality.value).toBe(2)
    expect(r.businessCriticality.reason).toContain('非法')
    expect(r.total).toBe(2)
    expect(r.tier).not.toBe('on-loop')
  })
})

describe('風險硬性規則 H1–H7（docs/06 §3.2）', () => {
  it.each([
    ['H1', 'src/auth/login.ts'],
    ['H2', 'src/payment/invoice.ts'],
    ['H3', 'src/crypto/keys.ts'],
    ['H4', 'src/shared/model.ts'],
    ['H5', '.github/workflows/factory-run.yml'],
    ['H6', 'migrations/001_init.sql'],
    ['H7', 'api/v1/orders.ts'],
  ])('%s：觸及即 risk=2，即使 catalog 標為 low', (rule, path) => {
    const r = score(input({ changedPaths: [path] }))
    expect(r.riskProfile.value).toBe(2)
    expect(r.triggeredHardRules).toContain(rule as HardRuleId)
  })

  it('未觸及任何硬性規則路徑 → 沿用 catalog 值', () => {
    const r = score(input({ changedPaths: ['README.md', 'src/ui/button.ts'] }))
    expect(r.riskProfile.value).toBe(0)
    expect(r.triggeredHardRules).toEqual([])
  })

  it('同時觸發多條規則 → 全數記錄且去重排序', () => {
    const r = score(
      input({ changedPaths: ['src/auth/a.ts', 'src/auth/b.ts', 'migrations/x.sql'] }),
    )
    expect(r.triggeredHardRules).toEqual(['H1', 'H6'])
  })

  it('H5 保護 guardrail 自身：CODEOWNERS 與 skills', () => {
    expect(matchHardRules(['CODEOWNERS'], PATTERNS)).toEqual(['H5'])
    expect(matchHardRules(['.dsh/skills/factory-stop-rules/SKILL.md'], PATTERNS)).toEqual(['H5'])
    expect(matchHardRules(['catalog-info.yaml'], PATTERNS)).toEqual(['H5'])
  })

  it('無 pattern 設定時不誤判', () => {
    expect(matchHardRules(['src/auth/x.ts'], {})).toEqual([])
  })
})

describe('門檻邊界（docs/06 §4）', () => {
  it.each([
    [0, 'on-loop'],
    [1, 'on-loop'],
    [2, 'review'],
    [4, 'review'],
    [5, 'in-loop'],
    [6, 'in-loop'],
  ])('總分 %i → %s', (total, tier) => {
    expect(tierForTotal(total)).toBe(tier)
  })
})

describe('自動合併附加條件（docs/06 §4.1）', () => {
  it('0 分且無阻擋 → 允許自動合併', () => {
    const r = score(input({ changedLines: 50 }))
    expect(r.automergeAllowed).toBe(true)
    expect(r.automergeBlockers).toEqual([])
  })

  // The owner veto must hold even at the lowest possible score.
  it('agent-automerge=false → 即使 0 分仍不得自動合併', () => {
    const r = score(
      input({
        annotations: {
          businessCriticality: 'tactical',
          riskProfile: 'low',
          complexity: 'low',
          agentAutomerge: 'false',
        },
      }),
    )
    expect(r.total).toBe(0)
    expect(r.tier).toBe('on-loop')
    expect(r.automergeAllowed).toBe(false)
    expect(r.automergeBlockers.join()).toContain('否決')
  })

  it('agent-automerge=true 不會放寬其他條件', () => {
    const r = score(
      input({
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'low',
          complexity: 'low',
          agentAutomerge: 'true',
        },
      }),
    )
    expect(r.automergeAllowed).toBe(false)
  })

  it(`變更超過 ${AUTOMERGE_MAX_LINES} 行 → 退回人類審查`, () => {
    const r = score(input({ changedLines: AUTOMERGE_MAX_LINES + 1 }))
    expect(r.automergeAllowed).toBe(false)
    expect(r.automergeBlockers.join()).toContain('上限')
  })

  it(`恰好 ${AUTOMERGE_MAX_LINES} 行 → 仍允許（邊界含等於）`, () => {
    const r = score(input({ changedLines: AUTOMERGE_MAX_LINES }))
    expect(r.automergeAllowed).toBe(true)
  })

  it('review 層級不得自動合併', () => {
    const r = score(input({ annotations: { businessCriticality: 'strategic' } }))
    expect(r.tier).not.toBe('on-loop')
    expect(r.automergeAllowed).toBe(false)
  })
})

describe('二次判定：只升不降（docs/06 §5.3）', () => {
  it('diff 觸及 auth → 由 on-loop 升級並撤銷自動合併', () => {
    const initial = score(input({ changedLines: 20 }))
    expect(initial.automergeAllowed).toBe(true)

    const updated = score(input({ changedPaths: ['src/auth/session.ts'], changedLines: 20 }))
    const final = rescore(initial, updated)

    expect(final.total).toBeGreaterThan(initial.total)
    expect(final.automergeAllowed).toBe(false)
    expect(final.triggeredHardRules).toContain('H1')
  })

  it('實際風險較低時維持原判，不得降級', () => {
    const initial = score(
      input({ annotations: { businessCriticality: 'strategic', riskProfile: 'high', complexity: 'high' } }),
    )
    const updated = score(input())

    const final = rescore(initial, updated)
    expect(final.total).toBe(initial.total)
    expect(final.tier).toBe('in-loop')
  })

  it('分數持平但新增阻擋條件 → 仍撤銷自動合併', () => {
    const initial = score(input({ changedLines: 10 }))
    const updated = score(input({ changedLines: AUTOMERGE_MAX_LINES + 50 }))

    const final = rescore(initial, updated)
    expect(final.total).toBe(initial.total)
    expect(final.automergeAllowed).toBe(false)
  })
})

describe('判定理由可供人類稽核（docs/06 §5.1）', () => {
  it('每一軸都附帶可讀的理由', () => {
    const r = score(input({ changedPaths: ['src/auth/x.ts'] }))
    expect(r.businessCriticality.reason).toBeTruthy()
    expect(r.riskProfile.reason).toContain('硬性規則')
    expect(r.complexity.reason).toBeTruthy()
  })
})
