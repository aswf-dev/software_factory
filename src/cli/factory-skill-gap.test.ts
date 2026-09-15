import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractSkillGap, main, parseArgs } from './factory-skill-gap.js'
import { CliError } from './run-cli.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-gap-cli-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeReport(name: string, body: unknown): string {
  const p = join(tmp, name)
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  return p
}

const GAP = {
  category: 'ci-sandbox-vitest-run',
  needed: 'CI 沙箱內跑 vitest 的 SOP',
  context: 'Issue #287 test-only 層',
}

describe('parseArgs', () => {
  it('--report 必填', () => {
    expect(() => parseArgs([])).toThrow(CliError)
    expect(() => parseArgs(['--out', 'x.md'])).toThrow('需指定 --report')
  })

  it('--report 與 --out 皆解析', () => {
    expect(parseArgs(['--report', 'r.json', '--out', 'o.md'])).toEqual({
      reportPath: 'r.json',
      outPath: 'o.md',
    })
  })

  it('--out 省略 → undefined', () => {
    expect(parseArgs(['--report', 'r.json']).outPath).toBeUndefined()
  })

  it('旗標缺值 → CliError（含下一個旗標佔位的情況）', () => {
    expect(() => parseArgs(['--report'])).toThrow('--report requires a value')
    expect(() => parseArgs(['--report', '--out'])).toThrow('--report requires a value')
    expect(() => parseArgs(['--report', 'r.json', '--out'])).toThrow('--out requires a value')
  })

  it('未知參數 → CliError', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument: --nope')
  })
})

describe('extractSkillGap', () => {
  it('三欄齊全 → 渲染完整段落', () => {
    const out = extractSkillGap(writeReport('full.json', { skillGap: GAP }))
    expect(out.present).toBe(true)
    expect(out.reason).toBeNull()
    expect(out.markdown).toBe(
      [
        '### 🧩 技能缺口回報',
        '- **分類**：`ci-sandbox-vitest-run`',
        '- **需要**：CI 沙箱內跑 vitest 的 SOP',
        '- **情境**：Issue #287 test-only 層',
      ].join('\n'),
    )
  })

  it('省略 context → 不輸出情境行', () => {
    const { category, needed } = GAP
    const out = extractSkillGap(writeReport('no-ctx.json', { skillGap: { category, needed } }))
    expect(out.present).toBe(true)
    expect(out.markdown).not.toContain('情境')
  })

  it('檔案不存在 → present=false 且不 throw', () => {
    const out = extractSkillGap(join(tmp, 'missing.json'))
    expect(out).toMatchObject({ present: false, markdown: '' })
    expect(out.reason).toContain('report 無法讀取或非合法 JSON')
  })

  it('非合法 JSON → present=false 且不 throw', () => {
    const out = extractSkillGap(writeReport('broken.json', '{ not json'))
    expect(out.present).toBe(false)
    expect(out.reason).toContain('report 無法讀取或非合法 JSON')
  })

  it('無 skillGap 欄位 → present=false，原因為未回報', () => {
    const out = extractSkillGap(writeReport('none.json', { issueNumber: 287 }))
    expect(out).toEqual({ present: false, reason: '未回報技能缺口', markdown: '' })
  })

  /**
   * 迴歸（同 run #34456925126 的既有釘法）：agent 以 `"skillGap": null` 表達
   * 「無缺口」。此處若 throw，守衛留言就會整段失敗——正是本 CLI 要防的事。
   */
  it('skillGap 為 null → 視同缺席', () => {
    const out = extractSkillGap(writeReport('null.json', { skillGap: null }))
    expect(out).toEqual({ present: false, reason: '未回報技能缺口', markdown: '' })
  })

  it('category 非 kebab-case → present=false 且回報格式原因（不 throw）', () => {
    const out = extractSkillGap(writeReport('bad-cat.json', { skillGap: { ...GAP, category: 'BadCase' } }))
    expect(out.present).toBe(false)
    expect(out.reason).toContain('skillGap 格式不合法')
    expect(out.reason).toContain('skillGap.category')
  })

  /**
   * report 根本不是物件（fallback report 寫壞、或 agent 誤寫成陣列/純量）時，
   * zod 的 issue path 為空陣列——錯誤訊息必須仍可讀，故以 `(root)` 標示。
   */
  it('report 非物件 → present=false 且原因標示 (root)', () => {
    const out = extractSkillGap(writeReport('scalar.json', '123'))
    expect(out.present).toBe(false)
    expect(out.reason).toContain('(root)')
  })

  it('缺 needed → present=false（欄位缺漏同樣降級，不中止守衛）', () => {
    const out = extractSkillGap(writeReport('no-needed.json', { skillGap: { category: 'a-b' } }))
    expect(out.present).toBe(false)
    expect(out.reason).toContain('skillGap 格式不合法')
  })
})

describe('main', () => {
  it('--out 有缺口 → 寫出段落', () => {
    const report = writeReport('m-full.json', { skillGap: GAP })
    const out = join(tmp, 'nested', 'gap.md')
    const result = main(['--report', report, '--out', out])
    expect(result.present).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe(result.markdown)
  })

  /**
   * 空檔而非不寫檔：workflow 以 `[ -s <file> ]` 判斷是否附加段落。若無缺口時
   * 保留上一次 run 的殘檔，守衛會把**別人的缺口**貼到這次的 Issue 上。
   */
  it('--out 無缺口 → 覆寫為空檔（不得留下殘檔）', () => {
    const out = join(tmp, 'stale.md')
    writeFileSync(out, '### 🧩 技能缺口回報\n- **分類**：`stale-from-previous-run`')
    const result = main(['--report', writeReport('m-none.json', { skillGap: null }), '--out', out])
    expect(result.present).toBe(false)
    expect(readFileSync(out, 'utf8')).toBe('')
  })

  it('省略 --out → 不落檔，只回傳結果', () => {
    const out = join(tmp, 'never-written.md')
    const result = main(['--report', writeReport('m-plain.json', { skillGap: GAP })])
    expect(result.present).toBe(true)
    expect(existsSync(out)).toBe(false)
  })
})
