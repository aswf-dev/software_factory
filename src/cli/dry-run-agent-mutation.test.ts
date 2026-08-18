import { describe, expect, it } from 'vitest'
import { dryRunReport } from './dry-run-agent.js'

/**
 * Mutation-strength tests for `dryRunReport` (docs/11 §6.1)。
 *
 * 目的與 `src/scoring/rescore-mutation.test.ts` 相同：證明套件對
 * `dry-run-agent` 情境報告有「牙齒」而非只是行覆蓋（docs/15 §1 的既有
 * 觀察點 family）。每一段都是一次具體變異，並斷言該變異會破壞的行為。
 *
 * 既有套件（`dry-run-agent.test.ts`）對三種情境各只釘住一、兩個欄位，
 * 下列三條隱性契約完全未覆蓋，變異後仍全綠（存活變異）：
 *
 *  | ID | Mutation                                                              | Before | After  |
 *  |----|-----------------------------------------------------------------------|--------|--------|
 *  | M1 | `success` 把 `changedLines` 從 40 誤改成 0（宣稱改檔卻 0 行）        | GREEN  | RED    |
 *  | M2 | `guardrail` 把 `hasAcceptanceCriteria` 誤設成 false（被當成缺驗收）  | GREEN  | RED    |
 *  | M3 | `blocked` 誤帶 changedPaths（宣稱改檔，污染終點判定）                | GREEN  | RED    |
 *
 * 「Before」= 既有套件（`dry-run-agent.test.ts`）單獨執行；
 * 「After」= 加入本檔案後。M1/M2/M3 在既有套件下都是 GREEN（存活變異），
 * 是本檔案新增的價值；詳見下方每段 `survives` 註記。
 *
 * 驗證方式（與其他 mutation 測試同）：手改 `dry-run-agent.ts` 套用該變異
 * → `npx vitest run src/cli/dry-run-agent-mutation.test.ts` 變紅 →
 * 還原 → 變綠。
 */

describe('M1 變異：success 情境把 changedLines 誤改成 0', () => {
  /**
   * success 報告同時宣稱改過 `changedPaths`、changedLines 是實際儲存的
   * 行數主張。既有套件只斷言 `assertionDelta > 0`、`hasAcceptanceCriteria`
   * 與 changedPaths 內容，從未斷言 changedLines——若有人把 `40` 誤改成 `0`
   * （「改了檔但改了 0 行」的自相矛盾），既有套件仍全綠。下列錨定它：一個
   * 修改過檔案的 success 報告，行數主張必須為正。
   */
  it('success 報告宣稱有實際檔案變更時，changedLines 必須為正', () => {
    const r = dryRunReport({ scenario: 'success', issueNumber: 101, cwd: '/tmp' })
    expect(r.changedLines).toBeGreaterThan(0)
  })
})

describe('M2 變異：guardrail 情境把 hasAcceptanceCriteria 誤設成 false', () => {
  /**
   * hasAcceptanceCriteria 觸發 SR4 的許可判讀（docs/15 1.1）。guardrail 與
   * success 都是「valid 情境」，必須維持 true；只有被擋下不該產生報告的
   * blocked 才省略它。既有套件對 guardrail 只斷言 changedPaths 內容，
   * 若有人把它的 hasAcceptanceCriteria 誤設成 false，既有套件仍全綠。
   * 下列錨定 guardrail 仍帶有驗收條件。
   */
  it('guardrail 報告必須帶有 hasAcceptanceCriteria = true', () => {
    const r = dryRunReport({ scenario: 'guardrail', issueNumber: 103, cwd: '/tmp' })
    expect(r.hasAcceptanceCriteria).toBe(true)
  })
})

describe('M3 變異：blocked 情境誤帶 changedPaths（宣稱改檔）', () => {
  /**
   * blocked 是 in-loop 初始計分就擋下 agent、報告不被使用的「no-op」情境
   * （src/cli/dry-run-agent.ts 註解）。它的報告不該宣稱改過任何檔案，否則
   * 會污染計分/終點判定。既有套件對 blocked 只斷言 `scenario === 'blocked'`，
   * 若有人誤把 changedPaths 帶進 blocked 報告，既有套件仍全綠。下列錨定：
   * blocked 報告不得宣稱任何檔案變更，也不得誤帶驗收條件。
   */
  it('blocked 報告不得宣稱任何改檔主張（changedPaths 缺席）', () => {
    const r = dryRunReport({ scenario: 'blocked', issueNumber: 102, cwd: '/tmp' })
    expect(r.changedPaths).toBeUndefined()
  })

  it('blocked 報告不得誤帶 hasAcceptanceCriteria', () => {
    const r = dryRunReport({ scenario: 'blocked', issueNumber: 102, cwd: '/tmp' })
    expect(r.hasAcceptanceCriteria).toBeUndefined()
  })
})
