/**
 * 定價表載入（config/dsh/pricing.yaml，docs/ADR/011）。
 *
 * 每工作項成本 = provider 回報的 token 用量 × 此定價表（USD/MTok）。定價是
 * repo 自有的機器可讀表——DSH 本身不換錢（pi-ai adapter 的 cost metadata 在
 * replay 時歸零，見 node_modules 內 dsh-llm-pi-ai 原始碼註記）。
 *
 * 用量桶語意沿用 DSH TokenUsage 的 disjoint 慣例：
 *   - inputTokens 不含 cache read（DeepSeek adapter 把 cache hit 從 prompt
 *     tokens 扣除後才寫入 inputTokens，見 dsh-llm-deepseek mapUsage）；
 *   - outputTokens 已含 reasoning（reasoningTokens 是輸出子集，不得再加）。
 */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { z } from 'zod'
import { CliError } from '../cli/run-cli.js'

/** 單一 model 的 USD/MTok 定價。cacheRead 缺欄＝快取讀取不單獨計價。 */
export interface ModelPricing {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  cacheReadUsdPerMTok?: number | undefined
}

/** 以 model id 為鍵的定價表（model id 跨 provider 唯一，見 model-tiers.yaml）。 */
export type PricingTable = ReadonlyMap<string, ModelPricing>

const ModelPricingSchema = z.object({
  inputUsdPerMTok: z.number().nonnegative().finite(),
  outputUsdPerMTok: z.number().nonnegative().finite(),
  cacheReadUsdPerMTok: z.number().nonnegative().finite().optional(),
})

const PricingFileSchema = z.object({
  pricing: z.record(z.string().min(1), ModelPricingSchema),
})

/** 讀定價檔並驗證；空檔/純註解視為「空定價表」（無任何 model 有價）。 */
export function loadPricing(path: string): PricingTable {
  const text = readFileSync(path, 'utf8')
  let raw: unknown
  if (text.trim() === '' || text.trim().split('\n').every((l) => l.trim().startsWith('#'))) {
    raw = { pricing: {} }
  } else {
    try {
      // YAML 檔解析回 null（如內容只有 "null"）→ 視同空定價表
      raw = load(text) ?? { pricing: {} }
    } catch (err) {
      throw new CliError(`pricing (${path}) is not valid YAML: ${(err as Error).message}`)
    }
  }
  const parsed = PricingFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CliError(
      `pricing (${path}) is invalid: 需 pricing 為 model id → {inputUsdPerMTok, outputUsdPerMTok[, cacheReadUsdPerMTok]} 的 dict`,
    )
  }
  return new Map(Object.entries(parsed.data.pricing))
}

/**
 * 查 model 定價。
 * @returns 定價；model 不存在回傳 undefined（呼叫做足量判斷，勿靜默當 0）。
 */
export function lookupPricing(table: PricingTable, model: string): ModelPricing | undefined {
  return table.get(model)
}

/**
 * 單一 route 的成本公式（USD）。
 *
 * cost = input×Pi/1e6 + output×Po/1e6 + cacheRead×Pc/1e6
 *  - output 已含 reasoning（不再加 reasoningTokens）；
 *  - cacheRead 僅在有 cacheRead 價時計入；缺價時該桶照列 tokens 但不計金額
 *    （回傳的 costUsd 不含它，caller 以 `cacheReadUnpriced` 標示）。
 */
export function routeCostUsd(
  pricing: ModelPricing | undefined,
  buckets: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  },
): { costUsd: number | undefined; cacheReadUnpriced: boolean } {
  if (pricing === undefined) return { costUsd: undefined, cacheReadUnpriced: false }
  const input = (buckets.inputTokens * pricing.inputUsdPerMTok) / 1_000_000
  const output = (buckets.outputTokens * pricing.outputUsdPerMTok) / 1_000_000
  const cacheReadP = pricing.cacheReadUsdPerMTok
  if (cacheReadP === undefined) {
    return {
      costUsd: input + output,
      cacheReadUnpriced: buckets.cacheReadTokens > 0,
    }
  }
  const cacheRead = (buckets.cacheReadTokens * cacheReadP) / 1_000_000
  return { costUsd: input + output + cacheRead, cacheReadUnpriced: false }
}
