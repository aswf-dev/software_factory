/**
 * 所有 git 子行程的唯一入口（N1，third fix wave；N4，fourth fix wave）。
 *
 * 為什麼需要集中：`factory-crosscheck` 與 `factory-verify-encrypt` 都把
 * `git diff`／`git status` 當成「agent 改了什麼」的事實來源，而 agent 就在 target/
 * 內有 shell——crosscheck 更是在 agent **之後**執行，且同一個步驟握有 WRITE App
 * token。因此 git 讀得到的每一個檔案面都必須視為可被 agent 改寫，且預設全部生效：
 *
 *   1. `refs/replace/*`：`git replace <base-sha> <fake-commit>` 之後，`git diff`
 *      會把 base 當成 fake commit 的樹——真正的越界變更（例如 `src/app.ts`）
 *      可以整批消失，白名單與 bundle 範圍同時被繞過。`GIT_NO_REPLACE_OBJECTS=1`
 *      是 git 官方的總開關，關掉後 replace ref 完全不參與物件解析。
 *   2. global／system config：agent 可寫 `$HOME/.gitconfig`，注入 `diff.external`
 *      （偽造 patch 輸出）、`core.pager`、alias 等行為。以
 *      `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_SYSTEM=/dev/null` 讓這兩個
 *      檔案面不存在；`--no-pager`／`--no-ext-diff` 另外擋掉 repo-local config。
 *   3. repo-local `.git/config`：`core.fsmonitor` 讓 `git status` 執行 agent 的
 *      script；`core.worktree=/tmp/fake` 讓 diff 改看假的樹（白名單被繞過）；
 *      `core.excludesFile`／預設 global ignore 讓未追蹤交付消失。一律以 command
 *      scope `-c` 覆寫成安全值。
 *   4. `.git/info/attributes` 或工作區 `.gitattributes`：`diff.<driver>.textconv`
 *      會讓 `git diff --unified=0` 執行 agent 的 script（`--no-ext-diff` **擋不到**
 *      textconv）；`* -diff` 則讓 diff 輸出「Binary files … differ」，assertion
 *      淨減被算成 0。前者以 `--no-textconv` 關掉，後者以 `--text` 強制逐行輸出。
 *
 * **worktree 為什麼同時要 `-c core.worktree=` 與 `--work-tree=`**：git 在
 * `setup_git_directory()` 階段就從 repo config 決定 worktree，command scope 的
 * `-c core.worktree` 在那之後才查得到（實測 git 2.52：單獨用 `-c` 無法覆寫
 * `.git/config` 的 `core.worktree`）。真正生效的是全域選項 `--work-tree=<abs>`；
 * `-c` 保留為縱深防禦，兩者都指向同一個絕對路徑。
 *
 * **不要讓呼叫端自己記得加**：本模組只暴露 `execGit`，環境與旗標在這裡一次組好。
 * 測試（`git-safe.test.ts`、`factory-crosscheck.test.ts`、`test/verify-encrypt.test.ts`）
 * 以真實 git repo 驗證 replace refs、惡意 global config 與五種 repo-local 攻擊都
 * 無法改變事實輸出。
 */
import { execFileSync, type StdioOptions } from 'node:child_process'
import { resolve } from 'node:path'

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
 * 會輸出 patch 的子命令：一律加這三個旗標。
 * - `--no-ext-diff`：擋掉 repo-local／global `diff.external`（任意程式執行＋偽造輸出）。
 * - `--no-textconv`：`--no-ext-diff` 擋不到 `diff.<driver>.textconv`，必須另外關。
 * - `--text`：覆寫 `.gitattributes`／`.git/info/attributes` 的 `-diff`，否則
 *   assertion 計數只會看到「Binary files … differ」而算出 0（SR6 被繞過）。
 */
const DIFF_OUTPUT_COMMANDS: ReadonlySet<string> = new Set(['diff', 'show'])
const DIFF_OUTPUT_FLAGS = ['--no-ext-diff', '--no-textconv', '--text'] as const

/** 以 hardened 環境為底；caller 傳入的 env 不能覆寫三個關鍵值。 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...GIT_HARDENING_ENV }
}

/**
 * repo-local 設定的安全覆寫值。`workTree` 必須是絕對路徑：相對路徑會隨 git 的
 * cwd 解讀，而 cwd 正是 agent 能改寫的 checkout 內部。
 *
 * `/dev/null` 對 `core.excludesFile`／`core.attributesFile` 而言是「空檔案」：
 * 與 `GIT_CONFIG_GLOBAL` 相同的 POSIX 假設（runner 是 Linux、開發機是 macOS）。
 */
function hardenedConfigArgs(workTree: string): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.worktree=${workTree}`,
    '-c',
    'core.excludesFile=/dev/null',
    '-c',
    'core.attributesFile=/dev/null',
  ]
}

/**
 * 組出 hardened argv：`git --no-pager --work-tree=<abs> <安全 config>… <cmd> …`。
 *
 * `cwd` 是子行程的工作目錄（兩個 CLI 都傳 target checkout 的根）；省略時沿用
 * `process.cwd()`，與 `execGit` 的預設一致。
 */
export function hardenedGitArgs(args: readonly string[], cwd: string = process.cwd()): string[] {
  const command = args[0] as string
  const rest = args.slice(1)
  const workTree = resolve(cwd)
  const globals = ['--no-pager', `--work-tree=${workTree}`, ...hardenedConfigArgs(workTree)]
  return DIFF_OUTPUT_COMMANDS.has(command)
    ? [...globals, command, ...DIFF_OUTPUT_FLAGS, ...rest]
    : [...globals, command, ...rest]
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
  return execFileSync('git', hardenedGitArgs(args, opts.cwd ?? process.cwd()), {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: hardenedGitEnv(process.env),
    stdio: opts.stdio,
  })
}
