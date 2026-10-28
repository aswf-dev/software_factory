/**
 * 所有 git 子行程的唯一入口（N1，third fix wave）。
 *
 * 為什麼需要集中：`factory-crosscheck` 與 `factory-verify-encrypt` 都把
 * `git diff` 當成「agent 改了什麼」的事實來源，而 agent 就在 target/ 內有 shell。
 * git 的兩個檔案面可以被 agent 改寫，且預設全部生效：
 *
 *   1. `refs/replace/*`：`git replace <base-sha> <fake-commit>` 之後，`git diff`
 *      會把 base 當成 fake commit 的樹——真正的越界變更（例如 `src/app.ts`）
 *      可以整批消失，白名單與 bundle 範圍同時被繞過。`GIT_NO_REPLACE_OBJECTS=1`
 *      是 git 官方的總開關，關掉後 replace ref 完全不參與物件解析。
 *   2. global／system config：agent 可寫 `$HOME/.gitconfig`，注入 `diff.external`
 *      （偽造 patch 輸出）、`core.pager`、alias 等行為。以
 *      `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_SYSTEM=/dev/null` 讓這兩個
 *      檔案面不存在；`--no-pager`／`--no-ext-diff` 另外擋掉 repo-local config。
 *
 * **不要讓呼叫端自己記得加**：本模組只暴露 `execGit`，環境與旗標在這裡一次組好。
 * 測試（`factory-crosscheck.test.ts`、`test/verify-encrypt.test.ts`）以真實 git
 * repo 驗證 replace ref 與惡意 global config 都無法改變事實輸出。
 */
import { execFileSync, type StdioOptions } from 'node:child_process'

/**
 * 強制覆寫的 git 環境變數：蓋在 caller 的 env 之後，任何呼叫端都無法解除。
 * 值刻意用 `/dev/null`（git 接受空檔作為 config 來源；runner 與 CI 都是 POSIX）。
 */
export const GIT_HARDENING_ENV = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
} as const

/**
 * 會輸出 patch 的子命令：一律加 `--no-ext-diff`，擋掉 repo-local `diff.external`。
 * `--name-only` 本身不走 external diff，但 assertion-count 的 `--unified=0` 會。
 */
const DIFF_OUTPUT_COMMANDS: ReadonlySet<string> = new Set(['diff', 'show'])

/** 以 hardened 環境為底；caller 傳入的 env 不能覆寫三個關鍵值。 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...GIT_HARDENING_ENV }
}

/** 組出 hardened argv：`git --no-pager <cmd> [--no-ext-diff] …`。 */
export function hardenedGitArgs(args: readonly string[]): string[] {
  const command = args[0] as string
  const rest = args.slice(1)
  return DIFF_OUTPUT_COMMANDS.has(command)
    ? ['--no-pager', command, '--no-ext-diff', ...rest]
    : ['--no-pager', command, ...rest]
}

export interface GitExecOptions {
  /** 目標 repo checkout；undefined 時沿用 process.cwd()。 */
  cwd?: string | undefined
  /** 只影響子行程的 stdio；預設同 execFileSync（pipe）。 */
  stdio?: StdioOptions | undefined
}

/**
 * 執行一個 git 子行程（唯一入口）。`encoding: 'utf8'` 與原本兩個 CLI 的用法一致；
 * 失敗時 execFileSync 照常拋錯，錯誤訊息只含 stdout/stderr（由 caller 決定是否轉述）。
 */
export function execGit(args: readonly string[], opts: GitExecOptions = {}): string {
  return execFileSync('git', hardenedGitArgs(args), {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: hardenedGitEnv(process.env),
    stdio: opts.stdio,
  })
}
