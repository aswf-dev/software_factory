/**
 * docs/34-verify-runbook.md 與實作同步（漂移即紅燈）。
 *
 * 手冊是手動 dispatch 與解密的唯一說明；白名單或 toolchain 改了而手冊沒跟上，
 * 操作者會依舊規則判讀 crosscheck 結果或裝錯版本。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERIFY_ALLOWED_GLOBS } from '../../src/pipeline/verify-scope.js'
import { VERIFY_TASK_TYPES } from '../../src/pipeline/verify-task-types.js'

const ROOT = join(import.meta.dirname, '../..')
const doc = readFileSync(join(ROOT, 'docs/34-verify-runbook.md'), 'utf8')

describe('docs/34-verify-runbook.md', () => {
  it('README 的文件表連到它', () => {
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('(docs/34-verify-runbook.md)')
  })

  it('列出 crosscheck 白名單的每一個 glob', () => {
    for (const glob of VERIFY_ALLOWED_GLOBS) expect(doc).toContain(glob)
  })

  it('四個 task type 都有 dispatch 說明；lean 帶 verify_phase', () => {
    for (const t of VERIFY_TASK_TYPES) expect(doc).toContain(t)
    expect(doc).toContain('-f verify_phase=statements')
    expect(doc).toContain('-f verify_phase=proofs')
    expect(doc).toMatch(/gh workflow run factory-run\.yml[\s\S]*-f repo=[\s\S]*-f issue_number=[\s\S]*-f base_branch=/)
  })

  it('toolchain 版本、secret 名稱與解密指令與 workflow 一致', () => {
    expect(doc).toContain('leanprover/lean4:v4.35.0')
    expect(doc).toContain('VERIFY_AGE_PUBLIC_KEY')
    expect(doc).toContain('age -d -i')
    for (const f of ['verify-bundle.age', 'steps.json', 'session-diag.json']) expect(doc).toContain(f)
  })
})
