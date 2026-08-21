/**
 * prompts 測試：grill-me 收斂版釐清 + 一次生成 的 prompt 契約。
 *
 * 這些 prompt 是「設定而非程式」——壞掉不會有功能性症狀（docs/11 §5），
 * 所以用測試釘住關鍵指令，防止未來改寫時把治理要求悄悄拿掉。
 */
import { describe, expect, it } from 'vitest'
import { buildClarifyPrompt, buildGeneratePrompt, CLARIFY_MAX_ROUNDS, SYSTEM_PROMPT } from './prompts.js'

describe('SYSTEM_PROMPT 治理邊界', () => {
  it('明示 LLM 只產草稿、最終決定權在使用者（docs/01 職責邊界）', () => {
    expect(SYSTEM_PROMPT).toContain('不決定')
    expect(SYSTEM_PROMPT).toContain('使用者')
  })
  it('要求 PRD 四段與可驗證的 DoD', () => {
    expect(SYSTEM_PROMPT).toContain('目標模組/檔案')
    expect(SYSTEM_PROMPT).toContain('做什麼')
    expect(SYSTEM_PROMPT).toContain('為什麼')
    expect(SYSTEM_PROMPT).toContain('範圍')
    expect(SYSTEM_PROMPT).toContain('可驗證')
  })
  it('要求誠實標示推測內容（品質標示）', () => {
    expect(SYSTEM_PROMPT).toContain('notes')
    expect(SYSTEM_PROMPT).toContain('推測')
  })
})

describe('buildClarifyPrompt（grill-me 收斂版）', () => {
  const p = buildClarifyPrompt({ requirement: '幫 repo 加測試', round: 2, history: [] })

  it('要求一次只問一輪、編號、附建議答案', () => {
    expect(p).toContain('一輪')
    expect(p).toContain('Qn')
    expect(p).toContain('建議答案')
  })
  it('帶入輪數與上限（CLARIFY_MAX_ROUNDS）', () => {
    expect(p).toContain('第 2 輪')
    expect(p).toContain(String(CLARIFY_MAX_ROUNDS))
  })
  it('帶入使用者可隨時跳過的逃生門', () => {
    expect(p).toContain('跳過')
  })
  it('帶入原始需求與釐清歷史', () => {
    const p2 = buildClarifyPrompt({
      requirement: '需求A',
      round: 3,
      history: [{ question: '目標 repo？', answer: 'software_factory' }],
    })
    expect(p2).toContain('需求A')
    expect(p2).toContain('目標 repo？')
    expect(p2).toContain('software_factory')
  })
})

describe('buildGeneratePrompt（一次生成全部欄位）', () => {
  const p = buildGeneratePrompt({ requirement: '需求B', history: [] })

  it('要求一次到位、嚴格 JSON、不帶 fence', () => {
    expect(p).toContain('一次')
    expect(p).toContain('JSON')
    expect(p).toContain('fence')
  })
  it('JSON schema 含 title/requirement/dod/targetRepo/notes', () => {
    for (const k of ['title', 'requirement', 'dod', 'targetRepo', 'notes']) {
      expect(p).toContain(k)
    }
  })
  it('notes 被定義為推測與未確認事項的品質標示', () => {
    expect(p).toContain('推測')
    expect(p).toContain('notes')
  })
  it('無釐清歷史時明示直接生成', () => {
    expect(p).toContain('無釐清')
  })
  it('有釐清歷史時帶入問答', () => {
    const p2 = buildGeneratePrompt({
      requirement: '需求B',
      history: [{ question: '範圍？', answer: 'src/scoring' }],
    })
    expect(p2).toContain('範圍？')
    expect(p2).toContain('src/scoring')
  })
})
