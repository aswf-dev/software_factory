import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  buildVariantData,
  main,
  parseArgs,
  renderCompareMarkdown,
  type CompareSummary,
} from './factory-compare.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'factory-compare-test-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeJson(filename: string, data: unknown): string {
  const p = join(tmpDir, filename)
  writeFileSync(p, JSON.stringify(data), 'utf8')
  return p
}

describe('parseArgs', () => {
  it('正確解析必填與選填參數', () => {
    const args = parseArgs([
      '--issue-number',
      '42',
      '--branch-a',
      'factory/42-a-01-test',
      '--branch-b',
      'factory/42-b-01-test',
      '--provider-a',
      'qwen',
      '--model-a',
      'qwen3.8-flash',
      '--provider-b',
      'anthropic',
      '--model-b',
      'claude-sonnet-5-5',
      '--format',
      'markdown',
    ])
    expect(args.issueNumber).toBe(42)
    expect(args.branchA).toBe('factory/42-a-01-test')
    expect(args.branchB).toBe('factory/42-b-01-test')
    expect(args.providerA).toBe('qwen')
    expect(args.modelA).toBe('qwen3.8-flash')
    expect(args.providerB).toBe('anthropic')
    expect(args.modelB).toBe('claude-sonnet-5-5')
    expect(args.format).toBe('markdown')
  })

  it('缺少 --issue-number 拋出 CliError', () => {
    expect(() => parseArgs([])).toThrow(/缺少必填參數 --issue-number/)
  })

  it('非法 --issue-number 拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number', 'invalid'])).toThrow(/--issue-number 必須為正整數/)
    expect(() => parseArgs(['--issue-number', '-5'])).toThrow(/--issue-number 必須為正整數/)
  })

  it('非法 --format 拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number', '42', '--format', 'yaml'])).toThrow(/--format 必須是 markdown\|json/)
  })

  it('未知參數拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number', '42', '--unknown'])).toThrow(/unknown argument/)
  })

  it('解析 report/judge/usage/pr-url/out 路徑參數', () => {
    const args = parseArgs([
      '--issue-number',
      '7',
      '--report-a',
      'ra.json',
      '--report-b',
      'rb.json',
      '--judge-a',
      'ja.json',
      '--judge-b',
      'jb.json',
      '--usage-a',
      'ua.json',
      '--usage-b',
      'ub.json',
      '--pr-url-a',
      'https://example.test/pull/1',
      '--pr-url-b',
      'https://example.test/pull/2',
      '--out',
      'out.md',
      '--format',
      'json',
    ])
    expect(args).toMatchObject({
      issueNumber: 7,
      reportAPath: 'ra.json',
      reportBPath: 'rb.json',
      judgeAPath: 'ja.json',
      judgeBPath: 'jb.json',
      usageAPath: 'ua.json',
      usageBPath: 'ub.json',
      prUrlA: 'https://example.test/pull/1',
      prUrlB: 'https://example.test/pull/2',
      outPath: 'out.md',
      format: 'json',
    })
  })

  it('旗標缺值（結尾或緊接另一旗標）拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number'])).toThrow(CliError)
    expect(() => parseArgs(['--issue-number', '42', '--report-a', '--judge-a', 'x'])).toThrow(
      /--report-a requires a value/,
    )
  })
})

describe('buildVariantData — 缺漏與異常輸入', () => {
  it('檔案不存在或非合法 JSON 時忽略該來源', () => {
    const badJson = join(tmpDir, 'bad.json')
    writeFileSync(badJson, '{not json', 'utf8')
    const v = buildVariantData({
      variant: 'a',
      reportPath: join(tmpDir, 'missing.json'),
      judgePath: badJson,
    })
    expect(v).toEqual({
      variant: 'a',
      provider: undefined,
      model: undefined,
      branch: undefined,
      prUrl: undefined,
      outcome: undefined,
      tokensUsed: undefined,
      costUsd: undefined,
      score: undefined,
    })
  })

  it('欄位型別不符時不採用；routes 為空陣列時不推斷 provider/model', () => {
    const reportPath = writeJson('report-bad.json', { tokensUsed: '100', invocation: { provider: 1 } })
    const judgePath = writeJson('judge-bad.json', { result: { outcome: 3, score: '6' } })
    const usagePath = writeJson('usage-empty-routes.json', { totals: {}, routes: [] })
    const v = buildVariantData({ variant: 'b', reportPath, judgePath, usagePath })
    expect(v.tokensUsed).toBeUndefined()
    expect(v.provider).toBeUndefined()
    expect(v.model).toBeUndefined()
    expect(v.outcome).toBeUndefined()
    expect(v.score).toBeUndefined()
    expect(v.costUsd).toBeUndefined()
  })

  it('usage.routes[0] 在未指定 provider/model 時作為推斷來源；明示值優先', () => {
    const usagePath = writeJson('usage-routes.json', {
      totals: { totalTokens: 10, costUsd: 0.001 },
      routes: [{ provider: 'deepseek', model: 'deepseek-flash' }],
    })
    const inferred = buildVariantData({ variant: 'a', usagePath })
    expect(inferred.provider).toBe('deepseek')
    expect(inferred.model).toBe('deepseek-flash')

    const explicit = buildVariantData({ variant: 'a', usagePath, provider: 'qwen', model: 'qwen3.8-flash' })
    expect(explicit.provider).toBe('qwen')
    expect(explicit.model).toBe('qwen3.8-flash')

    const nonStringRoute = writeJson('usage-route-types.json', { routes: [{ provider: 1, model: null }] })
    const v = buildVariantData({ variant: 'a', usagePath: nonStringRoute })
    expect(v.provider).toBeUndefined()
    expect(v.model).toBeUndefined()
  })

  it('report.invocation.provider 不覆寫明示的 provider', () => {
    const reportPath = writeJson('report-provider.json', { invocation: { provider: 'qwen' } })
    const v = buildVariantData({ variant: 'a', reportPath, provider: 'anthropic' })
    expect(v.provider).toBe('anthropic')
  })
})

describe('renderCompareMarkdown — 各欄位格式化分支', () => {
  function render(a: Partial<CompareSummary['variantA']>, b: Partial<CompareSummary['variantB']>): string {
    return renderCompareMarkdown({
      issueNumber: 9,
      variantA: { variant: 'a', ...a },
      variantB: { variant: 'b', ...b },
    })
  }

  it('模型：僅有 model 時只顯示 model；兩者皆無顯示「未知」', () => {
    const md = render({ model: 'only-model' }, { provider: 'only-provider' })
    expect(md).toContain('| **模型** | `only-model` | 未知 |')
  })

  it('PR：僅有 prUrl、僅有 branch、皆無', () => {
    const md = render({ prUrl: 'https://example.test/pull/3' }, { branch: 'factory/9-b-01-test' })
    expect(md).toContain('| **Pull Request** | [PR 連結](https://example.test/pull/3) | `factory/9-b-01-test`（未發 PR） |')
    expect(render({}, {})).toContain('| **Pull Request** | 未產生 PR | 未產生 PR |')
  })

  it('執行狀態：ready-for-review／blocked-in-loop／其他／缺值', () => {
    expect(render({ outcome: 'ready-for-review' }, { outcome: 'blocked-in-loop' })).toContain(
      '| **執行狀態** | ✅ ready-for-review | ⚠️ blocked-in-loop |',
    )
    expect(render({ outcome: 'needs-human' }, {})).toContain('| **執行狀態** | ❌ needs-human | - |')
  })

  it('評分／成本／Token 缺值時顯示 -', () => {
    const md = render({}, {})
    expect(md).toContain('| **品質評分** | - | - |')
    expect(md).toContain('| **推論成本** | - | - |')
    expect(md).toContain('| **Token 用量** | - | - |')
  })
})

describe('buildVariantData & renderCompareMarkdown', () => {
  it('從 report/judge/usage 檔案載入變體資料並生成 Markdown 比對表', () => {
    const reportPath = writeJson('report-a.json', {
      invocation: { provider: 'qwen' },
      tokensUsed: 120000,
    })
    const judgePath = writeJson('judge-a.json', {
      result: { outcome: 'ready-to-automerge', score: 6 },
    })
    const usagePath = writeJson('usage-a.json', {
      totals: { totalTokens: 120000, costUsd: 0.045 },
      routes: [{ provider: 'qwen', model: 'qwen3.8-flash' }],
    })

    const variantA = buildVariantData({
      variant: 'a',
      reportPath,
      judgePath,
      usagePath,
      branch: 'factory/42-a-01-test',
      prUrl: 'https://github.com/aswf-dev/software_factory/pull/101',
    })

    expect(variantA.provider).toBe('qwen')
    expect(variantA.model).toBe('qwen3.8-flash')
    expect(variantA.outcome).toBe('ready-to-automerge')
    expect(variantA.costUsd).toBe(0.045)
    expect(variantA.tokensUsed).toBe(120000)
    expect(variantA.score).toBe(6)

    const variantB = buildVariantData({
      variant: 'b',
      branch: 'factory/42-b-01-test',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    })

    const summary: CompareSummary = {
      issueNumber: 42,
      variantA,
      variantB,
    }

    const md = renderCompareMarkdown(summary)
    expect(md).toContain('## ⚔️ 雙模型競賽比對報告 (Issue #42)')
    expect(md).toContain('`qwen/qwen3.8-flash`')
    expect(md).toContain('`anthropic/claude-sonnet-5-5`')
    expect(md).toContain('[factory/42-a-01-test](https://github.com/aswf-dev/software_factory/pull/101)')
    expect(md).toContain('$0.0450')
  })
})

describe('main', () => {
  it('main 生成 markdown 輸出並可寫入 --out 檔案', () => {
    const outPath = join(tmpDir, 'compare.md')
    const res = main([
      '--issue-number',
      '42',
      '--provider-a',
      'qwen',
      '--model-a',
      'qwen3.8-flash',
      '--provider-b',
      'anthropic',
      '--model-b',
      'claude-sonnet-5-5',
      '--out',
      outPath,
    ])

    expect(typeof res).toBe('string')
    expect(res).toContain('Issue #42')
    expect(res).toContain('qwen3.8-flash')
    expect(res).toContain('claude-sonnet-5-5')
  })

  it('main 未指定 --out 時只回傳 markdown', () => {
    const res = main(['--issue-number', '5'])
    expect(typeof res).toBe('string')
    expect(res).toContain('Issue #5')
  })

  it('main --format json 搭配 --out 寫出 JSON 檔', () => {
    const outPath = join(tmpDir, 'compare.json')
    const res = main(['--issue-number', '6', '--format', 'json', '--out', outPath])
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(res)))
  })

  it('main --format json 輸出結構化資料', () => {
    const res = main([
      '--issue-number',
      '42',
      '--format',
      'json',
      '--provider-a',
      'qwen',
      '--model-a',
      'qwen3.8-flash',
    ])

    expect(typeof res).toBe('object')
    if (typeof res === 'object') {
      expect(res.issueNumber).toBe(42)
      expect(res.variantA.provider).toBe('qwen')
      expect(res.variantA.model).toBe('qwen3.8-flash')
    }
  })
})
