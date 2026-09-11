import { describe, expect, it } from 'vitest'
import { foldSessionLogs, parseEvents, type SessionLogInput } from './aggregate.js'

/** 產生一行 JSON 事件。 */
function ev(type: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type, ...extra })}\n`
}

/** 產生 assistant/chunk 的 usage 樣本行。 */
function usageChunk(turn: number, step: number, usage: Record<string, number>): string {
  return ev('assistant/chunk', { data: { turn, step, chunk: { type: 'usage', usage } } })
}

/** 產生 assistant/message 的 usage 樣本行（最終樣本，會取代同 turn/step 的 chunk）。 */
function usageMessage(turn: number, step: number, usage: Record<string, number>): string {
  return ev('assistant/message', { data: { turn, step, usage } })
}

const route = (provider: string, model: string): string => ev('request/context', { data: { provider, model, contextWindow: 1000 } })

describe('parseEvents', () => {
  it('逐行解析 JSON；跳過空行與壞行', () => {
    const events = parseEvents('{"a":1}\n\nnot-json\n{"b":2}\n')
    expect(events).toHaveLength(2)
  })
})

describe('foldSessionLogs', () => {
  it('無 usage 樣本 → 空 routes、全零 totals', () => {
    const r = foldSessionLogs([{ path: 'a', text: ev('session') + route('deepseek', 'deepseek-flash') }])
    expect(r.routes).toEqual([])
    expect(r.totals.inputTokens).toBe(0)
    expect(r.sessionCount).toBe(1)
  })

  it('單 session 單 route：累加每個 (turn,step) 的用量', () => {
    const text =
      ev('session') +
      route('deepseek', 'deepseek-flash') +
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 10 }) +
      usageChunk(1, 2, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 5 }) +
      usageChunk(2, 1, { inputTokens: 300, outputTokens: 30 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes).toHaveLength(1)
    expect(r.routes[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      inputTokens: 600,
      outputTokens: 60,
      cacheReadTokens: 5,
    })
    expect(r.totals.inputTokens).toBe(600)
    expect(r.totals.outputTokens).toBe(60)
  })

  it('同 (turn,step) 的後續樣本取代先前貢獻（chunk 中途樣本 → message 最終樣本）', () => {
    const text =
      route('deepseek', 'deepseek-flash') +
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 10 }) +
      usageMessage(1, 1, { inputTokens: 120, outputTokens: 15 }) // 取代 100/10
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.inputTokens).toBe(120)
    expect(r.routes[0]?.outputTokens).toBe(15)
  })

  it('同 route 但不同 session：跨 session 累加', () => {
    const mk = (): SessionLogInput => ({
      path: 'x',
      text: route('deepseek', 'deepseek-flash') + usageChunk(1, 1, { inputTokens: 100, outputTokens: 10 }),
    })
    const r = foldSessionLogs([mk(), mk()])
    expect(r.routes[0]?.inputTokens).toBe(200)
    expect(r.sessionCount).toBe(2)
    expect(r.sessions).toHaveLength(2)
  })

  it('多 route：依出現順序分開累計', () => {
    const text =
      route('deepseek', 'deepseek-flash') +
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 10 }) +
      route('anthropic', 'claude-opus-5') +
      usageChunk(1, 2, { inputTokens: 200, outputTokens: 20 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes).toHaveLength(2)
    expect(r.routes[0]).toMatchObject({ provider: 'deepseek', inputTokens: 100 })
    expect(r.routes[1]).toMatchObject({ provider: 'anthropic', inputTokens: 200 })
    expect(r.totals.inputTokens).toBe(300)
  })

  it('reasoningTokens 只記錄不加入 output（⊆ output 慣例）', () => {
    const text = route('deepseek', 'deepseek-flash') + usageChunk(1, 1, { inputTokens: 100, outputTokens: 50, reasoningTokens: 40 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.reasoningTokens).toBe(40)
    expect(r.routes[0]?.outputTokens).toBe(50)
  })

  it('樣本缺 input 或 output（缺損）→ 跳過不推測', () => {
    const text = route('deepseek', 'deepseek-flash') + usageChunk(1, 1, { inputTokens: 100 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes).toEqual([])
  })

  it('request/header 也可提供 route（fallback carrier）', () => {
    const text = ev('request/header', { data: { header: { config: { provider: 'qwen', model: 'qwen3.8-flash' } } } }) + usageChunk(1, 1, { inputTokens: 10, outputTokens: 1 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]).toMatchObject({ provider: 'qwen', model: 'qwen3.8-flash' })
  })

  it('session/title-llm-request 提供 route', () => {
    const text = ev('session/title-llm-request', { data: { route: { provider: 'deepseek', model: 'deepseek-flash' } } }) + usageChunk(1, 1, { inputTokens: 5, outputTokens: 1 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.model).toBe('deepseek-flash')
  })

  it('無任何 route 事件時的 usage → unknown route（不遺失樣本）', () => {
    const text = usageChunk(1, 1, { inputTokens: 7, outputTokens: 1 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]).toMatchObject({ provider: 'unknown', model: 'unknown', inputTokens: 7 })
  })

  it('request/context 缺 provider/model → 視同無 route，樣本歸 unknown（不遺失）', () => {
    const text = ev('request/context', { data: {} }) + usageChunk(1, 1, { inputTokens: 7, outputTokens: 1 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.model).toBe('unknown')
    expect(r.routes[0]?.inputTokens).toBe(7)
  })

  it('request/header 缺 header.config → 視同無 route', () => {
    const text = ev('request/header', { data: {} }) + usageChunk(1, 1, { inputTokens: 7, outputTokens: 1 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.model).toBe('unknown')
  })

  it('session/title-llm-request 缺 route → 視同無 route', () => {
    const text = ev('session/title-llm-request', { data: {} }) + usageChunk(1, 1, { inputTokens: 7, outputTokens: 1 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.model).toBe('unknown')
  })

  it('usage 樣本缺 turn/step → 跳過', () => {
    const text = route('deepseek', 'deepseek-flash') + ev('assistant/chunk', { data: { chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } } })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes).toEqual([])
  })

  it('非 usage 的 assistant/chunk 不誤判', () => {
    const text = route('deepseek', 'deepseek-flash') + ev('assistant/chunk', { data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hi' } } })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes).toEqual([])
  })

  it('cacheWriteTokens 記錄在桶中', () => {
    const text = route('deepseek', 'deepseek-flash') + usageChunk(1, 1, { inputTokens: 10, outputTokens: 1, cacheWriteTokens: 3 })
    const r = foldSessionLogs([{ path: 'a', text }])
    expect(r.routes[0]?.cacheWriteTokens).toBe(3)
  })
})
