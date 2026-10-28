/**
 * `git-safe` 的契約（N1）：環境與 argv 的硬化規則只在這裡定義，兩個 CLI 不得繞過。
 *
 * E2E 行為（git replace／惡意 global config 不改變事實）在
 * `factory-crosscheck.test.ts` 與 `test/verify-encrypt.test.ts`；本檔釘住較窄的
 * 介面：呼叫端覆寫不了三個關鍵環境變數，diff 類命令一律帶 `--no-ext-diff`。
 */
import { describe, expect, it } from 'vitest'
import { execGit, GIT_HARDENING_ENV, hardenedGitArgs, hardenedGitEnv } from './git-safe.js'

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

  it('diff／show 加 --no-ext-diff；其他命令只加 --no-pager', () => {
    expect(hardenedGitArgs(['diff', '--name-only', 'HEAD'])).toEqual([
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--name-only',
      'HEAD',
    ])
    expect(hardenedGitArgs(['show', 'main:file.txt'])).toEqual([
      '--no-pager',
      'show',
      '--no-ext-diff',
      'main:file.txt',
    ])
    expect(hardenedGitArgs(['status', '--porcelain'])).toEqual(['--no-pager', 'status', '--porcelain'])
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
