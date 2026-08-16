/**
 * Stop-rule types (docs/04-agent-execution-dsh.md §3.3, docs/02 §6).
 *
 * `needs-human` is the agent's ONLY legal exit path when it cannot finish.
 * Every rule here maps to a condition where continuing would be worse than
 * stopping — silence and guesswork are never acceptable outcomes.
 */

/** Rule identifiers, aligned with the factory-stop-rules skill. */
export type StopRuleId =
  | 'SR1-sync-failed'
  | 'SR2-high-risk-domain'
  | 'SR3-guardrail-change'
  | 'SR4-unclear-acceptance'
  | 'SR5-new-dependency'
  | 'SR6-weakened-tests'
  | 'SR7-cost-exceeded'
  | 'SR8-timeout'

export const NEEDS_HUMAN_LABEL = 'needs-human'

/** Consecutive `gh stack sync` failures tolerated before stopping (docs/07 §4.1). */
export const MAX_SYNC_ATTEMPTS = 2

export interface StopRuleContext {
  /** Consecutive `gh stack sync` failures so far. */
  syncFailures?: number | undefined
  /** Paths the agent changed or intends to change. */
  changedPaths?: readonly string[] | undefined
  /** Hard-rule matches from scoring; any hit means a high-risk domain. */
  triggeredHardRules?: readonly string[] | undefined
  /** Whether the issue carries testable acceptance criteria. */
  hasAcceptanceCriteria?: boolean | undefined
  /** Dependencies added that were not already declared. */
  addedDependencies?: readonly string[] | undefined
  /** Net change in test assertion count; negative means assertions were removed. */
  assertionDelta?: number | undefined
  /** Tokens consumed so far. */
  tokensUsed?: number | undefined
  /** Token ceiling for one work item; undefined means no ceiling is enforced yet. */
  tokenBudget?: number | undefined
  /** Whether the run exceeded its wall-clock limit. */
  timedOut?: boolean | undefined
}

export interface StopRuleViolation {
  rule: StopRuleId
  /** Human-readable reason, posted to the issue so a person can take over. */
  reason: string
}

export interface StopDecision {
  mustStop: boolean
  violations: StopRuleViolation[]
  /** Label to apply when stopping. */
  label: string
  /** Handover report for the issue comment (docs/07 §4.2). */
  report: string
}
