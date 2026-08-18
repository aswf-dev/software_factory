import { describe, expect, it } from 'vitest'
import { parseArgs } from './factory-score.js'

/**
 * Mutation-strength tests for `parseArgs` (docs/06 §5.1 CLI 旗標解析)。
 *
 * 這些測試的用途與 src/scoring/rescore-mutation.test.ts 相同：證明套件有
 * 「牙齒」而非只是行覆蓋。每一段都是一次具體的 parseArgs 變異，並斷言
 * 該變異會破壞的行為。
 *
 * Mutation log（以手改 src/cli/factory-score.ts 並重跑驗證，再還原）：
 *
 *  | ID | Mutation                                                    | Before | After  |
 *  |----|-------------------------------------------------------------|--------|--------|
 *  | M1 | 重複旗標「後出現者勝」被改成「先出現者勝」                   | GREEN  | RED    |
 *  | M2 | requireValue 的旗標判定 `startsWith('--')` 放寬成 `'-'`      | GREEN  | RED    |
 *  | M3 | 處理 --catalog 時把 riskPathsPath 誤重設為預設值             | GREEN  | RED    |
 *
 * 「Before」= 既有套件（src/cli/factory-score.test.ts）單獨執行；
 * 「After」= 加入本檔案後。M1/M2/M3 在既有套件下都是 GREEN（存活變異），
 * 是本檔案新增的價值；詳見下方每段 `survives` 註記。
 *
 * 驗證方式（與 rescore-mutation.test.ts 同）：手改 factory-score.ts 套用
 * 該變異 → `npx vitest run src/cli/parse-args-mutation.test.ts` 變紅 →
 * 還原 → 變綠。
 */

describe('M1 變異：重複旗標「後出現者勝」被改成「先出現者勝」', () => {
  /**
   * 既有套件從未對同一旗標下兩次值，因此「最後一次出現的值勝出」這條
   * 隱性契約完全未被釘住。若有人把判斷改成只在使用者尚未給過該旗標時才
   * 寫入（first-wins），既有套件仍全綠——只有下列斷言會變紅。
   */
  it('同一個旗標出現兩次 → 最後一次出現的值勝出', () => {
    expect(
      parseArgs(['--catalog', 'a.yaml', '--catalog', 'z.yaml']),
    ).toEqual({
      catalogPath: 'z.yaml',
      riskPathsPath: '.github/factory/risk-paths.yml',
    })
  })

  it('--risk-paths 出現兩次 → 最後一次出現的值勝出', () => {
    expect(
      parseArgs(['--risk-paths', 'low.yml', '--risk-paths', 'high.yml']),
    ).toEqual({
      catalogPath: 'catalog-info.yaml',
      riskPathsPath: 'high.yml',
    })
  })
})

describe('M2 變異：旗標判定 `--` 被放寬成 `-`（單一 `-` 值被誤判為旗標）', () => {
  /**
   * requireValue 只用 `--` 判定「值是旗標」；單一 `-` 開頭的值（例如某些
   * CLI 慣例中代表 stdin/stdout 的 `-`）是合法路徑值。若判定被放寬成
   * `startsWith('-')`，這類值會被誤判為「旗標當值」而失敗。既有套件沒
   * 有傳過單一 `-` 的值，放寬後仍全綠——本段將其釘住。
   */
  it('旗標值可以是單一 `-` 開頭的字串（只有 `--` 才算旗標標記）', () => {
    expect(parseArgs(['--catalog', '-'])).toEqual({
      catalogPath: '-',
      riskPathsPath: '.github/factory/risk-paths.yml',
    })
  })

  it('值為 `-x.yaml`（單一 dash 檔名）不被當成旗標，正常作為路徑值', () => {
    expect(parseArgs(['--risk-paths', '-x.yaml'])).toEqual({
      catalogPath: 'catalog-info.yaml',
      riskPathsPath: '-x.yaml',
    })
  })
})

describe('M3 變異：處理 --catalog 時把 riskPathsPath 誤重設為預設值', () => {
  /**
   * 既有套件唯一同時用到兩旗標的案例是 `--catalog ... --risk-paths ...`
   * 這個順序：catalog 先處理（重設 riskPaths 成預設值，此時本就已是
   * 預設值，看不出異狀），隨後 risk-paths 再設定 b.yml。因此「處理
   * --catalog 時誤清 riskPaths」的變異在既有套件下完全存活。下列反序
   * 輸入（先 --risk-paths 再 --catalog）會讓誤重設變得可見。
   */
  it('旗標給值順序與結果無關（反序）——riskPaths 不得被 --catalog 重設', () => {
    expect(
      parseArgs(['--risk-paths', 'b.yml', '--catalog', 'a.yaml']),
    ).toEqual({
      catalogPath: 'a.yaml',
      riskPathsPath: 'b.yml',
    })
  })
})
