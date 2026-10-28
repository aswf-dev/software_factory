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

  it('C1：dot segment 只在 specs/** 放寬、.github 一律拒絕，且四個繞過路徑寫進手冊', () => {
    expect(doc).toContain('只在 **`specs/**` 內**放寬')
    expect(doc).toContain('.github/workflows/evil.test.yml')
    expect(doc).toContain('.github/tests/x.ts')
    expect(doc).toContain('.github/test/x.ts')
    expect(doc).toContain('.github/factory/foo_test.go')
    expect(doc).toContain('任何含 `.github` segment 的路徑也一律拒絕')
  })

  it('C2／I2／I3：不可變 base、機制模板、唯讀 token 都有說明', () => {
    expect(doc).toContain('--base-sha')
    expect(doc).toContain('.factory/base-sha')
    expect(doc).toContain('task-template-verify-*.txt')
    expect(doc).toContain('metadata `read`')
    expect(doc).toContain('target/.dsh')
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

  it('I4：§7.3 階段交接已實作（指向 §3.3），不再自稱 Task 6 待辦', () => {
    expect(doc).not.toContain('Task 6 會加入')
    expect(doc).not.toContain('不會交接')
    const s73 = doc.slice(doc.indexOf('## 7. 已知限制'), doc.indexOf('\n4. **'))
    expect(s73).toContain('verify_input_url')
    expect(s73).toContain('--restored-manifest')
    expect(s73).toContain('factory-verify-input')
    expect(s73).toContain('§3.3')
  })

  it('I4：§7.4 不再把 Issue 當成「本就公開」，並說明驗證模式印出／不印什麼', () => {
    expect(doc).not.toContain('本就公開')
    expect(doc).toContain('目標 repo 若是 private')
    expect(doc).toMatch(/run log 是公開的/)
    // 驗證模式的 log 範圍（I1）：只印固定列舉值，不印格式卡／model.json／agent stderr
    const s74 = doc.slice(doc.indexOf('\n4. **公開 log'), doc.indexOf('\n5. **G2'))
    expect(s74).toContain('格式檢查只印')
    expect(s74).toContain('model.json')
    expect(s74).toMatch(/不印/)
  })

  it('I4：§7.6 說明 matrix 部分失敗可能讓 verify output 為空、仍可能補通用 needs-human', () => {
    const s76 = doc.slice(doc.indexOf('\n6. **compare job'))
    expect(s76).toContain('matrix 部分失敗')
    expect(s76).toMatch(/output.*空|空.*output/)
    expect(s76).toContain('通用 needs-human')
  })

  it('I3：§7.1 說明驗證模式只發唯讀憑證、寫入 token 不外流、探測跳過（不再宣稱交寫入憑證給 agent）', () => {
    const s71 = doc.slice(doc.indexOf('\n1. **agent 手上'), doc.indexOf('\n2. **G3'))
    expect(s71).toContain('唯讀 installation token')
    expect(s71).toMatch(/contents: read/)
    expect(s71).toContain('persist-credentials: false')
    expect(s71).toContain('git-credentials-')
    expect(s71).toContain('跳過')
    expect(s71).not.toContain('驗證模式不縮減')
    expect(s71).not.toContain('探針也照常推送')
  })

  it('I6：快取存檔是 best-effort，失敗不得讓 run 失敗（Lean 與 Quint 都寫明）', () => {
    expect(doc.match(/best-effort/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(doc).toContain('不得讓 run 失敗')
    expect(doc).toContain('continue-on-error')
    expect(doc).toContain('~/.elan/bin/lean')
  })

  it('R24：§3.1 不再說原因在 run log 的完整格式卡；驗證模式只印摘要，卡片只留 runner', () => {
    const s31 = doc.slice(doc.indexOf('### 3.1 Issue 格式'), doc.indexOf('### 3.2 dispatch'))
    // workflow 只印 `issue format: ok=… missing=…`（summary-out），不是 `cat` 完整卡片
    expect(s31).toContain('issue format: ok=')
    expect(s31).toContain('missing=')
    expect(s31).not.toContain('cat .factory/issue-check.txt')
    // 完整格式卡是 runner-only：不進 artifact，也不在加密 bundle 的機制檔清單內
    expect(s31).toContain('只留在 runner')
    expect(s31).toContain('不進 artifact')
    expect(s31).toContain('不在加密 bundle')
  })

  it('R24：§7.7 收窄 fs 錯誤宣稱——crosscheck 未逐一包裝 readFileSync，靠 workflow 傳相對路徑', () => {
    const s77 = doc.slice(doc.indexOf('7. **部分錯誤訊息'))
    expect(s77).toContain('`factory-crosscheck` 則**沒有**')
    expect(s77).toContain('err.path')
    expect(s77).toContain('err.message')
    // 舊的過寬宣稱不得留下
    expect(s77).not.toContain('已只輸出相對路徑')
    expect(s77).toContain('相對路徑')
    expect(s77).toMatch(/直接以\s*絕對路徑呼叫/)
    expect(s77).toContain('git ls-files')
  })
})
