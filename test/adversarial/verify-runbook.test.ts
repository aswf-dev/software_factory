/**
 * docs/34-verify-runbook.md 與實作同步（漂移即紅燈）。
 *
 * 手冊是手動 dispatch 與解密的唯一說明；白名單或 toolchain 改了而手冊沒跟上，
 * 操作者會依舊規則判讀 crosscheck 結果或裝錯版本。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkIssue, DOD_LABELS } from '../../src/cli/factory-issue-check.js'
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

  it('Issue 範例逐字通過 factory-issue-check（驗證類沒有格式豁免）', () => {
    const example = doc.match(/```markdown\n([\s\S]*?)```/)?.[1]
    expect(example).toBeDefined()
    const result = checkIssue(example as string)
    expect(result.ok).toBe(true)
    expect(VERIFY_TASK_TYPES as readonly string[]).toContain(result.taskType)
    for (const label of DOD_LABELS) expect(example).toContain(`- [x] ${label}`)
    expect(doc).toMatch(/gh issue create[\s\S]*--body-file/)
  })

  it('Lean 快取 key 與 workflow 一致（只有 ~/.elan）', () => {
    const key = 'lean-elan-${{ runner.os }}-leanprover/lean4:v4.35.0'
    expect(doc).toContain(key)
    expect(readFileSync(join(ROOT, '.github/workflows/factory-run.yml'), 'utf8')).toContain(`key: ${key}`)
  })

  it('toolchain 版本、secret 名稱與解密指令與 workflow 一致', () => {
    expect(doc).toContain('leanprover/lean4:v4.35.0')
    expect(doc).toContain('VERIFY_AGE_PUBLIC_KEY')
    expect(doc).toContain('age -d -i')
    for (const f of ['verify-bundle.age', 'steps.json', 'session-diag.json']) expect(doc).toContain(f)
  })

  it('bundle 格式帶 kind（R7）：解密指令依 kind 分流，不再以 mechanism/ 前綴辨識來源', () => {
    expect(doc).toContain('{"kind":"target","path":"specs/lean/RULES.md","b64":')
    expect(doc).toContain('{"kind":"mechanism","path":"issue.json","b64":')
    expect(doc).toContain('select(.kind == "target")')
    expect(doc).toContain('select(.kind == "mechanism")')
    expect(doc).not.toContain('mechanism/<name>')
    expect(doc).not.toContain('mechanism/*')
  })

  it('階段輸入：verify_input_url 與 runner keypair（VERIFY_RUNNER_AGE_IDENTITY）有說明', () => {
    expect(doc).toContain('-f verify_input_url=https://aswf.dev/')
    expect(doc).toContain('VERIFY_RUNNER_AGE_IDENTITY')
    expect(doc).toContain('factory-verify-input')
  })

  it('階段輸入的還原清單（R13）與 crosscheck 旗標有說明，且明說不進 bundle', () => {
    expect(doc).toContain('.factory/verify-restored.json')
    expect(doc).toContain('--restored-manifest')
    expect(doc).toContain('.lake/build/')
  })
})
