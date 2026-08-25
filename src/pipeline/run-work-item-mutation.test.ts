import { describe, expect, it } from 'vitest'
import type { AgentRun } from './run-work-item.js'
import { runWorkItem } from './run-work-item.js'
import type { HardRuleId, ScoreInput } from '../scoring/types.js'

/**
 * Mutation-strength tests for `runWorkItem` (src/pipeline/run-work-item.ts).
 *
 * The e2e suite (test/e2e/work-item-flow.test.ts) already pins the broad
 * OUTCOME of every gate, but it does not pin the ORDER of the early gates nor
 * the exact SHAPE of a terminal result beyond its `outcome` string. Those gaps
 * are exactly where a later refactor can quietly change behaviour without any
 * test turning red — which is what this file exists to catch.
 *
 * Mutation log (verified by hand-editing src/pipeline/run-work-item.ts and
 * re-running, then reverting):
 *
 *  | ID | Mutation                                                    | Before | After  |
 *  |----|-------------------------------------------------------------|--------|--------|
 *  | M1 | 把 no-runner guard 移到 Gate 1（in-loop）之上（閘門順序顛倒） | GREEN  | RED    |
 *  | M2 | DSH 失敗的回報標籤移除 `needs-human`（只剩 tier 標籤）        | GREEN  | RED    |
 *  | M3 | `ready-for-review` 的 summary 只保留第一個 blocker            | GREEN  | RED    |
 *  | M4 | 移除 Gate 2.5（exit 0 + changedPaths 缺席 → needs-human）    | GREEN  | RED    |
 *
 * "Before" = pre-existing suite (test/e2e/work-item-flow.test.ts) alone;
 * "After" = the same suite plus the mutation-tests added here. M1/M2/M3 are
 * GREEN→RED flips, i.e. mutations the pre-existing suite lets slip. Details in
 * each `describe` below.
 */

const EMPTY_PATTERNS: Readonly<Partial<Record<HardRuleId, readonly string[]>>> = {}

/** Low-risk internal tool profile, same shape the e2e suite uses. */
const LOW_RISK: ScoreInput = {
  annotations: { businessCriticality: 'tactical', riskProfile: 'low', complexity: 'low' },
  hardRulePatterns: EMPTY_PATTERNS,
}

/** High-risk profile that scores into the in-loop tier (docs/06 §4). */
const IN_LOOP: ScoreInput = {
  annotations: { businessCriticality: 'strategic', riskProfile: 'high', complexity: 'high' },
  hardRulePatterns: EMPTY_PATTERNS,
}

describe('M1 變異：閘門順序顛倒 —— no-runner guard 被移到有效的主要 Gate 1（in-loop）之上', () => {
  /**
   * Gate 1 — in-loop work never reaches the agent (docs/06 §4) — is the FIRST
   * decision in `runWorkItem`. A refactor that lifts the "no runner supplied"
   * guard above it changes what an in-loop item with no runner reports:
   * `needs-human` (a stale handover) instead of `blocked-in-loop` (the contract:
   * the tier was decided before any execution concern). Every existing test that
   * hits the no-runner path uses a non-in-loop tier, and every in-loop test
   * supplies a runner, so the reorder slips through the pre-existing suite
   * (GREEN).
   */
  it('in-loop 且完全未提供 runAgent → 仍為 blocked-in-loop，不落入 needs-human', () => {
    const r = runWorkItem({ issueNumber: 211, initial: IN_LOOP })
    expect(r.outcome).toBe('blocked-in-loop')
    expect(r.dshResult).toBeNull()
    expect(r.labels).toEqual(['oversight/in-loop'])
  })

  it('in-loop 且有 runner → agent 不得被呼叫且 outcome 同樣是 blocked-in-loop', () => {
    let agentCalled = false
    const r = runWorkItem({
      issueNumber: 201,
      initial: IN_LOOP,
      runAgent: () => {
        agentCalled = true
        return emptyRun()
      },
    })

    expect(r.outcome).toBe('blocked-in-loop')
    expect(agentCalled).toBe(false)
    expect(r.labels).toEqual(['oversight/in-loop'])
  })

  it('對照組：非 in-loop 且無 runner → 才是 needs-human（兩個 gate 互斥且順序固定）', () => {
    const r = runWorkItem({ issueNumber: 212, initial: LOW_RISK })
    expect(r.outcome).toBe('needs-human')
  })
})

describe('M2 變異：DSH 執行失敗的回報移除 needs-human 標籤', () => {
  /**
   * A failed or timed-out run is handed back with its stderr intact and the
   * issue must be visibly flagged for a human (docs/02 §6). The pre-existing
   * failure test asserts outcome/summary only — never the label set — so a
   * refactor that drops `needs-human` from that handover still passes (GREEN).
   * These tests pin the exact label shape: the original tier label plus
   * `needs-human`.
   */
  it('agent 回報 exit 1 → 標籤等於 [tier 標籤, needs-human]', () => {
    const r = runWorkItem({
      issueNumber: 202,
      initial: LOW_RISK,
      runAgent: () => ({ invocation: { exitCode: 1, stdout: '', stderr: 'rs interpreter missing' } }),
    })

    expect(r.dshResult?.outcome).toBe('failed')
    expect(r.outcome).toBe('needs-human')
    // M2 變異（移除 needs-human）會讓這個 equal 斷言變紅。
    expect(r.labels).toEqual(['oversight/on-loop', 'needs-human'])
  })

  it('agent 逾時 → 標籤必須同一形狀，確保「需人類接手」永不被吞掉', () => {
    const r = runWorkItem({
      issueNumber: 213,
      initial: LOW_RISK,
      runAgent: () => ({ invocation: { exitCode: 124, stdout: '', stderr: '', timedOut: true } }),
    })

    expect(r.dshResult?.outcome).toBe('timeout')
    expect(r.outcome).toBe('needs-human')
    expect(r.labels).toEqual(['oversight/on-loop', 'needs-human'])
  })
})

describe('M3 變異：ready-for-review 的 summary 只保留第一個 blocker', () => {
  /**
   * The review outcome must explain EVERY automerge blocker, not just the first
   * (docs/06 §5.1 audit trail). Every pre-existing review test triggers a SINGLE
   * blocker, so an implementation that keeps only `automergeBlockers[0]` passes
   * (GREEN). This test drives TWO distinct blockers at once — the owner veto and
   * the line ceiling — and requires both to survive in the summary.
   */
  it('同時被「擁有者否決」與「行數超限」擋住 → summary 兩者都說明', () => {
    const r = runWorkItem({
      issueNumber: 203,
      initial: {
        annotations: {
          businessCriticality: 'tactical',
          riskProfile: 'low',
          complexity: 'low',
          agentAutomerge: 'false',
        },
        hardRulePatterns: EMPTY_PATTERNS,
      },
      runAgent: () => ({
        invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
        changedPaths: ['src/a.ts'],
        changedLines: 250,
      }),
    })

    expect(r.outcome).toBe('ready-for-review')
    expect(r.finalScore.automergeBlockers.length).toBeGreaterThan(1)
    // 兩種 blocker 都必須出現在最終 summary（M3 只留第一個 → 這裡變紅）。
    expect(r.summary).toContain('否決')
    expect(r.summary).toContain('上限')
  })
})

describe('M4 變異：exit 0 但 changedPaths 缺席（fallback report）必須 needs-human', () => {
  /**
   * Agent 被截斷（DSH stdout 上限中斷）但 process 以 exit 0 結束時，CI 的
   * write-report.js 會補一份「最小 report」——只有 issueNumber + invocation，
   * changedPaths 缺席（undefined，不是空陣列 []）。
   *
   * 這份 fallback report 的特徵就是「宣稱成功但未留下任何變更軌跡」。若 pipeline
   * 把 `changedPaths ?? []` 當空變更一路放行，會把一次壞掉的執行判成
   * ready-for-review（issue #35 實測：agent 停在「Let me re-run a few times」，
   * 卻被輸出 ready-for-review、無任何 PR）。
   *
   * write-report.ts 的 docstring 明說 fallback 的目的是「使 factory-judge 仍能
   * 走完 needs-human 判定」——但現行 pipeline 對 exit 0 + 缺 changedPaths 判了
   * ready-for-review，與設計意圖矛盾。本測試釘住：must be needs-human。
   *
   * Mutation: 把 `changedPaths === undefined` 檢查移除（或改回 ?? [] 放行）→ RED。
   */
  it('exit 0 + changedPaths 缺席 → needs-human（不得 ready-for-review）', () => {
    const r = runWorkItem({
      issueNumber: 35,
      initial: LOW_RISK,
      runAgent: () => ({ invocation: { exitCode: 0, stdout: 'DONE', stderr: '' } }),
    })

    expect(r.outcome).toBe('needs-human')
    expect(r.labels).toContain('needs-human')
    // 與「明確回報無變更（[]）」區分——缺席是異常，不是合法空變更
    expect(r.summary).toContain('changedPaths')
  })

  it('對照組：exit 0 + changedPaths 明確為 []（無變更）→ 不落入 needs-human（M4 不誤傷）', () => {
    const r = runWorkItem({
      issueNumber: 36,
      initial: LOW_RISK,
      runAgent: () => ({ invocation: { exitCode: 0, stdout: 'DONE', stderr: '' }, changedPaths: [] }),
    })
    // 空陣列是 agent 明確回報「無變更」——仍走正常 pipeline（此情境計分 0 → automerge）
    expect(r.outcome).not.toBe('needs-human')
  })
})

/** Minimal idle agent report (only the invocation → completed, no side data). */
function emptyRun(): AgentRun {
  return { invocation: { exitCode: 0, stdout: '', stderr: '' } }
}
