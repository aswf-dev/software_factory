import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { CliError } from './run-cli.js'
import { main, parseArgs } from './factory-usage.js'

let tmp: string
let ws: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-usage-'))
})

beforeEach(() => {
  ws = join(tmp, `ws-${Math.random().toString(36).slice(2)}`)
  mkdirSync(ws, { recursive: true })
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const writeFile = (rel: string, content: string): string => {
  const p = join(ws, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}

const writeZstd = (rel: string, parts: string[]): string => {
  const p = join(ws, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  const buf = Buffer.concat(parts.map((s) => zstdCompressSync(Buffer.from(s, 'utf8'))))
  writeFileSync(p, buf)
  return p
}

const usageEvent = (inputTokens: number, outputTokens: number): string =>
  JSON.stringify({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens, outputTokens } } },
  }) + '\n'

const routeEvent = (provider: string, model: string): string =>
  JSON.stringify({ type: 'request/context', data: { provider, model, contextWindow: 1 } }) + '\n'

const header = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: 1000, cwd: '/x' }) + '\n'

const sessionsRoot = (): string => {
  const d = join(ws, 'sessions')
  mkdirSync(d, { recursive: true })
  return d
}

const pricingPath = (): string => {
  const p = join(ws, 'pricing.yaml')
  writeFileSync(
    p,
    'pricing:\n  deepseek-v4.1-flash:\n    inputUsdPerMTok: 0.14\n    outputUsdPerMTok: 0.28\n  claude-opus-5:\n    inputUsdPerMTok: 5\n    outputUsdPerMTok: 25\n    cacheReadUsdPerMTok: 0.5\n',
  )
  return p
}

describe('parseArgs', () => {
  it('解析旗標與選用項', () => {
    expect(parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--since-ms', '5', '--usage-md', '/c.md', '--report', '/r.json'])).toEqual({
      sessionsRoot: '/a',
      pricingPath: '/b.yaml',
      sinceMs: 5,
      usageMdPath: '/c.md',
      reportPath: '/r.json',
    })
  })

  it('旗標可省略', () => {
    expect(parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml'])).toEqual({
      sessionsRoot: '/a',
      pricingPath: '/b.yaml',
      sinceMs: 0,
      usageMdPath: undefined,
      reportPath: undefined,
    })
  })

  it('缺 sessions-root → CliError', () => {
    expect(() => parseArgs(['--pricing', '/b.yaml'])).toThrow(CliError)
  })

  it('缺 pricing → CliError', () => {
    expect(() => parseArgs(['--sessions-root', '/a'])).toThrow(CliError)
  })

  it('旗標缺值 → CliError', () => {
    expect(() => parseArgs(['--sessions-root'])).toThrow(CliError)
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '--report', '/r.json'])).toThrow(CliError)
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--report'])).toThrow(CliError)
  })

  it('未知旗標 → CliError', () => {
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--wat'])).toThrow(CliError)
  })

  it('非預期位置參數 → CliError', () => {
    expect(() => parseArgs(['extra', '--sessions-root', '/a', '--pricing', '/b.yaml'])).toThrow(CliError)
  })

  it('--since-ms 非法 → CliError', () => {
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--since-ms', 'abc'])).toThrow(CliError)
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--since-ms', '--report'])).toThrow(CliError)
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--since-ms', '-3'])).toThrow(CliError)
  })

  it('--usage-md 缺值 → CliError', () => {
    expect(() => parseArgs(['--sessions-root', '/a', '--pricing', '/b.yaml', '--usage-md'])).toThrow(CliError)
  })
})

describe('main', () => {
  it('有 session log → 輸出換算後的 usage 與 markdown', () => {
    const root = sessionsRoot()
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, routeEvent('deepseek', 'deepseek-v4.1-flash'), usageEvent(1_000_000, 500_000)])
    const out = main(['--sessions-root', root, '--pricing', pricingPath()], () => new Date('2026-09-02T00:00:00.000Z'))
    expect(out.usage.totals.inputTokens).toBe(1_000_000)
    expect(out.usage.totals.outputTokens).toBe(500_000)
    expect(out.usage.totals.totalTokens).toBe(1_500_000)
    expect(out.usage.totals.costUsd).toBeCloseTo(0.14 + 0.14, 10)
    expect(out.usage.unavailableReason).toBeUndefined()
    expect(out.markdown).toContain('deepseek-v4.1-flash')
    expect(out.markdown).toContain('USD $0.28')
  })

  it('無 session log → unavailableReason 且 exit 不失敗（main 回傳，不拋）', () => {
    const out = main(['--sessions-root', join(ws, 'empty-sessions'), '--pricing', pricingPath()])
    expect(out.usage.unavailableReason).toContain('找不到')
    expect(out.usage.totals.totalTokens).toBe(0)
    expect(out.markdown).toContain('未偽造')
  })

  it('--since-ms 過濾舊 session', () => {
    const root = sessionsRoot()
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, routeEvent('deepseek', 'deepseek-v4.1-flash'), usageEvent(1000, 100)])
    writeZstd('sessions/proj/s2/session.jsonl.zstd', [`${JSON.stringify({ type: 'session', version: 0, id: 's2', createdAt: 5000, cwd: '/x' })}\n`, routeEvent('deepseek', 'deepseek-v4.1-flash'), usageEvent(2000, 200)])
    const out = main(['--sessions-root', root, '--pricing', pricingPath(), '--since-ms', '2000'])
    expect(out.usage.totals.inputTokens).toBe(2000)
  })

  it('--usage-md 寫出 markdown 檔', () => {
    const root = sessionsRoot()
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, routeEvent('deepseek', 'deepseek-v4.1-flash'), usageEvent(1000, 100)])
    const mdPath = join(ws, 'usage.md')
    const out = main(['--sessions-root', root, '--pricing', pricingPath(), '--usage-md', mdPath])
    expect(readFileSync(mdPath, 'utf8')).toBe(out.markdown)
  })

  it('--report 把 usage 寫回 report.json（保留原欄位）', () => {
    const root = sessionsRoot()
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, routeEvent('deepseek', 'deepseek-v4.1-flash'), usageEvent(1000, 100)])
    const reportPath = writeFile('report.json', JSON.stringify({ issueNumber: 7, invocation: { exitCode: 0 } }))
    main(['--sessions-root', root, '--pricing', pricingPath(), '--report', reportPath])
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { issueNumber: number; usage?: { totals: { inputTokens: number } } }
    expect(report.issueNumber).toBe(7)
    expect(report.usage?.totals.inputTokens).toBe(1000)
  })

  it('--report 指向不存在/壞 JSON/非物件 JSON 的 report → 不拋錯、不產檔', () => {
    const root = sessionsRoot()
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, routeEvent('deepseek', 'deepseek-v4.1-flash'), usageEvent(1000, 100)])
    const reportPath = join(ws, 'missing-report.json')
    expect(() => main(['--sessions-root', root, '--pricing', pricingPath(), '--report', reportPath])).not.toThrow()
    expect(() => {
      const bad = writeFile('bad-report.json', 'not json')
      main(['--sessions-root', root, '--pricing', pricingPath(), '--report', bad])
    }).not.toThrow()
    expect(() => {
      const arr = writeFile('array-report.json', '[1,2,3]')
      main(['--sessions-root', root, '--pricing', pricingPath(), '--report', arr])
    }).not.toThrow()
    expect(() => {
      const nul = writeFile('null-report.json', 'null')
      main(['--sessions-root', root, '--pricing', pricingPath(), '--report', nul])
    }).not.toThrow()
    expect(() => {
      const num = writeFile('num-report.json', '42')
      main(['--sessions-root', root, '--pricing', pricingPath(), '--report', num])
    }).not.toThrow()
  })

  it('session log 全數壞檔 → unavailableReason 註明 skipped 數', () => {
    const root = sessionsRoot()
    writeFileSync(join(root, 'session.jsonl.zstd'), 'definitely not zstd')
    const out = main(['--sessions-root', root, '--pricing', pricingPath()])
    expect(out.usage.unavailableReason).toContain('找不到')
    expect(out.usage.unavailableReason).toContain('無法解碼')
    expect(out.markdown).toContain('未偽造')
  })

  it('空 root 且設 --since-ms → reason 含 since 資訊', () => {
    const out = main(['--sessions-root', join(ws, 'empty2'), '--pricing', pricingPath(), '--since-ms', '123'])
    expect(out.usage.unavailableReason).toContain('since 123')
  })

  it('未知 model → unpricedModels、costUsd 缺席、markdown 標無法完整估算', () => {
    const root = sessionsRoot()
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, usageEvent(1000, 100)])
    // 改 route 為查無定價的 model
    const customHeader = JSON.stringify({ type: 'request/context', data: { provider: 'anthropic', model: 'claude-opus-5', contextWindow: 1 } }) + '\n'
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, customHeader, usageEvent(1000, 100)])
    const out = main(['--sessions-root', root, '--pricing', pricingPath()])
    expect(out.usage.totals.unpricedModels).toEqual([]) // claude-opus-5 有價
    expect(out.usage.totals.costUsd).toBeDefined()
  })

  it('model 無價（custom model）→ unpriced 標示', () => {
    const root = sessionsRoot()
    const customHeader = JSON.stringify({ type: 'request/context', data: { provider: 'x', model: 'mystery-model', contextWindow: 1 } }) + '\n'
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, customHeader, usageEvent(1000, 100)])
    const out = main(['--sessions-root', root, '--pricing', pricingPath()])
    expect(out.usage.totals.unpricedModels).toEqual(['mystery-model'])
    expect(out.usage.totals.costUsd).toBeUndefined()
    expect(out.markdown).toContain('mystery-model')
  })
})
