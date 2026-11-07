/**
 * parse 測試：LLM 草稿 JSON 的健壯解析契約。
 */
import { describe, expect, it } from 'vitest'
import { missingPrdSections, parseDraftJson, parsePrdClarifyJson } from './parse.js'

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

describe('parsePrdClarifyJson（ADR-031：一題一張卡）', () => {
  it('正常：題目、選項、建議答案；容忍 fence 與前後雜訊', () => {
    const text = '好的：\n```json\n' + JSON.stringify({
      done: false,
      questions: [{ id: 'scope', text: '範圍？', options: ['只有 src/', '整個 repo'], recommended: '只有 src/' }],
    }) + '\n```'
    expect(parsePrdClarifyJson(text)).toEqual({
      done: false,
      questions: [{ id: 'scope', text: '範圍？', options: ['只有 src/', '整個 repo'], recommended: '只有 src/' }],
    })
  })

  it('recommended 不在選項中就丟掉；選項只留非空字串、最多 6 個', () => {
    const r = parsePrdClarifyJson(JSON.stringify({
      done: false,
      questions: [{ id: 'a', text: 'Q', options: ['x', '', 1, 'b', 'c', 'd', 'e', 'f', 'g'], recommended: 'nope' }],
    }))
    expect(r?.questions[0]).toEqual({ id: 'a', text: 'Q', options: ['x', 'b', 'c', 'd', 'e', 'f'], recommended: null })
  })

  it('最多 4 題；缺 id 或重複 id 自動補成 q<n>；空題目略過', () => {
    const r = parsePrdClarifyJson(JSON.stringify({
      done: false,
      questions: [
        { text: 'A', options: [] },
        { id: 'dup', text: 'B', options: [] },
        { id: 'dup', text: 'C', options: [] },
        { id: 'x', text: '  ', options: [] },
        { id: 'e', text: 'E', options: [] },
        { id: 'f', text: 'F', options: [] },
      ],
    }))
    expect(r?.questions.map((q) => [q.id, q.text])).toEqual([
      ['q1', 'A'],
      ['dup', 'B'],
      ['q3', 'C'],
      ['e', 'E'],
    ])
  })

  it('done:true 代表資訊足夠：一律回空題目', () => {
    expect(parsePrdClarifyJson('{"done": true, "questions": [{"id":"a","text":"Q"}]}')).toEqual({ done: true, questions: [] })
  })

  it('done:false 卻沒有任何有效題目、或不是 JSON → null（呼叫端重試或退回純文字）', () => {
    expect(parsePrdClarifyJson('{"done": false, "questions": []}')).toBeNull()
    expect(parsePrdClarifyJson('Q1：範圍？（建議：src/）')).toBeNull()
    expect(parsePrdClarifyJson('{bad json}')).toBeNull()
  })
})

describe('missingPrdSections', () => {
  it('列出 PRD 缺的段落（提示用，不擋確認）', () => {
    expect(missingPrdSections('**做什麼**\n...\n**範圍**', ['做什麼', '為什麼', '範圍'])).toEqual(['為什麼'])
    expect(missingPrdSections('**做什麼** **為什麼** **範圍**', ['做什麼', '為什麼', '範圍'])).toEqual([])
  })
})
