import { describe, expect, it } from 'vitest'
import {
  collectActualDiff,
  compareReportToActual,
  type CrosscheckActual,
  type GitRunner,
} from '../cli/factory-crosscheck.js'
import { countAssertionDelta } from './count.js'

/**
 * Mutation-strength tests for the SR6 反向鎖（`src/assertion-count` ＋
 * `factory-crosscheck` 的 `assertion-delta-understated`）。
 *
 * **這條鎖存在的理由**：SR6「絕不允許為通過測試而弱化斷言」的輸入 `assertionDelta`
 * 由 agent 自報，而且是 `.optional()`——**漏填就等於 SR6 從未存在**。`docs/25` §2.4
 * 已以 13 次 run 證明自報紀律是模型相依的；這裡鎖住的是「自報以外還有一個來源」。
 *
 * 這道閘門橫跨兩個模組（計數在 `count.ts`、判定在 `factory-crosscheck.ts`），
 * 因此變異測試也跨模組放在一起：分開放會讓「兩邊都各自通過、合起來擋不住」的
 * 變異沒有任何一個檔案抓得到。
 *
 *  | ID | Mutation                                                            | Before | After |
 *  |----|---------------------------------------------------------------------|--------|-------|
 *  | M1 | 方向鎖被移除（漏填 assertionDelta 不再 mismatch）                       | GREEN  | RED   |
 *  | M2 | 方向鎖改為「數值不等即 mismatch」（假陽性擋下誠實的 run）                 | GREEN  | RED   |
 *  | M3 | 刪除整個測試檔（`+++ /dev/null`）不計入減項                             | GREEN  | RED   |
 *  | M4 | `---`/`+++` 無條件當檔案標頭（不看是否已進 hunk）                       | GREEN  | RED   |
 *  | M5 | 各分支 assertionDelta 改為相加而非取最小值                              | GREEN  | RED   |
 *
 * 驗證方式：手改對應原始碼套用變異 → 重跑本檔變紅 → 還原 → 變綠。
 */

const actualWith = (assertionDelta: number): CrosscheckActual => ({
  branches: ['factory/12-01-test'],
  paths: ['src/a.test.ts'],
  added: 4,
  deleted: 4,
  uncommitted: [],
  assertionDelta,
})

const kindsOf = (ms: { kind: string }[]): string[] => ms.map((m) => m.kind)

describe('M1 變異：方向鎖被移除', () => {
  /**
   * 最重要的一格。攻擊路徑不是「回報一個假數字」，而是**根本不填**：
   * `assertionDelta` 是 optional，缺席時 SR6 的條件 `delta < 0` 永遠不成立。
   * 沒有這條鎖，刪光斷言＋不回報是一條完全乾淨的通路。
   */
  it('實算淨減少而 report 未回報 → 必須 mismatch', () => {
    const out = compareReportToActual({ changedPaths: ['src/a.test.ts'] }, actualWith(-2))
    expect(kindsOf(out)).toContain('assertion-delta-understated')
  })

  it('實算淨減少而 report 回報 0 → 必須 mismatch', () => {
    const out = compareReportToActual(
      { changedPaths: ['src/a.test.ts'], assertionDelta: 0 },
      actualWith(-2),
    )
    expect(kindsOf(out)).toContain('assertion-delta-understated')
  })
})

describe('M2 變異：改為數值相等比對', () => {
  /**
   * 反方向的變異，同樣致命但形式相反：把「方向」升級成「數值」看似更嚴謹，
   * 實際上跨語言的斷言計數必然有落差，結果是誠實的 run 被大量誤擋。
   * 假陽性會訓練人忽略這個訊號——那比沒有訊號更糟（`docs/25` §7「紀律失效」）。
   */
  it('雙方都是正值但數字不同 → 不得 mismatch', () => {
    const out = compareReportToActual(
      { changedPaths: ['src/a.test.ts'], assertionDelta: 9 },
      actualWith(2),
    )
    expect(kindsOf(out)).not.toContain('assertion-delta-understated')
  })

  it('雙方都是負值但數字不同 → 不得 mismatch（已誠實回報，交給 SR6）', () => {
    const out = compareReportToActual(
      { changedPaths: ['src/a.test.ts'], assertionDelta: -1 },
      actualWith(-7),
    )
    expect(kindsOf(out)).not.toContain('assertion-delta-understated')
  })
})

describe('M3 變異：刪整個測試檔不計入', () => {
  /**
   * 「刪掉幾行斷言」與「刪掉整個測試檔」在威脅上是同一件事，後者更徹底。
   * 刪檔的 diff 是 `+++ /dev/null`，當前檔案必須退回 `--- a/<舊路徑>`；
   * 只看新路徑的實作會在這裡靜靜回傳 0。
   */
  it('刪除整個測試檔 → delta 必須為負', () => {
    const text = [
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      'deleted file mode 100644',
      '--- a/src/a.test.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-  expect(a).toBe(1)',
      '-  expect(b).toBe(2)',
      '-  expect(c).toBe(3)',
    ].join('\n')
    expect(countAssertionDelta(text).delta).toBe(-3)
  })
})

describe('M4 變異：---/+++ 無條件當標頭', () => {
  /**
   * 一行被刪掉的 `-- x`（SQL／Lua／Haskell 註解）在 diff 裡長成 `--- x`，
   * 與檔案標頭同形。無條件解析的實作不只漏算那一行，還會把「當前檔案」改成
   * 一個不存在的路徑，讓其後整個 hunk 靜靜地不被計數——一個刪斷言的 commit
   * 只要夾一行這種內容就能把整段藏起來。
   */
  it('hunk 內的 --- / +++ 內容行必須被當成內容，且不改變當前檔案', () => {
    const text = [
      'diff --git a/test/x_test.rb b/test/x_test.rb',
      '--- a/test/x_test.rb',
      '+++ b/test/x_test.rb',
      '@@ -1,3 +1,1 @@',
      '--- expect(a).toBe(1)',
      '-  expect(b).toBe(2)',
      '-  expect(c).toBe(3)',
    ].join('\n')
    expect(countAssertionDelta(text).delta).toBe(-3)
  })
})

describe('M5 變異：各分支相加而非取最小值', () => {
  /**
   * stacked PR 的 02-impl 相對 base 已包含 01-test 的全部變更。相加會把同一批
   * 斷言重複計入，並且能讓「01 加 2、02 淨減 1」合成 +1——真正的淨減少被自己的
   * 前一層蓋掉。這個變異在單分支的專案上完全看不出來。
   */
  it('01 為正、02 為負 → 必須取到負值', () => {
    const git: GitRunner = (args) => {
      if (args[0] === 'for-each-ref') return 'factory/12-01-test\nfactory/12-02-impl\n'
      if (args[0] === 'status') return ''
      const branch = (args[2] ?? '').split('...')[1] ?? ''
      if (args[1] === '--name-only') return 'src/a.test.ts\n'
      if (args[1] === '--shortstat') return ' 1 file changed, 1 insertion(+)'
      const body =
        branch === 'factory/12-01-test'
          ? '+  expect(a).toBe(1)\n+  expect(b).toBe(2)'
          : '+  expect(a).toBe(1)\n-  expect(c).toBe(3)\n-  expect(d).toBe(4)'
      return [
        'diff --git a/src/a.test.ts b/src/a.test.ts',
        '--- a/src/a.test.ts',
        '+++ b/src/a.test.ts',
        '@@ -1 +1 @@',
        body,
      ].join('\n')
    }
    const actual = collectActualDiff(git, { issueNumber: 12, base: 'software-factory', target: 't' })
    expect(actual.assertionDelta).toBeLessThan(0)
  })
})
