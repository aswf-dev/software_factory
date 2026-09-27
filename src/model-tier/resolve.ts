/**
 * Model tier 解析核心（docs/ADR/011）。
 *
 * 純邏輯＋設定載入，被兩個 CLI 共用：
 *  - `factory-model`（factory-run 的 Select model tier 步驟）：完整解析（含
 *    score.total 的 critical 升級條件）＋輸出 chain 供 bash 迭代；
 *  - `factory-issue-check`（Issue 開立時留言建議）：只給分析結果（無 score，
 *    不觸發 critical——critical 需 review 上緣的總分，只有 factory-run 才算）。
 *
 * 解析順序（ADR-011 D3）：手動 `model_tier` ＞ Issue 需求分析 ＞ catalog 標註
 * ＞ fail-safe high。critical 額外條件：分析為 high 且 `score.total ≥ 4`
 * （review 上緣；5–6 為 in-loop，agent 不啟動故不耗模型）。
 *
 * fail-loud 原則：設定檔格式錯誤、chain 引用未宣告的 provider、未知的偏好
 * provider、缺 tier——一律拋 CliError，絕不靜默降級（沿用 src/cli 慣例）。
 */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { z } from 'zod'
import { CliError } from '../cli/run-cli.js'
import { COMPLEXITY, type Complexity } from '../scoring/types.js'
import type { ComplexityAnalysis } from '../issue-analysis/complexity.js'

/** 模型 tier id。low/medium/high 為 auto 路徑必需；critical 可選（手動或升級）。 */
export const MODEL_TIERS = ['low', 'medium', 'high', 'critical'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/** pi-ai 的 reasoning effort 等級（與 @earendil-works/pi-ai 的 level set 對齊）。 */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Chain 中的單一模型項：provider route ＋ 該 route 的 model id（＋可選 effort）。 */
export interface ModelEntry {
  provider: string
  model: string
  reasoningEffort?: string | undefined
}

export interface TierPolicy {
  primary: ModelEntry
  fallback: readonly ModelEntry[]
}

export type TierPolicies = {
  low: TierPolicy
  medium: TierPolicy
  high: TierPolicy
  critical?: TierPolicy | undefined
}

/** critical 升級門檻：複雜度 high 且總分 ≥ 4（docs/06 §4 的 review 上緣）。 */
export const CRITICAL_MIN_TOTAL = 4

/**
 * heavy-verify 任務的 critical 升級**不受總分門檻限制**（B5）。
 *
 * 理由：`CRITICAL_MIN_TOTAL` 是「review 上緣」的成本保險，預設只有高風險變更才
 * 願意燒旗艦。但模型檢查任務的成本結構不同——它的失敗模式不是「改壞東西」，而是
 * **一整個 run 的牆鐘被 Apalache 迭代吃掉、交付為零**（34735315950 實證：50 分鐘
 * 換到 0 commit，成本 $0.31 全損）。此時「先升級到強模型以更早做出降界取捨」的
 * 期望值明顯較高，故繞過分數門檻。
 */
export const HEAVY_VERIFY_ESCALATION_EVIDENCE = '計算強度 heavy-verify（模型檢查/求解器迭代）'

export type ComplexitySource = 'manual' | 'issue-analysis' | 'catalog' | 'fail-safe'

/**
 * tier 被強制升級的原因（B5）。缺席 = 依複雜度常態解析。
 *  - `heavy-verify`：Issue 需求分析判定為模型檢查/求解器迭代任務，繞過
 *    scoreTotal 門檻直接升 critical（34735315950 事故修正）。
 */
export type TierEscalationReason = 'heavy-verify'

export interface ModelResolution {
  tier: ModelTier
  /** 顯示用複雜度（手動覆寫時取分析值，無分析則 high）。 */
  complexity: Complexity
  complexitySource: ComplexitySource
  evidence: readonly string[]
  reason: string
  selected: ModelEntry
  /** primary + fallback 的迭代順序（含偏好 provider 過濾）。 */
  chain: readonly ModelEntry[]
  /** 強制升級原因；undefined = 未觸發。供 factory-run 決定 agent 逾時預算。 */
  escalation?: TierEscalationReason | undefined
}

export interface ModelResolutionInput {
  tiers: TierPolicies
  declaredProviders: readonly string[]
  /** 手動覆寫；undefined 或 'auto' = 自動解析。 */
  manualTier?: ModelTier | 'auto' | undefined
  /** Issue 需求分析結果（factory-issue-check 已抽好欄位）。 */
  analysis?: ComplexityAnalysis | undefined
  /** catalog 的 factory.io/complexity 原始值（score.json 的 annotations）。 */
  catalogComplexity?: string | undefined
  /** 初始計分總分（factory-score 輸出）；缺席則不觸發 critical 升級。 */
  scoreTotal?: number | undefined
  /** 偏好 provider；undefined 或 'auto' = 不過濾。 */
  preferredProvider?: string | undefined
}

/* v8 ignore start -- zod schema（資料契約；載入錯誤由 load* 拋 CliError） */
const ModelEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
})

const TierPolicySchema = z.object({
  primary: ModelEntrySchema,
  fallback: z.array(ModelEntrySchema).min(1),
})

const TiersSchema = z.object({
  tiers: z.object({
    low: TierPolicySchema,
    medium: TierPolicySchema,
    high: TierPolicySchema,
    critical: TierPolicySchema.optional(),
  }),
})

/** settings.providers.yaml 的結構：llm-pi-ai.providers 為 route dict。 */
const ProvidersSchema = z.object({
  'llm-pi-ai': z.object({
    providers: z.record(z.string(), z.unknown()),
  }),
})
/* v8 ignore stop */

/** 讀 YAML 檔；空檔/純註解視為空文件（與 factory-score 同慣例）。 */
function loadYamlFile(path: string, label: string): unknown {
  const text = readFileSync(path, 'utf8')
  if (text.trim() === '' || text.trim().split('\n').every((l) => l.trim().startsWith('#'))) {
    return {}
  }
  try {
    return load(text) ?? {}
  } catch (err) {
    throw new CliError(`${label} (${path}) is not valid YAML: ${(err as Error).message}`)
  }
}

/**
 * 讀 model-tiers 政策檔並驗證：
 *  - 結構合法（zod）；
 *  - low/medium/high 齊全（auto 路徑必需）；
 *  - chain 每個 entry 的 provider 都已宣告於 settings.providers.yaml。
 */
export function loadTiers(path: string, declaredProviders: readonly string[]): TierPolicies {
  const raw = loadYamlFile(path, 'model-tiers')
  const parsed = TiersSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CliError(
      `model-tiers (${path}) is invalid: 每個 tier 需 primary{provider,model} 與非空 fallback[]，且 low/medium/high 必備`,
    )
  }
  const tiers = parsed.data.tiers
  for (const [tierId, policy] of Object.entries(tiers) as [ModelTier, TierPolicy][]) {
    for (const entry of [policy.primary, ...policy.fallback]) {
      if (!declaredProviders.includes(entry.provider)) {
        throw new CliError(
          `model-tiers (${path}) tier "${tierId}" 引用未宣告的 provider "${entry.provider}"` +
            `（settings.providers.yaml 已宣告：${declaredProviders.join(', ')}）`,
        )
      }
    }
  }
  return tiers
}

/** 讀 settings.providers.yaml 並回傳 `llm-pi-ai` 區段（DSH llm-pi-ai entry 的 config）。 */
export function loadPiAiConfig(path: string): { providers: Record<string, unknown> } {
  const raw = loadYamlFile(path, 'settings.providers')
  const parsed = ProvidersSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CliError(
      `settings.providers (${path}) is invalid: 需 llm-pi-ai.providers 為 provider route dict`,
    )
  }
  return parsed.data['llm-pi-ai']
}

/** 讀 settings.providers.yaml 並回傳已宣告的 provider route 清單。 */
export function loadDeclaredProviders(path: string): string[] {
  return Object.keys(loadPiAiConfig(path).providers)
}

/** 依偏好 provider 過濾並去重：偏好項目前置，其餘依序，重複項目只留第一個。 */
export function buildChain(
  policy: TierPolicy,
  preferredProvider: string | undefined,
  declaredProviders: readonly string[],
): ModelEntry[] {
  const all = [policy.primary, ...policy.fallback]
  const pref = preferredProvider ?? 'auto'
  if (pref !== 'auto') {
    if (!declaredProviders.includes(pref)) {
      throw new CliError(`未知的偏好 provider "${pref}"（已宣告：${declaredProviders.join(', ')}）`)
    }
    const ordered = [...all.filter((e) => e.provider === pref), ...all.filter((e) => e.provider !== pref)]
    return dedupe(ordered)
  }
  return dedupe(all)
}

function dedupe(entries: readonly ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>()
  const out: ModelEntry[] = []
  for (const e of entries) {
    const key = `${e.provider}/${e.model}/${e.reasoningEffort ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

/** catalog 複雜度值是否合法（fail-safe 方向：非法視同未宣告）。 */
function isComplexity(raw: string): raw is Complexity {
  return (COMPLEXITY as readonly string[]).includes(raw.toLowerCase())
}

/**
 * 解析模型 tier（純函式，決定性）。
 *
 * 解析順序（ADR-011 D3）：
 *  1. 手動 `manualTier`（非 auto）→ 直接取該 tier，不升級；
 *  2. Issue 需求分析（analysis）→ 其 complexity；
 *  3. catalog 標註（catalogComplexity 合法值）→ 其值；
 *  4. fail-safe → high。
 * 自動路徑下：complexity high 且 scoreTotal ≥ 4 → critical。
 */
export function resolveModelTier(input: ModelResolutionInput): ModelResolution {
  const { tiers, declaredProviders } = input

  if (input.manualTier !== undefined && input.manualTier !== 'auto') {
    const tier = input.manualTier
    const policy = tiers[tier]
    if (policy === undefined) {
      throw new CliError(`model-tiers 缺 tier "${tier}"（可用的：${MODEL_TIERS.join(', ')}）`)
    }
    const chain = buildChain(policy, input.preferredProvider, declaredProviders)
    const selected = chain[0] as ModelEntry
    return {
      tier,
      complexity: input.analysis?.complexity ?? 'high',
      complexitySource: 'manual',
      evidence: input.analysis?.evidence ?? [],
      reason: `手動指定 model_tier=${tier}`,
      selected,
      chain,
    }
  }
  let complexity: Complexity
  let complexitySource: ComplexitySource
  let evidence: readonly string[]
  let reason: string

  if (input.analysis !== undefined) {
    complexity = input.analysis.complexity
    complexitySource = 'issue-analysis'
    evidence = input.analysis.evidence
    reason = `Issue 需求分析：${complexity}（判據：${evidence.join('；')}）`
  } else if (input.catalogComplexity !== undefined && isComplexity(input.catalogComplexity)) {
    complexity = input.catalogComplexity.toLowerCase() as Complexity
    complexitySource = 'catalog'
    evidence = [`catalog 標註 factory.io/complexity: ${complexity}`]
    reason = `catalog 複雜度：${complexity}`
  } else {
    complexity = 'high'
    complexitySource = 'fail-safe'
    evidence = ['無 Issue 分析且 catalog 未標註/非法 → fail-safe 採最高複雜度']
    reason = 'fail-safe：未宣告複雜度 → high（deepseek-flash，不誤燒旗艦成本）'
  }

  let tier: ModelTier = complexity === 'low' ? 'low' : complexity === 'medium' ? 'medium' : 'high'
  if (tier === 'high' && input.scoreTotal !== undefined && input.scoreTotal >= CRITICAL_MIN_TOTAL) {
    tier = 'critical'
    reason = `${reason}；複雜度 high 且總分 ${input.scoreTotal} ≥ ${CRITICAL_MIN_TOTAL} → critical（claude-opus-5-5，未收錄前 fallback 至 claude-opus-5）`
  }

  // B5：heavy-verify 強制 critical（繞過總分門檻）。順序刻意排在總分升級之後，
  // 讓 reason 能同時保留兩條判據。
  //
  // `escalation` 必須在**兩條升級路徑都成立時**仍然標記——factory-run 用它決定
  // agent 逾時預算（A1）；若只在「本次才升 critical」時標記，一個總分剛好達門檻的
  // heavy-verify 任務就會拿到預設逾時，重演 34735315950。故標記與升 tier 解耦。
  let escalation: TierEscalationReason | undefined
  if (input.analysis?.computationalIntensity === 'heavy-verify') {
    if (tiers.critical !== undefined) {
      escalation = 'heavy-verify'
      if (tier !== 'critical') {
        tier = 'critical'
        reason = `${reason}；${HEAVY_VERIFY_ESCALATION_EVIDENCE} → critical（不受總分門檻限制）`
      } else {
        reason = `${reason}；${HEAVY_VERIFY_ESCALATION_EVIDENCE}`
      }
    } else {
      reason = `${reason}；${HEAVY_VERIFY_ESCALATION_EVIDENCE}，但 model-tiers 未定義 critical → 維持 ${tier}`
    }
  }

  const policy = tiers[tier]
  if (policy === undefined) {
    throw new CliError(`model-tiers 缺 tier "${tier}"（可用的：${MODEL_TIERS.join(', ')}）`)
  }
  const chain = buildChain(policy, input.preferredProvider, declaredProviders)
  const selected = chain[0] as ModelEntry
  return { tier, complexity, complexitySource, evidence, reason, selected, chain, escalation }
}
