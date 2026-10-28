/**
 * factory-task-template — 決定 agent 收到哪一份 task template（ADR-029 §5；I2）。
 *
 * 模板是 agent 的行為準則（可做什麼、不得做什麼、產出放哪裡）。驗證模式的
 * agent 執行的是**目標 repo** 的程式碼，而目標 repo 的 checkout 內也可能有
 * `.github/factory/task-template-verify-*.txt`——先前 workflow 讓它優先，等於
 * 受測者可以自己寫考卷：一份寫著「可以 push／開 PR／把發現貼上 Issue」的模板
 * 會直接推翻 ADR-029 §5 的「不 push、不寫發現」。因此：
 *
 *   - 驗證模式（`--verify true`）：**一律**用機制 repo（`$GITHUB_WORKSPACE`）的
 *     `.github/factory/task-template-<type>.txt`；目標 repo 的覆寫不讀，機制模板
 *     不存在時 fail closed（不退回目標模板或通用模板）。
 *   - 非驗證模式：維持既有偏好——target 的覆寫模板（agent cwd）→ 機制專屬模板
 *     → 通用 `task-template.txt`（`fallback: true`，workflow 印原有警告）。
 *
 * CLI（workflow 呼叫）：
 *   node dist/cli/factory-task-template.js \
 *     --workspace "$GITHUB_WORKSPACE" --cwd . \
 *     --task-type "$TASK_TYPE" --verify "$VERIFY_MODE"
 * 輸出 JSON：`{ template, source: "target"|"mechanism"|"generic", fallback }`。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

/** task type 的形狀（workflow 已 allowlist；此處防路徑跳脫與拼錯檔名）。 */
const TASK_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/

export interface TaskTemplateOptions {
  /** 機制 repo 根目錄（`$GITHUB_WORKSPACE`）。 */
  workspace: string
  /** agent 的工作目錄（驗證模式是 target/；非驗證模式也是 target/）。 */
  cwd: string
  /** 已解析的 task type（`agent-verify-quint` 等）。 */
  taskType: string
  /** 驗證模式：一律使用機制模板。 */
  verify: boolean
}

export type TaskTemplateSource = 'target' | 'mechanism' | 'generic'

export interface TaskTemplateChoice {
  /** 模板檔案的絕對（或相對於 cwd 的）路徑，直接交給 dsh。 */
  template: string
  source: TaskTemplateSource
  /** true = 專屬模板不存在、退回通用模板（只有非驗證模式會是 true）。 */
  fallback: boolean
}

/** 檔名慣例：`task-template-<type>.txt`（type 無 `agent-` 前綴，docs/09 §3 2.1）。 */
export function templateFileName(taskType: string): string {
  if (!TASK_TYPE_RE.test(taskType)) {
    throw new CliError(`task type 不合法（只接受小寫英數與連字號）：${taskType}`)
  }
  return `task-template-${taskType.replace(/^agent-/, '')}.txt`
}

/** 是否為既有的一般檔案；不存在／是目錄／權限不足都視為 false（不得因此崩潰）。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 選出模板。驗證模式不讀 `cwd`（目標 repo）底下的任何模板：那是受測者可寫的
 * 輸入，不能決定自己的行為準則（I2）。
 */
export function selectTaskTemplate(opts: TaskTemplateOptions): TaskTemplateChoice {
  const file = templateFileName(opts.taskType)
  const mechanism = join(opts.workspace, '.github/factory', file)
  if (opts.verify) {
    if (!isFile(mechanism)) {
      throw new CliError(
        `驗證模式一律使用機制模板 ${mechanism}，但檔案不存在——` +
          '拒絕退回目標 repo 的覆寫模板或通用模板（ADR-029 §5，fail closed）',
      )
    }
    return { template: mechanism, source: 'mechanism', fallback: false }
  }
  const target = join(opts.cwd, '.github/factory', file)
  if (isFile(target)) return { template: target, source: 'target', fallback: false }
  if (isFile(mechanism)) return { template: mechanism, source: 'mechanism', fallback: false }
  // 既有行為：專屬模板缺失時退回通用模板並警告（由呼叫端印既有訊息）。
  return {
    template: join(opts.workspace, '.github/factory/task-template.txt'),
    source: 'generic',
    fallback: true,
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} requires a value`)
  }
  return value
}

/** 解析 CLI 參數：`--workspace`／`--cwd`／`--task-type`／`--verify <true|false>`。 */
export function parseArgs(argv: string[]): TaskTemplateOptions {
  let workspace: string | undefined
  let cwd = '.'
  let taskType: string | undefined
  let verify: boolean | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--workspace') {
      workspace = requireValue(argv, ++i, arg)
    } else if (arg === '--cwd') {
      cwd = requireValue(argv, ++i, arg)
    } else if (arg === '--task-type') {
      taskType = requireValue(argv, ++i, arg)
    } else if (arg === '--verify') {
      const value = requireValue(argv, ++i, arg)
      if (value !== 'true' && value !== 'false') {
        throw new CliError(`--verify must be true or false, got ${value}`)
      }
      verify = value === 'true'
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  if (workspace === undefined) throw new CliError('--workspace is required')
  if (taskType === undefined) throw new CliError('--task-type is required')
  if (verify === undefined) throw new CliError('--verify is required')
  return { workspace, cwd, taskType, verify }
}

export function main(argv: string[]): TaskTemplateChoice {
  return selectTaskTemplate(parseArgs(argv))
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
