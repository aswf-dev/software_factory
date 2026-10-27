/**
 * factory-run 驗證模式 artifact 上傳接線（ADR-029 §5、§7；plan Task 3）。
 *
 * 這是安全屬性，不是功能：驗證類的產出（run／specs／測試檔）一旦以明文進
 * artifact，任何登入 GitHub 的人都下載得到，而且 90 天內不會消失。步驟順序、
 * `if:` 條件或路徑清單任一處寫錯都不會有功能症狀——只有這個測試會紅。
 *
 * 因此本檔同時釘住「正向」與「負向」：
 *   1. 驗證模式先加密、且只在加密成功後上傳密文；
 *   2. 缺 VERIFY_AGE_PUBLIC_KEY 時步驟失敗（shell 有 `-z` 檢查），不得 fallback；
 *   3. 一般模式的上傳步驟在驗證模式被跳過，但非驗證行為（路徑清單）不變；
 *   4. 密文 artifact 不含 target/**（明文 run／specs／測試檔）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
  with?: { name?: string; path?: string; 'if-no-files-found'?: string }
}

function runSteps(): Step[] {
  const wf = load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as {
    jobs: { run: { steps: Step[] } }
  }
  return wf.jobs.run.steps
}

function findStep(name: string): Step {
  const step = runSteps().find((s) => s.name === name)
  expect(step, `workflow 缺少步驟：${name}`).toBeDefined()
  return step as Step
}

function uploadPaths(step: Step): string[] {
  return (step.with?.path ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

describe('驗證模式：先加密、只上傳密文', () => {
  const encrypt = (): Step => findStep('Encrypt verify artifacts (age)')
  const plaintextUpload = (): Step => findStep('Upload run artifacts')
  const encryptedUpload = (): Step => findStep('Upload encrypted verify artifacts')

  it('加密步驟只在驗證模式執行，且 agent 失敗時仍嘗試取回部分產出', () => {
    expect(encrypt().if).toContain("steps.verifymode.outputs.verify == 'true'")
    expect(encrypt().if).toContain('always()')
  })

  it('公鑰只從 secret 取得；缺 secret 時 shell 明確 exit 1（不得 fallback 明文）', () => {
    expect(encrypt().env?.['VERIFY_AGE_PUBLIC_KEY']).toBe('${{ secrets.VERIFY_AGE_PUBLIC_KEY }}')
    const script = encrypt().run ?? ''
    expect(script).toContain('${VERIFY_AGE_PUBLIC_KEY:-}')
    expect(script).toMatch(/if \[ -z "\$\{VERIFY_AGE_PUBLIC_KEY:-\}" \]; then[\s\S]*exit 1/)
  })

  it('呼叫 factory-verify-encrypt CLI，輸出固定在 .factory/verify-bundle.age', () => {
    const script = encrypt().run ?? ''
    expect(script).toContain('dist/cli/factory-verify-encrypt.js')
    expect(script).toContain('--target "$GITHUB_WORKSPACE/target"')
    expect(script).toContain('--out "$GITHUB_WORKSPACE/.factory/verify-bundle.age"')
    expect(script).toContain('--recipient "$VERIFY_AGE_PUBLIC_KEY"')
  })

  it('加密步驟在 agent 之後、兩個上傳步驟之前', () => {
    const steps = runSteps()
    const agent = steps.findIndex((s) => s.name === 'Run factory agent')
    const enc = steps.findIndex((s) => s.name === 'Encrypt verify artifacts (age)')
    const plain = steps.findIndex((s) => s.name === 'Upload run artifacts')
    const encrypted = steps.findIndex((s) => s.name === 'Upload encrypted verify artifacts')
    expect(agent).toBeGreaterThan(-1)
    expect(enc).toBeGreaterThan(agent)
    expect(plain).toBeGreaterThan(enc)
    expect(encrypted).toBeGreaterThan(enc)
  })

  it('一般上傳步驟在驗證模式被跳過（明文 run／specs 不進 artifact）', () => {
    expect(plaintextUpload().if).toContain("steps.verifymode.outputs.verify != 'true'")
    const paths = uploadPaths(plaintextUpload())
    // 非驗證行為不變：run 診斷仍上傳（gh-token 仍排除）。
    expect(paths).toContain('target/.factory/run/')
    expect(paths).toContain('!target/.factory/run/gh-token')
    expect(paths).not.toContain('target/specs/')
  })

  it('密文上傳要求加密成功，缺 secret／加密失敗時不上傳任何東西', () => {
    expect(encryptedUpload().if).toContain("steps.verifymode.outputs.verify == 'true'")
    expect(encryptedUpload().if).toContain("steps.verify-encrypt.outcome == 'success'")
  })

  it('密文 artifact 只含 bundle 與非敏感機制 JSON，不含任何 target/** 路徑', () => {
    const paths = uploadPaths(encryptedUpload())
    expect(paths).toContain('.factory/verify-bundle.age')
    expect(paths).toContain('.factory/verify-mode.json')
    expect(paths).toContain('.factory/crosscheck.json')
    expect(paths).toContain('.factory/steps.json')
    // 明文來源（run／specs／測試檔）一律不得出現；連 target/ 都不該有。
    for (const path of paths) {
      expect(path, `驗證模式 artifact 含明文路徑：${path}`).not.toMatch(/^target\//)
      expect(path).not.toMatch(/(^|\/)specs\//)
    }
    expect(uploadPaths(encryptedUpload()).some((p) => p.endsWith('.test.'))).toBe(false)
  })

  it('兩個上傳步驟使用同一個 artifact 名稱（compare／download 以名稱取回）', () => {
    expect(encryptedUpload().with?.name).toBe(plaintextUpload().with?.name)
    expect(encryptedUpload().with?.name).toBe('factory-run-${{ inputs.issue_number }}-${{ matrix.variant }}')
  })

  it('密文上傳失敗不擋 run（與既有 artifact 上傳一致），但加密失敗會擋', () => {
    expect(encryptedUpload()['continue-on-error']).toBe(true)
    expect(encrypt()['continue-on-error']).not.toBe(true)
  })
})
