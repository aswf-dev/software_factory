/**
 * apply-score-labels — 依初始計分貼 oversight 標籤；in-loop 則擋下 agent。
 *
 * 純函式（computeScoreLabels/buildBlockComment）可單元測試；
 * main() 的 gh 呼叫以注入（GhRunner）取代，測試傳入 fake runner 記錄呼叫。
 *
 * blocked（in-loop）時：貼標籤、留言說明、以 exit 1 阻斷 workflow 的
 * 後續 agent 步驟——這是 gate 觸發，不是錯誤。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

const ScoreSchema = z.object({
  score: z.object({
    total: z.number(),
    tier: z.enum(['on-loop', 'review', 'in-loop']),
    label: z.string(),
  }),
})
export type ScoreLike = z.infer<typeof ScoreSchema>['score']

/**
 * in-loop 仍可執行的「僅產出、不實作」型別（docs/06 §4）。
 *
 * 兩者共用同一條理由：**產出物不具放行效力**，仍須人類審查。
 *  - `agent-analyze`（docs/20 C1）：產出分析報告（docs/）
 *  - `agent-propose-skill`（E6／ADR-016 §4）：產出技能草案（proposals/skills/）
 *
 * **這不是放寬監督層級**：tier 不變、標籤不變、automerge 不變（ADR-016 §4）。
 * 各型別的實際可寫範圍由 crosscheck 的對應模式以白名單強制。
 */
export const OUTPUT_ONLY_TASK_TYPES = ['agent-analyze', 'agent-propose-skill'] as const

/**
 * in-loop 仍可執行、但**會開實作 PR**的型別（ADR-019 R11）。
 *
 * 刻意不併入 `OUTPUT_ONLY_TASK_TYPES`：audit 的產出是會合併進 repo 的測試，不是
 * 「不具放行效力」的報告或草案；放在同一個名單裡，讀程式的人會誤以為它也碰不到
 * 任何會生效的東西。
 *
 * 允許的理由是兩個**機械前提**同時成立，缺一不可（對抗性測試
 * `factory-assets` 釘住：名單內每個型別都必須同時滿足兩者）：
 *  1. crosscheck 白名單只放行 PBT 測試檔、禁止刪除（`src/pbt-audit/scope.ts`）——
 *     agent 碰不到產品程式碼、設定或依賴；
 *  2. 類型層級禁止自動合併（`NO_AUTOMERGE_TASK_TYPES`）——PR 一律交人類審查。
 *
 * 一樣**不是放寬監督層級**：tier、標籤、自動合併都不變。
 */
export const IN_LOOP_ALLOWED_TASK_TYPES = ['agent-pbt-audit'] as const

export function computeScoreLabels(
  score: ScoreLike,
  taskType?: string,
): { labels: string[]; blocked: boolean; analyzeAllowed: boolean; auditAllowed: boolean } {
  const inLoop = score.tier === 'in-loop'
  const analyzeAllowed =
    inLoop && (OUTPUT_ONLY_TASK_TYPES as readonly string[]).includes(taskType ?? '')
  const auditAllowed =
    inLoop && (IN_LOOP_ALLOWED_TASK_TYPES as readonly string[]).includes(taskType ?? '')
  return {
    labels: [score.label],
    blocked: inLoop && !analyzeAllowed && !auditAllowed,
    analyzeAllowed,
    auditAllowed,
  }
}

/**
 * 閘門留言。`runId` 存在時內嵌 `（run: <id>）`——終態守衛
 * （factory-run.yml G1、factory-run-cleanup.yml G2）以「Issue 留言是否含該
 * run id」判定本 run 是否已留下終態紀錄。缺了它，去重失效，cleanup 會在
 * agent 從未啟動的情況下補貼「agent 已啟動但未留下終態判定」的矛盾訊息。
 */
export function buildBlockComment(total: number, runId?: string): string {
  const run = runId ? `（run: ${runId}）` : ''
  return (
    `工廠執行未啟動${run}：初始計分 ${total} 分屬 human-in-the-loop（docs/06 §4.3）。` +
    '設計與實作須由人類主導。'
  )
}

export function buildAnalyzeComment(total: number, taskType?: string): string {
  if (taskType === 'agent-propose-skill') {
    return (
      `⚠️ 初始計分 ${total} 分屬 human-in-the-loop（docs/06 §4.3），但本工作項為 ` +
      '**agent-propose-skill**（僅提案不實作）——依 docs/06 §4「僅可產出分析與方案，不得實作」，' +
      '允許 agent 產出技能草案 PR 供人類審查。**草案不具放行效力**：它寫入 `proposals/skills/`，' +
      '不在任何 DSH 探索路徑上，**即使誤合併也不會生效**；須由人類執行 ' +
      '`factory-skills-lock --promote` 並經 CODEOWNERS 審查後才生效（ADR-016）。' +
      '提案不得觸碰 `src/`、`.dsh/`、`.github/`（crosscheck 以 propose-skill 模式驗證）。'
    )
  }
  return (
    `⚠️ 初始計分 ${total} 分屬 human-in-the-loop（docs/06 §4.3），但本工作項為 ` +
    '**agent-analyze**（僅分析不實作）——依 docs/06 §4「僅可產出分析與方案，不得實作」，' +
    '允許 agent 產出分析報告 PR 供人類審查。**報告不具放行效力**；分析不得觸碰 src/ 等' +
    '程式碼變更（crosscheck 以 analyze 模式驗證）。'
  )
}

export function buildAuditComment(total: number): string {
  return (
    `⚠️ 初始計分 ${total} 分屬 human-in-the-loop（docs/06 §4.3），但本工作項為 ` +
    '**agent-pbt-audit**（事後稽核，ADR-019）——允許 agent 執行，前提是兩條機械限制：' +
    '①只能新增或修改 PBT 測試檔、不得刪除（crosscheck 以 pbt-audit 模式驗證，越界即 needs-human）；' +
    '②類型層級禁止自動合併，audit PR 一律交人類審查。**監督層級不變**：tier、標籤、自動合併規則都照舊。' +
    '候選發現由機制貼在本 Issue，人類確認後再開 `agent-fix-bug`。'
  )
}

/** gh CLI 的注入點：測試以 fake runner 取代真實 gh（避免單元測試執行 gh）。 */
export type GhRunner = (args: string[]) => void

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner；
   實機行為由 dry-run E2E（Task 9）在真實 Actions 上驗證 */
const realGh: GhRunner = (args) => {
  execFileSync('gh', args)
}
/* v8 ignore stop */

export interface ScoreLabelsOutput {
  labels: string[]
  blocked: boolean
  analyzeAllowed: boolean
  auditAllowed: boolean
}

export function main(argv: string[], gh: GhRunner = realGh): ScoreLabelsOutput {
  const [issueNumber, scorePath, taskType, runId] = argv
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  if (scorePath === undefined) throw new CliError('scorePath is required')

  const parsed = ScoreSchema.safeParse(JSON.parse(readFileSync(scorePath, 'utf8')))
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CliError(`score (${scorePath}) is invalid: ${detail}`)
  }

  const { labels, blocked, analyzeAllowed, auditAllowed } = computeScoreLabels(parsed.data.score, taskType)
  gh(['issue', 'edit', issueNumber, '--add-label', labels.join(',')])
  if (blocked) {
    gh(['issue', 'comment', issueNumber, '--body', buildBlockComment(parsed.data.score.total, runId)])
  } else if (analyzeAllowed) {
    gh(['issue', 'comment', issueNumber, '--body', buildAnalyzeComment(parsed.data.score.total, taskType)])
  } else if (auditAllowed) {
    gh(['issue', 'comment', issueNumber, '--body', buildAuditComment(parsed.data.score.total)])
  }
  return { labels, blocked, analyzeAllowed, auditAllowed }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const out = main(process.argv.slice(2))
    if (out.blocked) process.exitCode = 1 // 阻斷 workflow：in-loop 不啟動 agent
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
