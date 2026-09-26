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
import { adviseUnreportedSkillGap, type SkillGapAdvisory } from '../skill-gap/unreported.js'
import { UsageReportSchema } from '../usage/report-schema.js'
import { loadScoreInput } from './factory-score.js'
import { applyWriteSpecMergePolicy } from '../write-spec/policy.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/**
 * DSH 執行結果。每個欄位皆為選填，對應 DshInvocation：
 * 逾時的行程沒有 exitCode，成功的行程 stderr 為空。
 *
 * `stopReason`（A2）為封閉列舉：34735315950 事故的教訓是「沒有名字的失敗無從
 * 歸因」——scoreboard 收到 `stop_reason: null`，judge 與事後統計都分不出
 * 「agent 迷路」與「任務對 50 分鐘不可行」。此處以 zod 收緊，讓 CI 寫入的
 * 終止原因必須是已知值，否則 judge 讀取時 fail-loud（而非靜默吞掉）。
 */
const InvocationSchema = z.object({
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  timedOut: z.boolean().optional(),
  stopReason: z
    .enum([
      'agent-step-timeout',
      'agent-inner-timeout',
      'provider-error',
      'agent-error',
      'agent-exit-zero',
    ])
    .optional(),
  provider: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
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
/**
 * 技能缺口回報（docs/25 §2.1、docs/20 E4）。
 *
 * agent 在**已經要停手或繞路時**額外填寫，回報「我缺什麼 SOP」。這是
 * `docs/25` 迴圈 A 的 T1 偵測層——把擴展需求從盲區變成可見訊號。
 *
 * `category` 是**聚類鍵**，強制 kebab-case：`docs/25` §7 已列「同義異名」
 * 為已知風險（`monorepo-test-path` vs `pnpm-workspace-test` 會稀釋計數），
 * 格式不一致會直接讓 §3 的「≥3 次」門檻失準，因此在入口就 fail-loud。
 */
export const SkillGapSchema = z.object({
  category: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'category must be kebab-case (e.g. monorepo-test-path)'),
  needed: z.string().min(1),
  context: z.string().min(1).optional(),
})

export type SkillGap = z.infer<typeof SkillGapSchema>

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
  /**
   * G8 需求追蹤（docs/18 §4、docs/20 B1）：每一條 Issue 驗收條件對應一個
   * {id, status}。status 為封閉三態（passed/failed/skipped）——這是「每條驗收
   * 條件都有一個明確狀態」的證據槽。agent 自報、外部不可信，因此以 zod 收緊。
   */
  requirements: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(['passed', 'failed', 'skipped']),
      }),
    )
    .optional(),
  /**
   * CI 實測的 token 用量與成本（factory-usage 寫回，docs/04 §5）。
   *
   * 與 tokensUsed（agent 自報，SR7 用）不同：usage 是 CI 於 run 結束後回放
   * DSH session log 的實測值，非 agent 自報。schema 內保留它，讓 judge.json
   * 與執行報告留底；pipeline 判定不讀它（量測是附註不是 gate）。
   */
  usage: UsageReportSchema.optional(),
  /**
   * 技能缺口（docs/25 §2.1）。選填——缺席時留言與標籤行為與現況**逐字相同**
   * （容錯，不擋終態）。
   *
   * **刻意不進入 pipeline 判定**（不出現在 toAgentRun）：若讓自報的技能缺口
   * 影響終態，等於給 agent 一個「宣稱缺技能就改變判定」的施力點。與 usage
   * 同立場——schema 收下以供留言與事件使用，判定不讀它。
   *
   * **`null` 與缺席同義**（run #34456925126 迴歸）：agent 曾以 `"skillGap": null`
   * 表達「無缺口」，而 `.optional()` 只收 `undefined`，導致 crosscheck 在讀取
   * 階段就 throw、整個 run 被判失敗（該次 agent 其實已正常開出 PR #29）。
   * `null` 是 JSON 表達「無值」最自然的寫法，把它當格式錯誤等於用 schema
   * 懲罰誠實回報，故以 `.nullish()` 收下並用 `transform` 正規化為 `undefined`
   * ——下游（`report?.skillGap` 的 undefined 判斷）因此完全不需改動。
   */
  skillGap: SkillGapSchema.nullish().transform((v) => v ?? undefined),
})

export type FactoryReport = z.infer<typeof ReportSchema>

export interface JudgeCliPaths {
  reportPath: string
  catalogPath: string
  riskPathsPath: string
  /** 工單類型；目前只用於 write-spec 的類型層級合併政策（ADR-018 護欄②）。 */
  taskType?: string | undefined
}

export interface JudgeCliOutput {
  report: FactoryReport
  result: PipelineResult
  /**
   * Advisory 發現：**不影響 `result` 的任何一欄**，與 `factory-crosscheck` 的
   * `advisories` 同性質（第一階段觀察期，不擋 run）。
   *
   * 放在 `result` 之外是刻意的：`result` 是終態判定，advisory 只是給人看的提醒。
   * 兩者混在一起，日後就會有人以為 advisory 參與判定——M7 變異測試釘住的正是
   * 「skillGap 不得影響終態」，advisory 必須留在同一側（不判定的那一側）。
   */
  advisories: SkillGapAdvisory[]
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
  const positional: string[] = []
  let taskType: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--task-type') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError('--task-type requires a value')
      taskType = v
    } else {
      positional.push(arg)
    }
  }
  const extra = positional[3]
  if (extra !== undefined) {
    throw new CliError(`unexpected argument: ${extra}`)
  }
  return {
    reportPath: positional[0] ?? DEFAULT_PATHS.reportPath,
    catalogPath: positional[1] ?? DEFAULT_PATHS.catalogPath,
    riskPathsPath: positional[2] ?? DEFAULT_PATHS.riskPathsPath,
    taskType,
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
    requirements: report.requirements,
  }
}

export function main(argv: string[], tokenBudget?: number): JudgeCliOutput {
  const { reportPath, catalogPath, riskPathsPath, taskType } = parseArgs(argv)
  const report = loadReport(reportPath)
  const { annotations, hardRulePatterns } = loadScoreInput(catalogPath, riskPathsPath)

  const result = applyWriteSpecMergePolicy(
    runWorkItem({
      issueNumber: report.issueNumber,
      initial: { annotations, hardRulePatterns },
      runAgent: () => toAgentRun(report),
      tokenBudget,
    }),
    taskType,
  )
  // needs-human 卻沒回報技能缺口 → advisory（docs/25 §2.1）。
  // judge 是唯一知道**真實終態**的元件，因此涵蓋停手規則等 crosscheck 看不到的
  // needs-human 成因（實證：run 34457060253，11 個 changedPaths、終態 needs-human、
  // 無 skillGap——crosscheck 的零產出代理訊號抓不到它）。
  const advisories = adviseUnreportedSkillGap(
    result.outcome === 'needs-human' ? 'needs-human' : null,
    report.skillGap !== undefined,
  )
  return { report, result, advisories }
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
