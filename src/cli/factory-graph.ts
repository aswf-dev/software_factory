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
import type { GraphDocument, IssueInput } from '../graph/build.js'
import { parseComments } from './factory-hg.js'
import { gateReport } from '../hg/parse.js'
import { loadModuleSpec, loadProcessSpec } from '../process/spec.js'

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

export interface GraphOptions {
  repo: string
  system: string
  processPath?: string | undefined
  modulesPath?: string | undefined
  trackingIssue?: number | undefined
  limit: number
  generatedAt?: string | undefined
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

function loadOrThrow<T extends { ok: boolean; errors: string[] }>(result: T, what: string): T {
  if (!result.ok) throw new CliError(`${what}：${result.errors.join('; ')}`)
  return result
}

export function graph(options: GraphOptions, deps: GraphDeps): GraphDocument {
  const issues = parseIssues(
    deps.gh([
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

  const gates =
    options.trackingIssue === undefined
      ? undefined
      : gateReport(
          parseComments(
            deps.gh([
              'api',
              '--paginate',
              '--slurp',
              `repos/${options.repo}/issues/${options.trackingIssue}/comments`,
            ]),
          ),
        ).gates

  return buildGraph({
    system: options.system,
    issues,
    modules,
    process,
    gates,
    generatedAt: options.generatedAt ?? deps.now(),
    github: options.repo,
  })
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
