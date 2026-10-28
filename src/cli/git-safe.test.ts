/**
 * `git-safe` 的契約（N1／N4）：環境與 argv 的硬化規則只在這裡定義，兩個 CLI 不得繞過。
 *
 * E2E 行為（git replace／惡意 global 或 repo-local config 不改變事實）在
 * `factory-crosscheck.test.ts` 與 `test/verify-encrypt.test.ts`；本檔釘住較窄的
 * 介面：呼叫端覆寫不了三個關鍵環境變數，diff 類命令一律帶
 * `--no-ext-diff --no-textconv --text`，且每個子行程都以絕對 worktree 釘住 repo
 * （`-c core.worktree=<abs>`＋`--work-tree=<abs>`）。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execGit, GIT_HARDENING_ENV, hardenedGitArgs, hardenedGitEnv } from './git-safe.js'

/** N4 之後每個子行程都有的 repo-local 硬化參數（worktree 取決於 cwd）。 */
function repoSafeArgs(cwd: string): string[] {
  return [
    '--no-pager',
    `--work-tree=${cwd}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.worktree=${cwd}`,
    '-c',
    'core.excludesFile=/dev/null',
    '-c',
    'core.attributesFile=/dev/null',
  ]
}

/** diff／show 另外要帶的三個旗標（--text 讓 `-diff` 屬性無法壓掉 assertion 計數）。 */
const DIFF_SAFE_FLAGS = ['--no-ext-diff', '--no-textconv', '--text']

describe('git-safe：git 子行程的強制隔離', () => {
  it('三個關鍵變數固定，caller 的 env 無法覆寫（也不會被刪掉）', () => {
    expect(GIT_HARDENING_ENV).toEqual({
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    })
    const caller = {
      PATH: '/usr/bin',
      GIT_NO_REPLACE_OBJECTS: '0',
      GIT_CONFIG_GLOBAL: '/home/agent/.gitconfig',
      GIT_CONFIG_SYSTEM: '/etc/gitconfig',
    }
    expect(hardenedGitEnv(caller)).toEqual({
      PATH: '/usr/bin',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    })
    // 沒有既有的 GIT_* 時也不憑空多出其他變數
    expect(hardenedGitEnv({})).toEqual(GIT_HARDENING_ENV)
  })

  it('每個命令都釘住 worktree 並關掉 fsmonitor／global excludes／global attributes', () => {
    const cwd = resolve(process.cwd())
    expect(hardenedGitArgs(['status', '--porcelain'])).toEqual([...repoSafeArgs(cwd), 'status', '--porcelain'])
    // caller 傳入的 cwd 決定 worktree 的絕對路徑；相對路徑一律先 resolve
    expect(hardenedGitArgs(['rev-parse', 'HEAD'], '/tmp/checkout')).toEqual([
      ...repoSafeArgs('/tmp/checkout'),
      'rev-parse',
      'HEAD',
    ])
    expect(hardenedGitArgs(['diff'], 'relative/dir').slice(0, 2)).toEqual([
      '--no-pager',
      `--work-tree=${resolve('relative/dir')}`,
    ])
  })

  it('diff／show 加 --no-ext-diff --no-textconv --text；其他命令不加', () => {
    expect(hardenedGitArgs(['diff', '--name-only', 'HEAD'])).toEqual([
      ...repoSafeArgs(resolve(process.cwd())),
      'diff',
      ...DIFF_SAFE_FLAGS,
      '--name-only',
      'HEAD',
    ])
    expect(hardenedGitArgs(['show', 'main:file.txt'])).toEqual([
      ...repoSafeArgs(resolve(process.cwd())),
      'show',
      ...DIFF_SAFE_FLAGS,
      'main:file.txt',
    ])
    // status 不是 diff 輸出命令：不得多帶 --text（那三個旗標只對 patch 輸出有意義）
    expect(hardenedGitArgs(['status', '--porcelain'])).not.toContain('--text')
  })

  it('execGit 以預設 cwd 執行，且輸出不受 caller 的 GIT_* 覆寫影響', () => {
    const original = process.env.GIT_NO_REPLACE_OBJECTS
    process.env.GIT_NO_REPLACE_OBJECTS = '0'
    try {
      expect(execGit(['--version']).trim()).toMatch(/^git version /)
    } finally {
      if (original === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS
      else process.env.GIT_NO_REPLACE_OBJECTS = original
    }
  })
})
