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

export function computeScoreLabels(
  score: ScoreLike,
  taskType?: string,
): { labels: string[]; blocked: boolean; analyzeAllowed: boolean } {
  const inLoop = score.tier === 'in-loop'
  const analyzeAllowed =
    inLoop && (OUTPUT_ONLY_TASK_TYPES as readonly string[]).includes(taskType ?? '')
  return { labels: [score.label], blocked: inLoop && !analyzeAllowed, analyzeAllowed }
}

export function buildBlockComment(total: number): string {
  return (
    `工廠執行未啟動：初始計分 ${total} 分屬 human-in-the-loop（docs/06 §4.3）。` +
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
}

export function main(argv: string[], gh: GhRunner = realGh): ScoreLabelsOutput {
  const [issueNumber, scorePath, taskType] = argv
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  if (scorePath === undefined) throw new CliError('scorePath is required')

  const parsed = ScoreSchema.safeParse(JSON.parse(readFileSync(scorePath, 'utf8')))
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CliError(`score (${scorePath}) is invalid: ${detail}`)
  }

  const { labels, blocked, analyzeAllowed } = computeScoreLabels(parsed.data.score, taskType)
  gh(['issue', 'edit', issueNumber, '--add-label', labels.join(',')])
  if (blocked) {
    gh(['issue', 'comment', issueNumber, '--body', buildBlockComment(parsed.data.score.total)])
  } else if (analyzeAllowed) {
    gh(['issue', 'comment', issueNumber, '--body', buildAnalyzeComment(parsed.data.score.total, taskType)])
  }
  return { labels, blocked, analyzeAllowed }
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
