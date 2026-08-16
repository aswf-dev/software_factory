/**
 * DSH headless result interpretation (docs/04 §1, §4.2; ADR-002).
 *
 * The contract, verified against a real run on 2026-08-16:
 *   exit 0  → the final turn/end completed; stdout holds the last assistant text
 *   exit 1  → anything else; stderr carries the error code and message
 *   stderr is empty on success; no port is ever opened
 *
 * The single most dangerous misreading of this contract is treating exit 0 as
 * proof the task was done correctly. It is not: it only means the agent's turn
 * ended normally. Correctness is decided by required checks and human review
 * (docs/02 D4), which is why `taskVerified` below is always false.
 */

export type DshOutcome = 'completed' | 'failed' | 'timeout'

export interface DshInvocation {
  /** Process exit code; undefined when the process was killed (e.g. timeout). */
  exitCode?: number | undefined
  stdout?: string | undefined
  stderr?: string | undefined
  /** True when the runner enforced its wall-clock limit. */
  timedOut?: boolean | undefined
}

export interface DshResult {
  outcome: DshOutcome
  /** Last non-empty assistant text, trimmed. */
  output: string
  /** Error detail for handover; empty on success. */
  errorDetail: string
  /** Whether CI should continue to the next step. */
  shouldContinue: boolean
  /**
   * Always false, by design.
   *
   * Exit 0 means "the turn ended", not "the work is right". Exposing this as a
   * named constant makes the distinction impossible to overlook at call sites.
   */
  taskVerified: false
}

export function interpretDshResult(invocation: DshInvocation): DshResult {
  const stdout = (invocation.stdout ?? '').trim()
  const stderr = (invocation.stderr ?? '').trim()

  // Timeout is checked first: a killed process may carry a misleading code.
  if (invocation.timedOut === true) {
    return {
      outcome: 'timeout',
      output: stdout,
      errorDetail: stderr || '執行超過時間上限，已中止',
      shouldContinue: false,
      taskVerified: false,
    }
  }

  if (invocation.exitCode === 0) {
    return {
      outcome: 'completed',
      output: stdout,
      errorDetail: '',
      shouldContinue: true,
      taskVerified: false,
    }
  }

  // Any non-zero or absent code is a failure. An empty stderr must still report
  // something actionable, otherwise the issue comment would say nothing at all.
  return {
    outcome: 'failed',
    output: stdout,
    errorDetail:
      stderr ||
      `DSH 以 exit code ${invocation.exitCode ?? '(無)'} 結束，但未提供錯誤訊息`,
    shouldContinue: false,
    taskVerified: false,
  }
}
