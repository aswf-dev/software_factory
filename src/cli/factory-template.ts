/**
 * factory-template — 讀模板目錄（`templates/index.json`；ADR-025 §2）。
 *
 * 用法：
 *   factory-template list [--root .]
 *   factory-template resolve --root . --id factory/M
 *
 * 輸出（JSON）：`list` 印 `{schema_version, templates:[…]}`；`resolve` 印 `{id, version, path}`。
 *
 * **刻意不做的事**：不改檔案、不發布版本、不審批。它只回答「有哪些模板、某個 id 的檔案在哪」，
 * 供 CI（目錄與檔案一致性）與 Scoreboard（模板目錄）使用。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { loadTemplate } from '../process/spec.js'
import type { Template } from '../process/spec.js'
import {
  findTemplate,
  loadRegistry,
  validateRegistry,
  type TemplateEntry,
  type TemplateRegistry,
} from '../process/registry.js'

export interface TemplateCliDeps {
  readFile: (path: string) => string
  /** 回傳 repo-root 相對路徑（`templates/<tenant>/<name>.yaml`）。 */
  listTemplateFiles: (root: string) => string[]
}

/* v8 ignore start -- 真實檔案系統的薄包裝：單元測試一律注入 fake deps */
const realDeps: TemplateCliDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  listTemplateFiles: (root) => {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && entry.name.endsWith('.yaml')) {
          found.push(relative(root, full).split('\\').join('/'))
        }
      }
    }
    walk(join(root, 'templates'))
    return found
  },
}
/* v8 ignore stop */

export interface TemplateCliOptions {
  command: 'list' | 'resolve'
  root: string
  id?: string
}

export function parseOptions(argv: readonly string[]): TemplateCliOptions {
  const [command, ...rest] = argv
  if (command !== 'list' && command !== 'resolve') {
    throw new CliError(`未知的子命令：${command ?? '(缺少)'}（可用：list、resolve）`)
  }

  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string
    if (!arg.startsWith('--')) throw new CliError(`無法辨識的參數：${arg}`)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) throw new CliError(`${arg} 需要一個值`)
    values.set(arg.slice(2), next)
    i += 1
  }

  const root = values.get('root') ?? '.'
  const options: TemplateCliOptions = { command, root }
  if (command === 'resolve') {
    const id = values.get('id')
    if (id === undefined) throw new CliError('resolve 需要 --id <tenant>/<name>')
    options.id = id
  }
  return options
}

interface Loaded {
  registry: TemplateRegistry
  templates: Map<string, Template>
}

/**
 * 讀目錄、讀所有模板檔，並檢查兩者一致。
 *
 * 任何不一致（目錄有但檔案不存在、版本不同、檔案未列入目錄）都是 CliError：
 * 目錄是「事實」不是「提示」。
 */
export function loadAll(root: string, deps: TemplateCliDeps): Loaded {
  const registryResult = loadRegistry(deps.readFile(`${root}/templates/index.json`))
  if (!registryResult.ok || registryResult.registry === undefined) {
    throw new CliError(`templates/index.json 無效：${registryResult.errors.join('; ')}`)
  }

  const templates = new Map<string, Template>()
  for (const path of deps.listTemplateFiles(root)) {
    const loaded = loadTemplate(deps.readFile(`${root}/${path}`))
    if (!loaded.ok || loaded.template === undefined) {
      throw new CliError(`${path} 無效：${loaded.errors.join('; ')}`)
    }
    templates.set(`${loaded.template.tenant}/${loaded.template.name}`, loaded.template)
  }

  const consistency = validateRegistry(registryResult.registry, templates)
  if (!consistency.ok) {
    throw new CliError(`templates/index.json 與模板檔不一致：${consistency.errors.join('; ')}`)
  }
  return { registry: registryResult.registry, templates }
}

export function list(
  options: TemplateCliOptions,
  deps: TemplateCliDeps,
): { schema_version: 1; templates: TemplateEntry[] } {
  const { registry } = loadAll(options.root, deps)
  return {
    schema_version: 1,
    templates: [...registry.templates].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function resolve(
  options: TemplateCliOptions,
  deps: TemplateCliDeps,
): { id: string; version: number; path: string } {
  const id = options.id as string
  const { registry } = loadAll(options.root, deps)
  const entry = findTemplate(registry, id)
  if (entry === undefined) throw new CliError(`目錄沒有這個模板：${id}`)
  return { id: entry.id, version: entry.version, path: entry.path }
}

export function main(
  argv: readonly string[],
  deps: TemplateCliDeps = realDeps,
): { schema_version: 1; templates: TemplateEntry[] } | { id: string; version: number; path: string } {
  const options = parseOptions(argv)
  return options.command === 'list' ? list(options, deps) : resolve(options, deps)
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
