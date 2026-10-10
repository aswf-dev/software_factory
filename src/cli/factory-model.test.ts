/**
 * factory-model CLI 測試（選模 CLI，docs/ADR/011）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import { main, parseArgs } from './factory-model.js'
import type { ModelResolution } from '../model-tier/resolve.js'

let tmp: string

function runMain(argv: string[]): ModelResolution {
  const r = main(argv)
  if (Array.isArray(r)) {
    throw new Error('Expected ModelResolution, got MatrixItem[]')
  }
  return r
}

function fixture(name: string, content: string): string {
  const p = join(tmp, name)
  writeFileSync(p, content)
  return p
}

function tiersYaml(): string {
  return [
    // 合成 fixture：各 tier 刻意用不同 model id，讓「選錯 tier」必然被斷言抓到
    // （真實政策見 config/dsh/model-tiers.yaml，由對抗性測試釘住）。
    'tiers:',
    '  low:',
    '    primary: { provider: deepseek, model: tier-low-model }',
    '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
    '  medium:',
    '    primary: { provider: deepseek, model: tier-medium-model }',
    '    fallback: [{ provider: qwen, model: qwen3.7-flash }]',
    '  high:',
    '    primary: { provider: deepseek, model: deepseek-flash }',
    '    fallback: [{ provider: anthropic, model: claude-sonnet-5-5 }, { provider: qwen, model: qwen3.7-flash }]',
    '  critical:',
    '    primary: { provider: anthropic, model: claude-opus-5 }',
    '    fallback: [{ provider: deepseek, model: deepseek-flash }]',
    '',
  ].join('\n')
}

function providersYaml(): string {
  return [
    'llm-pi-ai:',
    '  providers:',
    '    anthropic:',
    '      apiKeyEnv: ANTHROPIC_API_KEY',
    '    deepseek:',
    '      apiKeyEnv: DEEPSEEK_API_KEY',
    '    qwen:',
    '      apiKeyEnv: QWEN_API_KEY',
    '',
  ].join('\n')
}

function issueJson(requirement: string): string {
  return JSON.stringify({
    body: [
      '### 任務類型',
      '',
      'agent-fix-bug',
      '',
      '### 需求描述（PRD）',
      '',
      requirement,
      '',
      '### 驗收標準（DoD）',
      '',
      '- [x] 有可驗證的測試/驗證方式',
      '',
    ].join('\n'),
  })
}

function scoreJson(complexity: string, total: number): string {
  return JSON.stringify({
    annotations: { complexity },
    stack: {},
    score: { complexity: { value: 0 }, total, tier: 'review' },
  })
}

let tiersPath: string
let providersPath: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-model-'))
  tiersPath = fixture('tiers.yaml', tiersYaml())
  providersPath = fixture('providers.yaml', providersYaml())
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('預設值：tier=auto、provider=auto、路徑走預設', () => {
    const p = parseArgs([])
    expect(p.tier).toBe('auto')
    expect(p.provider).toBe('auto')
    expect(p.tiersPath).toBe('config/dsh/model-tiers.yaml')
  })
  it('旗標解析', () => {
    const p = parseArgs([
      '--issue',
      'a.json',
      '--score',
      's.json',
      '--tiers',
      't.yaml',
      '--providers',
      'p.yaml',
      '--tier',
      'critical',
      '--provider',
      'anthropic',
    ])
    expect(p).toMatchObject({
      issuePath: 'a.json',
      scorePath: 's.json',
      tiersPath: 't.yaml',
      providersPath: 'p.yaml',
      tier: 'critical',
      provider: 'anthropic',
    })
  })
  it('非法 --tier → CliError', () => {
    expect(() => parseArgs(['--tier', 'ultra'])).toThrow(CliError)
  })
  it('缺旗標值 → CliError', () => {
    expect(() => parseArgs(['--tiers'])).toThrow(CliError)
  })
  it('未知參數 → CliError', () => {
    expect(() => parseArgs(['--nope'])).toThrow(CliError)
  })
})

describe('main — 自動解析', () => {
  it('Issue 分析 low → low tier（取 low 的 primary，不得誤取其他 tier）', () => {
    const issue = fixture('low.json', issueJson('為單一工具函式補測試'))
    const r = runMain(['--issue', issue, '--tiers', tiersPath, '--providers', providersPath])
    expect(r.tier).toBe('low')
    expect(r.complexitySource).toBe('issue-analysis')
    expect(r.selected.model).toBe('tier-low-model')
    expect(r.chain[0]).toEqual({ provider: 'deepseek', model: 'tier-low-model' })
  })

  it('Issue 分析 high + score total=4 → critical（claude-opus-5）', () => {
    const issue = fixture('high.json', issueJson('跨服務架構變更，含授權邏輯'))
    const score = fixture('score4.json', scoreJson('high', 4))
    const r = runMain([
      '--issue',
      issue,
      '--score',
      score,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(r.tier).toBe('critical')
    expect(r.selected.model).toBe('claude-opus-5')
    expect(r.chain.map((e) => e.model)).toEqual(['claude-opus-5', 'deepseek-flash'])
  })

  it('無 --issue → catalog fallback（medium → medium tier）', () => {
    const score = fixture('score-m.json', scoreJson('medium', 3))
    const r = runMain(['--score', score, '--tiers', tiersPath, '--providers', providersPath])
    expect(r.tier).toBe('medium')
    expect(r.complexitySource).toBe('catalog')
  })

  it('無 --issue 且 catalog 未標註 → fail-safe high', () => {
    const score = fixture('score-none.json', scoreJson('', 0))
    const r = runMain(['--score', score, '--tiers', tiersPath, '--providers', providersPath])
    expect(r.tier).toBe('high')
    expect(r.complexitySource).toBe('fail-safe')
  })

  it('score json 缺 total → 不觸發 critical（scoreTotal undefined）', () => {
    const issue = fixture('high-nototal.json', issueJson('跨服務架構變更'))
    const score = fixture('score-nototal.json', JSON.stringify({ annotations: {}, score: {} }))
    const r = runMain([
      '--issue',
      issue,
      '--score',
      score,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(r.tier).toBe('high')
    expect(r.selected.model).toBe('deepseek-flash')
  })
})

describe('main — 手動覆寫與偏好 provider', () => {
  it('--tier critical → 覆寫分析結果', () => {
    const issue = fixture('low2.json', issueJson('為單一工具函式補測試'))
    const r = runMain([
      '--issue',
      issue,
      '--tier',
      'critical',
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(r.tier).toBe('critical')
    expect(r.complexitySource).toBe('manual')
    expect(r.selected.model).toBe('claude-opus-5')
  })

  it('--provider anthropic → chain 內 anthropic 置前', () => {
    const issue = fixture('high2.json', issueJson('跨服務架構變更'))
    const r = runMain([
      '--issue',
      issue,
      '--provider',
      'anthropic',
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(r.chain[0]?.provider).toBe('anthropic')
    // high tier 的 anthropic 項：claude-sonnet-5-5
    expect(r.chain[0]?.model).toBe('claude-sonnet-5-5')
  })

  it('--provider 未知 → CliError（fail-loud）', () => {
    const issue = fixture('high3.json', issueJson('跨服務架構變更'))
    expect(() =>
      main(['--issue', issue, '--provider', 'openai', '--tiers', tiersPath, '--providers', providersPath]),
    ).toThrow(CliError)
  })
})

describe('main — 輸入錯誤 fail-loud', () => {
  it('issue json 不存在 → CliError', () => {
    expect(() => main(['--issue', 'nope.json', '--tiers', tiersPath, '--providers', providersPath])).toThrow(
      CliError,
    )
  })
  it('issue json 不是合法 JSON → CliError（絕不靜默）', () => {
    const issue = fixture('badjson.json', 'not json at all')
    expect(() => main(['--issue', issue, '--tiers', tiersPath, '--providers', providersPath])).toThrow(
      CliError,
    )
  })
  it('issue json 缺 body → CliError', () => {
    const issue = fixture('nobody.json', JSON.stringify({ title: 'x' }))
    expect(() => main(['--issue', issue, '--tiers', tiersPath, '--providers', providersPath])).toThrow(
      CliError,
    )
  })
  it('model-tiers 設定損壞 → CliError（絕不靜默）', () => {
    const bad = fixture('bad-tiers.yaml', 'tiers: 42')
    const issue = fixture('low3.json', issueJson('為單一工具函式補測試'))
    expect(() => main(['--issue', issue, '--tiers', bad, '--providers', providersPath])).toThrow(CliError)
  })
})

/**
 * ADR-018：write-spec 兩個階段的計算強度由階段決定，而不是由 Issue 文字的關鍵字。
 * Issue 內文幾乎必然提到 Quint／形式化，若照字面判定，便宜的不變量階段也會被
 * 升到 critical；反之模型階段一定要跑模型檢查，必須拿到 heavy-verify 的預算。
 */
describe('main — write-spec 階段（--spec-phase）', () => {
  const heavyText = '以 quint 建立可執行規格並用 apalache 模型檢查不變量'
  it('不變量階段：即使文字命中 heavy-verify 也不升 critical', () => {
    const issue = fixture('spec-inv.json', issueJson(heavyText))
    const r = runMain(['--issue', issue, '--tiers', tiersPath, '--providers', providersPath, '--spec-phase', 'invariants'])
    expect(r.tier).not.toBe('critical')
    expect(r.escalation).toBeUndefined()
  })
  it('模型階段：文字沒命中也強制 heavy-verify → critical', () => {
    const issue = fixture('spec-model.json', issueJson('為單一工具函式補測試'))
    const r = runMain(['--issue', issue, '--tiers', tiersPath, '--providers', providersPath, '--spec-phase', 'model'])
    expect(r.tier).toBe('critical')
    expect(r.escalation).toBe('heavy-verify')
  })
  it('--spec-phase 值不合法、或沒有 --issue → CliError', () => {
    expect(() => parseArgs(['--spec-phase', 'draft'])).toThrow(CliError)
    expect(() => main(['--tiers', tiersPath, '--providers', providersPath, '--spec-phase', 'model'])).toThrow(
      /--issue/,
    )
  })
})

describe('main — 輸出格式（--format matrix）', () => {
  it('--format matrix 輸出雙模型矩陣項目清單', () => {
    const issue = fixture('issue-matrix.json', issueJson('單一工具函式補測試'))
    const r = main([
      '--issue',
      issue,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
      '--tier',
      'high',
      '--format',
      'matrix',
    ])
    expect(Array.isArray(r)).toBe(true)
    if (Array.isArray(r)) {
      expect(r.length).toBe(2)
      expect(r[0]).toMatchObject({ variant: 'a' })
      expect(r[1]).toMatchObject({ variant: 'b' })
    }
  })

  it('--format 收到非法格式 → CliError', () => {
    expect(() => parseArgs(['--format', 'yaml'])).toThrow(/--format 必須是 json\|matrix/)
  })
})

