/**
 * factory-hg — 讀出「導入追蹤 Issue」上的人類閘門（HG）簽核狀態（docs/29 §8.1；ADR-024）。
 *
 * 用法：
 *   factory-hg show --repo owner/name --issue 12 [--gates HG1,HG2] [--scope system]
 *                    [--template templates/factory/M.yaml]   # 讓租戶自訂閘門可被辨識
 *
 * 輸出（JSON）：
 *   { repo, issue, scope, gates: [{id, scope, state, signed_by?, signed_at?, evidence?}], warnings[] }
 *
 * **刻意不做的事**：不改任何狀態、不貼 label、不觸發派工。它只讀留言並化簡成狀態，
 * 供 `factory-graph` 與拓撲 UI 使用。要不要拿它當閘門，是呼叫端的決定（ADR-024 §4）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { CUSTOM_GATE_PATTERN, HG_IDS, TRACKED_GATE_IDS, gateReport, hasGateMarker, isBotAuthor, signersOf } from '../hg/parse.js'
import type { GateId, GateReport, HgComment } from '../hg/parse.js'
import { loadTemplate } from '../process/spec.js'

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
const realReadFile = (path: string): string => readFileSync(path, 'utf8')
/* v8 ignore stop */

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

const GhCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
  author_association: z.string().optional(),
})

/** `gh api --paginate --slurp` 的輸出：每一頁一個陣列。 */
const GhCommentsPagesSchema = z.array(z.array(GhCommentSchema))

export interface HgShowOptions {
  repo: string
  issue: number
  gates: readonly GateId[]
  scope: string
  /** README：模板路徑；提供時，模板宣告的自訂閘門才會被辨識。 */
  templatePath?: string
}

export interface HgShowResult extends GateReport {
  repo: string
  issue: number
  scope: string
}

export function parseOptions(argv: readonly string[]): HgShowOptions {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (!arg.startsWith('--')) throw new CliError(`無法辨識的參數：${arg}`)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new CliError(`${arg} 需要一個值`)
    values.set(arg.slice(2), next)
    i += 1
  }

  const repo = values.get('repo')
  if (repo === undefined) throw new CliError('缺少 --repo owner/name')
  if (!REPO_PATTERN.test(repo)) throw new CliError(`--repo 格式不正確：${repo}`)

  const rawIssue = values.get('issue')
  if (rawIssue === undefined) throw new CliError('缺少 --issue <number>')
  if (!/^\d+$/.test(rawIssue)) throw new CliError(`--issue 必須是正整數：${rawIssue}`)
  const issue = Number(rawIssue)
  if (issue <= 0) throw new CliError(`--issue 必須是正整數：${rawIssue}`)

  const rawGates = values.get('gates')
  const gates = rawGates === undefined ? TRACKED_GATE_IDS : parseGateList(rawGates)

  const scope = values.get('scope') ?? 'system'
  if (scope.trim().length === 0) throw new CliError('--scope 不可為空')

  const options: HgShowOptions = { repo, issue, gates, scope }
  const templatePath = values.get('template')
  if (templatePath !== undefined) options.templatePath = templatePath
  return options
}

function parseGateList(raw: string): GateId[] {
  const ids: GateId[] = []
  for (const token of raw.split(',')) {
    const id = token.trim()
    if (id.length === 0) continue
    const isHg = (HG_IDS as readonly string[]).includes(id)
    if (!isHg && !CUSTOM_GATE_PATTERN.test(id)) throw new CliError(`未知的閘門 id：${id}`)
    if (!ids.includes(id as GateId)) ids.push(id as GateId)
  }
  if (ids.length === 0) throw new CliError('--gates 至少要指定一個閘門')
  return ids
}

/** 把 `gh api --paginate --slurp` 的多頁輸出攤平為留言清單。 */
export function parseComments(raw: string): HgComment[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new CliError('留言 JSON 無法解析')
  }
  const pages = GhCommentsPagesSchema.safeParse(json)
  if (!pages.success) throw new CliError(`留言 JSON 結構不符：${pages.error.message}`)

  const comments: HgComment[] = []
  for (const page of pages.data) {
    for (const item of page) {
      comments.push({
        id: item.id,
        body: item.body ?? '',
        author: item.user?.login ?? '',
        createdAt: item.created_at,
        ...(item.author_association !== undefined ? { association: item.author_association } : {}),
      })
    }
  }
  return comments
}

/**
 * 為帶簽核標記的留言補上作者的 repo 權限（#126）。
 *
 * `author_association` 對不公開的組織成員會依讀取者回 `NONE`（App token 讀到的就是 NONE），
 * 不能單獨用來判斷簽核資格。改查 `GET /repos/{repo}/collaborators/{login}/permission`：
 * GitHub App 安裝 token 只需 Metadata read（docs: permissions-required-for-github-apps）。
 *
 * - 每位作者只查一次；bot 與沒有標記的留言不查。
 * - 404（帳號不存在或對 repo 無任何權限）→ `none`，是明確的「沒有權限」。
 * - 其他失敗（例如 403）→ 不填，`isAuthorizedSigner` 退回 `author_association`；
 *   失敗原因寫進回傳的 warnings，讓快照看得出是查不到而不是被拒。
 */
export function resolveSignerPermissions(
  comments: readonly HgComment[],
  repo: string,
  gh: GhRunner,
): { comments: HgComment[]; warnings: string[] } {
  const warnings: string[] = []
  const permissionOf = new Map<string, string | undefined>()
  for (const comment of comments) {
    if (!hasGateMarker(comment.body) || isBotAuthor(comment.author) || comment.author === '') continue
    if (permissionOf.has(comment.author)) continue
    try {
      const raw = gh(['api', `repos/${repo}/collaborators/${comment.author}/permission`, '--jq', '.permission']).trim()
      permissionOf.set(comment.author, raw === '' ? undefined : raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(message)) {
        permissionOf.set(comment.author, 'none')
      } else {
        permissionOf.set(comment.author, undefined)
        // execFileSync 的第一行是「Command failed: …」，原因（含 HTTP 狀態）在 stderr 那幾行。
        const lines = message.split('\n').map((line) => line.trim()).filter((line) => line !== '')
        const reason = lines.find((line) => /HTTP \d{3}/.test(line)) ?? lines[0] ?? message
        warnings.push(`查不到 ${comment.author} 對 ${repo} 的權限（${reason}），改以 author_association 判斷`)
      }
    }
  }
  return {
    comments: comments.map((comment) => {
      const permission = permissionOf.get(comment.author)
      return permission === undefined ? comment : { ...comment, permission }
    }),
    warnings,
  }
}

export function show(
  options: HgShowOptions,
  gh: GhRunner,
  readFile: (path: string) => string = realReadFile,
): HgShowResult {
  let declaredGates: readonly GateId[] | undefined
  let signers: ReturnType<typeof signersOf> | undefined
  if (options.templatePath !== undefined) {
    const loaded = loadTemplate(readFile(options.templatePath))
    if (!loaded.ok || loaded.template === undefined) {
      throw new CliError(`${options.templatePath} 無效：${loaded.errors.join('; ')}`)
    }
    declaredGates = loaded.template.gates
    signers = signersOf(loaded.template.gate_defs)
  }

  const expected =
    declaredGates === undefined
      ? options.gates
      : [...new Set([...options.gates, ...declaredGates])]

  const raw = gh([
    'api',
    '--paginate',
    '--slurp',
    `repos/${options.repo}/issues/${options.issue}/comments`,
  ])
  const resolved = resolveSignerPermissions(parseComments(raw), options.repo, gh)
  const report = gateReport(resolved.comments, expected, options.scope, declaredGates, signers)
  return {
    repo: options.repo,
    issue: options.issue,
    scope: options.scope,
    gates: report.gates,
    warnings: [...resolved.warnings, ...report.warnings],
  }
}

export function main(
  argv: readonly string[],
  gh: GhRunner = realGh,
  readFile: (path: string) => string = realReadFile,
): HgShowResult {
  return show(parseOptions(argv), gh, readFile)
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
