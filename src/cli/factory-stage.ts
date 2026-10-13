/**
 * factory-stage — 依序模式的「階段完成」判定與接力（ADR-022）。
 *
 * 一張 Issue 是一個階段；下游 Issue 以「前置工作項」欄位宣告它要等哪些 Issue 完成。
 * 本 CLI 只依 **GitHub 當下的即時狀態**判斷，不採信任何事件內容（webhook 只是觸發）：
 *
 *   prereqs  — 派工時檢查：本 Issue 宣告的前置是否都已完成；未完成就在花 LLM 成本前擋下。
 *   finalize — 某張 Issue 的 PR 合併後：判定該階段是否完成；完成就刪落選變體的分支、
 *              通知宣告它為前置的下游 Issue；兩個變體各合併一部分時請人裁決。
 *
 * 完成的判定（Q4、Q11）：
 *   - Issue 有 `stage/done` 標籤 → 完成（人工覆寫）；
 *   - 恰好一組（變體 a、b，或沒有變體代號的單一交付）有已合併的 PR，且該組沒有開著的 PR
 *     → 完成，勝者就是這一組。人接手修好再合併也算（只看合併，不看機器終態）；
 *   - 兩組以上都有已合併的 PR → mixed，機器不替人猜，請人貼 `stage/done`；
 *   - 其他 → 尚未完成。被關閉而未合併的 PR 不計（stacked PR 重建、落選方關閉都屬此類）。
 *
 * 所有 gh 呼叫經注入的 runner，單元測試以 fake runner 驗證每一個寫入動作。
 */
import { execFileSync } from 'node:child_process'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { parsePrerequisites, reviewPrerequisites } from './factory-issue-check.js'

/** 人工覆寫：前置已完成（Q4）。由人貼上，工廠只建立不發射。 */
export const STAGE_DONE_LABEL = 'stage/done'

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export interface PrInfo {
  number: number
  headRefName: string
  state: PrState
}

/** a／b＝N-version 變體；single＝沒有變體代號的交付（關閉 N-version 前的舊單、人工分支）。 */
export type Group = 'a' | 'b' | 'single'

/** PR 所屬的組；不屬於本 Issue（前綴不符，例如 7210 對 721）回 undefined。 */
export function groupOf(issue: number, head: string): Group | undefined {
  const prefix = `factory/${issue}-`
  if (!head.startsWith(prefix)) return undefined
  const m = head.slice(prefix.length).match(/^(a|b)-/)
  return m === null ? 'single' : (m[1] as Group)
}

export type StageState = 'complete' | 'in-progress' | 'mixed' | 'not-started'
export interface StageStatus {
  state: StageState
  winner?: Group | undefined
  override: boolean
}

export function stageStatus(issue: number, prs: PrInfo[], labels: string[]): StageStatus {
  if (labels.includes(STAGE_DONE_LABEL)) return { state: 'complete', override: true }
  const tally = new Map<Group, { merged: number; open: number }>()
  for (const pr of prs) {
    const g = groupOf(issue, pr.headRefName)
    if (g === undefined) continue
    const t = tally.get(g) ?? { merged: 0, open: 0 }
    if (pr.state === 'MERGED') t.merged++
    if (pr.state === 'OPEN') t.open++
    tally.set(g, t)
  }
  const withMerged = [...tally].filter(([, t]) => t.merged > 0)
  if (withMerged.length > 1) return { state: 'mixed', override: false }
  const [only] = withMerged
  if (only !== undefined) {
    const [g, t] = only
    return t.open > 0 ? { state: 'in-progress', winner: g, override: false } : { state: 'complete', winner: g, override: false }
  }
  const anyOpen = [...tally.values()].some((t) => t.open > 0)
  return { state: anyOpen ? 'in-progress' : 'not-started', override: false }
}

/**
 * 可安全刪除的落選分支：以落選變體前綴開頭，且**不是**任何開著或已合併 PR 的 head。
 * 勝者不是 a／b（單一交付或人工覆寫）時沒有落選方。
 */
export function loserBranches(issue: number, winner: Group | undefined, branches: string[], prs: PrInfo[]): string[] {
  if (winner !== 'a' && winner !== 'b') return []
  const loser = winner === 'a' ? 'b' : 'a'
  const live = new Set(prs.filter((p) => p.state !== 'CLOSED').map((p) => p.headRefName))
  return branches.filter((b) => groupOf(issue, b) === loser && !live.has(b))
}

/** 宣告本 Issue 為前置的 open Issue（以 `parsePrerequisites` 精確判定，不靠全文搜尋）。 */
export function downstreamIssues(issue: number, open: { number: number; body: string }[]): number[] {
  return open.filter((i) => i.number !== issue && parsePrerequisites(i.body).includes(issue)).map((i) => i.number)
}

export const prereqDoneMarker = (issue: number): string => `<!-- factory:prereq-done issue=${issue} -->`
export const STAGE_MIXED_MARKER = '<!-- factory:stage-mixed -->'

const STATE_TEXT: Record<StageState, string> = {
  complete: '✅ 已完成',
  'in-progress': '⏳ 進行中（還有開著的 PR）',
  mixed: '⚠️ 兩個變體各合併了一部分，需人工貼 `stage/done`',
  'not-started': '⏳ 尚未合併任何交付',
}

export interface PrereqCheck {
  blocked: boolean
  comment?: string | undefined
}

/** 派工時的前置檢查結果（Q12：未完成即擋下，不貼 needs-human，不提供略過 input）。 */
export function evaluatePrereqs(
  review: ReturnType<typeof reviewPrerequisites>,
  results: { issue: number; status: StageStatus | undefined }[],
): PrereqCheck {
  const pending = results.filter((r) => r.status?.state !== 'complete')
  if (review.malformed.length === 0 && review.selfRefs.length === 0 && pending.length === 0) return { blocked: false }
  const lines = ['## 🧭 前置工作項尚未完成——停止派工', '', '本次執行在呼叫 LLM 之前停止，沒有產生任何費用（ADR-022）。', '']
  if (review.malformed.length > 0) {
    lines.push(`- 「前置工作項」欄位含無法解析的內容：${review.malformed.map((t) => `\`${t}\``).join('、')}。只接受同一個 repo 的 \`#N\`。`)
  }
  if (review.selfRefs.length > 0) lines.push(`- 前置指向本 Issue 自己（${review.selfRefs.map((n) => `#${n}`).join('、')}）。`)
  if (pending.length > 0) {
    lines.push('', '| 前置 | 狀態 |', '| :--- | :--- |')
    for (const r of pending) lines.push(`| #${r.issue} | ${r.status === undefined ? '❌ 找不到這張 Issue' : STATE_TEXT[r.status.state]} |`)
  }
  lines.push('', '前置完成後重新派工即可。若確定不需要等待，請把本 Issue 的「前置工作項」欄位清空後再派工——這樣會留下紀錄。')
  return { blocked: true, comment: lines.join('\n') }
}

/** gh CLI 的注入點；失敗時丟出例外（與 execFileSync 相同）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
/* v8 ignore stop */

function json<T>(raw: string): T {
  return JSON.parse(raw) as T
}

function readStage(gh: GhRunner, repo: string, issue: number): { status: StageStatus | undefined; prs: PrInfo[] } {
  let labels: string[]
  try {
    labels = json<{ labels: { name: string }[] }>(gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'labels'])).labels.map((l) => l.name)
  } catch {
    return { status: undefined, prs: [] }
  }
  // search 的 head: 是模糊比對，groupOf 再以前綴精確過濾（7210 對 721）
  const prs = json<PrInfo[]>(
    gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--search', `head:factory/${issue}-`, '--json', 'number,headRefName,state']),
  ).filter((p) => groupOf(issue, p.headRefName) !== undefined)
  return { status: stageStatus(issue, prs, labels), prs }
}

function hasComment(gh: GhRunner, repo: string, issue: number, marker: string): boolean {
  const { comments } = json<{ comments: { body: string }[] }>(gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'comments']))
  return comments.some((c) => c.body.includes(marker))
}

export function runPrereqs(gh: GhRunner, repo: string, issue: number): PrereqCheck {
  const { body, title } = json<{ body: string; title: string }>(gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'body,title']))
  const review = reviewPrerequisites(body, title)
  const results = review.ids.filter((id) => !review.selfRefs.includes(id)).map((id) => ({ issue: id, status: readStage(gh, repo, id).status }))
  return evaluatePrereqs(review, results)
}

export interface FinalizeResult {
  onboarded: boolean
  state?: StageState | undefined
  winner?: Group | undefined
  deleted: string[]
  notified: number[]
  askedForOverride: boolean
}

export function runFinalize(gh: GhRunner, repo: string, issue: number, dryRun: boolean): FinalizeResult {
  const result: FinalizeResult = { onboarded: false, deleted: [], notified: [], askedForOverride: false }
  // 允許清單（Q34 第 4 項）：以即時狀態判斷，不採信 aswf.dev 的 knownRepos
  try {
    gh(['api', `repos/${repo}/contents/catalog-info.yaml?ref=software-factory`, '--silent'])
  } catch {
    return result
  }
  result.onboarded = true
  const { status, prs } = readStage(gh, repo, issue)
  if (status === undefined) throw new CliError(`issue #${issue} not found in ${repo}`)
  result.state = status.state
  result.winner = status.winner

  if (status.state === 'mixed') {
    if (!hasComment(gh, repo, issue, STAGE_MIXED_MARKER)) {
      result.askedForOverride = true
      if (!dryRun) {
        gh(['issue', 'comment', String(issue), '--repo', repo, '--body',
          `${STAGE_MIXED_MARKER}\n⚠️ 兩個變體各有 PR 被合併，機器無法判斷本階段是否完成。確認完成後請貼上 \`${STAGE_DONE_LABEL}\` 標籤，下游工作項才會收到通知（ADR-022）。`])
      }
    }
    return result
  }
  if (status.state !== 'complete') return result

  const branches = json<{ ref: string }[]>(gh(['api', `repos/${repo}/git/matching-refs/heads/factory/${issue}-`])).map((r) => r.ref.replace(/^refs\/heads\//, ''))
  result.deleted = loserBranches(issue, status.winner, branches, prs)
  if (!dryRun) for (const b of result.deleted) gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${b}`, '--silent'])

  const open = json<{ number: number; body: string }[]>(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,body']))
  const marker = prereqDoneMarker(issue)
  for (const d of downstreamIssues(issue, open)) {
    if (hasComment(gh, repo, d, marker)) continue
    result.notified.push(d)
    if (!dryRun) {
      gh(['issue', 'comment', String(d), '--repo', repo, '--body',
        `${marker}\n✅ 前置 #${issue} 已完成${status.override ? '（人工標記 `stage/done`）' : ''}，可以派工本工作項（ADR-022）。`])
    }
  }
  return result
}

export function main(argv: string[], gh: GhRunner = realGh): PrereqCheck | FinalizeResult {
  const [command, ...rest] = argv
  let repo: string | undefined
  let issue: number | undefined
  let dryRun = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    const v = rest[++i]
    if (v === undefined) throw new CliError(`${arg} requires a value`)
    if (arg === '--repo') {
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v) || v.includes('..')) throw new CliError(`--repo must be owner/name, got ${v}`)
      repo = v
    } else if (arg === '--issue') {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) throw new CliError(`--issue must be a positive integer, got ${v}`)
      issue = n
    } else throw new CliError(`unknown argument: ${arg}`)
  }
  if (repo === undefined || issue === undefined) throw new CliError('--repo and --issue are required')
  if (command === 'prereqs') return runPrereqs(gh, repo, issue)
  if (command === 'finalize') return runFinalize(gh, repo, issue, dryRun)
  throw new CliError('usage: factory-stage <prereqs|finalize> --repo <owner/name> --issue <n> [--dry-run]')
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`)
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
