/**
 * factory-next — 產生「待開工作項」清單（ADR-024）。
 *
 * **只算、不建立**：不建 Issue、不貼 label、不觸發 workflow。人按下送出之後才走既有的
 * Backstage 表單／issue form（ADR-024 §2）。
 *
 * 用法：
 *   factory-next --repo owner/name --process processes/<system>.yaml \
 *     --modules <factory/process.yaml> [--tracking-issue <n>] [--templates-dir templates]
 *
 * 輸出：`{ system, generated_at, actions[], warnings[] }`（契約見 `src/process/next-actions.ts`）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { parseIssues } from './factory-graph.js'
import { parseComments } from './factory-hg.js'
import { gateReport } from '../hg/parse.js'
import { loadModuleSpec, loadProcessSpec, loadTemplate } from '../process/spec.js'
import type { ModuleSpec, ProcessSpec, Template } from '../process/spec.js'
import { nextActions } from '../process/next-actions.js'
import type { NextActionsDocument } from '../process/next-actions.js'

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

export interface NextDeps {
  gh: GhRunner
  readFile: (path: string) => string
  now: () => string
}

/* v8 ignore start -- 真實環境的薄包裝：單元測試一律注入 fake */
const realDeps: NextDeps = {
  gh: (args) => execFileSync('gh', args, { encoding: 'utf8' }),
  readFile: (path) => readFileSync(path, 'utf8'),
  now: () => new Date().toISOString(),
}
/* v8 ignore stop */

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export interface NextOptions {
  repo: string
  processPath: string
  modulesPath: string
  templatesDir: string
  trackingIssue?: number | undefined
  limit: number
  generatedAt?: string | undefined
}

export function parseOptions(argv: readonly string[]): NextOptions {
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

  const processPath = values.get('process')
  if (processPath === undefined) throw new CliError('缺少 --process <process.yaml>')
  const modulesPath = values.get('modules')
  if (modulesPath === undefined) throw new CliError('缺少 --modules <factory/process.yaml>')

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

  const options: NextOptions = {
    repo,
    processPath,
    modulesPath,
    templatesDir: values.get('templates-dir') ?? 'templates',
    limit: Number(limitRaw),
  }
  if (trackingIssue !== undefined) options.trackingIssue = trackingIssue
  const generatedAt = values.get('generated-at')
  if (generatedAt !== undefined) options.generatedAt = generatedAt
  return options
}

function loadOrThrow<T extends { ok: boolean; errors: string[] }>(result: T, what: string): T {
  if (!result.ok) throw new CliError(`${what}：${result.errors.join('; ')}`)
  return result
}

export function next(options: NextOptions, deps: NextDeps): NextActionsDocument {
  const process = loadOrThrow(
    loadProcessSpec(deps.readFile(options.processPath)),
    `${options.processPath} 無效`,
  ).process as ProcessSpec

  const templatePath = `${options.templatesDir.replace(/\/$/, '')}/${process.template}.yaml`
  const template = loadOrThrow(loadTemplate(deps.readFile(templatePath)), `${templatePath} 無效`)
    .template as Template

  const modules = loadOrThrow(
    loadModuleSpec(deps.readFile(options.modulesPath)),
    `${options.modulesPath} 無效`,
  ).modules as ModuleSpec

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

  const gates =
    options.trackingIssue === undefined
      ? []
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

  return nextActions({
    system: process.system,
    template,
    process,
    modules: modules.modules,
    issues,
    gates,
    generatedAt: options.generatedAt ?? deps.now(),
  })
}

export function main(argv: readonly string[], deps: NextDeps = realDeps): NextActionsDocument {
  return next(parseOptions(argv), deps)
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
