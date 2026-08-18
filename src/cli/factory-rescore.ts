/**
 * factory-rescore — PR 事件觸發的二次判定（docs/06 §5.3, Q06-5）。
 *
 * 在 PR 更新時獨立重計分：讀 PR 變更檔 → 依目標 repo 的 catalog/risk-paths 計分 →
 * 與 Issue 上的初始 oversight/* 標籤比較 → 單向升級（rescore）→ 輸出判定與留言。
 *
 * 目的：攔截「描述低風險但實際改到高風險」的升級（docs/06 §5.3 的單向棘輪）。
 * 判定邏輯全部重用既有 src/scoring（100% 測試），本 CLI 只做資料搬運與比較。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { score } from '../scoring/score.js'
import { TIER_LABEL } from '../scoring/types.js'
import type { HardRuleId, OversightTier } from '../scoring/types.js'
import { loadScoreInput } from './factory-score.js'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

const PrInfoSchema = z.object({
  number: z.number(),
  headRefName: z.string(),
  files: z.array(z.object({ path: z.string() })),
  body: z.string().nullable().optional(),
})

export interface PrInfo {
  number: number
  headRefName: string
  files: string[]
  body?: string | null | undefined
}

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
/* v8 ignore stop */

export function parsePrInfo(json: string): PrInfo {
  const parsed = PrInfoSchema.safeParse(JSON.parse(json))
  if (!parsed.success) throw new CliError(`pr info invalid: ${parsed.error.message}`)
  return { ...parsed.data, files: parsed.data.files.map((f) => f.path) }
}

/** 從 PR body 的 `Closes #N` 或 head 分支 `factory/N-*` 找關聯 Issue。 */
export function findLinkedIssue(pr: PrInfo): number | undefined {
  const fromBody = pr.body?.match(/Closes #(\d+)/i)?.[1]
  if (fromBody !== undefined) return Number(fromBody)
  const fromHead = pr.headRefName.match(/factory\/(\d+)/)?.[1]
  return fromHead !== undefined ? Number(fromHead) : undefined
}

/** 從 Issue 標籤找初始 oversight/* 層級。 */
export function initialTierFromLabels(labels: Array<{ name: string }>): OversightTier | undefined {
  const map: Record<string, OversightTier> = {
    'oversight/on-loop': 'on-loop',
    'oversight/review': 'review',
    'oversight/in-loop': 'in-loop',
  }
  for (const l of labels) {
    const t = map[l.name]
    if (t !== undefined) return t
  }
  return undefined
}

export interface RescoreOutput {
  prNumber: number
  issueNumber?: number | undefined
  before: OversightTier | undefined
  after: OversightTier
  total: number
  triggeredHardRules: HardRuleId[]
  escalated: boolean
}

export function computeRescore(o: Omit<RescoreOutput, 'escalated'>): RescoreOutput {
  // 單向升級：after 高於 before（或 before 未知但觸發硬規則）→ escalated
  const rank: Record<OversightTier, number> = { 'on-loop': 0, review: 1, 'in-loop': 2 }
  const escalated =
    o.before === undefined ? o.triggeredHardRules.length > 0 : rank[o.after] > rank[o.before]
  return { ...o, escalated }
}

export function buildRescoreComment(o: RescoreOutput): string {
  const lines = [
    `## 二次判定：${o.before === undefined ? '（未知）' : TIER_LABEL[o.before]} → ${TIER_LABEL[o.after]}`,
  ]
  if (o.escalated) {
    lines.push(
      '',
      `**監督層級升級**（docs/06 §5.3 單向升級）。計分 ${o.total} 分。` +
        (o.triggeredHardRules.length > 0
          ? `觸發硬性規則：${o.triggeredHardRules.join('、')}`
          : ''),
    )
  } else {
    lines.push('', '監督層級未變。')
  }
  return lines.join('\n')
}

export function main(argv: string[], gh: GhRunner = realGh): RescoreOutput {
  const [prNumber, catalogPath = 'catalog-info.yaml', riskPathsPath = '.github/factory/risk-paths.yml'] = argv
  if (prNumber === undefined) throw new CliError('prNumber is required')

  const pr = parsePrInfo(gh(['pr', 'view', prNumber, '--json', 'number,headRefName,files,body']))
  const issueNumber = findLinkedIssue(pr)

  let before: OversightTier | undefined
  if (issueNumber !== undefined) {
    const issueJson = gh(['issue', 'view', String(issueNumber), '--json', 'labels'])
    const labels = (JSON.parse(issueJson) as { labels: Array<{ name: string }> }).labels
    before = initialTierFromLabels(labels)
  }

  const { annotations, hardRulePatterns } = loadScoreInput(catalogPath, riskPathsPath)
  const updated = score({ annotations, hardRulePatterns, changedPaths: pr.files })

  return computeRescore({
    prNumber: pr.number,
    issueNumber,
    before,
    after: updated.tier,
    total: updated.total,
    triggeredHardRules: updated.triggeredHardRules,
  })
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
