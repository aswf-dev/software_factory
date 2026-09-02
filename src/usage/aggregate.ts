/**
 * 回放 DSH session log → 每 route 的 token 用量（docs/04 §5 量測路徑）。
 *
 * 語意鏡射 DSH 自己的 token-meter fold（Web UI「Turn usage」與 tokenUsage
 * projection 同一套）：以 provider 回報的 usage 樣本為準，逐 (turn, step)
 * 累加；同一 (turn, step) 出現多次樣本時，**後到的樣本取代先前的貢獻**
 * （usage chunk 是中途樣本、assistant/message 是最終樣本，不能重複計）；
 * 不同 (turn, step) 才真正累加。reasoningTokens 是 output 的子集（DSH
 * TokenUsage 慣例），只記錄不加入總量。
 *
 * 每個 usage 樣本依序歸屬到「seq 上最近的 route 事件」——route 由
 * request/context（data.provider/model）或 request/header（header.config）
 * 或 session/title-llm-request（route）攜帶。如此同一 session 內若出現
 * 不同 model（title 產生、provider 切換）也能正確分開計價。
 */

export interface RouteRef {
  provider: string
  model: string
}

/** 單一 route 的累計 token 用量（桶皆為 disjoint；reasoning ⊆ output）。 */
export interface RouteUsage extends RouteRef {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface SessionUsage {
  /** 有實際 token 的 routes（依出現順序）。 */
  routes: RouteUsage[]
  /** 全 route 加總（input/cacheRead/cacheWrite/output）。 */
  totals: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
  }
  /** 有 usage 樣本的 session 檔數。 */
  sessionCount: number
  /** session 檔路徑（診斷用）。 */
  sessions: string[]
}

export interface UsageSample {
  turn: number
  step: number
  usage: {
    inputTokens?: number | undefined
    outputTokens?: number | undefined
    cacheReadTokens?: number | undefined
    cacheWriteTokens?: number | undefined
    reasoningTokens?: number | undefined
  }
}

/** 由 usage 物件取出 disjoint 五桶；缺欄位視為 0。 */
function toBuckets(usage: UsageSample['usage']) {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    reasoning: usage.reasoningTokens ?? 0,
  }
}

export interface SessionLogInput {
  /** session log 檔路徑（診斷用）。 */
  path: string
  /** 完整解碼後的 JSONL 文字（含 header 行）。 */
  text: string
}

/**
 * 把多份 session log 折成每 route 用量。
 *
 * @param sessions - 每份 session log 的完整文字與路徑。
 * @returns 依 route 分組的用量與總量。
 */
export function foldSessionLogs(sessions: readonly SessionLogInput[]): SessionUsage {
  const routeTotals = new Map<string, RouteUsage>()
  const order: string[] = []

  for (const session of sessions) {
    const routeStack: (RouteRef | undefined)[] = []
    const events = parseEvents(session.text)
    // last 樣本取代槽：同一 route 內 (turn,step) 重複樣本只取代不重計。
    const lastByRoute = new Map<string, { turn: number; step: number; buckets: ReturnType<typeof toBuckets> }>()

    for (const event of events) {
      if (event.type === 'request/context' || event.type === 'request/header' || event.type === 'session/title-llm-request') {
        routeStack.push(routeFromEvent(event))
        continue
      }
      const sample = usageSampleFromEvent(event)
      if (sample === undefined) continue
      // 樣本不帶 route：採用目前已見的最近 route；無則歸入 unknown。
      const route = lastDefined(routeStack) ?? { provider: 'unknown', model: 'unknown' }
      const key = routeKey(route)
      let acc = routeTotals.get(key)
      if (acc === undefined) {
        acc = {
          provider: route.provider,
          model: route.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        }
        routeTotals.set(key, acc)
        order.push(key)
      }
      const buckets = toBuckets(sample.usage)
      const prev = lastByRoute.get(key)
      const replace = prev !== undefined && prev.turn === sample.turn && prev.step === sample.step
      acc.inputTokens += buckets.input - (replace ? prev!.buckets.input : 0)
      acc.outputTokens += buckets.output - (replace ? prev!.buckets.output : 0)
      acc.cacheReadTokens += buckets.cacheRead - (replace ? prev!.buckets.cacheRead : 0)
      acc.cacheWriteTokens += buckets.cacheWrite - (replace ? prev!.buckets.cacheWrite : 0)
      acc.reasoningTokens += buckets.reasoning - (replace ? prev!.buckets.reasoning : 0)
      lastByRoute.set(key, { turn: sample.turn, step: sample.step, buckets })
    }
  }

  const routes = order
    .map((k) => routeTotals.get(k))
    .filter((r): r is RouteUsage => r !== undefined)
    .filter((r) => r.inputTokens > 0 || r.outputTokens > 0 || r.cacheReadTokens > 0 || r.cacheWriteTokens > 0)

  const totals = {
    inputTokens: routes.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: routes.reduce((a, r) => a + r.outputTokens, 0),
    cacheReadTokens: routes.reduce((a, r) => a + r.cacheReadTokens, 0),
    cacheWriteTokens: routes.reduce((a, r) => a + r.cacheWriteTokens, 0),
    reasoningTokens: routes.reduce((a, r) => a + r.reasoningTokens, 0),
  }
  return { routes, totals, sessionCount: sessions.length, sessions: sessions.map((s) => s.path) }
}

/** 把 JSONL 文字解析成事件（逐行 JSON；跳過空行與不可解析行）。 */
export function parseEvents(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // 容忍壞行：session log 可能含 torn tail；壞行視同不存在
    }
  }
  return out
}

function routeKey(route: RouteRef): string {
  return `${route.provider}/${route.model}`
}

function lastDefined(stack: (RouteRef | undefined)[]): RouteRef | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i]
    if (r !== undefined) return r
  }
  return undefined
}

function routeFromEvent(event: Record<string, unknown>): RouteRef | undefined {
  if (event.type === 'request/context') {
    const data = event.data as { provider?: unknown; model?: unknown } | undefined
    if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
      return { provider: data.provider, model: data.model }
    }
    return undefined
  }
  if (event.type === 'request/header') {
    const data = event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined
    const config = data?.header?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
    return undefined
  }
  if (event.type === 'session/title-llm-request') {
    const data = event.data as { route?: { provider?: unknown; model?: unknown } } | undefined
    const route = data?.route
    if (typeof route?.provider === 'string' && typeof route?.model === 'string') {
      return { provider: route.provider, model: route.model }
    }
    return undefined
  }
  return undefined
}

function usageSampleFromEvent(event: Record<string, unknown>): UsageSample | undefined {
  if (event.type === 'assistant/chunk') {
    const data = event.data as { turn?: unknown; step?: unknown; chunk?: { type?: unknown; usage?: unknown } } | undefined
    if (data?.chunk?.type !== 'usage') return undefined
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
    const usage = normalizeUsage(data.chunk.usage)
    if (usage === undefined) return undefined
    return { turn: data.turn, step: data.step, usage }
  }
  if (event.type === 'assistant/message') {
    const data = event.data as { turn?: unknown; step?: unknown; usage?: unknown } | undefined
    if (data?.usage === undefined) return undefined
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
    const usage = normalizeUsage(data.usage)
    if (usage === undefined) return undefined
    return { turn: data.turn, step: data.step, usage }
  }
  return undefined
}

/** 驗證並正規化 provider 回報的 usage 物件；形狀不合時回 undefined（不猜測）。 */
function normalizeUsage(raw: unknown): UsageSample['usage'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const u = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const input = num(u.inputTokens)
  const output = num(u.outputTokens)
  // input 或 output 缺任一即無法計價——視為樣本缺損，不推測
  if (input === undefined || output === undefined) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    reasoningTokens: num(u.reasoningTokens),
  }
}
