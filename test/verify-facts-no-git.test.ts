/**
 * R26 (e)：帶 `--facts` 的驗證路徑不得 spawn 任何 git 子行程。
 *
 * 這是行為測試，不是原始碼字串比對：把一個 fake `git` 放在 PATH 最前面，
 * 它只要被執行就留下 marker。`factory-crosscheck --verify-only --facts` 與
 * `factory-verify-encrypt --facts` 都必須在 marker 不存在的情況下成功。
 *
 * 為什麼要釘住：wave 6 的結構性修復就是把事實移到 target 之外計算；若未來
 * 有人在 facts 分支偷偷加回 `collectVerifyDiff`／`changedPaths`，功能測試可能
 * 仍然全綠（target 是正常 repo 時答案一樣），但「不在 target 跑 git」的保證
 * 已經消失。這個測試讓那個回歸一定有第二次訊號。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateX25519Identity, identityToRecipient } from 'age-encryption'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main as crosscheckMain } from '../src/cli/factory-crosscheck.js'
import { main as encryptMain } from '../src/cli/factory-verify-encrypt.js'

const created: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function factsFile(baseSha: string): string {
  const path = join(tempDir('factory-no-git-facts-'), 'verify-facts.json')
  writeFileSync(
    path,
    JSON.stringify({
      baseSha,
      changed: [{ path: 'test/new.test.ts', status: 'A' }],
      linesAdded: 1,
      linesDeleted: 0,
      assertionDelta: 1,
    }),
  )
  return path
}

function reportFile(): string {
  const path = join(tempDir('factory-no-git-report-'), 'report.json')
  writeFileSync(
    path,
    JSON.stringify({
      issueNumber: 12,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['test/new.test.ts'],
      changedLines: 1,
    }),
  )
  return path
}

let identity: string
let recipient: string

beforeAll(async () => {
  identity = await generateX25519Identity()
  recipient = await identityToRecipient(identity)
})

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('R26 (e)：--facts 路徑不 spawn git', () => {
  it('crosscheck --verify-only --facts 與 encrypt --facts 都不執行 PATH 上的 git', async () => {
    const sha = 'a'.repeat(40)
    const target = tempDir('factory-no-git-target-')
    writeFile(target, 'test/new.test.ts', "it('new', () => { expect(1).toBe(1) })\n")
    const facts = factsFile(sha)

    // fake git：被任何子行程執行就留下 marker；exit 1 讓「被呼叫」更難被忽略。
    const bin = tempDir('factory-no-git-bin-')
    const marker = join(tempDir('factory-no-git-marker-'), 'git-called')
    const fake = join(bin, 'git')
    writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${marker}'\nexit 1\n`)
    chmodSync(fake, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    try {
      // crosscheck 用預設的 realGit（不是注入的 never-git runner），這樣任何
      // 內部硬編的 execGit 都會命中 fake git。
      const crosscheck = crosscheckMain([
        '12',
        reportFile(),
        '--target',
        target,
        '--verify-only',
        '--base-sha',
        sha,
        '--facts',
        facts,
      ])
      expect(crosscheck.ok).toBe(true)

      const out = join(tempDir('factory-no-git-out-'), 'verify-bundle.age')
      const encrypted = await encryptMain([
        '--target',
        target,
        '--out',
        out,
        '--recipient',
        recipient,
        '--base-sha',
        sha,
        '--facts',
        facts,
      ])
      expect(encrypted.files).toEqual(['test/new.test.ts'])
      expect(existsSync(out)).toBe(true)
    } finally {
      process.env.PATH = originalPath
    }

    expect(existsSync(marker), `git was spawned: ${existsSync(marker) ? execFileSync('cat', [marker], { encoding: 'utf8' }) : ''}`).toBe(false)
  })
})
