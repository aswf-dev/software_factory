import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { main } from './factory-usage.js'

let tmp: string
let ws: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-usage-mutation-'))
})

beforeEach(() => {
  ws = join(tmp, `ws-${Math.random().toString(36).slice(2)}`)
  mkdirSync(ws, { recursive: true })
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const writeZstd = (rel: string, parts: string[]): string => {
  const p = join(ws, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, Buffer.concat(parts.map((s) => zstdCompressSync(Buffer.from(s, 'utf8')))))
  return p
}

const header = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: 1, cwd: '/x' }) + '\n'
const route = JSON.stringify({ type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 1 } }) + '\n'
const usage = (turn: number, step: number, i: number, o: number): string =>
  JSON.stringify({ type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage: { inputTokens: i, outputTokens: o } } } }) + '\n'

const args = (): string[] => ['--sessions-root', join(ws, 'sessions'), '--pricing', join(ws, 'pricing.yaml')]

/**
 * Mutation-strength tests for factory-usage main (src/cli/factory-usage.ts)。
 *
 * 與 repo 內其他 *-mutation.test.ts 相同原則：證明套件有「牙齒」而非只是行覆蓋。
 * 每段是一次具體的 main 變異，並斷言該變異會破壞的行為。
 *
 * Mutation log（以手改 src/cli/factory-usage.ts 套用變異後重跑驗證、再還原）：
 *
 *  | ID | Mutation                                       | Before | After  |
 *  |----|------------------------------------------------|--------|--------|
 *  | M1 | 有 logs 時誤判為 unavailable（拿掉 else）        | GREEN  | RED    |
 *  | M2 | costUsd 在 unpricedModels 非空時仍給加總        | GREEN  | RED    |
 *  | M3 | attachUsageToReport 覆寫原 report 欄位           | GREEN  | RED    |
 *  | M4 | replace 語意改成「一律累加」（同 turn/step 重複計）| GREEN  | RED    |
 */

const setup = (): void => {
  mkdirSync(join(ws, 'sessions/proj/s1'), { recursive: true })
  writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, route, usage(1, 1, 1000, 100)])
  writeFileSync(
    join(ws, 'pricing.yaml'),
    'pricing:\n  deepseek-flash:\n    inputUsdPerMTok: 0.14\n    outputUsdPerMTok: 0.28\n',
  )
}

describe('M1 變異：有 session log 卻回 unavailable（logs 分支被改成 always unavailable）', () => {
  it('有 log 時必須量測出用量與成本，而不是 unavailable', () => {
    setup()
    const out = main(args())
    expect(out.usage.unavailableReason).toBeUndefined()
    expect(out.usage.totals.inputTokens).toBe(1000)
    expect(out.usage.totals.costUsd).toBeDefined()
    expect(out.markdown).toContain('deepseek-flash')
  })
})

describe('M2 變異：unpriced route 存在時 costUsd 仍給部分加總（看似完整）', () => {
  it('有查無定價的 model 時 totals.costUsd 必須缺席，且 markdown 標無法完整估算', () => {
    mkdirSync(join(ws, 'sessions/proj/s1'), { recursive: true })
    const mystery = JSON.stringify({ type: 'request/context', data: { provider: 'x', model: 'mystery', contextWindow: 1 } }) + '\n'
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, mystery, usage(1, 1, 500, 50)])
    writeFileSync(
      join(ws, 'pricing.yaml'),
      'pricing:\n  deepseek-flash:\n    inputUsdPerMTok: 0.14\n    outputUsdPerMTok: 0.28\n',
    )
    const out = main(args())
    expect(out.usage.totals.unpricedModels).toEqual(['mystery'])
    expect(out.usage.totals.costUsd).toBeUndefined()
    expect(out.markdown).toContain('無法完整估算')
  })
})

describe('M3 變異：attachUsageToReport 覆寫原有 report 欄位', () => {
  it('--report 時保留 issueNumber/invocation 原欄位，只加 usage', () => {
    setup()
    const reportPath = join(ws, 'report.json')
    writeFileSync(reportPath, JSON.stringify({ issueNumber: 7, invocation: { exitCode: 0 }, changedPaths: [] }))
    main([...args(), '--report', reportPath])
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as { issueNumber: number; changedPaths: unknown[]; usage: { totals: { inputTokens: number } } }
    expect(parsed.issueNumber).toBe(7)
    expect(parsed.changedPaths).toEqual([])
    expect(parsed.usage.totals.inputTokens).toBe(1000)
  })
})

describe('M4 變異：同 (turn,step) 的後續 usage 樣本被重複累加（取代語意被移除）', () => {
  it('usage chunk 中途樣本 + assistant/message 最終樣本只算一次', () => {
    mkdirSync(join(ws, 'sessions/proj/s1'), { recursive: true })
    const msg = JSON.stringify({
      type: 'assistant/message',
      data: { turn: 1, step: 1, usage: { inputTokens: 1200, outputTokens: 120 } },
    }) + '\n'
    writeZstd('sessions/proj/s1/session.jsonl.zstd', [header, route, usage(1, 1, 1000, 100), msg])
    writeFileSync(
      join(ws, 'pricing.yaml'),
      'pricing:\n  deepseek-flash:\n    inputUsdPerMTok: 1\n    outputUsdPerMTok: 1\n',
    )
    const out = main(args())
    // 最終樣本取代中途樣本：1200 + 120，不是 1000+100 再 +1200+120
    expect(out.usage.totals.inputTokens).toBe(1200)
    expect(out.usage.totals.outputTokens).toBe(120)
  })
})
