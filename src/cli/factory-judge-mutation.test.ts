import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadReport } from './factory-judge.js'
import { CliError } from './run-cli.js'

let tmp: string

/** 寫一個暫存 report.json 並回傳路徑；`content` 為字串時原樣寫入（用於壞格式）。 */
function report(name: string, content: unknown): string {
  const path = join(tmp, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-judge-mutation-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Mutation-strength tests for `loadReport` (docs/06 §5.1、docs/14 觀察期試跑 #45)。
 *
 * `loadReport` 用 zod 驗證 agent 自己寫出的 report.json——這份檔案是外部且
 * 不可信的輸入，任何「選填欄位型別被放寬」的變異都會讓一次壞格式的 report
 * 被寬容地讀入，進而可能把一次未真正執行的 run 判成 completed 或
 * ready-to-automerge。src/cli/** 是 CI gate，需 100% branch 覆蓋，因此這裡的
 * 挑戰不在行覆蓋（既有套件已是 100%），而在釘住 zod 對「選填欄位型別」的
 * 型別看守——行覆蓋測不出型別契約，只有型別變異測得出。
 *
 * Mutation log（以手工編輯 src/cli/factory-judge.ts 套用變異、重跑本檔變紅、
 * 再還原變綠的方式驗證）：
 *
 *  | ID | Mutation（放寬 ReportSchema / InvocationSchema 對選填欄位的型別看守）| Before | After |
 *  |----|-------------------------------------------------------------------------|--------|-------|
 *  | M1 | `changedPaths` 陣列元素 `z.string()` 放寬成 `z.string().or(z.number())` | GREEN  | RED   |
 *  | M2 | `changedLines` 由 `z.number()` 放寬成 `z.union([z.number(), z.string()])`| GREEN  | RED   |
 *  | M3 | `invocation.timedOut` 由 `z.boolean()` 放寬成 `union(…, z.string())`     | GREEN  | RED   |
 *  | M4 | `hasAcceptanceCriteria` 由 `z.boolean()` 放寬成 `union(…, z.string())`   | GREEN  | RED   |
 *
 * "Before" = 既有套件（src/cli/factory-judge.test.ts，24 則）；"After" = 加上
 * 本檔。M1–M4 在既有套件下全是全綠（存活變異）：既有測試只測「欄位缺席」與
 * 「欄位完全錯誤的型別」（如 `changedPaths: 'str'`），從未傳過「元素 / 型別
 * 含糊」的垃圾值，因此這四條選填欄位的型別契約完全未被釘住。本檔把每個欄位
 * 的型別看守錨定下來，讓這四類放寬變異在合併後無法悄悄溜進 CI。
 *
 * 驗證方式（與 parse-args-mutation.test.ts / rescore-mutation.test.ts 同）：
 * 手改 factory-judge.ts 套用變異 → `npx vitest run
 * src/cli/factory-judge-mutation.test.ts` 變紅 → 還原 → 變綠（四個變異均已
 * 實測確認，見 Issue #59 留言）。
 */

describe('M1 變異：changedPaths 陣列元素型別被放寬成 string-or-number', () => {
  /**
   * `changedPaths` 是「改了哪些檔」的路徑字串陣列。若元素型別看守放寬成
   * 也接受數字，agent 誤報 `changedPaths: [123]` 會被寬容讀入，計分時可能
   * 找不到匹配路徑而低估風險。既有套件只驗證「不是陣列」（字串）會失敗，
   * 從未驗證「陣列內元素型別」——放寬後仍全綠，此段將其釘住。
   */
  it('changedPaths 帶數字元素 → CliError，不接受型別含糊的陣列', () => {
    expect(() =>
      loadReport(
        report('m1.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          changedPaths: [123],
        }),
      ),
    ).toThrow(CliError)
  })

  it('正常字串陣列仍被接受（錨定，避免過度收緊）', () => {
    const r = loadReport(
      report('m1-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        changedPaths: ['src/a.ts'],
      }),
    )
    expect(r.changedPaths).toEqual(['src/a.ts'])
  })
})

describe('M2 變異：changedLines 型別被放寬成 number-or-string', () => {
  /**
   * `changedLines` 是變更行數（數字）。若放寬成也接受字串，agent 回報
   * `changedLines: '12'` 會被當成合法但型別錯的值，後續計分可能把字串當
   * 數字比對而失真。既有套件從未以字串傳入，放寬後全綠——此段錨定它必須
   * 是數字。
   */
  it('changedLines 帶字串 → CliError，不接受字串當行數', () => {
    expect(() =>
      loadReport(
        report('m2.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          changedLines: '12',
        }),
      ),
    ).toThrow(CliError)
  })

  it('數字行數仍被接受（錨定）', () => {
    const r = loadReport(
      report('m2-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        changedLines: 12,
      }),
    )
    expect(r.changedLines).toBe(12)
  })
})

describe('M3 變異：invocation.timedOut 型別被放寬成 boolean-or-string', () => {
  /**
   * `invocation.timedOut` 是「是否逾時」的布林旗標，直接決定 DSH 判讀是否
   * 走 needs-human 路徑（見 factory-judge.test.ts「逾時的 invocation →
   * needs-human」）。若放寬成也接受字串，agent 回報 `timedOut: 'yes'` 會被
   * 判成非逾時（缺少真正的布林 true），把一次逾時 run 誤判成別的終態——
   * 這是「未真正執行的 run 被當成 completed」的典型漏洞。既有套件只測過
   * 布林 true，此段釘住型別看守。
   */
  it('invocation.timedOut 帶字串 → CliError，不接受字串旗標', () => {
    expect(() =>
      loadReport(
        report('m3.json', {
          issueNumber: 1,
          invocation: { timedOut: 'yes' },
        }),
      ),
    ).toThrow(CliError)
  })

  it('布林 timedOut 仍被接受（錨定）', () => {
    const r = loadReport(
      report('m3-ok.json', {
        issueNumber: 1,
        invocation: { timedOut: true },
      }),
    )
    expect(r.invocation.timedOut).toBe(true)
  })
})

describe('M4 變異：hasAcceptanceCriteria 型別被放寬成 boolean-or-string', () => {
  /**
   * `hasAcceptanceCriteria: false` 是 SR4（驗收條件不明確）停手訊號（見
   * factory-judge.test.ts「hasAcceptanceCriteria: false → SR4 停手」）。若放寬
   * 成也接受字串，agent 回報 `hasAcceptanceCriteria: 'no'` 時，只有真正布林
   * false 才觸發停手，字串值會被判成「有判準」而放行不該放走的 run。既有
   * 套件只測過布林 false，此段錨定兩值必須是布林。
   */
  it('hasAcceptanceCriteria 帶字串 → CliError，不接受字串旗標', () => {
    expect(() =>
      loadReport(
        report('m4.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          hasAcceptanceCriteria: 'no',
        }),
      ),
    ).toThrow(CliError)
  })

  it('布林 hasAcceptanceCriteria 仍被接受（錨定）', () => {
    const r = loadReport(
      report('m4-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        hasAcceptanceCriteria: false,
      }),
    )
    expect(r.hasAcceptanceCriteria).toBe(false)
  })
})
