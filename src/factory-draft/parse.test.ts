/**
 * parse 測試：LLM 草稿 JSON 的健壯解析契約。
 */
import { describe, expect, it } from 'vitest'
import { parseDraftJson } from './parse.js'

const VALID = {
  title: '為計分邏輯補測試',
  requirement: '目標模組/檔案：src/scoring\n做什麼：補測試\n為什麼：信心\n範圍：不動 pipeline',
  dod: ['測試紅→綠', '不碰高風險路徑'],
  targetRepo: 'philipz/software_factory',
  notes: ['目標 repo 未知，帶入預設'],
}

describe('parseDraftJson', () => {
  it('解析純 JSON', () => {
    const r = parseDraftJson(JSON.stringify(VALID))
    expect(r?.title).toBe(VALID.title)
    expect(r?.requirement).toBe(VALID.requirement)
    expect(r?.dod).toEqual(VALID.dod)
    expect(r?.targetRepo).toBe(VALID.targetRepo)
    expect(r?.notes).toEqual(VALID.notes)
  })
  it('容忍 ```json fence 與前後雜訊文字', () => {
    const fenced = '好的，草稿如下：\n```json\n' + JSON.stringify(VALID) + '\n```\n以上。'
    expect(parseDraftJson(fenced)?.title).toBe(VALID.title)
  })
  it('容忍缺選用欄位（title/targetRepo/notes/dod）', () => {
    const r = parseDraftJson(JSON.stringify({ requirement: '只寫需求' }))
    expect(r?.requirement).toBe('只寫需求')
    expect(r?.title).toBeUndefined()
    expect(r?.dod).toEqual([])
    expect(r?.notes).toEqual([])
  })
  it('無 JSON 區塊 → null', () => {
    expect(parseDraftJson('完全沒有大括號')).toBeNull()
  })
  it('JSON 語法錯誤 → null', () => {
    expect(parseDraftJson('{"requirement": }')).toBeNull()
  })
  it('requirement 缺失或空白 → null', () => {
    expect(parseDraftJson('{"title": "x"}')).toBeNull()
    expect(parseDraftJson('{"requirement": "   "}')).toBeNull()
  })
  it('requirement 前後空白被 trim', () => {
    expect(parseDraftJson('{"requirement": "  需求  "}')?.requirement).toBe('需求')
  })
})
