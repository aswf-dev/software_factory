/**
 * UsageReport 的 zod schema（report.json 的 usage 區塊契約）。
 *
 * 與 src/usage/types.ts 的 UsageReport 對應；CI 的 factory-usage 寫回
 * report.json 的 usage 鍵必須符合此形狀，factory-judge/crosscheck 才能
 * fail-loud 驗證。JSON 序列化會省略 undefined 欄位，故金額欄皆 optional。
 */
import { z } from 'zod'

const Buckets = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
})

export const RouteUsageSchema = Buckets.extend({
  provider: z.string().min(1),
  model: z.string().min(1),
})

export const RouteCostSchema = RouteUsageSchema.extend({
  costUsd: z.number().nonnegative().optional(),
  cacheReadUnpriced: z.boolean(),
})

export const UsageTotalsCostSchema = Buckets.extend({
  totalTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  unpricedModels: z.array(z.string()),
  cacheReadUnpriced: z.boolean(),
})

export const UsageReportSchema = z.object({
  source: z.literal('dsh-session-log'),
  totals: UsageTotalsCostSchema,
  routes: z.array(RouteCostSchema),
  pricingRef: z.string().min(1),
  measuredAt: z.string().min(1),
  sessionCount: z.number().nonnegative().int(),
  unavailableReason: z.string().optional(),
})
