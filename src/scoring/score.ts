/**
 * Three-axis oversight scoring (docs/06-human-oversight-policy.md).
 *
 * Two invariants this module exists to enforce:
 *
 *  1. FAIL-SAFE — missing or invalid axis data scores the STRICTEST value, never
 *     the most permissive. A typo in an annotation must never lower oversight
 *     (docs/03 §7, docs/06 §3).
 *  2. AGENT EXCLUSION — scoring runs in CI before the agent starts. The agent
 *     never participates in deciding its own permissions (docs/06 §5.1).
 */

import { minimatch } from 'minimatch'
import {
  BUSINESS_CRITICALITY,
  COMPLEXITY,
  RISK_PROFILE,
  TIER_LABEL,
  type AxisScore,
  type BusinessCriticality,
  type Complexity,
  type HardRuleId,
  type OversightTier,
  type RiskProfile,
  type ScoreInput,
  type ScoreResult,
} from './types.js'

/** Automerge line ceiling (docs/06 §4.1). Distinct from the 200–300 split guideline in docs/07 §2.2. */
export const AUTOMERGE_MAX_LINES = 200

const CRITICALITY_SCORE: Record<BusinessCriticality, 0 | 1 | 2> = {
  tactical: 0,
  operational: 1,
  strategic: 2,
}
const RISK_SCORE: Record<RiskProfile, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 }
const COMPLEXITY_SCORE: Record<Complexity, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 }

const HARD_RULE_REASON: Record<HardRuleId, string> = {
  H1: '授權/認證邏輯',
  H2: '財務計算',
  H3: '敏感資料處理',
  H4: 'systems of record 或共用模組',
  H5: 'guardrail 自身（CI 設定、CODEOWNERS、catalog、skills）',
  H6: '資料庫 schema 遷移（不可逆）',
  H7: '對外 API 破壞性變更',
}

/**
 * Resolves one axis, applying the fail-safe rule.
 *
 * An absent value and an invalid value are treated identically and score 2.
 * Collapsing these two cases is deliberate: if an unrecognised string scored 0,
 * misspelling an annotation would silently reduce oversight.
 */
function resolveAxis<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  scores: Record<T, 0 | 1 | 2>,
  axisName: string,
): AxisScore {
  if (raw === undefined || raw.trim() === '') {
    return { value: 2, reason: `${axisName} 未標註 → fail-safe 採最高風險值` }
  }
  const normalised = raw.trim().toLowerCase()
  const match = allowed.find((a) => a === normalised)
  if (match === undefined) {
    return {
      value: 2,
      reason: `${axisName} 值 "${raw}" 非法 → fail-safe 採最高風險值`,
    }
  }
  return { value: scores[match], reason: `${axisName} = ${match}` }
}

/** Returns every hard rule triggered by the changed paths (docs/06 §3.2). */
export function matchHardRules(
  changedPaths: readonly string[],
  patterns: Readonly<Partial<Record<HardRuleId, readonly string[]>>>,
): HardRuleId[] {
  const triggered = new Set<HardRuleId>()
  for (const [ruleId, globs] of Object.entries(patterns) as [HardRuleId, readonly string[]][]) {
    for (const glob of globs) {
      if (changedPaths.some((p) => minimatch(p, glob, { dot: true }))) {
        triggered.add(ruleId)
        break
      }
    }
  }
  return [...triggered].sort()
}

/** Maps a total score to its oversight tier (docs/06 §4). */
export function tierForTotal(total: number): OversightTier {
  if (total <= 1) return 'on-loop'
  if (total <= 4) return 'review'
  return 'in-loop'
}

/**
 * Scores a work item and decides whether the agent may merge unattended.
 *
 * Automerge requires the on-loop tier AND every additional condition in
 * docs/06 §4.1 — a low score alone is necessary, not sufficient.
 */
export function score(input: ScoreInput): ScoreResult {
  const { annotations, changedPaths = [], changedLines, hardRulePatterns = {} } = input

  const businessCriticality = resolveAxis(
    annotations.businessCriticality,
    BUSINESS_CRITICALITY,
    CRITICALITY_SCORE,
    'business-criticality',
  )
  const complexity = resolveAxis(annotations.complexity, COMPLEXITY, COMPLEXITY_SCORE, 'complexity')

  // Risk starts from the catalog, then hard rules override upward only.
  let riskProfile = resolveAxis(annotations.riskProfile, RISK_PROFILE, RISK_SCORE, 'risk-profile')
  const triggeredHardRules = matchHardRules(changedPaths, hardRulePatterns)
  if (triggeredHardRules.length > 0) {
    const names = triggeredHardRules.map((r) => `${r}(${HARD_RULE_REASON[r]})`).join('、')
    riskProfile = { value: 2, reason: `硬性規則觸發：${names}` }
  }

  const total = businessCriticality.value + riskProfile.value + complexity.value
  const tier = tierForTotal(total)

  // Automerge blockers, per docs/06 §4.1. Conditions only tighten, never loosen.
  const automergeBlockers: string[] = []
  if (tier !== 'on-loop') {
    automergeBlockers.push(`計分 ${total} 分不在 on-loop 範圍（需 0–1）`)
  }
  if (annotations.agentAutomerge?.trim().toLowerCase() === 'false') {
    automergeBlockers.push('擁有者已透過 factory.io/agent-automerge 否決')
  }
  if (triggeredHardRules.length > 0) {
    automergeBlockers.push(`觸發風險硬性規則：${triggeredHardRules.join('、')}`)
  }
  if (changedLines !== undefined && changedLines > AUTOMERGE_MAX_LINES) {
    automergeBlockers.push(`變更 ${changedLines} 行，超過自動合併上限 ${AUTOMERGE_MAX_LINES} 行`)
  }

  return {
    businessCriticality,
    riskProfile,
    complexity,
    total,
    tier,
    label: TIER_LABEL[tier],
    triggeredHardRules,
    automergeAllowed: automergeBlockers.length === 0,
    automergeBlockers,
  }
}

/**
 * Re-scores after the diff is known (docs/06 §5.3).
 *
 * Deliberately one-way: the result may only escalate. This closes the path where
 * a work item described as low risk acquires loose permissions and then makes
 * high-risk changes.
 */
export function rescore(initial: ScoreResult, updated: ScoreResult): ScoreResult {
  if (updated.total <= initial.total) {
    // Never downgrade, but a later hard-rule hit must still block automerge.
    return {
      ...initial,
      automergeAllowed: initial.automergeAllowed && updated.automergeAllowed,
      automergeBlockers: [
        ...new Set([...initial.automergeBlockers, ...updated.automergeBlockers]),
      ],
    }
  }
  return updated
}
