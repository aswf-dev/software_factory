/**
 * Model tier 解析核心測試（src/model-tier/resolve.ts，docs/ADR/011）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from '../cli/run-cli.js'
import {
  buildChain,
  CRITICAL_MIN_TOTAL,
  loadDeclaredProviders,
  loadTiers,
  resolveModelTier,
  type TierPolicies,
} from './resolve.js'

/**
 * 測試用 tier 政策（provider 皆假設已宣告）。
 * 各 tier 刻意用不同 model id：選錯 tier 必然被斷言抓到（真實政策見
 * config/dsh/model-tiers.yaml，由對抗性測試釘住）。
 */
const TIERS: TierPolicies = {
  low: {
    primary: { provider: 'deepseek', model: 'tier-low-model' },
    fallback: [{ provider: 'qwen', model: 'qwen3.7-flash' }],
  },
  medium: {
    primary: { provider: 'deepseek', model: 'tier-medium-model' },
    fallback: [{ provider: 'qwen', model: 'qwen3.7-flash' }],
  },
  high: {
    primary: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    fallback: [
      { provider: 'anthropic', model: 'claude-sonnet-5' },
      { provider: 'qwen', model: 'qwen3.7-flash' },
    ],
  },
  critical: {
    primary: { provider: 'anthropic', model: 'claude-opus-5' },
    fallback: [{ provider: 'deepseek', model: 'deepseek-v4.1-flash' }],
  },
}

const PROVIDERS = ['deepseek', 'qwen', 'anthropic']

describe('resolveModelTier — 自動路徑解析順序', () => {
  it('Issue 分析優先於 catalog（analysis low → low tier）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'low', score: 0, evidence: ['scope 低'] },
      catalogComplexity: 'high',
    })
    expect(r.tier).toBe('low')
    expect(r.complexitySource).toBe('issue-analysis')
    expect(r.selected.model).toBe('tier-low-model')
  })

  it('無分析 → catalog 複雜度（medium → medium tier）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      catalogComplexity: 'medium',
    })
    expect(r.tier).toBe('medium')
    expect(r.complexitySource).toBe('catalog')
  })

  it('無分析且 catalog 未標註 → fail-safe high（deepseek-v4.1-flash，不誤燒旗艦成本）', () => {
    const r = resolveModelTier({ tiers: TIERS, declaredProviders: PROVIDERS })
    expect(r.tier).toBe('high')
    expect(r.complexitySource).toBe('fail-safe')
    expect(r.selected.model).toBe('deepseek-v4.1-flash')
  })

  it('無分析且 catalog 非法值 → fail-safe high', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      catalogComplexity: 'super-high',
    })
    expect(r.tier).toBe('high')
    expect(r.complexitySource).toBe('fail-safe')
  })

  it('reason 含判據（給人看）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高：跨服務'] },
    })
    expect(r.reason).toContain('Issue 需求分析')
    expect(r.reason).toContain('跨服務')
  })
})

describe('resolveModelTier — critical 升級條件', () => {
  it('分析 high 且 total=4 → critical（claude-opus-5）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      scoreTotal: CRITICAL_MIN_TOTAL,
    })
    expect(r.tier).toBe('critical')
    expect(r.selected.model).toBe('claude-opus-5')
    expect(r.reason).toContain('critical')
  })

  it('分析 high 且 total=3 → high（不升級，不誤燒旗艦成本）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      scoreTotal: 3,
    })
    expect(r.tier).toBe('high')
    expect(r.selected.model).toBe('deepseek-v4.1-flash')
  })

  it('無 scoreTotal（檢查留言路徑）→ 不觸發 critical', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
    })
    expect(r.tier).toBe('high')
  })
})

describe('resolveModelTier — 手動覆寫', () => {
  it('manualTier=critical → 直接 critical，不因 total 低而降級', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      manualTier: 'critical',
      scoreTotal: 0,
    })
    expect(r.tier).toBe('critical')
    expect(r.complexitySource).toBe('manual')
    expect(r.selected.model).toBe('claude-opus-5')
  })

  it('manualTier=low → low（即使分析 high）', () => {
    const r = resolveModelTier({
      tiers: TIERS,
      declaredProviders: PROVIDERS,
      manualTier: 'low',
      analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
    })
    expect(r.tier).toBe('low')
  })

  it('manualTier 未宣告於政策 → CliError', () => {
    const tiers: TierPolicies = { ...TIERS, critical: undefined }
    expect(() =>
      resolveModelTier({ tiers, declaredProviders: PROVIDERS, manualTier: 'critical' }),
    ).toThrow(CliError)
  })
})

describe('buildChain — 偏好 provider 過濾', () => {
  it('auto → 原順序', () => {
    const chain = buildChain(TIERS.high, undefined, PROVIDERS)
    expect(chain.map((e) => e.provider)).toEqual(['deepseek', 'anthropic', 'qwen'])
  })

  it('偏好 provider → 置前，其餘依序', () => {
    const chain = buildChain(TIERS.high, 'anthropic', PROVIDERS)
    expect(chain.map((e) => e.provider)).toEqual(['anthropic', 'deepseek', 'qwen'])
    expect(chain.map((e) => e.model)).toEqual(['claude-sonnet-5', 'deepseek-v4.1-flash', 'qwen3.7-flash'])
  })

  it('重複項目去重（保留第一個）', () => {
    const policy = {
      primary: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      fallback: [{ provider: 'deepseek', model: 'deepseek-v4.1-flash' }],
    }
    const chain = buildChain(policy, undefined, PROVIDERS)
    expect(chain).toHaveLength(1)
  })

  it('未知偏好 provider → CliError（fail-loud）', () => {
    expect(() => buildChain(TIERS.high, 'openai', PROVIDERS)).toThrow(CliError)
  })
})

describe('loadTiers / loadDeclaredProviders（檔案載入）', () => {
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'resolve-'))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function fixture(name: string, ...lines: string[]): string {
    const p = join(tmp, name)
    writeFileSync(p, `${lines.join('\n')}\n`)
    return p
  }

  it('settings.providers.yaml → 回傳已宣告 route 清單', () => {
    const p = fixture(
      'providers.yml',
      'llm-pi-ai:',
      '  providers:',
      '    anthropic:',
      '      apiKeyEnv: ANTHROPIC_API_KEY',
      '    deepseek:',
      '      apiKeyEnv: DEEPSEEK_API_KEY',
    )
    expect(loadDeclaredProviders(p)).toEqual(['anthropic', 'deepseek'])
  })

  it('providers 設定格式錯誤 → CliError', () => {
    const p = fixture('bad-providers.yml', 'llm-pi-ai:', '  providers: 42')
    expect(() => loadDeclaredProviders(p)).toThrow(CliError)
  })

  it('model-tiers 合法 → 載入成功', () => {
    const p = fixture(
      'tiers.yml',
      'tiers:',
      '  low:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  medium:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  high:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: anthropic, model: claude-sonnet-5 }]',
    )
    const tiers = loadTiers(p, ['deepseek', 'qwen', 'anthropic'])
    expect(tiers.low.primary.model).toBe('deepseek-v4.1-flash')
    expect(tiers.high.primary.model).toBe('deepseek-v4.1-flash')
  })

  it('缺 low/medium/high → CliError（auto 路徑必需）', () => {
    const p = fixture('missing-tiers.yml', 'tiers:', '  low:')
    expect(() => loadTiers(p, ['deepseek'])).toThrow(CliError)
  })

  it('chain 引用未宣告 provider → CliError（fail-loud）', () => {
    const p = fixture(
      'undeclared.yml',
      'tiers:',
      '  low:',
      '    primary: { provider: openai, model: gpt-5 }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  medium:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  high:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: anthropic, model: claude-sonnet-5 }]',
    )
    expect(() => loadTiers(p, ['deepseek', 'qwen', 'anthropic'])).toThrow(CliError)
  })

  it('chain 缺 model → CliError', () => {
    const p = fixture(
      'no-model.yml',
      'tiers:',
      '  low:',
      '    primary: { provider: deepseek }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  medium:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  high:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: anthropic, model: claude-sonnet-5 }]',
    )
    expect(() => loadTiers(p, ['deepseek', 'qwen', 'anthropic'])).toThrow(CliError)
  })

  it('fallback 為空陣列 → CliError（每個 tier 必須可 fallback）', () => {
    const p = fixture(
      'empty-fallback.yml',
      'tiers:',
      '  low:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: []',
      '  medium:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
      '  high:',
      '    primary: { provider: deepseek, model: deepseek-v4.1-flash }',
      '    fallback: [{ provider: anthropic, model: claude-sonnet-5 }]',
    )
    expect(() => loadTiers(p, ['deepseek', 'qwen', 'anthropic'])).toThrow(CliError)
  })

  it('空檔/純註解 → 視為空文件 → TiersSchema 失敗（CliError）', () => {
    const p = fixture('empty.yml', '# 只有註解')
    expect(() => loadTiers(p, ['deepseek'])).toThrow(CliError)
  })

  it('只有文件分隔線（js-yaml 回 undefined）→ 視為空文件', () => {
    const p = fixture('sep.yml', '---')
    expect(() => loadTiers(p, ['deepseek'])).toThrow(CliError)
  })

  it('不是合法 YAML → CliError', () => {
    const p = fixture('bad-yaml.yml', 'tiers: [unclosed')
    expect(() => loadTiers(p, ['deepseek'])).toThrow(CliError)
  })

  it('空檔 → loadDeclaredProviders 也 CliError（providers dict 缺失）', () => {
    const p = fixture('empty-providers.yml', '# 註解')
    expect(() => loadDeclaredProviders(p)).toThrow(CliError)
  })
})

describe('resolveModelTier — auto 路徑缺 tier 政策', () => {
  it('分析 high 但政策缺 high → CliError（絕不靜默降級）', () => {
    const tiers = { low: TIERS.low, medium: TIERS.medium } as unknown as TierPolicies
    expect(() =>
      resolveModelTier({
        tiers,
        declaredProviders: PROVIDERS,
        analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
      }),
    ).toThrow(CliError)
  })

  it('critical 升級目標缺政策 → CliError', () => {
    const tiers: TierPolicies = { ...TIERS, critical: undefined }
    expect(() =>
      resolveModelTier({
        tiers,
        declaredProviders: PROVIDERS,
        analysis: { complexity: 'high', score: 2, evidence: ['scope 高'] },
        scoreTotal: 4,
      }),
    ).toThrow(CliError)
  })
})
