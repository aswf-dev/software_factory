import { describe, expect, it } from 'vitest'
import { buildChain, resolveModelTier, CRITICAL_MIN_TOTAL, type TierPolicies } from '../model-tier/resolve.js'

const TIERS: TierPolicies = {
  low: {
    primary: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    fallback: [{ provider: 'qwen', model: 'qwen3.7-flash' }],
  },
  medium: {
    primary: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    fallback: [{ provider: 'qwen', model: 'qwen3.7-flash' }],
  },
  high: {
    primary: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
  },
  critical: {
    primary: { provider: 'anthropic', model: 'claude-opus-5' },
    fallback: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
  },
}

const PROVIDERS = ['deepseek', 'qwen', 'anthropic']

/**
 * Mutation-strength tests for `resolveModelTier`（docs/ADR/011 的解析順序契約）。
 *
 * 解析順序是模型路由的安全核心：順序被搞錯會導致「檢查留言與實際路由不一致」、
 * 「該用最強模型時誤用最便宜」或「誤燒 fable 旗艦成本」。行覆蓋測不出順序——
 * 必須以「故意顛倒/放寬」的變異來釘住。
 *
 * Mutation log（以手工編輯 src/model-tier/resolve.ts 套用變異、重跑本檔變紅、
 * 再還原變綠的方式驗證）：
 *
 *  | ID | Mutation（破壞解析契約）                                  | Before | After |
 *  |----|------------------------------------------------------------|--------|-------|
 *  | M1 | analysis 優先改為 catalog 優先（兩者並存時選錯來源）        | GREEN  | RED   |
 *  | M2 | critical 門檻 `>=` 誤放寬成 `>`（total=4 不再升級）         | GREEN  | RED   |
 *  | M3 | fail-safe 預設改為 low（未宣告 → 最便宜而非最強）           | GREEN  | RED   |
 *  | M4 | 偏好 provider 從「置前」誤改成「置後」                       | GREEN  | RED   |
 *  | M5 | critical 升級整個移除（複雜度 high 永不觸發 opus-5）          | GREEN  | RED   |
 *  | M6 | manual tier 誤把 'auto' 當作實際 tier 使用                   | GREEN  | RED   |
 */

describe('M1 變異：解析順序被顛倒（catalog 優先於 Issue 分析）', () => {
  /**
   * Issue 分析與 catalog 同時存在時必須以 Issue 為準（ADR-011 D3：手動 > 分析 >
   * catalog > fail-safe）。若有人把分支顛倒成「catalog 優先」，同一份 Issue 的
   * 留言建議與實際路由會打架，且 catalog 未標註時分析被默默忽略。
   */
  it('分析 low + catalog high → 必須取 low（Issue 為準）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'low', score: 0, evidence: ['scope 低'] },
      catalogComplexity: 'high',
    })
    expect(r.tier).toBe('low')
  })

  it('分析 high + catalog low → 必須取 high（不因 catalog 降級）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      catalogComplexity: 'low',
    })
    expect(r.tier).toBe('high')
  })
})

describe('M2 變異：critical 門檻放寬（total=4 不升級）', () => {
  /** 門檻是 `>= 4`；改成 `> 4` 會讓 total=4（review 上緣）漏掉 opus-5 升級。 */
  it(`total = ${CRITICAL_MIN_TOTAL} → critical`, () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      scoreTotal: CRITICAL_MIN_TOTAL,
    })
    expect(r.tier).toBe('critical')
  })

  it('total = 3 → high（不誤燒旗艦成本）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      scoreTotal: 3,
    })
    expect(r.tier).toBe('high')
  })
})

describe('M3 變異：fail-safe 預設被放寬成 low', () => {
  /** 未宣告 → 必須最強適用（high/deepseek-v4-pro），不可知 ⇒ 不降級（docs/06 同方向）。 */
  it('無分析、無 catalog → high', () => {
    const r = resolveModelTier({ tiers: TIERS, declaredProviders: PROVIDERS })
    expect(r.tier).toBe('high')
    expect(r.selected.model).toBe('deepseek-v4-pro')
  })
})

describe('M4 變異：偏好 provider 被誤改成置後', () => {
  /** 偏好 provider 必須置前（chain 由 primary 開始嘗試）。 */
  it('偏好 anthropic → anthropic 在 chain[0]', () => {
    const chain = buildChain(TIERS.high, 'anthropic', PROVIDERS)
    expect(chain[0]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
  })
  it('偏好 deepseek → deepseek 在 chain[0]（維持 tier 的 primary 優先）', () => {
    const chain = buildChain(TIERS.high, 'deepseek', PROVIDERS)
    expect(chain[0]).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  })
})

describe('M5 變異：critical 升級被移除', () => {
  /** 複雜度 high + 總分上緣必須能觸發 critical（最高 tier 用 opus-5，fable-5 已移除）。 */
  it('high + total=4 → claude-opus-5 出現在 chain[0]', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      scoreTotal: 4,
    })
    expect(r.selected.model).toBe('claude-opus-5')
    expect(r.chain[0]?.model).toBe('claude-opus-5')
  })
})

describe('M6 變異：manual tier 誤把 auto 當作實際 tier', () => {
  /** 'auto' 是「自動解析」的哨兵，不是 tier id；被當成實際 tier 會選到不存在的政策。 */
  it('manualTier=auto → 走自動路徑（不拋缺 tier）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      manualTier: 'auto',
      analysis: { complexity: 'medium', score: 1, evidence: ['scope 中'] },
    })
    expect(r.tier).toBe('medium')
    expect(r.complexitySource).toBe('issue-analysis')
  })
  it('manualTier=low 的 selected 是 chain[0]（primary）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      manualTier: 'low',
    })
    expect(r.selected).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  })
})
