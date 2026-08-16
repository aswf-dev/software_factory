/**
 * Oversight scoring types.
 *
 * Implements the three-axis model from docs/06-human-oversight-policy.md,
 * which derives from Gartner G00843405 Figure 11 (see docs/00-source-summary.md §6).
 *
 * The source research gives a sliding scale; the numeric scoring here is this
 * project's design work, not the source's content.
 */

/** Business criticality: tactical → strategic (docs/06 §3.1). */
export const BUSINESS_CRITICALITY = ['tactical', 'operational', 'strategic'] as const
export type BusinessCriticality = (typeof BUSINESS_CRITICALITY)[number]

/** Risk profile: low → high (docs/06 §3.2). */
export const RISK_PROFILE = ['low', 'medium', 'high'] as const
export type RiskProfile = (typeof RISK_PROFILE)[number]

/** Architectural complexity: low → high (docs/06 §3.3). */
export const COMPLEXITY = ['low', 'medium', 'high'] as const
export type Complexity = (typeof COMPLEXITY)[number]

/**
 * Oversight tier.
 *
 * `review` is this project's addition to the source's two-level model: it covers
 * work that an agent may produce but a human must approve (docs/06 §4).
 */
export type OversightTier = 'on-loop' | 'review' | 'in-loop'

/** GitHub label applied for each tier (docs/GLOSSARY.md §3). */
export const TIER_LABEL: Record<OversightTier, string> = {
  'on-loop': 'oversight/on-loop',
  review: 'oversight/review',
  'in-loop': 'oversight/in-loop',
}

/**
 * Hard rules: touching any of these paths forces risk = 2 with no discretion.
 * H1–H4 come from the source research; H5–H7 are this project's additions
 * (guardrail self-protection and irreversibility). See docs/06 §3.2.
 */
export type HardRuleId = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7'

/** Catalog-declared axis values, read from catalog-info.yaml annotations. */
export interface CatalogAnnotations {
  businessCriticality?: string | undefined
  riskProfile?: string | undefined
  complexity?: string | undefined
  /** Owner veto: when "false", automerge is forbidden regardless of score. */
  agentAutomerge?: string | undefined
}

export interface ScoreInput {
  annotations: CatalogAnnotations
  /** Paths changed by the work item; empty before the agent runs. */
  changedPaths?: readonly string[] | undefined
  /** Total changed lines, used for the automerge gate. */
  changedLines?: number | undefined
  /** Hard-rule path patterns, loaded from .github/factory/risk-paths.yml. */
  hardRulePatterns?: Readonly<Partial<Record<HardRuleId, readonly string[]>>> | undefined
}

export interface AxisScore {
  value: 0 | 1 | 2
  /** Why this score was assigned — surfaced to humans, never inferred by the agent. */
  reason: string
}

export interface ScoreResult {
  businessCriticality: AxisScore
  riskProfile: AxisScore
  complexity: AxisScore
  total: number
  tier: OversightTier
  label: string
  /** Hard rules triggered, if any. */
  triggeredHardRules: HardRuleId[]
  /** Whether the agent may merge without human approval. */
  automergeAllowed: boolean
  /** Why automerge was refused; empty when allowed. */
  automergeBlockers: string[]
}
