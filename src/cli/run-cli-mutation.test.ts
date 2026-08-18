import { describe, expect, it } from 'vitest'
import { formatCliError } from './run-cli.js'

/**
 * Mutation-strength tests for `formatCliError` (docs/06 §5.3 精神；src/cli 為
 * CI gate，src/cli/** 需 100% branch 覆蓋 —— 見 vitest.config.ts)。
 *
 * 這些測試要證明套件「有牙齒」而非僅行覆蓋。每個 block 記錄一個
 * `formatCliError` 的具體變異，並斷言該變異會破壞的行為。
 *
 * Mutation log（以手工編輯 src/cli/run-cli.ts 後重跑 `npx vitest run
 * src/cli`、再還原的方式驗證）：
 *
 *  | ID | Mutation                                                        | Before | After  |
 *  |----|-----------------------------------------------------------------|--------|--------|
 *  | MA | `err.code === 'ENOENT'` → `'NOWHERE'`                          | RED    | RED    |
 *  | MB | `err.path ?? 'unknown path'` → `err.path`（拔掉 fallback）      | RED    | RED    |
 *  | MC | 最終分支 `String(err)` → `err.message`                          | RED    | RED    |
 *  | MD | 把通用 Error 分支移到 ENOENT 分支之前                           | RED    | RED    |
 *  | ME | `isErrnoException` 丟掉 `instanceof Error` 守衛                 | GREEN  | RED    |
 *
 * "Before" = 既有套件；"After" = 加上本檔。
 * ME 由 GREEN→RED 是本檔新增的價值：既有套件把「帶 code 但非 Error 的物件」
 * 誤當成真正的檔案遺失錯誤。其餘（MA–MD）在此錨定，避免舊測試重構時保護失效。
 */

describe('ME 變異：isErrnoException 丟掉 instanceof Error 守衛', () => {
  /**
   * 唯一的區別輸入是「帶 code 的普通物件」。真實程式語意是：只有『真正的
   * Error 實例』才可能被當成檔案遺失；普通物件一律落入最終 String 分支。
   * 一旦 isErrnoException 放寬成只看 `code in obj`，這種物件就會被誤判成
   * `file not found:` —— 這個 block 釘住真實語意，讓變異體爆炸（RED）。
   */
  it('帶 ENOENT code 與 path 的普通物件，不得被當成真正的檔案遺失錯誤', () => {
    expect(formatCliError({ code: 'ENOENT', path: '/tmp/missing.yaml' })).toBe(
      'error: [object Object]',
    )
  })

  it('帶 ENOENT code 的普通物件同樣不走 file-not-found 分支', () => {
    expect(formatCliError({ code: 'ENOENT' })).toBe('error: [object Object]')
  })
})

describe('MA 變異：ENOENT code 比對被改壞', () => {
  /** 既有套件已殺；錨定以免舊測試重構時失去保護。 */
  it('ENOENT 錯誤仍能以 file not found + 路徑呈現', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
      path: '/tmp/missing.yaml',
    })
    expect(formatCliError(err)).toBe('error: file not found: /tmp/missing.yaml')
  })
})

describe('MB 變異：path fallback 被移除', () => {
  /** 既有套件已殺；錨定 path 欄位缺席時的讀性。 */
  it('ENOENT 缺 path 欄位 → 仍給出 unknown path 而非 undefined', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    expect(formatCliError(err)).toBe('error: file not found: unknown path')
  })
})

describe('MC 變異：最終分支改用 err.message', () => {
  /** 非 Error 的丟擲值沒有 .message，改用 message 會吐 undefined。 */
  it('純字串丟擲值保持原樣', () => {
    expect(formatCliError('plain string')).toBe('error: plain string')
  })
  it('undefined 丟擲值保持原樣', () => {
    expect(formatCliError(undefined)).toBe('error: undefined')
  })
  it('null 丟擲值保持原樣', () => {
    expect(formatCliError(null)).toBe('error: null')
  })
})

describe('MD 變異：通用 Error 分支被移前', () => {
  /** ENOENT errno 也是 Error 實例；若通用分支在前，會吞掉 file-not-found 語意。 */
  it('ENOENT 錯誤優先走 file-not-found 分支', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/a/b' })
    expect(formatCliError(err)).toBe('error: file not found: /a/b')
  })
})
