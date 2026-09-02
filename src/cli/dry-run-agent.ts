/**
 * dry-run-agent — 以 stub agent 取代真實 DSH（docs/11 §4.3 精神）。
 *
 * 用途：在沒有 LLM key 的 CI 上驗證 factory-run.yml 的流程接線——
 * 計分閘門、標籤、judge 終點、needs-human 路徑。stub 是確定性的：
 * 同一 scenario 永遠產出同一份報告。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderUsageMarkdown } from '../usage/render.js'
import type { UsageReport } from '../usage/types.js'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export type DryRunScenario = 'success' | 'blocked' | 'guardrail'

const SCENARIOS: readonly DryRunScenario[] = ['success', 'blocked', 'guardrail']

export interface DryRunInput {
  scenario: DryRunScenario
  issueNumber: number
  cwd: string
}

export interface DryRunReport {
  issueNumber: number
  invocation: { exitCode: number; stdout: string; stderr: string }
  scenario?: string
  changedPaths?: string[]
  changedLines?: number
  assertionDelta?: number
  hasAcceptanceCriteria?: boolean
  tokensUsed?: number
}

export function dryRunReport(input: DryRunInput): DryRunReport {
  const base: DryRunReport = {
    issueNumber: input.issueNumber,
    invocation: { exitCode: 0, stdout: 'DONE (dry-run stub)', stderr: '' },
    tokensUsed: 15_000, // 固定值，供 SR7 接線測試（Q02-5）
  }
  if (input.scenario === 'success') {
    return {
      ...base,
      changedPaths: ['src/util/format.test.ts'],
      changedLines: 40,
      assertionDelta: 6,
      hasAcceptanceCriteria: true,
    }
  }
  if (input.scenario === 'guardrail') {
    return {
      ...base,
      changedPaths: ['.github/workflows/test.yml'],
      changedLines: 5,
      assertionDelta: 0,
      hasAcceptanceCriteria: true,
    }
  }
  // blocked：in-loop 初始計分會擋下 agent，此報告不會被使用
  return { ...base, scenario: 'blocked' }
}

/**
 * dry-run 用的固定 usage 值（docs/04 §5 接線驗證：無 LLM 也能測 usage 留言）。
 * 與 DRY_RUN tokensUsed=15_000 對齊；接線測試只看「存在、形狀正確」。
 */
export const DRY_RUN_USAGE: UsageReport = {
  source: 'dsh-session-log',
  totals: {
    inputTokens: 9_000,
    outputTokens: 6_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15_000,
    costUsd: 0.001, // 9k×0.14/1e6 + 6k×0.28/1e6（deepseek-v4-flash 價）
    unpricedModels: [],
    cacheReadUnpriced: false,
  },
  routes: [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 9_000,
      outputTokens: 6_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.001,
      cacheReadUnpriced: false,
    },
  ],
  pricingRef: 'config/dsh/pricing.yaml',
  measuredAt: '2026-09-02T00:00:00.000Z',
  sessionCount: 1,
}

/** 解析位置參數：`<scenario> <issueNumber>`。 */
export function parseArgs(argv: string[]): DryRunInput {
  const extra = argv[2]
  if (extra !== undefined) {
    throw new CliError(`unexpected argument: ${extra}`)
  }
  const scenario = (argv[0] ?? 'success') as DryRunScenario
  if (!SCENARIOS.includes(scenario)) {
    throw new CliError(`unknown scenario: ${scenario} (expected ${SCENARIOS.join('|')})`)
  }
  const issueNumber = Number(argv[1])
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError(`issueNumber must be a positive integer, got ${argv[1] ?? '(missing)'}`)
  }
  return { scenario, issueNumber, cwd: process.cwd() }
}

export function main(argv: string[], cwd = process.cwd()): DryRunReport {
  const input = { ...parseArgs(argv), cwd }
  const report = dryRunReport(input)
  const target = join(input.cwd, '.factory/run/report.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(report, null, 2))
  // 固定 usage：讓 apply-judge-labels 在無 LLM 的 dry-run 也能附加用量段落
  // （docs/04 §5 接線驗證；真實 run 由 factory-usage CLI 覆寫同路徑檔案）
  const usageJson = join(input.cwd, '.factory/run/usage.json')
  const usageMd = join(input.cwd, '.factory/run/usage.md')
  writeFileSync(usageJson, `${JSON.stringify(DRY_RUN_USAGE, null, 2)}\n`)
  writeFileSync(usageMd, renderUsageMarkdown(DRY_RUN_USAGE))
  return report
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
