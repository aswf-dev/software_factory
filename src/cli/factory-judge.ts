/**
 * factory-judge — agent 執行後的終態判定 CLI（docs/02 §4, docs/06 §5.1）。
 *
 * 輸入：agent 在 workspace 寫下的 .factory/run/report.json，加上 catalog 三軸
 * 標註與 risk-paths 硬性規則。輸出：最終判定 JSON（stdout）。
 *
 * 這支 CLI 刻意「不含任何判斷邏輯」：它只把 report 重播進 runWorkItem，
 * 由已 100% 測試覆蓋的 pipeline（計分 → DSH 解讀 → 二次計分 → 停手規則）決定終態。
 * 在這裡重寫一份判定，等於製造出第二套可能與 pipeline 不一致的規則
 * —— 兩者一旦分歧，寬鬆的那一套就會成為實際生效的規則。
 *
 * report.json 由 agent 自己寫出，屬於**外部且不可信**的輸入，因此一律以 zod
 * fail-loud 驗證（沿用 factory-score.ts 的慣例）。這裡刻意不做任何 .catch()
 * 兜底：格式錯誤的 report 若被寬容地補上預設值，最可能的結果是「沒有 changedPaths、
 * 沒有停手訊號」的乾淨紀錄，也就是把一次壞掉的執行判成 ready-to-automerge。
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { runWorkItem, type AgentRun, type PipelineResult } from '../pipeline/run-work-item.js'
import { loadScoreInput } from './factory-score.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/**
 * DSH 執行結果。每個欄位皆為選填，對應 DshInvocation：
 * 逾時的行程沒有 exitCode，成功的行程 stderr 為空。
 */
const InvocationSchema = z.object({
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  timedOut: z.boolean().optional(),
})

/**
 * report.json 的結構。
 *
 * 只有 issueNumber 與 invocation 為必填 —— 沒有這兩者就無從判定「哪個工作項、
 * 執行成敗如何」。其餘欄位缺席代表「agent 未回報」，交由 pipeline 的既有
 * fail-safe 處理，而不是在此臆測數值。
 *
 * @export 供 factory-crosscheck 等「以 report 為輸入的判定器」共用，確保只有
 * 一份 report 契約。
 */
export const ReportSchema = z.object({
  issueNumber: z.number(),
  invocation: InvocationSchema,
  changedPaths: z.array(z.string()).optional(),
  changedLines: z.number().optional(),
  assertionDelta: z.number().optional(),
  addedDependencies: z.array(z.string()).optional(),
  syncFailures: z.number().optional(),
  hasAcceptanceCriteria: z.boolean().optional(),
  tokensUsed: z.number().optional(),
})

export type FactoryReport = z.infer<typeof ReportSchema>

export interface JudgeCliPaths {
  reportPath: string
  catalogPath: string
  riskPathsPath: string
}

export interface JudgeCliOutput {
  report: FactoryReport
  result: PipelineResult
}

const DEFAULT_PATHS: JudgeCliPaths = {
  reportPath: '.factory/run/report.json',
  catalogPath: 'catalog-info.yaml',
  riskPathsPath: '.github/factory/risk-paths.yml',
}

/**
 * 解析位置參數 `[reportPath, catalogPath, riskPathsPath]`。
 *
 * 多餘的參數一律拋錯而非忽略：CI 的呼叫方式打錯字時，寧可紅燈，
 * 也不要讓人以為判定用的是自己指定的那份檔案。
 */
export function parseArgs(argv: string[]): JudgeCliPaths {
  const extra = argv[3]
  if (extra !== undefined) {
    throw new CliError(`unexpected argument: ${extra}`)
  }
  return {
    reportPath: argv[0] ?? DEFAULT_PATHS.reportPath,
    catalogPath: argv[1] ?? DEFAULT_PATHS.catalogPath,
    riskPathsPath: argv[2] ?? DEFAULT_PATHS.riskPathsPath,
  }
}

/** 把 zod 的 issue 攤平成單行訊息，讓 CI log 直接看得出哪個欄位不合法。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

/**
 * 讀取並驗證 agent 寫出的 report.json。
 *
 * 任何格式問題都以 CliError 中止，絕不回傳「部分可用」的物件。
 */
export function loadReport(reportPath: string): FactoryReport {
  const text = readFileSync(reportPath, 'utf8')

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new CliError(`report (${reportPath}) is not valid JSON: ${(err as Error).message}`)
  }

  const parsed = ReportSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CliError(`report (${reportPath}) is invalid: ${describeIssues(parsed.error)}`)
  }
  return parsed.data
}

/** 把驗證過的 report 轉成 pipeline 的 AgentRun。純資料搬運，不做任何判斷。 */
function toAgentRun(report: FactoryReport): AgentRun {
  return {
    invocation: report.invocation,
    changedPaths: report.changedPaths,
    changedLines: report.changedLines,
    assertionDelta: report.assertionDelta,
    addedDependencies: report.addedDependencies,
    syncFailures: report.syncFailures,
    hasAcceptanceCriteria: report.hasAcceptanceCriteria,
    tokensUsed: report.tokensUsed,
  }
}

export function main(argv: string[], tokenBudget?: number): JudgeCliOutput {
  const { reportPath, catalogPath, riskPathsPath } = parseArgs(argv)
  const report = loadReport(reportPath)
  const { annotations, hardRulePatterns } = loadScoreInput(catalogPath, riskPathsPath)

  const result = runWorkItem({
    issueNumber: report.issueNumber,
    initial: { annotations, hardRulePatterns },
    runAgent: () => toAgentRun(report),
    tokenBudget,
  })
  return { report, result }
}

/**
 * 這個模組是否以執行檔身分被啟動（共用實作見 is-main-module.ts）。
 */
/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  // TOKEN_BUDGET 由 workflow 以 env 傳入；0 或未設 = 不設限（Q02-5 待基線校準）。
  const raw = process.env.TOKEN_BUDGET
  const tokenBudget = raw !== undefined && raw !== '' && Number(raw) > 0 ? Number(raw) : undefined
  process.exitCode = runCli(() => main(process.argv.slice(2), tokenBudget))
}
/* v8 ignore stop */
