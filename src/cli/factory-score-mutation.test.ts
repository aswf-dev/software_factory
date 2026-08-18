import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadScoreInput, main } from './factory-score.js'

let tmp: string
let riskPaths: string

/** 寫一個暫存 YAML fixture 並回傳路徑。 */
function fixture(name: string, ...lines: string[]): string {
  const path = join(tmp, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/** 只宣告單一 annotation 欄位，其餘欄位缺席（以便單獨釘住每個 coercion 目標）。 */
function singleAnnotation(key: string, yamlValue: string): string {
  const file = `${key.replaceAll('factory.io/', 'fx-')}-${yamlValue.trim()}.yaml`
  return fixture(file, 'metadata:', '  annotations:', `    ${key}: ${yamlValue}`)
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-score-mutation-'))
  riskPaths = fixture(
    'risk-paths.yml',
    'hard_rules:',
    '  H1: ["src/auth/**"]',
    '  H5: [".github/**", "CODEOWNERS", "catalog-info.yaml", ".dsh/skills/**"]',
  )
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Mutation-strength tests for the zod coercion (強制轉型) contract of
 * `factory-score` (docs/06 §5.1、docs/14 觀察期試跑 #82)。
 *
 * `loadScoreInput` 用 `AnnotationValue` zod schema 把 catalog 的
 * `factory.io/*` annotation 強制轉成字串（string/number/boolean →
 * String(v)），再交給 `score()` 計分。這個轉型的契約是：
 *
 *   1. 型別為「未加引號的 YAML 純量」時，boolean/number 必須原樣轉成其字串
 *      表示，不得失真或偷換（例如 `true` 不能變成 `'false'`、`2.5` 不能
 *      被截成 `'2'`）。
 *   2. 轉型應同時涵蓋三軸 annotation 與技術棧（stack/test-framework/...
 *      quint-spec）——後者的 number/boolean 同樣要轉成字串。
 *
 * 這裡的挑戰在行覆蓋測不出型別契約（既有套件已在 `src/cli/**`
 * 100% branch），因此用「放寬/搞錯轉型」的變異來釘住。既有
 * `factory-score.test.ts` 只測到：
 *   - `agent-automerge: false`（boolean → 'false'，否決）
 *   - `risk-profile: 3`（integer → '3'，fail-safe 2）
 * 從未傳過「非否決值的 boolean」、非整數的 number、或 number/boolean 的
 * 技術棧欄位，因此下列變異在既有套件下全是全綠（存活變異）。
 *
 * Mutation log（以手工編輯 src/cli/factory-score.ts 套用變異、重跑本檔變紅、
 * 再還原變綠的方式驗證，見 Issue #82 留言）：
 *
 *  | ID | Mutation（破壞 AnnotationValue 的強制轉型）              | Before | After  |
 *  |----|-----------------------------------------------------------|--------|--------|
 *  | M1 | boolean 一律轉成 'false'（丟失 true 的極性）               | GREEN  | RED    |
 *  | M2 | number 一律 `Math.trunc` 取整（丟失小數）                  | GREEN  | RED    |
 *  | M3 | 技術棧欄位繞過轉型直接取原始值（boolean 不被轉字串）       | GREEN  | RED    |
 *  | M4 | 技術棧欄位繞過轉型直接取原始值（number 不被轉字串）        | GREEN  | RED    |
 *
 * M1 與 M2 是獨立變異：M1 讓本檔 M1 段（兩則）變紅、M2 讓本檔 M2 段（兩則）
 * 變紅。M3/M4 共用「技術棧繞過轉型」的同一變異，讓本檔 M3/M4 段（兩則）變紅。
 * "Before" = 既有 `factory-score.test.ts`（28 則）；"After" = 加上本檔。
 * M1、M2、M3/M4 在既有套件下都是 GREEN（存活變異），既有測試完全蓋不到這些
 * 轉型面。
 */

describe('M1 變異：boolean 強制轉型丟失極性（true 被誤轉成 "false"）', () => {
  /**
   * `factory.io/agent-automerge: true` 是「明確允許自動合併」的宣告，轉型後
   * 必須是字串 `'true'`，score() 的 `=== 'false'` 才不會誤觸發擁有者否決。
   * 若有人把 boolean 轉型簡化成「一律 'false'」（或丟失 true 值），一次
   * `true` 的許可宣告會被誤判成否決——既有套件只測過 `false`，完全看不出
   * 差異。此段釘住 boolean 轉型的極性必須保留。
   */
  it('agent-automerge: true → 轉成字串 "true"，不得誤成 "false"', () => {
    const catalog = singleAnnotation('factory.io/agent-automerge', 'true')
    expect(loadScoreInput(catalog, riskPaths).annotations.agentAutomerge).toBe('true')
  })

  it('score 不得被 true 誤觸發否決（錯誤地擋下 automerge）', () => {
    const catalog = fixture(
      'veto-true.yaml',
      'metadata:',
      '  annotations:',
      '    factory.io/business-criticality: tactical',
      '    factory.io/risk-profile: low',
      '    factory.io/complexity: low',
      '    factory.io/agent-automerge: true',
    )
    const out = main(['--catalog', catalog, '--risk-paths', riskPaths])
    expect(out.annotations.agentAutomerge).toBe('true')
    // 唯一許可信號是 string "false"；true 不得自己把 score 拉進 in-loop 或否決。
    expect(out.score.automergeBlockers.some((b) => b.includes('否決'))).toBe(false)
    expect(out.score.automergeAllowed).toBe(true)
  })
})

describe('M2 變異：number 強制轉型丟失精度（小數被 trunc 成整數）', () => {
  /**
   * 未加引號的 YAML 小數（如 `complexity: 1.5`）轉型後必須是原始字串
   * `'1.5'`，不得被無條件取整成 `'1'`。`Math.trunc`/`Math.round` 這類
   * 變異在既有套件（只測過整數 3）下完全測不出來，但會悄悄改變 fail-safe
   * 的判定與人類在留言上讀到的分數來源。此段釘住 number 轉型必須保留小數。
   */
  it('小數 annotation → 轉成完整字串，不截斷', () => {
    const catalog = singleAnnotation('factory.io/complexity', '1.5')
    expect(loadScoreInput(catalog, riskPaths).annotations.complexity).toBe('1.5')
  })

  it('score 看得到原樣字串，不因取整而誤判分數', () => {
    const catalog = fixture(
      'frac.yaml',
      'metadata:',
      '  annotations:',
      '    factory.io/complexity: 2.5',
    )
    const out = main(['--catalog', catalog, '--risk-paths', riskPaths])
    expect(out.annotations.complexity).toBe('2.5')
    // 非法字串 → fail-safe 最高風險值（docs/06 §3），此分數必須能被讀到。
    expect(out.score.complexity.value).toBe(2)
  })
})

describe('M3 變異：技術棧 test-framework 的 boolean 不被轉成字串', () => {
  /**
   * 技術棧欄位（factory.io/test-framework）同樣走 AnnotationValue 轉型，
   * 但既有套件只測過「字串值」的技術棧，boolean/number 完全未涵蓋。若有人
   * 在技術棧路徑上拿掉 boolean 處理，`test-framework: true` 會被 safeParse
   * 判失敗而退回 undefined——技術棧宣告悄悄消失，CI 可能據此改變驗證組合。
   * 此段釘住技術棧欄位同樣受強制轉型保護。
   */
  it('test-framework: true → 轉成字串，不退回 undefined', () => {
    const catalog = singleAnnotation('factory.io/test-framework', 'true')
    const { stack } = loadScoreInput(catalog, riskPaths)
    expect(stack.testFramework).toBe('true')
  })
})

describe('M4 變異：技術棧 stack 的 number 不被轉成字串', () => {
  /**
   * 同上：`factory.io/stack: 2024`（未加引號 number）轉型後必須是字串
   * `'2024'`。number 不被接受時 safeParse 失敗→stack 退回 undefined，技術棧
   * 宣告悄悄失效。此段釘住技術棧的 number→字串轉型。
   */
  it('stack: 2024 → 轉成字串，不退回 undefined', () => {
    const catalog = singleAnnotation('factory.io/stack', '2024')
    const { stack } = loadScoreInput(catalog, riskPaths)
    expect(stack.stack).toBe('2024')
  })
})
