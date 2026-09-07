import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMainModule } from './is-main-module.js'
import { loadReport, main, parseArgs } from './factory-judge.js'
import { CliError } from './run-cli.js'

let tmp: string
let catalog: string
let riskPaths: string

/** 寫一個暫存 report.json 並回傳路徑；`content` 為字串時原樣寫入（用於壞格式）。 */
function report(name: string, content: unknown): string {
  const path = join(tmp, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-judge-'))
  catalog = join(tmp, 'catalog-info.yaml')
  writeFileSync(
    catalog,
    [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: demo',
      '  annotations:',
      '    factory.io/business-criticality: tactical',
      '    factory.io/risk-profile: low',
      '    factory.io/complexity: low',
      '',
    ].join('\n'),
  )
  riskPaths = join(tmp, 'risk-paths.yml')
  writeFileSync(
    riskPaths,
    [
      'hard_rules:',
      '  H1: ["src/auth/**"]',
      '  H5: [".github/**", "CODEOWNERS", "catalog-info.yaml", ".dsh/skills/**"]',
      '',
    ].join('\n'),
  )
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('無參數時採用 repo 標準路徑（CI 免設定即可執行）', () => {
    expect(parseArgs([])).toEqual({
      reportPath: '.factory/run/report.json',
      catalogPath: 'catalog-info.yaml',
      riskPathsPath: '.github/factory/risk-paths.yml',
    })
  })

  it('依序讀取三個位置參數', () => {
    expect(parseArgs(['r.json', 'c.yaml', 'p.yml'])).toEqual({
      reportPath: 'r.json',
      catalogPath: 'c.yaml',
      riskPathsPath: 'p.yml',
    })
  })

  it('只給前面的位置參數 → 其餘沿用預設', () => {
    expect(parseArgs(['r.json'])).toEqual({
      reportPath: 'r.json',
      catalogPath: 'catalog-info.yaml',
      riskPathsPath: '.github/factory/risk-paths.yml',
    })
  })

  it('多餘的位置參數 → 拋錯，不靜默忽略', () => {
    expect(() => parseArgs(['a', 'b', 'c', 'd'])).toThrow('unexpected argument: d')
  })
})

describe('loadReport', () => {
  it('讀出 agent 回報的欄位', () => {
    const path = report('ok.json', {
      issueNumber: 42,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/a.ts'],
      changedLines: 12,
    })
    const r = loadReport(path)
    expect(r.issueNumber).toBe(42)
    expect(r.invocation.exitCode).toBe(0)
    expect(r.changedPaths).toEqual(['src/a.ts'])
  })

  it('缺 issueNumber → CliError（絕不當成成功）', () => {
    const path = report('no-issue.json', { invocation: { exitCode: 0 } })
    expect(() => loadReport(path)).toThrow(CliError)
    expect(() => loadReport(path)).toThrow(/issueNumber/)
  })

  it('invocation 型別錯誤 → CliError', () => {
    // 若放行，interpretDshResult 會讀不到 exitCode 而把失敗判成失敗以外的狀態，
    // 或更糟：把一次沒真正執行的 run 當成 completed。
    const path = report('bad-invocation.json', { issueNumber: 1, invocation: 'ok' })
    expect(() => loadReport(path)).toThrow(CliError)
    expect(() => loadReport(path)).toThrow(/invocation/)
  })

  it('缺 invocation → CliError', () => {
    const path = report('no-invocation.json', { issueNumber: 1 })
    expect(() => loadReport(path)).toThrow(CliError)
  })

  it('欄位型別錯誤（changedPaths 不是字串陣列）→ CliError', () => {
    const path = report('bad-paths.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      changedPaths: 'src/a.ts',
    })
    expect(() => loadReport(path)).toThrow(CliError)
  })

  it('讀出 requirements 欄位（G8：驗收條件證據槽）', () => {
    const path = report('with-requirements.json', {
      issueNumber: 42,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/a.ts'],
      requirements: [
        { id: 'R1', status: 'passed' },
        { id: 'R2', status: 'failed' },
      ],
    })
    const r = loadReport(path)
    expect(r.requirements).toEqual([
      { id: 'R1', status: 'passed' },
      { id: 'R2', status: 'failed' },
    ])
  })

  it('requirements 條目型別錯誤（status 非 passed/failed/skipped）→ CliError', () => {
    const path = report('bad-requirements.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      requirements: [{ id: 'R1', status: 'whatever' }],
    })
    expect(() => loadReport(path)).toThrow(CliError)
    expect(() => loadReport(path)).toThrow(/requirements/)
  })

  it('requirements 條目缺 id → CliError', () => {
    const path = report('no-id-requirements.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      requirements: [{ status: 'passed' }],
    })
    expect(() => loadReport(path)).toThrow(CliError)
  })

  it('requirements 缺 status → CliError', () => {
    const path = report('no-status-requirements.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      requirements: [{ id: 'R1' }],
    })
    expect(() => loadReport(path)).toThrow(CliError)
  })

  it('不是合法 JSON → 單行 CliError，不外洩 parser stack', () => {
    const path = report('broken.json', '{ not json')
    expect(() => loadReport(path)).toThrow(CliError)
    expect(() => loadReport(path)).toThrow(/is not valid JSON/)
  })

  it('讀出 usage 欄位（CI 實測 token 用量與成本，docs/04 §5）', () => {
    const path = report('with-usage.json', {
      issueNumber: 42,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      usage: {
        source: 'dsh-session-log',
        totals: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
          reasoningTokens: 30,
          totalTokens: 1250,
          costUsd: 0.0042,
          unpricedModels: [],
          cacheReadUnpriced: false,
        },
        routes: [
          {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 50,
            cacheWriteTokens: 0,
            reasoningTokens: 30,
            costUsd: 0.0042,
            cacheReadUnpriced: false,
          },
        ],
        pricingRef: 'config/dsh/pricing.yaml',
        measuredAt: '2026-09-02T00:00:00.000Z',
        sessionCount: 1,
      },
    })
    const r = loadReport(path)
    expect(r.usage?.totals.totalTokens).toBe(1250)
    expect(r.usage?.routes[0]?.model).toBe('deepseek-v4-flash')
  })

  it('usage 欄位形狀錯誤 → CliError（fail-loud，不接受破格式的執行報告）', () => {
    const path = report('bad-usage.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      usage: { source: 'dsh-session-log', totals: { inputTokens: -1 } },
    })
    expect(() => loadReport(path)).toThrow(CliError)
    expect(() => loadReport(path)).toThrow(/usage/)
  })

  it('JSON 頂層不是物件（陣列 / 純量）→ CliError', () => {
    expect(() => loadReport(report('list.json', [1, 2]))).toThrow(CliError)
    expect(() => loadReport(report('scalar.json', '"hi"'))).toThrow(CliError)
  })

  // --- skillGap（docs/25 §2.1、docs/20 E4）---

  it('skillGap 三欄齊全 → 讀出', () => {
    const path = report('gap-full.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      skillGap: { category: 'monorepo-test-path', needed: 'vitest 路徑解析 SOP', context: 'issue #201' },
    })
    expect(loadReport(path).skillGap).toEqual({
      category: 'monorepo-test-path',
      needed: 'vitest 路徑解析 SOP',
      context: 'issue #201',
    })
  })

  it('skillGap 省略 context → 通過（context 為選填）', () => {
    const path = report('gap-min.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      skillGap: { category: 'java-multimodule-mvn', needed: '多模組測試路徑' },
    })
    expect(loadReport(path).skillGap?.context).toBeUndefined()
  })

  it('skillGap 缺席 → 通過且為 undefined（容錯，不擋終態）', () => {
    const path = report('gap-absent.json', { issueNumber: 1, invocation: { exitCode: 0 } })
    expect(loadReport(path).skillGap).toBeUndefined()
  })

  it('category 非 kebab-case → CliError（聚類鍵不得劣化，docs/25 §7 同義異名風險）', () => {
    const bads = ['MonorepoTestPath', 'monorepo_test_path', 'monorepo test path', '-lead', 'trail-', 'a--b', '']
    bads.forEach((bad, i) => {
      const path = report(`gap-bad-${i}.json`, {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        skillGap: { category: bad, needed: 'x' },
      })
      expect(() => loadReport(path), `category=${JSON.stringify(bad)} 應被拒`).toThrow(CliError)
    })
  })

  it('needed 為空字串 → CliError（空缺口等於沒回報，不接受佔位）', () => {
    const path = report('gap-empty-needed.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      skillGap: { category: 'a-b', needed: '' },
    })
    expect(() => loadReport(path)).toThrow(CliError)
  })

  it('context 給了就必須有內容（空字串 → CliError）', () => {
    const path = report('gap-empty-ctx.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      skillGap: { category: 'a-b', needed: 'x', context: '' },
    })
    expect(() => loadReport(path)).toThrow(CliError)
  })

  it('skillGap 缺 needed → CliError', () => {
    const path = report('gap-no-needed.json', {
      issueNumber: 1,
      invocation: { exitCode: 0 },
      skillGap: { category: 'a-b' },
    })
    expect(() => loadReport(path)).toThrow(CliError)
  })
})

describe('main', () => {
  /** 用 fixture catalog/risk-paths 跑一次判定。 */
  function judge(name: string, body: Record<string, unknown>) {
    return main([report(name, body), catalog, riskPaths])
  }

  it('低風險 + exit 0 + 只改測試檔 → ready-to-automerge', () => {
    const { report: r, result } = judge('automerge.json', {
      issueNumber: 201,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/util/format.test.ts'],
      changedLines: 40,
      assertionDelta: 6,
    })
    expect(r.issueNumber).toBe(201)
    expect(result.initialScore.total).toBe(0)
    expect(result.outcome).toBe('ready-to-automerge')
    expect(result.dshResult?.outcome).toBe('completed')
    expect(result.labels).not.toContain('needs-human')
  })

  it('改到 guardrail（.github/workflows）→ needs-human + SR3', () => {
    const { result } = judge('guardrail.json', {
      issueNumber: 202,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['.github/workflows/test.yml'],
    })
    expect(result.outcome).toBe('needs-human')
    expect(result.stopDecision?.violations.some((v) => v.rule === 'SR3-guardrail-change')).toBe(
      true,
    )
  })

  it('exit 1 + stderr → needs-human，且 summary 保留原始錯誤', () => {
    const { result } = judge('failed.json', {
      issueNumber: 203,
      invocation: { exitCode: 1, stdout: '', stderr: 'model unavailable' },
    })
    expect(result.outcome).toBe('needs-human')
    expect(result.dshResult?.outcome).toBe('failed')
    expect(result.summary).toContain('model unavailable')
  })

  it('hasAcceptanceCriteria: false → SR4 停手', () => {
    const { result } = judge('sr4.json', {
      issueNumber: 204,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/a.ts'],
      hasAcceptanceCriteria: false,
    })
    expect(result.outcome).toBe('needs-human')
    expect(result.stopDecision?.violations.some((v) => v.rule === 'SR4-unclear-acceptance')).toBe(
      true,
    )
  })

  it('report 格式錯誤 → 拋 CliError，不輸出任何判定結果', () => {
    expect(() => judge('bad.json', { invocation: { exitCode: 0 } })).toThrow(CliError)
  })

  it('agent 只回報 invocation（fallback report 特徵）→ needs-human，不誤判為完成', () => {
    // write-report.js 在 agent 被截斷時補的最小 report：只有 issueNumber + invocation，
    // changedPaths 缺席（undefined）。這是「宣稱成功但未留下變更軌跡」的異常特徵
    // （issue #35 實測：被判 ready-for-review 卻無任何 PR）——必須 needs-human。
    const { result } = judge('minimal.json', {
      issueNumber: 205,
      invocation: { exitCode: 0, stdout: 'DONE' },
    })
    expect(result.outcome).toBe('needs-human')
    expect(result.labels).toContain('needs-human')
    expect(result.summary).toContain('changedPaths')
  })

  it('tokensUsed 超過 tokenBudget → needs-human + SR7（Q02-5 接線）', () => {
    const { result } = main(
      [
        report('sr7.json', {
          issueNumber: 208,
          invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
          changedPaths: ['src/a.ts'],
          tokensUsed: 12_000,
        }),
        catalog,
        riskPaths,
      ],
      10_000,
    )
    expect(result.outcome).toBe('needs-human')
    expect(result.stopDecision?.violations.some((v) => v.rule === 'SR7-cost-exceeded')).toBe(true)
  })

  it('tokensUsed 但未設 budget → SR7 不觸發（待基線校準）', () => {
    const { result } = judge('sr7-no-budget.json', {
      issueNumber: 209,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/a.ts'],
      tokensUsed: 99_999,
    })
    expect(result.outcome).toBe('ready-to-automerge')
    expect(result.stopDecision?.violations.some((v) => v.rule === 'SR7-cost-exceeded')).toBe(false)
  })

  it('逾時的 invocation → needs-human', () => {
    const { result } = judge('timeout.json', {
      issueNumber: 206,
      invocation: { timedOut: true },
    })
    expect(result.outcome).toBe('needs-human')
    expect(result.summary).toContain('逾時')
  })

  it('新增相依 + 弱化斷言 → needs-human（SR5、SR6 同時列出）', () => {
    const { result } = judge('deps.json', {
      issueNumber: 207,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['package.json'],
      addedDependencies: ['left-pad'],
      assertionDelta: -3,
      syncFailures: 0,
    })
    expect(result.outcome).toBe('needs-human')
    const rules = result.stopDecision?.violations.map((v) => v.rule) ?? []
    expect(rules).toContain('SR5-new-dependency')
    expect(rules).toContain('SR6-weakened-tests')
  })
})

describe('isMainModule', () => {
  it('進入點不是本模組（被 import 時）→ false', () => {
    expect(isMainModule(catalog, '/self/path.js')).toBe(false)
  })

  it('沒有進入點（argv[1] 為 undefined）→ false', () => {
    expect(isMainModule(undefined, '/self/path.js')).toBe(false)
  })

  it('selfPath 缺席 → false', () => {
    expect(isMainModule('/some/entry.js', undefined)).toBe(false)
  })

  it('進入點不存在 → false，而非讓 realpath 拋錯把 CLI 弄崩', () => {
    expect(isMainModule(join(tmp, 'does-not-exist.js'), '/self/path.js')).toBe(false)
  })

  it('selfPath === realpath(entry) → true（直接執行的判準）', () => {
    const entry = join(tmp, 'entry.js')
    writeFileSync(entry, '')
    expect(isMainModule(entry, realpathSync(entry))).toBe(true)
  })
})
