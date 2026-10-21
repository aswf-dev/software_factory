/**
 * factory-graph — 把「一個系統的流程現況」輸出成 JSON（ADR-023 附錄 B）。
 *
 * 用法：
 *   factory-graph --repo owner/name [--system name] [--process processes/<system>.yaml]
 *                 [--modules path/to/factory/process.yaml] [--tracking-issue <n>]
 *                 [--limit 200] [--generated-at <ISO8601>]
 *
 * 資料來源全部是既有的：Issue（body／label／state）、可選的 process.yaml／模組清單、
 * 以及導入追蹤 Issue 上的 HG 簽核留言（`src/hg/parse.ts`）。本 CLI **不做任何推導**，
 * 只組裝；`warnings` 是 advisory，不得被當成閘門（ADR-024 §4）。
 *
 * 輸出契約見 `docs/research/55-workflow-topology-ui.md` 附錄 B；
 * canonical fixture 在 `docs/research/fixtures/factory-graph.sample.json`（供 Scoreboard 使用）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { buildGraph } from '../graph/build.js'
import type { GraphDocument, IssueInput, PullRequestInput } from '../graph/build.js'
import type { ModuleEntry, ProcessSpec, Template } from '../process/spec.js'
import type { GateReport, GateStatus } from '../hg/parse.js'
import { parseComments, resolveSignerPermissions } from './factory-hg.js'
import { TRACKED_GATE_IDS, gateReport, signersOf } from '../hg/parse.js'
import type { GateId } from '../hg/parse.js'
import { loadModuleSpec, loadProcessSpec, loadTemplate } from '../process/spec.js'

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

export interface GraphDeps {
  gh: GhRunner
  readFile: (path: string) => string
  now: () => string
}

/* v8 ignore start -- 真實環境的薄包裝：單元測試一律注入 fake */
const realDeps: GraphDeps = {
  gh: (args) => execFileSync('gh', args, { encoding: 'utf8' }),
  readFile: (path) => readFileSync(path, 'utf8'),
  now: () => new Date().toISOString(),
}
/* v8 ignore stop */

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

const GhLabelSchema = z.object({ name: z.string() })
const GhIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(GhLabelSchema),
  state: z.string(),
})
const GhIssueListSchema = z.array(GhIssueSchema)

const GhPrSchema = z.object({
  number: z.number(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergedAt: z.string().nullable(),
  headRefName: z.string(),
  body: z.string().nullable(),
})
const GhPrListSchema = z.array(GhPrSchema)

/** `buildGraph` 的完整輸入；也是 `factory-snapshot` 餵給 `factory-next` 的同一份資料。 */
export interface GraphInputs {
  system: string
  issues: IssueInput[]
  pullRequests?: readonly PullRequestInput[] | undefined
  modules?: readonly ModuleEntry[] | undefined
  process?: ProcessSpec | undefined
  /** 由 `--template` 載入的模板（`factory-snapshot` 需要它驗證 process）。 */
  template?: Template | undefined
  gates?: readonly GateStatus[] | undefined
  /** 閘門留言的 advisory（例如無簽核權限而被忽略的簽核）；`factory-snapshot` 會帶進 warnings。 */
  gateWarnings?: readonly string[] | undefined
  generatedAt: string
  github: string
}

export interface GraphOptions {
  repo: string
  system: string
  processPath?: string | undefined
  modulesPath?: string | undefined
  /** `templates/<tenant>/<name>.yaml`（preset 為 `templates/factory/S|M|L.yaml`）；used by factory-snapshot. */
  templatePath?: string | undefined
  /** Offline mode: read the `gh issue list` JSON from a file instead of calling gh. */
  issuesPath?: string | undefined
  /** Offline mode: read the `gh api …/comments` JSON pages from a file instead of calling gh. */
  commentsPath?: string | undefined
  /** Offline mode: read the `gh pr list` JSON from a file instead of calling gh. */
  prsPath?: string | undefined
  trackingIssue?: number | undefined
  limit: number
  generatedAt?: string | undefined
  /**
   * 簽核者權限（#126）：`resolve`＝以 collaborator permission API 查每位簽核者的 repo 權限；
   * `association`＝只看留言的 author_association。線上讀取預設 `resolve`；`--comments-file`
   * 離線模式預設 `association`（合成樣本沒有真的 repo 可查），真實系統的快照需明確指定 `resolve`。
   */
  signerPermissions?: 'resolve' | 'association' | undefined
}

export function parseOptions(argv: readonly string[]): GraphOptions {
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

  const limitRaw = values.get('limit') ?? '200'
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) <= 0) {
    throw new CliError(`--limit 必須是正整數：${limitRaw}`)
  }

  const trackingRaw = values.get('tracking-issue')
  let trackingIssue: number | undefined
  if (trackingRaw !== undefined) {
    if (!/^\d+$/.test(trackingRaw) || Number(trackingRaw) <= 0) {
      throw new CliError(`--tracking-issue 必須是正整數：${trackingRaw}`)
    }
    trackingIssue = Number(trackingRaw)
  }

  const options: GraphOptions = {
    repo,
    system: values.get('system') ?? repo,
    limit: Number(limitRaw),
  }
  const processPath = values.get('process')
  if (processPath !== undefined) options.processPath = processPath
  const modulesPath = values.get('modules')
  if (modulesPath !== undefined) options.modulesPath = modulesPath
  const templatePath = values.get('template')
  if (templatePath !== undefined) options.templatePath = templatePath
  const issuesPath = values.get('issues-file')
  if (issuesPath !== undefined) options.issuesPath = issuesPath
  const commentsPath = values.get('comments-file')
  if (commentsPath !== undefined) options.commentsPath = commentsPath
  const signerPermissions = values.get('signer-permissions')
  if (signerPermissions !== undefined) {
    if (signerPermissions !== 'resolve' && signerPermissions !== 'association') {
      throw new CliError(`--signer-permissions 只接受 resolve 或 association：${signerPermissions}`)
    }
    options.signerPermissions = signerPermissions
  }
  const prsPath = values.get('prs-file')
  if (prsPath !== undefined) options.prsPath = prsPath
  if (trackingIssue !== undefined) options.trackingIssue = trackingIssue
  const generatedAt = values.get('generated-at')
  if (generatedAt !== undefined) options.generatedAt = generatedAt
  return options
}

/** 把 `gh issue list --json` 的輸出轉成圖的輸入。 */
export function parseIssues(raw: string): IssueInput[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new CliError('Issue 清單 JSON 無法解析')
  }
  const parsed = GhIssueListSchema.safeParse(json)
  if (!parsed.success) throw new CliError(`Issue 清單結構不符：${parsed.error.message}`)
  return parsed.data.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
    state: issue.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
  }))
}

/** 把 `gh pr list --json` 的輸出轉成完成判定需要的欄位。 */
export function parsePullRequests(raw: string): PullRequestInput[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new CliError('PR 清單 JSON 無法解析')
  }
  const parsed = GhPrListSchema.safeParse(json)
  if (!parsed.success) throw new CliError(`PR 清單結構不符：${parsed.error.message}`)
  return parsed.data.map((pr) => ({
    number: pr.number,
    state: pr.state,
    mergedAt: pr.mergedAt,
    headRefName: pr.headRefName,
    body: pr.body ?? '',
  }))
}

function loadOrThrow<T extends { ok: boolean; errors: string[] }>(result: T, what: string): T {
  if (!result.ok) throw new CliError(`${what}：${result.errors.join('; ')}`)
  return result
}

/**
 * 取數（Issue／process.yaml／模組清單／HG 留言），不組裝圖。
 *
 * 抽出來的理由：`factory-snapshot` 需要同一份輸入同時餵給 `factory-graph` 與
 * `factory-next`；重複一份 gh 呼叫程式碼會讓兩支 CLI 的資料來源分岔。
 */
export function collectInputs(options: GraphOptions, deps: GraphDeps): GraphInputs {
  // `--issues-file`／`--comments-file` 是離線模式：CI 對合成系統（沒有真的 repo）
  // 也能產生快照，測試也不必mock gh。資料格式與 gh 的輸出相同。
  const issues = parseIssues(
    options.issuesPath !== undefined
      ? deps.readFile(options.issuesPath)
      : deps.gh([
          'issue',
          'list',
          '--repo',
          options.repo,
          '--state',
          'all',
          '--limit',
          String(options.limit),
          '--json',
          'number,title,body,labels,state',
        ]),
  )

  const process =
    options.processPath === undefined
      ? undefined
      : loadOrThrow(loadProcessSpec(deps.readFile(options.processPath)), `${options.processPath} 無效`).process

  const modules =
    options.modulesPath === undefined
      ? undefined
      : loadOrThrow(loadModuleSpec(deps.readFile(options.modulesPath)), `${options.modulesPath} 無效`).modules?.modules

  let template: Template | undefined
  if (options.templatePath !== undefined) {
    const loaded = loadTemplate(deps.readFile(options.templatePath))
    if (!loaded.ok) {
      throw new CliError(`${options.templatePath} 無效：${loaded.errors.join('; ')}`)
    }
    /* v8 ignore start -- ok 已保證 template 存在（防守型；不讓型別斷言進入正式路徑） */
    if (loaded.template === undefined) throw new CliError(`${options.templatePath} 無效：template 未解析`)
    /* v8 ignore stop */
    template = loaded.template
  }
  const declaredGates: readonly GateId[] | undefined = template?.gates
  // 模板已宣告 gates 時以它為準：HG7 只適用 P5，沒有宣告卻硬列會讓每個 P0–P4 系統
  // 永遠顯示一個 missing 的鎖（真實租戶就是這樣）。validateTemplate 已保證必要閘門存在。
  const expectedGates: readonly GateId[] = declaredGates ?? TRACKED_GATE_IDS

  let report: GateReport | undefined
  if (options.trackingIssue !== undefined) {
    const comments = parseComments(
      options.commentsPath !== undefined
        ? deps.readFile(options.commentsPath)
        : deps.gh(['api', '--paginate', '--slurp', `repos/${options.repo}/issues/${options.trackingIssue}/comments`]),
    )
    const mode = options.signerPermissions ?? (options.commentsPath !== undefined ? 'association' : 'resolve')
    const resolved =
      mode === 'resolve' ? resolveSignerPermissions(comments, options.repo, deps.gh) : { comments, warnings: [] }
    const gateResult = gateReport(resolved.comments, expectedGates, 'system', declaredGates, signersOf(template?.gate_defs))
    report = { gates: gateResult.gates, warnings: [...resolved.warnings, ...gateResult.warnings] }
  }
  const gates = report?.gates

  // 離線 issues 模式（合成系統）預設沒有 PR；要納入 PR 就另外給 --prs-file。
  const pullRequests =
    options.prsPath !== undefined
      ? parsePullRequests(deps.readFile(options.prsPath))
      : options.issuesPath !== undefined
        ? []
        : parsePullRequests(
            deps.gh([
              'pr',
              'list',
              '--repo',
              options.repo,
              '--state',
              'all',
              '--limit',
              String(options.limit),
              '--json',
              'number,state,mergedAt,headRefName,body',
            ]),
          )

  return {
    system: options.system,
    issues,
    pullRequests,
    modules,
    process,
    template,
    gates,
    gateWarnings: report?.warnings,
    generatedAt: options.generatedAt ?? deps.now(),
    github: options.repo,
  }
}

export function graph(options: GraphOptions, deps: GraphDeps): GraphDocument {
  return buildGraph(collectInputs(options, deps))
}

export function main(argv: readonly string[], deps: GraphDeps = realDeps): GraphDocument {
  return graph(parseOptions(argv), deps)
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
