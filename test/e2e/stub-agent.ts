/**
 * Stub agent for E2E tests (docs/11 §4.3, resolves Q11-1).
 *
 * Why a stub instead of a real LLM: E2E here verifies that the FLOW is wired
 * correctly — scoring gates the run, stop rules fire, results are interpreted,
 * merge permission is decided. A real model is non-deterministic, slow and
 * costly, and would make failures ambiguous: did the wiring break, or did the
 * model have an off day? Model output quality is checked by human review and
 * the defect-escape metric instead (docs/11 §2.1).
 *
 * The stub mimics the one contract that matters: docs/04 §1 — a single task in,
 * stdout plus an exit code out, stderr empty on success.
 */

import type { DshInvocation } from '../../src/integration/dsh-result.js'

export interface StubAgentScript {
  /** Files the agent claims to change. */
  changedPaths?: readonly string[]
  /** Total changed lines. */
  changedLines?: number
  /** Net change in test assertions; negative means assertions were removed. */
  assertionDelta?: number
  /** Dependencies the agent added. */
  addedDependencies?: readonly string[]
  /** Consecutive `gh stack sync` failures the agent hit. */
  syncFailures?: number
  /** Force a non-zero exit to exercise the failure path. */
  fail?: { exitCode: number; stderr: string }
  /** Simulate exceeding the wall-clock limit. */
  timeout?: boolean
  /** Text the agent prints on success. */
  output?: string
}

export interface StubAgentRun {
  invocation: DshInvocation
  changedPaths: readonly string[]
  changedLines: number
  assertionDelta: number
  addedDependencies: readonly string[]
  syncFailures: number
}

/**
 * Runs the stub agent.
 *
 * Deterministic by construction: the same script always yields the same run, so
 * an E2E failure always points at the pipeline rather than at sampling noise.
 */
export function runStubAgent(script: StubAgentScript = {}): StubAgentRun {
  const changedPaths = script.changedPaths ?? []
  const base = {
    changedPaths,
    changedLines: script.changedLines ?? changedPaths.length * 20,
    assertionDelta: script.assertionDelta ?? 0,
    addedDependencies: script.addedDependencies ?? [],
    syncFailures: script.syncFailures ?? 0,
  }

  if (script.timeout === true) {
    return { ...base, invocation: { timedOut: true, stdout: '', stderr: '' } }
  }

  if (script.fail !== undefined) {
    return {
      ...base,
      invocation: { exitCode: script.fail.exitCode, stdout: '', stderr: script.fail.stderr },
    }
  }

  return {
    ...base,
    invocation: {
      exitCode: 0,
      stdout: script.output ?? 'DONE',
      stderr: '',
    },
  }
}

/** Stacked PR branch names for one work item (docs/07 §3.2). */
export function stackBranchNames(issueNumber: number): string[] {
  return [
    `factory/${issueNumber}/01-test`,
    `factory/${issueNumber}/02-impl`,
    `factory/${issueNumber}/03-docs`,
  ]
}
