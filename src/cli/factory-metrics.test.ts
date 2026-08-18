/**
 * factory-metrics 測試（docs/08 §2/§7，Phase 2 T5）。
 *
 * computeMetrics/renderMarkdown 為純函式；main 的 gh 呼叫以注入取代。
 */
import { describe, expect, it } from 'vitest'
import { AUTOMERGE_MAX_LINES } from '../scoring/score.js'
import { computeMetrics, main, parsePrs, renderMarkdown } from './factory-metrics.js'
import type { PrData } from './factory-metrics.js'

const PRS: PrData[] = [
  {
    number: 1,
    createdAt: '2026-08-01T00:00:00Z',
    mergedAt: '2026-08-01T02:00:00Z',
    additions: 100,
    deletions: 20,
    labels: [],
  },
  {
    number: 2,
    createdAt: '2026-08-02T00:00:00Z',
    mergedAt: '2026-08-02T01:00:00Z',
    additions: 300,
    deletions: 0,
    labels: [{ name: 'defect/escape' }],
  },
  // 未合併：不計入 lead time / 大小
  { number: 3, createdAt: '2026-08-03T00:00:00Z', mergedAt: null, additions: 999, deletions: 999, labels: [] },
]

describe('computeMetrics', () => {
  it('計算 lead time 平均（小時）與合併數', () => {
    const m = computeMetrics(PRS)
    expect(m.mergedCount).toBe(2)
    expect(m.leadTimeHours).toBeCloseTo(1.5, 5) // (2h + 1h) / 2
  })
  it('平均 PR 大小只算合併的 PR', () => {
    const m = computeMetrics(PRS)
    expect(m.avgAdditions).toBe(200) // (100+300)/2
  })
  it('超過自動合併上限的 PR 被標記（只算合併）', () => {
    const m = computeMetrics(PRS)
    expect(m.overLimitCount).toBe(1) // PR2 320 行 > 200；PR3 未合併不計
    expect(m.overLimitCount).toBe(PRS.filter((p) => p.mergedAt != null && p.additions + p.deletions > AUTOMERGE_MAX_LINES).length)
  })
  it('缺陷逃逸數：帶 defect/escape 標籤的合併 PR（其他標籤不計）', () => {
    const m = computeMetrics([...PRS, { number: 4, createdAt: '2026-08-04T00:00:00Z', mergedAt: '2026-08-04T01:00:00Z', additions: 5, deletions: 0, labels: [{ name: 'bug' }] }])
    expect(m.defectEscapeCount).toBe(1) // 只有 PR2 是 defect/escape；bug 標籤不計
  })
  it('無合併 PR → 全零（不除零）', () => {
    const m = computeMetrics([PRS[2] as PrData])
    expect(m.mergedCount).toBe(0)
    expect(m.leadTimeHours).toBe(0)
    expect(m.avgAdditions).toBe(0)
    expect(m.overLimitCount).toBe(0)
  })
})

describe('parsePrs', () => {
  it('解析 gh pr list JSON（labels 可缺省）', () => {
    const prs = parsePrs(
      JSON.stringify([
        { number: 1, createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-01T02:00:00Z', additions: 10, deletions: 2 },
      ]),
    )
    expect(prs[0]?.labels).toEqual([])
    expect(prs[0]?.number).toBe(1)
  })
  it('JSON 合法但 schema 不符 → CliError', () => {
    expect(() => parsePrs(JSON.stringify([{ number: 'oops' }]))).toThrow()
  })
})

describe('renderMarkdown', () => {
  const md = renderMarkdown(computeMetrics(PRS))
  it('含標題與各指標行', () => {
    expect(md).toContain('產出型指標')
    expect(md).toContain('合併 PR：2')
    expect(md).toContain('Lead Time')
    expect(md).toContain('缺陷逃逸')
    expect(md).toContain(String(AUTOMERGE_MAX_LINES))
  })
})

describe('main（注入 fake gh）', () => {
  it('呼叫 gh pr list 並輸出 metrics 與 markdown', () => {
    const gh = (args: string[]): string => {
      expect(args[0]).toBe('pr')
      expect(args[1]).toBe('list')
      return JSON.stringify([
        { number: 1, createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-01T02:00:00Z', additions: 100, deletions: 20, labels: [] },
      ])
    }
    const out = main([], gh)
    expect(out.metrics.mergedCount).toBe(1)
    expect(out.metrics.leadTimeHours).toBeCloseTo(2, 5)
    expect(out.markdown).toContain('產出型指標')
  })
  it('limit 非正整數 → CliError（不呼叫 gh）', () => {
    const gh = (): string => {
      throw new Error('should not call gh')
    }
    expect(() => main(['0'], gh)).toThrow()
    expect(() => main(['abc'], gh)).toThrow() // NaN → !Number.isInteger 分支
  })
  it('limit 為正整數時傳給 gh', () => {
    const gh = (args: string[]): string => {
      expect(args).toContain('--limit')
      expect(args[args.indexOf('--limit') + 1]).toBe('100')
      return '[]'
    }
    const out = main(['100'], gh)
    expect(out.metrics.mergedCount).toBe(0)
  })
})
