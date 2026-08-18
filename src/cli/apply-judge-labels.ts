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

export const PHASE1_HUMAN_REVIEW_NOTE = '（第 1 期：不自動合併，等待人類審查）'

const JudgeSchema = z.object({
  result: z.object({
    outcome: z.enum(['blocked-in-loop', 'ready-to-automerge', 'ready-for-review', 'needs-human']),
    labels: z.array(z.string()),
    summary: z.string(),
  }),
})
export type JudgeLike = z.infer<typeof JudgeSchema>['result']

export function computeJudgeLabels(judge: JudgeLike): { labels: string[]; requiresHuman: boolean } {
  const labels = [...judge.labels]
  if (judge.outcome === 'needs-human' && !labels.includes('needs-human')) labels.push('needs-human')
  // Phase 1：任何執行過的終點都要人審；blocked-in-loop 已在 apply-score-labels 留言
  const requiresHuman = judge.outcome !== 'blocked-in-loop'
  return { labels, requiresHuman }
}

export function buildJudgeComment(outcome: string, summary: string): string {
  const lines = [`## 工廠執行結果：${outcome}`, '', summary]
  if (outcome === 'ready-to-automerge') lines.push('', PHASE1_HUMAN_REVIEW_NOTE)
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
  const [issueNumber, judgePath] = argv
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  if (judgePath === undefined) throw new CliError('judgePath is required')

  const parsed = JudgeSchema.safeParse(JSON.parse(readFileSync(judgePath, 'utf8')))
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CliError(`judge (${judgePath}) is invalid: ${detail}`)
  }

  const { labels } = computeJudgeLabels(parsed.data.result)
  gh(['issue', 'edit', issueNumber, '--add-label', labels.join(',')])
  gh([
    'issue',
    'comment',
    issueNumber,
    '--body',
    buildJudgeComment(parsed.data.result.outcome, parsed.data.result.summary),
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
