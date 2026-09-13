/**
 * apply-judge-labels — 依 factory-judge 終點貼標籤並留言。
 *
 * Phase 1 閘門：即使終點為 ready-to-automerge，也**不執行合併**，
 * 一律標記等待人類審查（docs/09-roadmap.md §2「第 1 期不開放自動合併」）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { SkillGapSchema } from './factory-judge.js'
import { renderSkillGapMarkdown } from '../skill-gap/render.js'
import { SKILL_GAP_LABEL } from '../labels.js'
import { NEEDS_HUMAN_LABEL } from '../stop-rules/types.js'

export const PHASE1_HUMAN_REVIEW_NOTE = '（第 1 期：不自動合併，等待人類審查）'

const JudgeSchema = z.object({
  result: z.object({
    outcome: z.enum(['blocked-in-loop', 'ready-to-automerge', 'ready-for-review', 'needs-human']),
    labels: z.array(z.string()),
    summary: z.string(),
  }),
  /**
   * judge.json 頂層的 report（factory-judge 的 JudgeCliOutput = { report, result }）。
   * 這裡只取 skillGap 一欄，其餘不重複驗證——report 已於 factory-judge 端經
   * ReportSchema fail-loud 驗過，在此再收一次只會製造第二套可能分歧的規則。
   *
   * `skillGap` 同樣收 `null`（與 ReportSchema 同規則）：agent 常以
   * `"skillGap": null` 表達「無缺口」，而 `.optional()` 只收 `undefined`。
   * 本步驟是**貼終態留言**的地方，在此 throw 等於終態資訊遺失
   * （run #34456925126 即只剩 G1 守衛的模糊警告），故兩處都必須收下。
   */
  report: z
    .object({ skillGap: SkillGapSchema.nullish().transform((v) => v ?? undefined) })
    .optional(),
})
export type JudgeLike = z.infer<typeof JudgeSchema>['result']

/**
 * 計算標籤。
 *
 * `hasSkillGap` 只影響**標籤**，不影響 `requiresHuman`：技能缺口是分類訊號，
 * 不是監督層級。讓它改變 requiresHuman 會使 agent 多一個影響終態的施力點
 * （docs/25 §2.1「不擋終態」）。
 */
export function computeJudgeLabels(
  judge: JudgeLike,
  hasSkillGap = false,
): { labels: string[]; requiresHuman: boolean } {
  const labels = [...judge.labels]
  // 字面值改用 src/labels.ts 的常數：那份清單同時被對抗性測試拿去比對
  // factory-run.yml 的 bootstrap，確保「發射得出來的 label 一定先被建立」
  // （run 34731487680：skill-gap 未建立導致收尾 exit 1）。
  // 左式是**終點**、右式是**label**，兩者字面相同但語意不同，故不共用常數。
  if (judge.outcome === 'needs-human' && !labels.includes(NEEDS_HUMAN_LABEL)) {
    labels.push(NEEDS_HUMAN_LABEL)
  }
  if (hasSkillGap && !labels.includes(SKILL_GAP_LABEL)) labels.push(SKILL_GAP_LABEL)
  // Phase 1：任何執行過的終點都要人審；blocked-in-loop 已在 apply-score-labels 留言
  const requiresHuman = judge.outcome !== 'blocked-in-loop'
  return { labels, requiresHuman }
}

export function buildJudgeComment(
  outcome: string,
  summary: string,
  usageMarkdown?: string | undefined,
  skillGapMarkdown?: string | undefined,
): string {
  const lines = [`## 工廠執行結果：${outcome}`, '', summary]
  if (outcome === 'ready-to-automerge') lines.push('', PHASE1_HUMAN_REVIEW_NOTE)
  if (usageMarkdown !== undefined && usageMarkdown.trim() !== '') {
    lines.push('', '---', '', usageMarkdown.trim())
  }
  // 技能缺口段落置於用量之後：兩者都是選用附註，缺席時輸出與現況逐字相同。
  if (skillGapMarkdown !== undefined && skillGapMarkdown.trim() !== '') {
    lines.push('', '---', '', skillGapMarkdown.trim())
  }
  return lines.join('\n')
}

/** gh CLI 的注入點（同 apply-score-labels.ts）。 */
export type GhRunner = (args: string[]) => void

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner；
   實機行為由 dry-run E2E（Task 9）在真實 Actions 上驗證 */
const realGh: GhRunner = (args) => {
  execFileSync('gh', args)
}
/* v8 ignore stop */

export interface JudgeLabelsOutput {
  labels: string[]
}

export function main(argv: string[], gh: GhRunner = realGh): JudgeLabelsOutput {
  const [issueNumber, judgePath, usageMarkdownPath] = argv
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  if (judgePath === undefined) throw new CliError('judgePath is required')

  const parsed = JudgeSchema.safeParse(JSON.parse(readFileSync(judgePath, 'utf8')))
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CliError(`judge (${judgePath}) is invalid: ${detail}`)
  }

  // 用量段落是選用附註：usage markdown 檔不存在時不附（量測失敗不擋終態）
  let usageMarkdown: string | undefined
  if (usageMarkdownPath !== undefined) {
    try {
      usageMarkdown = readFileSync(usageMarkdownPath, 'utf8')
    } catch {
      usageMarkdown = undefined
    }
  }

  // 技能缺口為選用訊號（docs/25 §2.1）：缺席時標籤與留言與現況逐字相同。
  const skillGap = parsed.data.report?.skillGap
  const skillGapMarkdown = skillGap === undefined ? undefined : renderSkillGapMarkdown(skillGap)

  const { labels } = computeJudgeLabels(parsed.data.result, skillGap !== undefined)
  gh(['issue', 'edit', issueNumber, '--add-label', labels.join(',')])
  gh([
    'issue',
    'comment',
    issueNumber,
    '--body',
    buildJudgeComment(
      parsed.data.result.outcome,
      parsed.data.result.summary,
      usageMarkdown,
      skillGapMarkdown,
    ),
  ])
  return { labels }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
