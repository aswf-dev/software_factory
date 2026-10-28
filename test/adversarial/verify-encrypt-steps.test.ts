/**
 * factory-run 驗證模式 artifact 上傳接線（ADR-029 §5；plan Task 3）。
 *
 * 這是安全屬性，不是功能：驗證類的產出（run／specs／測試檔）一旦以明文進
 * artifact，任何登入 GitHub 的人都下載得到，而且 90 天內不會消失。步驟順序、
 * `if:` 條件或路徑清單任一處寫錯都不會有功能症狀——只有這個測試會紅。
 *
 * 因此本檔同時釘住「正向」與「負向」：
 *   1. 驗證模式先加密、且只在加密成功後上傳密文；
 *   2. 缺 VERIFY_AGE_PUBLIC_KEY 時步驟失敗（shell 有 `-z` 檢查），不得 fallback；
 *   3. 一般模式的上傳步驟在驗證模式被跳過，但非驗證行為（路徑清單）不變；
 *   4. 密文 artifact 只有 bundle＋兩份無內容診斷（steps／session-diag）；
 *      issue／crosscheck／model 等機制 JSON 只進密文（`--mechanism-dir`）；
 *   5. 其他把目標內容送出 runner 的路徑（scoreboard 推送、crosscheck 檔案清單
 *      印進公開 log）在驗證模式被閘住。
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

  it('加密步驟要求 agent 真的跑過（success 或 failure；skipped 時不打包 checkout 的舊內容）', () => {
    expect(encrypt().if).toBe(
      "always() && steps.verifymode.outcome == 'success' && steps.verifymode.outputs.verify == 'true' && " +
        "(steps.agent.outcome == 'success' || steps.agent.outcome == 'failure')",
    )
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
    // 機制 JSON（issue／crosscheck／model…）改由 CLI 收進密文，不再明文上傳
    expect(script).toContain('--mechanism-dir "$GITHUB_WORKSPACE/.factory"')
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

  it('密文 artifact 恰為 bundle＋兩份無內容診斷，不含任何機制 JSON 或 target/** 路徑', () => {
    // steps.json：各步驟 outcome 字串；session-diag.json：計數／長度／工具名（factory-session-diag
    // 的設計即「無內容」）。其餘機制 JSON 含目標內容（issue body、crosscheck 檔案清單、
    // skillGap 自由文字），只能進密文。
    expect(uploadPaths(encryptedUpload())).toEqual([
      '.factory/verify-bundle.age',
      '.factory/steps.json',
      '.factory/session-diag.json',
    ])
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

/**
 * M1：明文上傳在驗證模式永遠不會執行。
 *
 * 兩個上傳的條件是同一個 output 的互補述詞（`!= 'true'`／`== 'true'`），不會同時成立。
 * 刻意不改成正向閘門（`verify == 'false'`）：guard 在寫出 output 之前失敗時（查不到預設
 * 分支），正向閘門會讓非驗證 run 連 steps.json 都不上傳，compare 的 G1 會把「沒有
 * artifact」當成「可能已啟動」而補貼 needs-human——非驗證行為就變了。這個空 output 的
 * 情境裡，任何會產生目標內容的步驟都還沒跑（見下方第三個測試），明文上傳沒有內容可帶。
 */
describe('明文 artifact 在驗證模式永不上傳（M1）', () => {
  it('明文上傳的條件恰為 verify != true（與密文上傳互補）', () => {
    expect(findStep('Upload run artifacts').if).toBe("always() && steps.verifymode.outputs.verify != 'true'")
    expect(findStep('Upload encrypted verify artifacts').if).toMatch(/^always\(\) && steps\.verifymode\.outputs\.verify == 'true' && /)
  })

  it('guard 先寫出 verify output 才可能因 base_branch 不合法而 exit 1（被擋的驗證 run 仍是 verify=true）', () => {
    const script = findStep('Guard base_branch safety (ADR-013 / ADR-029 §6)').run ?? ''
    const output = script.indexOf('echo "verify=$(jq -r .verify .factory/verify-mode.json)" >> "$GITHUB_OUTPUT"')
    const rejected = script.indexOf('if [ "$(jq -r .baseBranchAllowed .factory/verify-mode.json)" != "true" ]; then')
    expect(output).toBeGreaterThan(-1)
    expect(rejected).toBeGreaterThan(output)
    // 唯一早於 output 的 exit 是查不到預設分支——此時 verify-mode.json 都還沒寫
    expect(script.indexOf('exit 1')).toBeLessThan(script.indexOf('> .factory/verify-mode.json'))
  })

  it('產生目標內容的步驟都在 guard 之後、且只在前面成功時執行（guard 失敗時沒有內容可上傳）', () => {
    const steps = runSteps()
    const guard = steps.findIndex((s) => s.id === 'verifymode')
    for (const name of ['Write agent run env (token / base / repo)', 'Select model tier', 'Run factory agent']) {
      const i = steps.findIndex((s) => s.name === name)
      expect(i, name).toBeGreaterThan(guard)
      expect(steps[i]?.if ?? 'success()', name).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
    }
  })
})

describe('驗證模式不把目標內容送出 runner（I1）', () => {
  it('scoreboard 推送在驗證模式跳過（事件含 agent 自報的 skillGap 自由文字）', () => {
    expect(findStep('Push event to scoreboard').if).toBe(
      "always() && steps.agent.outcome != 'skipped' && inputs.dry_run != true && steps.verifymode.outputs.verify != 'true'",
    )
  })
})
