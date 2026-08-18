import { describe, expect, it } from 'vitest'
import { buildBlockComment, computeScoreLabels } from './apply-score-labels.js'

/**
 * Mutation-strength tests for the pure functions of `apply-score-labels`
 * (docs/11-test-strategy.md §6.1). 目的與 `src/scoring/rescore-mutation.test.ts`
 * 相同：證明套件有「牙齒」而非只是行覆蓋。每一段都是一次具體變異，並斷言
 * 該變異會破壞的行為。
 *
 * 既有套件（`apply-score-labels.test.ts`）對這兩個純函式的覆蓋偏弱：
 * `buildBlockComment` 只在 in-loop 案例被叫過一次 `(6)`，而且只斷言含
 * `human-in-the-loop`——`total` 插值、`docs/06 §4.3` 引用、第二句說明都沒被釘住。
 *
 * Mutation log（以手改 `src/cli/apply-score-labels.ts` 並重跑驗證，再還原）：
 *
 *  | ID | Mutation                                                          | Before | After  |
 *  |----|-------------------------------------------------------------------|--------|--------|
 *  | M-A | `buildBlockComment` 把 total 插值換成硬編碼 6，不再反映實際計分 | GREEN  | RED    |
 *  | M-B | `buildBlockComment` 移除 `（docs/06 §4.3）` 引用                 | GREEN  | RED    |
 *  | M-C | `buildBlockComment` 刪除第二句「設計與實作須由人類主導」          | GREEN  | RED    |
 *  | M-D | `computeScoreLabels` 的 blocked 判定由「只等於 in-loop」改成「不等於 in-loop」 | GREEN | RED |
 *
 * 「Before」= 既有套件（`apply-score-labels.test.ts`）單獨執行；
 * 「After」= 加入本檔案後。M-A/M-B/M-C/M-D 在既有套件下都是 GREEN
 * （存活變異）——既有測試沒蓋到這些契約面，是本檔案新增的價值。
 *
 * 驗證方式（與 existing mutation 測試相同）：手改 `apply-score-labels.ts`
 * 套用該變異 → `npx vitest run apply-score-labels-mutation.test.ts` 變紅 →
 * 還原 → 變綠。
 *
 * === 實測步驟記錄（GREEN → RED → GREEN，每格一行命令結論） ===
 *   M-A 變異生效 → 本檔 M-A 段 RED；還原 → GREEN。
 *   M-B 變異生效 → 本檔 M-B 段 RED；還原 → GREEN。
 *   M-C 變異生效 → 本檔 M-C 段 RED；還原 → GREEN。
 *   M-D 變異生效 → 本檔 M-D 段 RED；還原 → GREEN。
 */

describe('M-A 變異：buildBlockComment 的 total 被硬編碼，不再反映實際計分', () => {
  /**
   * 留言的 `初始計分 ${total} 分` 必須反映真正交給 gate 的分數，是 gate
   * 觸發時人類用來判斷「為什麼被擋」的第一手數字。若有人把 `${total}`
   * 換成硬編碼 6，既有套件（只傳過 `6`）完全看不出差異。
   */
  it('留言必須內嵌實際傳入並無條件使用的那個總分', () => {
    // 用一個非 6 的分數，釘住「插值真的把 total 帶進字串」。
    expect(buildBlockComment(42)).toContain('初始計分 42 分')
  })

  it('不同 total 產生不同留言，彼此可區分', () => {
    expect(buildBlockComment(42)).not.toBe(buildBlockComment(7))
  })
})

describe('M-B 變異：buildBlockComment 移除 docs/06 §4.3 引用', () => {
  /**
   * 留言點名 `docs/06 §4.3` 是讓人類能直接查閱 human-in-the-loop 規範的
   * 關鍵指路。既有套件從未斷言這條引用，被誤刪時仍全綠。
   */
  it('留言必須保留 docs/06 §4.3 的規範引用', () => {
    expect(buildBlockComment(6)).toContain('docs/06')
    expect(buildBlockComment(6)).toContain('4.3')
  })
})

describe('M-C 變異：buildBlockComment 刪掉「設計與實作須由人類主導」', () => {
  /**
   * 第二句是留言的動作指引，告訴人類接下來該做什麼。既有套件只斷言
   * `human-in-the-loop`，第二句被整個刪掉也全綠。
   */
  it('留言必須包含人類主導的動作指引', () => {
    expect(buildBlockComment(6)).toContain('設計與實作須由人類主導')
  })
})

describe("M-D 變異：computeScoreLabels 的 blocked 判定反轉（不等於 in-loop）", () => {
  /**
   * blocked 只在 `tier === 'in-loop'` 時為真，是非 in-loop（on-loop/review）
   * 都不該阻斷。若有人把判定放寬成「只要不是 in-loop 就阻斷」或反轉，會讓
   * 正常審查流程被誤擋。既有套件逐 tier 斷言 blocked，但反轉後的
   * on-loop/review 行為（blocked=false）需要獨立釘住才不會被重構漏掉。
   */
  it('on-loop 不得被阻斷', () => {
    expect(
      computeScoreLabels({ total: 0, tier: 'on-loop', label: 'oversight/on-loop' }).blocked,
    ).toBe(false)
  })

  it('review 不得被阻斷，in-loop 必須被阻斷', () => {
    expect(
      computeScoreLabels({ total: 3, tier: 'review', label: 'oversight/review' }).blocked,
    ).toBe(false)
    expect(
      computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' }).blocked,
    ).toBe(true)
  })
})
