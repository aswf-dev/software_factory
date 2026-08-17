/**
 * Work-item pipeline (docs/02 §4).
 *
 * Wires the phases into one auditable sequence:
 *
 *   score → gate → agent → interpret → re-score → stop rules → merge decision
 *
 * Two properties this module exists to guarantee:
 *
 *  1. Scoring happens BEFORE the agent starts, and the agent never contributes
 *     to it. The agent receives permissions already decided (docs/06 §5.1).
 *  2. Every terminal state is explicit. There is no path that ends without
 *     either a merge decision or a needs-human handover — an agent must never
 *     fail silently (docs/02 §6).
 */

import { score } from '../scoring/score.js'
import { rescore } from '../scoring/score.js'
import type { ScoreInput, ScoreResult } from '../scoring/types.js'
import { evaluateStopRules } from '../stop-rules/stop-rules.js'
import type { StopDecision } from '../stop-rules/types.js'
import { interpretDshResult, type DshInvocation, type DshResult } from '../integration/dsh-result.js'

export type PipelineOutcome =
  /** Blocked before the agent ran: in-loop work is for humans to design. */
  | 'blocked-in-loop'
  /** Agent finished; the change may merge without further approval. */
  | 'ready-to-automerge'
  /** Agent finished; a human must review before merge. */
  | 'ready-for-review'
  /** Something went wrong or a rule fired; handed back to a human. */
  | 'needs-human'

export interface PipelineInput {
  issueNumber: number
  /** Scoring inputs known before the agent runs. */
  initial: ScoreInput
  /** Runs the agent; omitted when the item is blocked before execution. */
  runAgent?: (() => AgentRun) | undefined
}

export interface AgentRun {
  invocation: DshInvocation
  changedPaths?: readonly string[] | undefined
  changedLines?: number | undefined
  assertionDelta?: number | undefined
  addedDependencies?: readonly string[] | undefined
  syncFailures?: number | undefined
}

export interface PipelineResult {
  outcome: PipelineOutcome
  /** Score computed before the agent ran. */
  initialScore: ScoreResult
  /** Score after the diff is known; identical to initialScore when the agent did not run. */
  finalScore: ScoreResult
  dshResult: DshResult | null
  stopDecision: StopDecision | null
  /** Labels CI should apply to the issue. */
  labels: string[]
  /** Human-readable explanation of the terminal state. */
  summary: string
}

export function runWorkItem(input: PipelineInput): PipelineResult {
  const initialScore = score(input.initial)

  // Gate 1 — in-loop work never reaches the agent (docs/06 §4).
  if (initialScore.tier === 'in-loop') {
    return {
      outcome: 'blocked-in-loop',
      initialScore,
      finalScore: initialScore,
      dshResult: null,
      stopDecision: null,
      labels: [initialScore.label],
      summary:
        `計分 ${initialScore.total} 分屬 human-in-the-loop，未啟動 agent；` +
        '設計與實作須由人類主導（docs/06 §4.3）',
    }
  }

  // No runner supplied: treat as not started rather than silently succeeding.
  if (input.runAgent === undefined) {
    return {
      outcome: 'needs-human',
      initialScore,
      finalScore: initialScore,
      dshResult: null,
      stopDecision: null,
      labels: [initialScore.label, 'needs-human'],
      summary: '未提供 agent 執行器，工作項未被處理',
    }
  }

  const run = input.runAgent()
  const dshResult = interpretDshResult(run.invocation)

  // Gate 2 — a failed or timed-out run is handed back with its stderr intact,
  // and is never retried automatically (docs/02 §6).
  if (!dshResult.shouldContinue) {
    return {
      outcome: 'needs-human',
      initialScore,
      finalScore: initialScore,
      dshResult,
      stopDecision: null,
      labels: [initialScore.label, 'needs-human'],
      summary: `DSH 執行${dshResult.outcome === 'timeout' ? '逾時' : '失敗'}：${dshResult.errorDetail}`,
    }
  }

  // Gate 3 — re-score against the real diff. One-way: may only escalate,
  // closing the "describe it as low risk, then change high-risk code" path.
  const updatedScore = score({
    ...input.initial,
    changedPaths: run.changedPaths ?? [],
    changedLines: run.changedLines ?? undefined,
  })
  const finalScore = rescore(initialScore, updatedScore)

  // Gate 4 — stop rules see the actual behaviour, not the intent.
  const stopDecision = evaluateStopRules({
    syncFailures: run.syncFailures ?? undefined,
    changedPaths: run.changedPaths ?? undefined,
    triggeredHardRules: finalScore.triggeredHardRules,
    addedDependencies: run.addedDependencies ?? undefined,
    assertionDelta: run.assertionDelta ?? undefined,
  })

  if (stopDecision.mustStop) {
    return {
      outcome: 'needs-human',
      initialScore,
      finalScore,
      dshResult,
      stopDecision,
      labels: [finalScore.label, stopDecision.label],
      summary: stopDecision.report,
    }
  }

  // Gate 5 — merge permission. Automerge needs the on-loop tier AND every
  // additional condition in docs/06 §4.1; a low score alone is not enough.
  if (finalScore.automergeAllowed) {
    return {
      outcome: 'ready-to-automerge',
      initialScore,
      finalScore,
      dshResult,
      stopDecision,
      labels: [finalScore.label],
      summary: `計分 ${finalScore.total} 分且符合全部自動合併條件`,
    }
  }

  return {
    outcome: 'ready-for-review',
    initialScore,
    finalScore,
    dshResult,
    stopDecision,
    labels: [finalScore.label],
    summary:
      `計分 ${finalScore.total} 分，需人類審查後合併。原因：` +
      finalScore.automergeBlockers.join('；'),
  }
}
