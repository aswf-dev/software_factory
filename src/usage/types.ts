/**
 * Usage 報告的共用型別（factory-usage CLI 輸出、report.json 的 usage 區塊、
 * apply-judge-labels 留言皆共用此形狀）。
 */
import type { RouteUsage } from './aggregate.js'

/** 單一 route 的成本結果。costUsd undefined＝該 model 無定價（未計價）。 */
export interface RouteCost extends RouteUsage {
  costUsd?: number | undefined
  /** cacheRead > 0 但定價表無 cacheRead 欄位（僅列 tokens、未計金額）。 */
  cacheReadUnpriced: boolean
}

/** 報告層級的成本匯總。costUsd undefined＝有不計價 route 或全無定價。 */
export interface UsageTotalsCost {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd?: number | undefined
  /** 有 token 卻查無定價的 model id（不計入 costUsd）。 */
  unpricedModels: string[]
  /** 任一 route 的 cacheRead 未計價（快取讀取未含於金額）。 */
  cacheReadUnpriced: boolean
}

export interface UsageReport {
  /** 資料來源，恆為 dsh-session-log。 */
  source: 'dsh-session-log'
  totals: UsageTotalsCost
  routes: RouteCost[]
  /** 定價表檔名（診斷用）。 */
  pricingRef: string
  /** 量測完成時間（ISO 8601）。 */
  measuredAt: string
  /** 有 usage 樣本的 session 檔數。 */
  sessionCount: number
  /** 無法量測的原因；缺席＝量測成功。 */
  unavailableReason?: string | undefined
}
