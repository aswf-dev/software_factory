/**
 * factory-metrics — 產出型指標（docs/08 §2/§7，Phase 2 T5）。
 *
 * 資料源是 `gh pr list --state merged` 的 JSON（欄位經 gh v2.93.0 驗證，
 * 見 src/integration/gh-parse.ts）。計算：
 *   - Lead Time（平均，小時）：Issue/PR 建立 → 合併（docs/08 §2.1）
 *   - 平均 PR 大小（合併 PR 的 additions）
 *   - 超過自動合併上限的 PR 數（AUTOMERGE_MAX_LINES，docs/06 §4.1）
 *   - 缺陷逃逸數：帶 defect/escape 標籤的合併 PR（docs/14 觀察期機制）
 *
 * 純函式可單元測試；main 的 gh 呼叫以注入（GhRunner）取代。
 */
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { AUTOMERGE_MAX_LINES } from '../scoring/score.js'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export const PrSchema = z.object({
  number: z.number(),
  createdAt: z.string(),
  mergedAt: z.string().nullable().optional(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  labels: z.array(z.object({ name: z.string() })).default([]),
})
export type PrData = z.infer<typeof PrSchema>

export interface Metrics {
  leadTimeHours: number
  avgAdditions: number
  overLimitCount: number
  mergedCount: number
  defectEscapeCount: number
}

export function parsePrs(json: string): PrData[] {
  const parsed = z.array(PrSchema).safeParse(JSON.parse(json))
  if (!parsed.success) {
    throw new CliError(`pr list JSON invalid: ${parsed.error.message}`)
  }
  return parsed.data
}

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
/* v8 ignore stop */

export function computeMetrics(prs: PrData[]): Metrics {
  const merged = prs.filter((p) => p.mergedAt != null)
  const leads = merged.map((p) => (Date.parse(p.mergedAt as string) - Date.parse(p.createdAt)) / 3_600_000)
  const leadTimeHours = leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : 0
  const additions = merged.map((p) => p.additions)
  const avgAdditions = additions.length ? additions.reduce((a, b) => a + b, 0) / additions.length : 0
  const sizes = merged.map((p) => p.additions + p.deletions)
  const defectEscape = merged.filter((p) => p.labels.some((l) => l.name === 'defect/escape'))
  return {
    leadTimeHours,
    avgAdditions,
    overLimitCount: sizes.filter((s) => s > AUTOMERGE_MAX_LINES).length,
    mergedCount: merged.length,
    defectEscapeCount: defectEscape.length,
  }
}

export function renderMarkdown(m: Metrics): string {
  return [
    '## 產出型指標（factory-metrics，docs/08 §2）',
    '',
    `- 合併 PR：${m.mergedCount}`,
    `- 平均 Lead Time：${m.leadTimeHours.toFixed(1)} 小時`,
    `- 平均 PR 大小：${m.avgAdditions.toFixed(0)} 行`,
    `- 超過自動合併上限（${AUTOMERGE_MAX_LINES} 行）的 PR 數：${m.overLimitCount}`,
    `- 缺陷逃逸（defect/escape 標籤）：${m.defectEscapeCount}`,
    '',
  ].join('\n')
}

export function main(argv: string[], gh: GhRunner = realGh): { metrics: Metrics; markdown: string } {
  const [limitArg] = argv
  const limit = limitArg !== undefined ? Number(limitArg) : 100
  if (!Number.isInteger(limit) || limit <= 0) throw new CliError(`limit must be a positive integer, got ${String(limitArg)}`)

  const json = gh(['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,createdAt,mergedAt,additions,deletions,labels'])
  const prs = parsePrs(json)
  const metrics = computeMetrics(prs)
  return { metrics, markdown: renderMarkdown(metrics) }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const { metrics, markdown } = main(process.argv.slice(2))
    process.stdout.write(markdown + '\n')
    process.stdout.write(JSON.stringify(metrics, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
