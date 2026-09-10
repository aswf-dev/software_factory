import { describe, expect, it } from 'vitest'
import { foldSessionLogs, type SessionLogInput } from './aggregate.js'
import { lookupPricing } from './pricing.js'
import { buildUsageReport, formatTokens, formatUsd, renderUnavailableMarkdown, renderUsageMarkdown } from './render.js'

/** 產生 assistant/chunk 的 usage 樣本行。 */
function usageChunk(turn: number, step: number, usage: Record<string, number>): string {
  return `${JSON.stringify({ type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } })}\n`
}

const route = (provider: string, model: string): string =>
  `${JSON.stringify({ type: 'request/context', data: { provider, model, contextWindow: 1000 } })}\n`

/** 單一 session log input（deepseek-v4.1-flash 兩步）。 */
const deepseekSession: SessionLogInput = {
  path: 's1',
  text:
    route('deepseek-official', 'deepseek-v4.1-flash') +
    usageChunk(1, 1, { inputTokens: 100_000, outputTokens: 10_000 }) +
    usageChunk(1, 2, { inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 20_000 }),
}

const PRICING_REF = 'config/dsh/pricing.yaml'

describe('buildUsageReport', () => {
  it('routes 全空（session 有 log 但無 usage 樣本）→ costUsd undefined、priced 0、渲染 $0.00', () => {
    const usage = foldSessionLogs([{ path: 's0', text: '{"type":"session","version":0,"id":"s","createdAt":1,"cwd":"/x"}\n' }])
    const pricing = new Map([['deepseek-v4.1-flash', { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 }]])
    const report = buildUsageReport(usage, pricing, PRICING_REF, '2026-09-02T00:00:00.000Z')
    expect(report.totals.totalTokens).toBe(0)
    expect(report.totals.costUsd).toBeUndefined()
    expect(report.totals.unpricedModels).toEqual([])
    const md = renderUsageMarkdown(report)
    expect(md).toContain('$0.00')
  })

  it('全部 route 有定價 → totals.costUsd = 加總', () => {
    const usage = foldSessionLogs([deepseekSession])
    const pricing = new Map([
      ['deepseek-v4.1-flash', { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 }],
    ])
    const report = buildUsageReport(usage, pricing, PRICING_REF, '2026-09-02T00:00:00.000Z')
    // input 150k * 0.14/1e6 + output 15k * 0.28/1e6 = 0.021 + 0.0042
    expect(report.totals.costUsd).toBeCloseTo(0.0252, 8)
    expect(report.totals.totalTokens).toBe(150_000 + 15_000 + 20_000)
    expect(report.totals.unpricedModels).toEqual([])
    expect(report.source).toBe('dsh-session-log')
    expect(report.routes[0]?.costUsd).toBeCloseTo(0.0252, 8)
  })

  it('部分 route 無定價 → unpricedModels 列出、totals.costUsd 缺席（不給看似完整數字）', () => {
    const usage = foldSessionLogs([
      deepseekSession,
      {
        path: 's2',
        text: route('anthropic', 'claude-opus-5') + usageChunk(1, 1, { inputTokens: 1_000_000, outputTokens: 100_000 }),
      },
    ])
    const pricing = new Map([['deepseek-v4.1-flash', { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 }]])
    const report = buildUsageReport(usage, pricing, PRICING_REF, '2026-09-02T00:00:00.000Z')
    expect(report.totals.costUsd).toBeUndefined()
    expect(report.totals.unpricedModels).toEqual(['claude-opus-5'])
    expect(report.routes.find((r) => r.model === 'claude-opus-5')?.costUsd).toBeUndefined()
    expect(report.routes.find((r) => r.model === 'deepseek-v4.1-flash')?.costUsd).toBeDefined()
  })

  it('cacheRead 有定價 → 計入金額；cacheReadUnpriced false', () => {
    const usage = foldSessionLogs([deepseekSession])
    const pricing = new Map([
      ['deepseek-v4.1-flash', { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28, cacheReadUsdPerMTok: 0.014 }],
    ])
    const report = buildUsageReport(usage, pricing, PRICING_REF, '2026-09-02T00:00:00.000Z')
    expect(report.totals.cacheReadUnpriced).toBe(false)
    // 150k*0.14 + 15k*0.28 + 20k*0.014 (per 1e6)
    expect(report.totals.costUsd).toBeCloseTo(0.021 + 0.0042 + 0.00028, 10)
  })

  it('cacheRead>0 但無 cacheRead 定價 → 金額不含 cacheRead 且標 cacheReadUnpriced', () => {
    const usage = foldSessionLogs([deepseekSession])
    const pricing = new Map([
      ['deepseek-v4.1-flash', { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 }],
    ])
    const report = buildUsageReport(usage, pricing, PRICING_REF, '2026-09-02T00:00:00.000Z')
    expect(report.totals.cacheReadUnpriced).toBe(true)
  })
})

describe('renderUsageMarkdown', () => {
  function reportWith(costUsd: number | undefined, opts: { cacheReadUnpriced?: boolean; unpriced?: string[]; routes?: number } = {}) {
    return {
      source: 'dsh-session-log' as const,
      totals: {
        inputTokens: 150_000,
        outputTokens: 15_000,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 185_000,
        costUsd,
        unpricedModels: opts.unpriced ?? [],
        cacheReadUnpriced: opts.cacheReadUnpriced ?? false,
      },
      routes: Array.from({ length: opts.routes ?? 1 }, () => ({
        provider: 'deepseek-official',
        model: 'deepseek-v4.1-flash',
        inputTokens: 150_000,
        outputTokens: 15_000,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd,
        cacheReadUnpriced: opts.cacheReadUnpriced ?? false,
      })),
      pricingRef: PRICING_REF,
      measuredAt: '2026-09-02T00:00:00.000Z',
      sessionCount: 1,
    }
  }

  it('有成本 → 列出總 token、換算成本與來源', () => {
    const md = renderUsageMarkdown(reportWith(0.0252))
    expect(md).toContain('185,000')
    expect(md).toContain('USD $0.025')
    expect(md).toContain('deepseek-v4.1-flash')
    expect(md).toContain('非 agent 自報')
  })

  it('多 route → 附 route 明細表', () => {
    const md = renderUsageMarkdown(reportWith(1, { routes: 2 }))
    expect(md).toContain('| model | input | output | cache-read | USD |')
  })

  it('部分未計價 → 標出未計價 model，不給總金額', () => {
    const md = renderUsageMarkdown(reportWith(undefined, { unpriced: ['claude-opus-5'] }))
    expect(md).toContain('claude-opus-5')
    expect(md).toContain('無法完整估算')
  })

  it('cacheRead 未計價 → 加注意行', () => {
    const md = renderUsageMarkdown(reportWith(0.021, { cacheReadUnpriced: true }))
    expect(md).toContain('cache-read tokens 已列')
  })
})

describe('renderUnavailableMarkdown', () => {
  it('標示原因且聲明未偽造', () => {
    const md = renderUnavailableMarkdown('找不到 session log')
    expect(md).toContain('找不到 session log')
    expect(md).toContain('未偽造')
  })
})

describe('format helpers', () => {
  it('formatTokens 千分位', () => {
    expect(formatTokens(1_234_567)).toBe('1,234,567')
  })
  it('formatUsd 依大小給位數', () => {
    expect(formatUsd(0)).toBe('0.00')
    expect(formatUsd(0.0001234)).toBe('0.0001')
    expect(formatUsd(0.5)).toBe('0.500')
    expect(formatUsd(1.5)).toBe('1.50')
  })
})

describe('lookupPricing 整合（防 drift）', () => {
  it('查無定價的 model 在 build 時不會被誤計', async () => {
    const { loadPricing } = await import('./pricing.js')
    const { readFileSync } = await import('node:fs')
    const table = loadPricing(new URL('../../config/dsh/pricing.yaml', import.meta.url).pathname)
    expect(lookupPricing(table, 'deepseek-v4.1-flash')).toBeDefined()
    expect(lookupPricing(table, 'qwen3.8-flash')).toBeDefined()
    expect(lookupPricing(table, 'claude-opus-5')).toBeDefined()
    expect(lookupPricing(table, 'no-such-model')).toBeUndefined()
    expect(readFileSync(new URL('../../config/dsh/pricing.yaml', import.meta.url), 'utf8')).toContain('pricing:')
  })
})
