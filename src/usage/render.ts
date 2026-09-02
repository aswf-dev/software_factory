/**
 * 用量 → 成本換算與留言/report 的 markdown 渲染。
 *
 * 換算公式（USD，見 pricing.ts）：每 route 的
 *   costUsd = input×Pi/1e6 + output×Po/1e6 + cacheRead×Pc/1e6
 * outputTokens 已含 reasoning（DSH disjoint 慣例），故不再加 reasoningTokens。
 * model 查無定價 → 該 route 金額缺席、model 進 unpricedModels；任一 route
 * 未計價時總 costUsd 缺席（不給「看似完整」的數字，render 明確標示）。
 */
import type { SessionUsage } from './aggregate.js'
import { lookupPricing, routeCostUsd, type PricingTable } from './pricing.js'
import type { RouteCost, UsageReport, UsageTotalsCost } from './types.js'

/** 依定價表把 SessionUsage 換算成 UsageReport。 */
export function buildUsageReport(
  usage: SessionUsage,
  pricing: PricingTable,
  pricingRef: string,
  measuredAt: string,
): UsageReport {
  const routes: RouteCost[] = usage.routes.map((r) => {
    const modelPricing = lookupPricing(pricing, r.model)
    const { costUsd, cacheReadUnpriced } = routeCostUsd(modelPricing, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
    })
    return { ...r, costUsd, cacheReadUnpriced }
  })

  const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens') =>
    routes.reduce((a, r) => a + r[k], 0)

  const unpricedModels = [...new Set(routes.filter((r) => r.costUsd === undefined).map((r) => r.model))]
  const priced = routes.filter((r) => r.costUsd !== undefined)
  const totalCost = priced.reduce((a, r) => a + (r.costUsd ?? 0), 0)

  const inputTokens = sum('inputTokens')
  const outputTokens = sum('outputTokens')
  const cacheReadTokens = sum('cacheReadTokens')
  const cacheWriteTokens = sum('cacheWriteTokens')
  const reasoningTokens = sum('reasoningTokens')

  const totals: UsageTotalsCost = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: unpricedModels.length === 0 && priced.length > 0 ? totalCost : undefined,
    unpricedModels,
    cacheReadUnpriced: routes.some((r) => r.cacheReadUnpriced),
  }

  return { source: 'dsh-session-log', totals, routes, pricingRef, measuredAt, sessionCount: usage.sessionCount }
}

/** 把總 token 數格式化成有千分位的字串。 */
export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 把 USD 金額格式化成有意義的位數（太小就多印小數）。 */
export function formatUsd(n: number): string {
  if (n === 0) return '0.00'
  if (n < 0.01) return n.toFixed(4)
  if (n < 1) return n.toFixed(3)
  return n.toFixed(2)
}

/** 渲染給 GitHub Issue 留言用的用量段落（report.json 的 usage 區塊同內容）。 */
export function renderUsageMarkdown(report: UsageReport): string {
  const t = report.totals
  const lines: string[] = [
    '## 📊 Token 用量與成本（DSH session log 實測）',
    '',
    `- 總 token：${formatTokens(t.totalTokens)}（input ${formatTokens(t.inputTokens)} / output ${formatTokens(t.outputTokens)} / cache-read ${formatTokens(t.cacheReadTokens)} / cache-write ${formatTokens(t.cacheWriteTokens)}${t.reasoningTokens > 0 ? ` / reasoning ${formatTokens(t.reasoningTokens)}（⊆ output）` : ''}）`,
  ]
  if (t.costUsd !== undefined) {
    lines.push(`- 換算成本：約 **USD $${formatUsd(t.costUsd)}**（估算，非供應商帳單）`)
  } else if (t.unpricedModels.length > 0) {
    lines.push(`- 換算成本：**無法完整估算**——以下 model 查無定價（tokens 已列、金額未計）：${[...t.unpricedModels].join('、')}`)
  } else {
    lines.push('- 換算成本：$0.00（本次 run 無 token 消耗）')
  }
  if (t.cacheReadUnpriced) {
    lines.push('- 注意：cache-read tokens 已列，但定價表未含該 model 的 cacheRead 價，未計入金額')
  }
  if (report.routes.length === 1) {
    const r = report.routes[0] as RouteCost
    lines.push(`- model：${r.provider}/${r.model}`)
  } else if (report.routes.length > 1) {
    lines.push('')
    lines.push('| model | input | output | cache-read | USD |')
    lines.push('|---|---|---|---|---|')
    for (const r of report.routes) {
      const cost = r.costUsd === undefined ? '未計價' : `$${formatUsd(r.costUsd)}`
      lines.push(
        `| ${r.provider}/${r.model} | ${formatTokens(r.inputTokens)} | ${formatTokens(r.outputTokens)} | ${formatTokens(r.cacheReadTokens)} | ${cost} |`,
      )
    }
  }
  lines.push('')
  lines.push(`_來源：DSH session log（${report.sessionCount} 個 session）· 定價：${report.pricingRef}（pi-ai catalog，2026-08）· CI 實測，非 agent 自報_`)
  return lines.join('\n')
}

/** 無法量測時的留言段落（不偽造數字）。 */
export function renderUnavailableMarkdown(reason: string): string {
  return ['## 📊 Token 用量與成本', '', `- 無法量測：${reason}`, '', '_CI 嘗試回放 DSH session log 失敗；未偽造任何數字。_'].join('\n')
}
