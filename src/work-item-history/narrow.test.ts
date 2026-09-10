/**
 * narrow 收窄工具測試。
 *
 * 這兩個函式是本目錄所有不可信輸入的第一道關卡，且被 task-record 與 issue-url
 * 共用——邊界一鬆，兩個模組會同時安靜地壞掉，故逐型別釘死。
 */
import { describe, expect, it } from 'vitest'
import { asObject, asString } from './narrow.js'

describe('asObject', () => {
  it('物件原樣返回（同一個參考，不複製也不淺拷貝）', () => {
    const input = { id: 'abc' }
    expect(asObject(input)).toBe(input)
  })
  it('陣列也是物件，同樣原樣返回——要不要當陣列用由呼叫端判斷', () => {
    // 刻意不把陣列擋在這裡：issue-url 的 output.links 本來就是陣列，
    // 擋掉會讓它必須繞過本函式自己寫一套收窄。
    const input = [{ url: 'https://example.test' }]
    expect(asObject(input)).toBe(input)
  })
  it('null 回傳 null', () => {
    // 誠實揭露：把實作裡的 `v !== null` 拿掉，這條仍會過（else 分支給的就是 null）。
    // 該防護擋的是「把 null 當成 Record 交出去」的型別謊言，執行期結果相同；
    // 這條測的是對呼叫端的契約，不是那個防護。
    expect(asObject(null)).toBeNull()
  })
  it('undefined 與原始型別一律回傳 null', () => {
    expect(asObject(undefined)).toBeNull()
    expect(asObject(42)).toBeNull()
    expect(asObject('nonsense')).toBeNull()
    expect(asObject(true)).toBeNull()
  })
})

describe('asString', () => {
  it('字串原樣返回，空字串亦然', () => {
    expect(asString('philipz/camunda_hazelcast')).toBe('philipz/camunda_hazelcast')
    expect(asString('')).toBe('')
  })
  it('非字串一律回傳空字串，不做 String() 轉換', () => {
    // 改成 String(v) 會讓缺失欄位顯示成 'undefined'／'[object Object]' 這類
    // 長得像真值的字串，比空字串更難察覺是壞資料。
    expect(asString(undefined)).toBe('')
    expect(asString(null)).toBe('')
    expect(asString(42)).toBe('')
    expect(asString({ toString: () => 'evil' })).toBe('')
    expect(asString(['a'])).toBe('')
  })
})
