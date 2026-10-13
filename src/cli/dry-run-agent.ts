/**
 * dry-run-agent — 以 stub agent 取代真實 DSH（docs/11 §4.3 精神）。
 *
 * 用途：在沒有 LLM key 的 CI 上驗證 factory-run.yml 的流程接線——
 * 計分閘門、標籤、judge 終點、needs-human 路徑。stub 是確定性的：
 * 同一 scenario 永遠產出同一份報告。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  /** `Select model tier` 產出的 model.json；有給時 usage 回報本變體 chain 的第一順位。 */
  modelJsonPath?: string | undefined
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
    costUsd: 0.0099, // 9k×0.3/1e6 + 6k×1.2/1e6（deepseek-flash 官方高峰價）
    unpricedModels: [],
    cacheReadUnpriced: false,
  },
  routes: [
    {
      provider: 'deepseek',
      model: 'deepseek-flash',
      inputTokens: 9_000,
      outputTokens: 6_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.0099,
      cacheReadUnpriced: false,
    },
  ],
  pricingRef: 'config/dsh/pricing.yaml',
  measuredAt: '2026-09-02T00:00:00.000Z',
  sessionCount: 1,
}

export interface ModelRoute {
  provider: string
  model: string
}

/**
 * 本變體實際被路由到的模型：model.json 的 `chain[0]`（N-version 時已由 workflow
 * 改寫為「本變體的 dual 模型在前」）。讀不到或形狀不對 → undefined（沿用固定值）。
 */
export function routedModel(modelJsonPath: string): ModelRoute | undefined {
  try {
    const first = (JSON.parse(readFileSync(modelJsonPath, 'utf8')) as { chain?: unknown }).chain
    const head = Array.isArray(first) ? (first[0] as Record<string, unknown> | undefined) : undefined
    const provider = head?.['provider']
    const model = head?.['model']
    return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
      ? { provider, model }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * dry-run 的 usage：數量固定，route 換成本變體被路由到的模型。
 *
 * 2026-10-13 沙箱實測（agent-playground/node-redlock#10）：route 原本寫死
 * deepseek/deepseek-flash，兩個變體回報同一個模型，比對卡片因此誤判
 * 「fallback 坍縮」——dry-run 反而無法驗證 N-version 最重要的接線（變體路由）。
 * 成本與 token 仍是模擬值，比對卡片以 `--dry-run` 標示（factory-compare）。
 */
export function dryRunUsage(route?: ModelRoute | undefined): UsageReport {
  if (route === undefined) return DRY_RUN_USAGE
  return {
    ...DRY_RUN_USAGE,
    routes: DRY_RUN_USAGE.routes.map((r) => ({ ...r, provider: route.provider, model: route.model })),
  }
}

/** 解析參數：`<scenario> <issueNumber> [--model-json <path>]`。 */
export function parseArgs(argv: string[]): DryRunInput {
  let modelJsonPath: string | undefined
  if (argv[2] === '--model-json') {
    modelJsonPath = argv[3]
    if (modelJsonPath === undefined || modelJsonPath === '') throw new CliError('--model-json requires a value')
  }
  const extra = argv[modelJsonPath === undefined ? 2 : 4]
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
  return { scenario, issueNumber, cwd: process.cwd(), ...(modelJsonPath === undefined ? {} : { modelJsonPath }) }
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
  const usage = dryRunUsage(input.modelJsonPath === undefined ? undefined : routedModel(input.modelJsonPath))
  writeFileSync(usageJson, `${JSON.stringify(usage, null, 2)}\n`)
  writeFileSync(usageMd, renderUsageMarkdown(usage))
  return report
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
