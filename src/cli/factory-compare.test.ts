/**
 * factory-compare 單元測試（src/cli/** 100% branch 閘門）。
 *
 * 回歸 fubon-tradingbot#713（comment 6100016796）：比對卡片全部顯示「未知」「-」「未產生 PR」，
 * 三個根因各有一組測試釘住——usage.json 的 `{usage, markdown}` 包裝、judge.json 的真實形狀
 * （result.outcome／finalScore，沒有 score）、PR 以前綴而非精確分支名查找。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  buildVariantData,
  main,
  parseArgs,
  pickPr,
  renderCompareMarkdown,
  type CompareSummary,
  type VariantData,
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

/** 真實 usage.json 形狀：runCli 包裝成 `{usage, markdown}`（#713 run 38069374576 的 artifact）。 */
function usageFile(name: string, usage: Record<string, unknown>): string {
  return writeJson(name, { usage, markdown: '## 📊 Token 用量' })
}

const QWEN_USAGE = {
  totals: { totalTokens: 2291230, costUsd: 0.03239522, unpricedModels: [], cacheReadUnpriced: true },
  routes: [{ provider: 'qwen', model: 'qwen3.8-flash' }],
}

/** 真實 judge.json 形狀：`{report, result: PipelineResult, advisories}`，沒有 score。 */
function judgeFile(name: string, outcome: string, total: number): string {
  return writeJson(name, {
    report: {},
    result: { outcome, finalScore: { total, label: '需人類審查' } },
    advisories: [],
  })
}

const PR_716 = {
  number: 716,
  url: 'https://github.com/philipz/fubon-tradingbot/pull/716',
  headRefName: 'factory/713-a-01-analysis',
  state: 'OPEN',
  additions: 200,
  deletions: 0,
}

function variant(partial: Partial<VariantData> & { variant: 'a' | 'b' }): VariantData {
  return { routes: [], costUnderstated: [], reusedExisting: false, ...partial }
}

describe('parseArgs', () => {
  it('解析全部參數', () => {
    const args = parseArgs([
      '--issue-number', '713',
      '--report-a', 'ra.json', '--report-b', 'rb.json',
      '--judge-a', 'ja.json', '--judge-b', 'jb.json',
      '--usage-a', 'ua.json', '--usage-b', 'ub.json',
      '--pr-a', 'pa.json', '--pr-b', 'pb.json',
      '--out', 'out.md', '--format', 'json',
    ])
    expect(args).toEqual({
      issueNumber: 713,
      a: { reportPath: 'ra.json', judgePath: 'ja.json', usagePath: 'ua.json', prPath: 'pa.json' },
      b: { reportPath: 'rb.json', judgePath: 'jb.json', usagePath: 'ub.json', prPath: 'pb.json' },
      outPath: 'out.md',
      format: 'json',
    })
  })

  it('預設 markdown、選填參數皆可省略', () => {
    expect(parseArgs(['--issue-number', '1'])).toEqual({ issueNumber: 1, a: {}, b: {}, format: 'markdown' })
  })

  it('缺少 --issue-number → CliError', () => {
    expect(() => parseArgs([])).toThrow(/缺少必填參數 --issue-number/)
  })

  it('非法 --issue-number → CliError', () => {
    expect(() => parseArgs(['--issue-number', 'x'])).toThrow(/--issue-number 必須為正整數/)
    expect(() => parseArgs(['--issue-number', '-5'])).toThrow(CliError)
  })

  it('非法 --format → CliError', () => {
    expect(() => parseArgs(['--issue-number', '1', '--format', 'yaml'])).toThrow(/--format 必須是 markdown\|json/)
  })

  it('旗標缺值（結尾或緊接另一旗標）→ CliError', () => {
    expect(() => parseArgs(['--issue-number'])).toThrow(/--issue-number requires a value/)
    expect(() => parseArgs(['--issue-number', '1', '--pr-a', '--out', 'x'])).toThrow(/--pr-a requires a value/)
  })

  it('未知參數 → CliError（舊的 --pr-url-a 已移除，接線漏改會紅燈）', () => {
    expect(() => parseArgs(['--issue-number', '1', '--pr-url-a', 'u'])).toThrow(/unknown argument: --pr-url-a/)
  })
})

describe('pickPr：以變體前綴挑出本變體的 PR', () => {
  it('只認 factory/<n>-<variant>- 開頭；open 優先於較新的 closed', () => {
    const prs = [
      { ...PR_716, number: 900, headRefName: 'factory/7130-a-01-x' }, // 他張 Issue（search 為模糊比對）
      { ...PR_716, number: 901, headRefName: 'factory/713-b-01-analysis' }, // 另一變體
      { ...PR_716, number: 902, state: 'CLOSED' },
      PR_716,
    ]
    expect(pickPr(prs, 713, 'a')?.number).toBe(716)
  })

  it('沒有 open 時取第一筆符合者', () => {
    expect(pickPr([{ ...PR_716, state: 'MERGED' }], 713, 'a')?.state).toBe('MERGED')
  })

  it('缺 state、缺增刪行數時仍採用（state 視為空字串）', () => {
    expect(pickPr([{ number: 1, url: 'u', headRefName: 'factory/713-a-01-x' }], 713, 'a')).toEqual({
      number: 1,
      url: 'u',
      headRefName: 'factory/713-a-01-x',
      state: '',
      additions: undefined,
      deletions: undefined,
    })
  })

  it('沒有符合者或輸入不是陣列 → undefined；缺欄位的項目略過', () => {
    expect(pickPr([], 713, 'a')).toBeUndefined()
    expect(pickPr({ not: 'array' }, 713, 'a')).toBeUndefined()
    expect(pickPr([null, { headRefName: 1 }, { headRefName: 'factory/713-a-01-x' }], 713, 'a')).toBeUndefined()
  })
})

describe('buildVariantData：讀真實 artifact 形狀', () => {
  it('#713 變體 A：包裝過的 usage、judge 的 outcome／finalScore、前綴查到的 PR、需求涵蓋', () => {
    const v = buildVariantData(713, 'a', {
      usagePath: usageFile('ua.json', QWEN_USAGE),
      judgePath: judgeFile('ja.json', 'ready-for-review', 4),
      prPath: writeJson('pa.json', [PR_716]),
      reportPath: writeJson('ra.json', {
        changedPaths: ['docs/research/713.md'],
        requirements: [
          { id: 'REQ-1', status: 'passed' },
          { id: 'REQ-2', status: 'failed' },
          { id: 'REQ-3', status: 'skipped' },
        ],
      }),
    })
    expect(v).toEqual({
      variant: 'a',
      routes: ['qwen/qwen3.8-flash'],
      outcome: 'ready-for-review',
      riskTotal: 4,
      riskLabel: '需人類審查',
      pr: PR_716,
      costUsd: 0.03239522,
      costUnderstated: ['cache-read 未計價'],
      tokens: 2291230,
      requirements: { passed: 1, failed: 1, skipped: 1 },
      reusedExisting: false,
    })
  })

  it('usage 檔缺席時退回 report.usage；未包裝的 usage 也接受', () => {
    const fromReport = buildVariantData(1, 'b', {
      reportPath: writeJson('r-usage.json', { usage: QWEN_USAGE }),
    })
    expect(fromReport.routes).toEqual(['qwen/qwen3.8-flash'])
    const bare = buildVariantData(1, 'b', { usagePath: writeJson('u-bare.json', QWEN_USAGE) })
    expect(bare.tokens).toBe(2291230)
  })

  it('report.usage 不是物件時忽略；tokens 退回 agent 自報的 tokensUsed', () => {
    const v = buildVariantData(1, 'a', { reportPath: writeJson('r-tok.json', { usage: 'x', tokensUsed: 42 }) })
    expect(v.routes).toEqual([])
    expect(v.tokens).toBe(42)
  })

  it('多個 route（fallback）依序保留並去重；未計價模型列入低估原因', () => {
    const v = buildVariantData(1, 'a', {
      usagePath: usageFile('u-fb.json', {
        totals: { totalTokens: 1, costUsd: 0.1, unpricedModels: ['qwen/qwen3.8-flash'], cacheReadUnpriced: false },
        routes: [
          { provider: 'anthropic', model: 'claude-sonnet-5-5' },
          { provider: 'anthropic', model: 'claude-opus-5-5' },
          { provider: 'anthropic', model: 'claude-opus-5-5' },
          { provider: 1, model: 'x' },
          'not-an-object',
        ],
      }),
    })
    expect(v.routes).toEqual(['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'])
    expect(v.costUnderstated).toEqual(['未計價模型 qwen/qwen3.8-flash'])
  })

  it('report.changedPaths 為空且有 PR → 本次沿用本變體既有 PR', () => {
    const v = buildVariantData(713, 'a', {
      reportPath: writeJson('r-reuse.json', { changedPaths: [] }),
      prPath: writeJson('p-reuse.json', [PR_716]),
    })
    expect(v.reusedExisting).toBe(true)
  })

  it('檔案不存在、不是 JSON、欄位型別不符 → 一律視為未知，不拋錯', () => {
    const bad = join(tmpDir, 'bad.json')
    writeFileSync(bad, '{not json', 'utf8')
    const v = buildVariantData(1, 'a', {
      reportPath: join(tmpDir, 'missing.json'),
      judgePath: bad,
      usagePath: writeJson('u-types.json', { usage: { totals: { totalTokens: '1', costUsd: null }, routes: 'x' } }),
      prPath: bad,
    })
    expect(v).toEqual(variant({ variant: 'a' }))
    const v2 = buildVariantData(1, 'a', {
      judgePath: writeJson('j-types.json', { result: { outcome: 3, finalScore: { total: '4', label: 5 } } }),
      reportPath: writeJson('r-types.json', { requirements: 'x', changedPaths: 'x' }),
    })
    expect(v2).toEqual(variant({ variant: 'a' }))
  })

  it('requirements 中非物件或未知 status 不計入', () => {
    const v = buildVariantData(1, 'a', {
      reportPath: writeJson('r-req.json', { requirements: [null, { status: 'met' }, { status: 'passed' }] }),
    })
    expect(v.requirements).toEqual({ passed: 1, failed: 0, skipped: 0 })
  })
})

describe('renderCompareMarkdown', () => {
  const full = (v: 'a' | 'b', route: string, extra: Partial<VariantData> = {}) =>
    variant({
      variant: v,
      routes: [route],
      outcome: 'ready-for-review',
      riskTotal: 4,
      riskLabel: '需人類審查',
      pr: { ...PR_716, headRefName: `factory/713-${v}-01-analysis` },
      costUsd: 0.0324,
      tokens: 2291230,
      requirements: { passed: 5, failed: 0, skipped: 0 },
      ...extra,
    })
  const render = (a: VariantData, b: VariantData) =>
    renderCompareMarkdown({ issueNumber: 713, variantA: a, variantB: b } satisfies CompareSummary)

  it('#713 正常情形：每一列都有值，並附人工比對紀錄與誠實的合併後指引', () => {
    const md = render(full('a', 'qwen/qwen3.8-flash'), full('b', 'deepseek/deepseek-flash', { costUnderstated: ['cache-read 未計價'] }))
    expect(md).toContain('## ⚔️ 雙模型競賽比對報告（Issue #713）')
    expect(md).toContain('| **模型**（session log 實測） | `qwen/qwen3.8-flash` | `deepseek/deepseek-flash` |')
    expect(md).toContain('| **機器終態** | ✅ ready-for-review | ✅ ready-for-review |')
    expect(md).toContain(
      '| **Pull Request** | [#716](https://github.com/philipz/fubon-tradingbot/pull/716) `factory/713-a-01-analysis` +200/−0 |',
    )
    expect(md).toContain('| **需求涵蓋**（agent 自報） | 5 passed | 5 passed |')
    expect(md).toContain('| **監督風險分數**（越高越需人審，非品質） | 4（需人類審查） | 4（需人類審查） |')
    expect(md).toContain('| **推論成本** | $0.0324 | $0.0324（低估：cache-read 未計價） |')
    expect(md).toContain('| **Token 用量** | 2,291,230 | 2,291,230 |')
    expect(md).toContain('不代表品質')
    expect(md).toContain('### 人工比對紀錄')
    expect(md).toContain('判定：A / B / 平手 / 兩者皆不收')
    // ADR-021：落選方由選勝者 workflow 關閉（分支保留），不是靠人手動關閉
    expect(md).toContain('Factory N-version Pick')
    expect(md).toContain('分支保留')
    expect(md).not.toContain('不會自動關閉')
    expect(md).not.toContain('⚠️ **注意**')
  })

  it('缺值一律顯示「-」或「未知」，並列出警示：沒有 PR、模型未知', () => {
    const md = render(variant({ variant: 'a' }), full('b', 'deepseek/deepseek-flash'))
    expect(md).toContain('| **模型**（session log 實測） | 未知 |')
    expect(md).toContain('| **機器終態** | - |')
    expect(md).toContain('| **Pull Request** | 未產生 PR |')
    expect(md).toContain('| **需求涵蓋**（agent 自報） | - |')
    expect(md).toContain('| **監督風險分數**（越高越需人審，非品質） | - |')
    expect(md).toContain('| **推論成本** | - |')
    expect(md).toContain('| **Token 用量** | - |')
    expect(md).toContain('⚠️ **注意**')
    expect(md).toContain('變體 A 沒有找到 PR')
  })

  it('fallback（多個 route）與兩變體實際模型相同（坍縮）都要明講', () => {
    const md = render(
      full('a', 'anthropic/claude-opus-5-5'),
      full('b', 'anthropic/claude-sonnet-5-5', { routes: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'] }),
    )
    expect(md).toContain('`anthropic/claude-sonnet-5-5` → `anthropic/claude-opus-5-5`（fallback）')
    expect(md).toContain('兩個變體實際執行的模型相同')
    const same = render(full('a', 'qwen/qwen3.8-flash'), full('b', 'qwen/qwen3.8-flash'))
    expect(same).toContain('兩個變體實際執行的模型相同')
  })

  it('終態圖示、沿用既有 PR、需求 failed/skipped、PR 沒有增刪資訊', () => {
    const md = render(
      full('a', 'x/1', {
        outcome: 'blocked-in-loop',
        reusedExisting: true,
        requirements: { passed: 3, failed: 1, skipped: 1 },
      }),
      full('b', 'y/2', {
        outcome: 'needs-human',
        pr: { number: 9, url: 'u', headRefName: 'factory/713-b-01-x', state: 'OPEN' },
      }),
    )
    expect(md).toContain('| **機器終態** | ⚠️ blocked-in-loop | ❌ needs-human |')
    expect(md).toContain('+200/−0（本次沿用既有 PR）')
    expect(md).toContain('[#9](u) `factory/713-b-01-x` |')
    expect(md).toContain('3 passed／1 failed／1 skipped')
    expect(render(full('a', 'x/1', { outcome: 'ready-to-automerge' }), full('b', 'y/2'))).toContain('✅ ready-to-automerge')
  })

  it('風險分數沒有 label 時只顯示數字', () => {
    const md = render(full('a', 'x/1', { riskLabel: undefined }), full('b', 'y/2'))
    expect(md).toContain('| **監督風險分數**（越高越需人審，非品質） | 4 | 4（需人類審查） |')
  })
})

describe('main', () => {
  it('markdown 寫入 --out；未指定 --out 只回傳', () => {
    const outPath = join(tmpDir, 'compare.md')
    const res = main(['--issue-number', '713', '--usage-a', usageFile('m-ua.json', QWEN_USAGE), '--out', outPath])
    expect(typeof res).toBe('string')
    expect(readFileSync(outPath, 'utf8')).toBe(res)
    expect(main(['--issue-number', '5'])).toContain('Issue #5')
  })

  it('--format json 回傳結構化資料，並可寫入 --out', () => {
    const outPath = join(tmpDir, 'compare.json')
    const res = main(['--issue-number', '6', '--format', 'json', '--out', outPath])
    expect(res).toMatchObject({ issueNumber: 6, variantA: { variant: 'a' }, variantB: { variant: 'b' } })
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual(res)
    expect(main(['--issue-number', '7', '--format', 'json'])).toMatchObject({ issueNumber: 7 })
  })
})
