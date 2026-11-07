/**
 * prompts 測試：grill-me 收斂版釐清 + 一次生成 的 prompt 契約。
 *
 * 這些 prompt 是「設定而非程式」——壞掉不會有功能性症狀（docs/11 §5），
 * 所以用測試釘住關鍵指令，防止未來改寫時把治理要求悄悄拿掉。
 */
import { describe, expect, it } from 'vitest'
import {
  buildClarifyPrompt,
  buildGeneratePrompt,
  buildPrdClarifyPrompt,
  buildPrdDraftPrompt,
  CLARIFY_MAX_ROUNDS,
  PRD_CLARIFY_MAX_ROUNDS,
  PRD_MAX_QUESTIONS,
  PRD_SECTIONS,
  PRD_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompts.js'

describe('SYSTEM_PROMPT 治理邊界', () => {
  it('明示 LLM 只產草稿、最終決定權在使用者（docs/01 職責邊界）', () => {
    expect(SYSTEM_PROMPT).toContain('不決定')
    expect(SYSTEM_PROMPT).toContain('使用者')
  })
  it('要求 PRD 必填段落（含已知問題）與可驗證的 DoD', () => {
    expect(SYSTEM_PROMPT).toContain('目標模組/檔案')
    expect(SYSTEM_PROMPT).toContain('做什麼')
    expect(SYSTEM_PROMPT).toContain('為什麼')
    expect(SYSTEM_PROMPT).toContain('範圍')
    expect(SYSTEM_PROMPT).toContain('已知問題')
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

describe('PRD 多輪釐清（ADR-031）', () => {
  const base = { seed: '把 pottery 導入 factory，先補測試', repoDigest: 'README: pottery is a CLI', history: [] }

  it('釐清 prompt：grilling 規則、輪數與題數上限、嚴格 JSON 與 done 訊號', () => {
    const p = buildPrdClarifyPrompt({ ...base, round: 2 })
    expect(p).toContain(PRD_SYSTEM_PROMPT)
    expect(p).toContain('第 2 輪')
    expect(p).toContain(`總上限 ${PRD_CLARIFY_MAX_ROUNDS} 輪`)
    expect(p).toContain(`最多 ${PRD_MAX_QUESTIONS} 題`)
    expect(p).toContain('前提都已確定')
    expect(p).toContain('recommended 必須是 options 之一')
    expect(p).toContain('done:true')
    expect(p).toContain('不要為了湊輪數而問')
    expect(p).toContain('"questions"')
  })

  it('帶入初始需求、repo 摘要與歷史問答；沒有摘要時明講只依需求文字', () => {
    const withHistory = buildPrdClarifyPrompt({ ...base, round: 2, history: [{ question: '範圍？', answer: 'src/' }] })
    expect(withHistory).toContain('把 pottery 導入 factory')
    expect(withHistory).toContain('README: pottery is a CLI')
    expect(withHistory).toContain('Q1：範圍？\nA1：src/')
    const noDigest = buildPrdClarifyPrompt({ ...base, repoDigest: null, round: 1 })
    expect(noDigest).toContain('無法取得 repo 摘要')
  })

  it('PRD 草稿 prompt：六段粗體標題（不用 # 標題）、可驗證的驗收條件、提醒會公開', () => {
    const p = buildPrdDraftPrompt(base)
    for (const section of PRD_SECTIONS) expect(p).toContain(`**${section}**`)
    expect(p).toContain('不要用 # 標題')
    expect(p).toContain('可驗證')
    expect(p).toContain('公開')
  })

  it('系統 prompt 守住治理邊界：不決定、標示推測、不要求秘密', () => {
    expect(PRD_SYSTEM_PROMPT).toContain('不決定')
    expect(PRD_SYSTEM_PROMPT).toContain('推測')
    expect(PRD_SYSTEM_PROMPT).toContain('秘密')
    expect(PRD_SECTIONS).toEqual(['目標模組/檔案', '做什麼', '為什麼', '範圍', '已知問題', '驗收條件'])
  })
})
