import { describe, expect, it } from 'vitest'
import { DOD_LABELS, hasCheckedAcceptance } from './factory-issue-check.js'

/**
 * Mutation-strength tests for `hasCheckedAcceptance` 的「DoD 3/3 全勾」契約
 * （docs/11-test-strategy.md §6.1；docs/ADR/009 承諾表單驗證與檢查器規則一致）。
 *
 * 背景：舊版判定是「任一 `- [x]` 即過」，與模板宣稱的「全部勾選才算」不一致。
 * ADR-009 把判定收緊為「3 個規定 label 全部以 `- [x] <label>` 出現」。
 * 本檔案釘住這份契約的每一面，防止未來重構把判定退化回寬鬆版。
 *
 * Mutation log（以手改 `src/cli/factory-issue-check.ts` 套用變異並重跑驗證，
 * 再還原——與既有 mutation 測試相同）：
 *
 *  | ID | Mutation                                                          | 驗證 |
 *  |----|-------------------------------------------------------------------|------|
 *  | M-A | `every` 改回「任一 `- [x]` 即過」；1/3 勾選的 body 回傳 true       | RED  |
 *  | M-B | 只數「3 行 `- [x]`」不檢查 label；label 文字漂移仍回傳 true        | RED  |
 *  | M-C | `DOD_LABELS` 常數刪掉一項；缺該項的 body 回傳 true                | RED  |
 */

const ONE_CHECKED =
  '### 驗收標準（DoD）\n\n' +
  '- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）\n'

const TWO_CHECKED =
  '### 驗收標準（DoD）\n\n' +
  '- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）\n' +
  '- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）\n'

const ALL_CHECKED = TWO_CHECKED + '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）\n'

/** label 文字漂移：3 項全勾但其中一項被簡寫（與 DOD_LABELS 逐字不符）。 */
const DRIFTED =
  '### 驗收標準（DoD）\n\n' +
  '- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）\n' +
  '- [x] 不觸碰高風險路徑\n' +
  '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）\n'

describe('M-A 變異：全勾判定退化回「任一勾選即過」', () => {
  /**
   * 若有人把 `DOD_LABELS.every(...)` 改回舊版的「有任一 `- [x]` 就過」，
   * 只勾 1 項的 body 會從 false 變成 true——表單宣稱「全部勾選才算」的承諾
   * 當場失效，且舊測試（沒有「只勾 1 項 → false」的斷言）看不出差異。
   */
  it('只勾 1 項（其餘未勾選不輸出）→ 必須為 false', () => {
    expect(hasCheckedAcceptance(ONE_CHECKED)).toBe(false)
  })
  it('只勾 2 項 → 必須為 false', () => {
    expect(hasCheckedAcceptance(TWO_CHECKED)).toBe(false)
  })
})

describe('M-B 變異：只數勾選行數、不檢查 label 內容', () => {
  /**
   * 若有人把判定簡化成「3 行 `- [x]` 就算過」，label 文字漂移（例如 yml 改寫
   * 而常數沒同步）時 body 仍回 true——「與模板逐字對齊」的契約就此斷裂。
   */
  it('3 行勾選但其中一項 label 不符規定 → 必須為 false', () => {
    expect(hasCheckedAcceptance(DRIFTED)).toBe(false)
  })
})

describe('M-C 變異：DOD_LABELS 常數缺項', () => {
  /**
   * 若有人從 `DOD_LABELS` 刪掉一個 label（例如誤以為只有兩項必勾），
   * 缺該項的 body（TWO_CHECKED 少第三項）會誤判為合規。
   * 此測試以「清單長度必須為 3」與「每一項都被實際要求」雙面釘住。
   */
  it('DOD_LABELS 必須恰好是 3 個規定 label', () => {
    expect(DOD_LABELS).toHaveLength(3)
  })
  it('缺第三項（跑測試確認綠燈）的 body → 必須為 false', () => {
    expect(hasCheckedAcceptance(TWO_CHECKED)).toBe(false)
  })
  it('全勾的 body → 必須為 true（正面對照，防過度收緊）', () => {
    expect(hasCheckedAcceptance(ALL_CHECKED)).toBe(true)
  })
})
