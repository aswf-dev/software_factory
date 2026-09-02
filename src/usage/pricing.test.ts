import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from '../cli/run-cli.js'
import { loadPricing, lookupPricing, routeCostUsd } from './pricing.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pricing-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
  const p = join(tmp, name)
  writeFileSync(p, content)
  return p
}

describe('loadPricing', () => {
  it('讀取合法定價檔並回傳以 model 為鍵的 Map', () => {
    const p = write(
      'pricing.yaml',
      `pricing:\n  qwen3.8-flash:\n    inputUsdPerMTok: 0.15\n    outputUsdPerMTok: 0.47\n  claude-opus-5:\n    inputUsdPerMTok: 5\n    outputUsdPerMTok: 25\n    cacheReadUsdPerMTok: 0.5\n`,
    )
    const table = loadPricing(p)
    expect(table.size).toBe(2)
    expect(table.get('qwen3.8-flash')).toEqual({ inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.47 })
    expect(table.get('claude-opus-5')).toEqual({
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheReadUsdPerMTok: 0.5,
    })
  })

  it('空檔與純註解視為空定價表（沿用 model-tiers 載入慣例）', () => {
    expect(loadPricing(write('empty.yaml', '')).size).toBe(0)
    expect(loadPricing(write('comments.yaml', '# nothing here\n# 只有註解\n')).size).toBe(0)
  })

  it('結構不合法（缺 output）→ CliError', () => {
    const p = write('bad.yaml', 'pricing:\n  qwen3.8-flash:\n    inputUsdPerMTok: 0.15\n')
    expect(() => loadPricing(p)).toThrow(CliError)
  })

  it('檔案不存在 → 拋 ENOENT（formatCliError 慣例轉成單行）', () => {
    expect(() => loadPricing(join(tmp, 'missing.yaml'))).toThrow()
  })

  it('不是 YAML → CliError', () => {
    const p = write('not-yaml.txt', '\tnot: [valid\n')
    expect(() => loadPricing(p)).toThrow(CliError)
  })

  it('YAML 解析回 null（檔案內容只有 null）→ 視同空定價表', () => {
    expect(loadPricing(write('null.yaml', 'null')).size).toBe(0)
  })

  it('負價格 → CliError（fail-loud，不接受奇怪數字）', () => {
    const p = write('neg.yaml', 'pricing:\n  x:\n    inputUsdPerMTok: -1\n    outputUsdPerMTok: 1\n')
    expect(() => loadPricing(p)).toThrow(CliError)
  })

  it('非數值價格 → CliError', () => {
    const p = write('nan.yaml', 'pricing:\n  x:\n    inputUsdPerMTok: abc\n    outputUsdPerMTok: 1\n')
    expect(() => loadPricing(p)).toThrow(CliError)
  })
})

describe('lookupPricing', () => {
  it('查得到回傳定價、查不到回傳 undefined（不靜默當 0）', () => {
    const table = loadPricing(
      write(
        'one.yaml',
        'pricing:\n  qwen3.8-flash:\n    inputUsdPerMTok: 0.15\n    outputUsdPerMTok: 0.47\n',
      ),
    )
    expect(lookupPricing(table, 'qwen3.8-flash')?.inputUsdPerMTok).toBe(0.15)
    expect(lookupPricing(table, 'nope')).toBeUndefined()
  })
})

describe('routeCostUsd', () => {
  it('無定價 → costUsd undefined 且 cacheRead 不視為 unpriced（無從計價）', () => {
    expect(routeCostUsd(undefined, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 })).toEqual({
      costUsd: undefined,
      cacheReadUnpriced: false,
    })
  })

  it('有定價：cost = input×Pi + output×Po（/1e6）', () => {
    const { costUsd } = routeCostUsd(
      { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0 },
    )
    expect(costUsd).toBe(2)
  })

  it('有 cacheRead 定價時計入 cacheRead；output 已含 reasoning 不再加', () => {
    const { costUsd, cacheReadUnpriced } = routeCostUsd(
      { inputUsdPerMTok: 10, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 5 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 },
    )
    expect(costUsd).toBe(10 + 20 + 5)
    expect(cacheReadUnpriced).toBe(false)
  })

  it('cacheRead > 0 但無 cacheRead 定價 → 金額不含 cacheRead 且標 cacheReadUnpriced', () => {
    const { costUsd, cacheReadUnpriced } = routeCostUsd(
      { inputUsdPerMTok: 10, outputUsdPerMTok: 20 },
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
    )
    expect(costUsd).toBe(10)
    expect(cacheReadUnpriced).toBe(true)
  })
})
