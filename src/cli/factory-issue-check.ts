/**
 * factory-issue-check — Issue 格式檢查器（零 LLM 成本，事前攔截格式不合的工作項）。
 *
 * 背景：現行流程的「缺驗收條件」檢查由 agent 在執行中做（SR4 停手）——那是事後、
 * 且已花費一次 LLM run。此 CLI 把檢查提前到「開 Issue 時」：解析 factory-work-item
 * 表單（.github/ISSUE_TEMPLATE/factory-work-item.yml）產生的結構化 body，
 * 確認必填欄位（任務類型 / 需求 / DoD）齊全，零 LLM 成本。
 *
 * 輸入：`gh issue view <n> --json body` 的 body（表單欄位格式 `### <id>\n\n<值>`）。
 * 輸出：CheckResult（ok + 缺失欄位清單）。
 *
 * 純函式可單元測試；gh 呼叫以注入（GhRunner）取代（模式同 factory-rescore）。
 */
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

/** 表單必填欄位（與 ISSUE_TEMPLATE/factory-work-item.yml 對齊）。 */
export const REQUIRED_FIELDS = ['task_type', 'requirement', 'acceptance'] as const
export type RequiredField = (typeof REQUIRED_FIELDS)[number]

/** 欄位 id → 表單產生的 body 標題（GitHub Issue Forms 用 label 文字當 `###` 標題）。 */
export const FIELD_TITLES: Record<string, string> = {
  task_type: '任務類型',
  requirement: '需求描述（PRD）',
  acceptance: '驗收標準（DoD）',
}

export interface CheckResult {
  ok: boolean
  missing: RequiredField[]
  taskType?: string | undefined
}

/** 從表單 body 抽取欄位值：`### <欄位標題>\n\n<值>`（值為首個非空段落）。 */
export function extractField(body: string, field: string): string | undefined {
  const title = FIELD_TITLES[field]
  if (title === undefined) return undefined
  const re = new RegExp(`###\\s*${title}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`)
  const m = body.match(re)
  if (!m) return undefined
  const value = m[1]?.trim()
  return value && value.length > 0 ? value : undefined
}

/** DoD 欄位是否「有勾選」（含 `- [x]` 且非空；表單必填勾選項在未勾時不存在）。 */
export function hasCheckedAcceptance(body: string): boolean {
  const value = extractField(body, 'acceptance')
  if (value === undefined) return false
  // 表單產生的 DoD：未勾選項目不輸出；有任一 `- [x]` 即視為有 DoD 勾選
  if (value.includes('[x]')) {
    return true
  }
  return false
}

export function checkIssue(body: string): CheckResult {
  const missing: RequiredField[] = []
  if (extractField(body, 'task_type') === undefined) missing.push('task_type')
  if (extractField(body, 'requirement') === undefined) missing.push('requirement')
  if (!hasCheckedAcceptance(body)) missing.push('acceptance')
  return {
    ok: missing.length === 0,
    missing,
    taskType: extractField(body, 'task_type'),
  }
}

export function buildCheckComment(r: CheckResult): string {
  if (r.ok) {
    // ok=true 時 checkIssue 保證 taskType 有值（缺欄位時 ok=false）
    return (
      '✅ **Issue 格式合規**（factory-issue-check）：' +
      `任務類型 \`${r.taskType}\`、需求、DoD 齊全。` +
      '可 dispatch（software_factory → Actions → Factory Run，或貼 `factory/approved` label 由同 repo 自動觸發）。'
    )
  }
  return (
    '❌ **Issue 格式不合規**（factory-issue-check）：缺 ' +
    r.missing.map((f) => `\`${f}\``).join('、') +
    '。請依 `.github/ISSUE_TEMPLATE/factory-work-item.yml` 表單補齊後再編輯 Issue（編輯會重新檢查）。'
  )
}

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
/* v8 ignore stop */

export function main(
  argv: string[],
  gh: GhRunner = realGh,
): { issueNumber: string; result: CheckResult; comment: string } {
  const [issueNumber] = argv
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  const json = gh(['issue', 'view', issueNumber, '--json', 'body'])
  let body: string
  try {
    body = (JSON.parse(json) as { body: unknown }).body as string
  } catch {
    throw new CliError(`issue view JSON invalid: ${json.slice(0, 80)}`)
  }
  const result = checkIssue(body)
  return { issueNumber, result, comment: buildCheckComment(result) }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const { issueNumber, result, comment } = main(process.argv.slice(2))
    process.stdout.write(comment + '\n')
    // 不合規 → exit 1（workflow 可據此在 Issue 留言後停止，避免繼續流程）
    if (!result.ok) process.exitCode = 1
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
