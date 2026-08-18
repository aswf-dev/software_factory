/**
 * Integration tests for gh CLI JSON parsing (docs/11 §4.2).
 *
 * Field names were verified against gh v2.93.0. These tests pin our assumptions
 * so that an upstream field rename fails loudly here rather than silently
 * corrupting the metrics in docs/08.
 */

import { describe, expect, it } from 'vitest'
import {
  changedLines,
  hasLabel,
  idleRatio,
  leadTimeHours,
  parseIssues,
  parsePullRequests,
} from '../../src/integration/gh-parse.js'

const ISSUES_JSON = JSON.stringify([
  {
    number: 1,
    title: '補齊計分邏輯測試',
    createdAt: '2026-08-01T00:00:00Z',
    closedAt: '2026-08-03T00:00:00Z',
    labels: [{ name: 'oversight/on-loop' }, { name: 'ready' }],
  },
  {
    number: 2,
    title: '修復授權判斷',
    createdAt: '2026-08-02T00:00:00Z',
    closedAt: null,
    labels: [{ name: 'oversight/in-loop' }],
  },
])

const PRS_JSON = JSON.stringify([
  {
    number: 10,
    createdAt: '2026-08-01T00:00:00Z',
    mergedAt: '2026-08-01T06:00:00Z',
    additions: 120,
    deletions: 30,
  },
  { number: 11, createdAt: '2026-08-02T00:00:00Z', mergedAt: null, additions: 5, deletions: 0 },
])

describe('gh issue list --json 解析（欄位已對 gh v2.93.0 查證）', () => {
  it('解析基本欄位', () => {
    const issues = parseIssues(ISSUES_JSON)
    expect(issues).toHaveLength(2)
    expect(issues[0]?.number).toBe(1)
    expect(issues[0]?.title).toBe('補齊計分邏輯測試')
  })

  it('closedAt 可為 null（未關閉）', () => {
    expect(parseIssues(ISSUES_JSON)[1]?.closedAt).toBeNull()
  })

  it('labels 缺失時預設為空陣列', () => {
    const json = JSON.stringify([{ number: 3, title: 'x', createdAt: '2026-08-01T00:00:00Z' }])
    expect(parseIssues(json)[0]?.labels).toEqual([])
  })

  it('欄位型別錯誤 → 明確拋錯，不靜默接受', () => {
    // Failing loudly matters: silently coercing bad data would corrupt metrics
    // in a way nobody notices until decisions have been made on them.
    const bad = JSON.stringify([{ number: 'not-a-number', title: 'x', createdAt: 'y' }])
    expect(() => parseIssues(bad)).toThrow()
  })

  it('缺少必要欄位 → 拋錯', () => {
    expect(() => parseIssues(JSON.stringify([{ title: 'no number' }]))).toThrow()
  })
})

describe('oversight 標籤判定（docs/06 §5.1）', () => {
  it('正確辨識 on-loop 與 in-loop', () => {
    const [first, second] = parseIssues(ISSUES_JSON)
    expect(hasLabel(first!, 'oversight/on-loop')).toBe(true)
    expect(hasLabel(first!, 'oversight/in-loop')).toBe(false)
    expect(hasLabel(second!, 'oversight/in-loop')).toBe(true)
  })

  it('不存在的標籤回傳 false', () => {
    expect(hasLabel(parseIssues(ISSUES_JSON)[0]!, 'needs-human')).toBe(false)
  })
})

describe('gh pr list --json 解析與衍生指標', () => {
  it('解析並計算變更行數（自動合併門檻的輸入）', () => {
    const prs = parsePullRequests(PRS_JSON)
    expect(changedLines(prs[0]!)).toBe(150)
    expect(changedLines(prs[1]!)).toBe(5)
  })

  it('lead time：已合併者以小時計', () => {
    expect(leadTimeHours(parsePullRequests(PRS_JSON)[0]!)).toBe(6)
  })

  it('lead time：未合併者為 null', () => {
    expect(leadTimeHours(parsePullRequests(PRS_JSON)[1]!)).toBeNull()
  })

  it('additions/deletions 缺失時預設為 0', () => {
    const json = JSON.stringify([{ number: 1, createdAt: '2026-08-01T00:00:00Z' }])
    expect(changedLines(parsePullRequests(json)[0]!)).toBe(0)
  })

  it('lead time：mergedAt 欄位缺席（undefined）時為 null，與 null 同義', () => {
    // Schema 把 mergedAt 宣告為 nullable + optional：欄位整個缺席時是 undefined。
    // 兩者都代表「未合併」，對 undefined 的判斷是合約的一部分（docs/08 §2.1）。
    const json = JSON.stringify([{ number: 12, createdAt: '2026-08-02T00:00:00Z' }])
    expect(leadTimeHours(parsePullRequests(json)[0]!)).toBeNull()
  })

  it('lead time：非整數小時原樣回傳，不做四捨五入', () => {
    // 計算必須保留原始精度；round/floor 的變異會讓這個斷言變紅。
    const json = JSON.stringify([
      { number: 13, createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-01T01:30:00Z' },
    ])
    expect(leadTimeHours(parsePullRequests(json)[0]!)).toBe(1.5)
  })
})

describe('閒置比（docs/08 §2.1 的核心指標）', () => {
  it('lead 24h、process 6h → 0.75', () => {
    expect(idleRatio(24, 6)).toBe(0.75)
  })

  it('完全無閒置 → 0', () => {
    expect(idleRatio(10, 10)).toBe(0)
  })

  it('lead time 為 0 → 回傳 0，不除以零', () => {
    expect(idleRatio(0, 0)).toBe(0)
    expect(idleRatio(-5, 1)).toBe(0)
  })

  it('process 大於 lead（資料異常）→ 夾為 0，不回傳負值', () => {
    // Negative idleness is meaningless; bad input must not produce a metric that
    // looks like an improvement.
    expect(idleRatio(5, 10)).toBe(0)
  })

  it('process 為 0 → 全部為閒置（比值 1）', () => {
    expect(idleRatio(10, 0)).toBe(1)
  })

  it('process 為負（資料異常）→ 原始比值逾 1，夾回 1', () => {
    // process < 0 時 (lead − process)/lead > 1，上界 clamp 把「逾 100% 閒置」的
    // 不合理比值夾回 1，與「完全無處理時間 → 1」一致，並守住對應實作變異。
    expect(idleRatio(10, -5)).toBe(1)
  })
})
