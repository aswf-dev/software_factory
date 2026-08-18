/**
 * E2E: one complete work item through the factory (docs/11 §4.3, T6).
 *
 * Uses the stub agent, so every assertion is about the PIPELINE — whether the
 * gates fire in the right order and whether every path terminates explicitly.
 * Model quality is deliberately out of scope (docs/11 §2.1).
 */

import { describe, expect, it } from 'vitest'
import { runWorkItem } from '../../src/pipeline/run-work-item.js'
import type { HardRuleId } from '../../src/scoring/types.js'
import { runStubAgent, stackBranchNames } from './stub-agent.js'

const PATTERNS: Partial<Record<HardRuleId, readonly string[]>> = {
  H1: ['src/auth/**'],
  H2: ['src/payment/**'],
  H5: ['.github/**', 'CODEOWNERS', 'catalog-info.yaml', '.dsh/skills/**'],
  H6: ['migrations/**'],
}

/** A low-risk internal tool, the profile of a phase-1 pilot item. */
const LOW_RISK = {
  annotations: {
    businessCriticality: 'tactical',
    riskProfile: 'low',
    complexity: 'low',
  },
  hardRulePatterns: PATTERNS,
}

describe('E2E：低風險工作項的完整流程', () => {
  it('補測試 → 計分 0 → agent 執行 → 可自動合併', () => {
    const r = runWorkItem({
      issueNumber: 101,
      initial: LOW_RISK,
      runAgent: () =>
        runStubAgent({
          changedPaths: ['src/util/format.test.ts'],
          changedLines: 40,
          assertionDelta: +6,
        }),
    })

    expect(r.initialScore.total).toBe(0)
    expect(r.dshResult?.outcome).toBe('completed')
    expect(r.outcome).toBe('ready-to-automerge')
    expect(r.labels).toContain('oversight/on-loop')
    expect(r.labels).not.toContain('needs-human')
  })

  it('變更過大 → 退回人類審查而非自動合併', () => {
    const r = runWorkItem({
      issueNumber: 102,
      initial: LOW_RISK,
      runAgent: () => runStubAgent({ changedPaths: ['src/a.ts'], changedLines: 500 }),
    })

    expect(r.outcome).toBe('ready-for-review')
    expect(r.summary).toContain('上限')
  })
})

describe('E2E：高風險工作項在 agent 啟動前即被擋下', () => {
  it('計分 5–6 → blocked-in-loop，agent 從未執行', () => {
    let agentCalled = false
    const r = runWorkItem({
      issueNumber: 103,
      initial: {
        annotations: {
          businessCriticality: 'strategic',
          riskProfile: 'high',
          complexity: 'high',
        },
        hardRulePatterns: PATTERNS,
      },
      runAgent: () => {
        agentCalled = true
        return runStubAgent()
      },
    })

    expect(r.outcome).toBe('blocked-in-loop')
    // The gate must precede execution: scoring decides permissions, and the
    // agent never participates in that decision (docs/06 §5.1).
    expect(agentCalled).toBe(false)
    expect(r.dshResult).toBeNull()
    expect(r.labels).toContain('oversight/in-loop')
  })

  it('缺少三軸標註 → fail-safe 採最高風險 → 同樣被擋', () => {
    const r = runWorkItem({
      issueNumber: 104,
      initial: { annotations: {}, hardRulePatterns: PATTERNS },
      runAgent: () => runStubAgent(),
    })
    expect(r.initialScore.total).toBe(6)
    expect(r.outcome).toBe('blocked-in-loop')
  })
})

describe('E2E：二次判定攔截「說低做高」', () => {
  it('宣稱低風險但實際改到 auth → 升級並撤銷自動合併', () => {
    const r = runWorkItem({
      issueNumber: 105,
      initial: LOW_RISK,
      runAgent: () =>
        runStubAgent({ changedPaths: ['src/auth/session.ts'], changedLines: 30 }),
    })

    expect(r.initialScore.total).toBe(0)
    expect(r.finalScore.total).toBeGreaterThan(r.initialScore.total)
    expect(r.finalScore.triggeredHardRules).toContain('H1')
    // SR2 fires on the high-risk domain, so this ends as a handover.
    expect(r.outcome).toBe('needs-human')
    expect(r.labels).toContain('needs-human')
  })
})

describe('E2E：停手規則在流程中確實生效', () => {
  it('嘗試修改 guardrail 自身 → needs-human', () => {
    const r = runWorkItem({
      issueNumber: 106,
      initial: LOW_RISK,
      runAgent: () => runStubAgent({ changedPaths: ['.github/workflows/test.yml'] }),
    })

    expect(r.outcome).toBe('needs-human')
    expect(r.stopDecision?.violations.some((v) => v.rule === 'SR3-guardrail-change')).toBe(true)
    expect(r.summary).toContain('工廠執行中止')
  })

  it('弱化測試斷言 → needs-human', () => {
    const r = runWorkItem({
      issueNumber: 107,
      initial: LOW_RISK,
      runAgent: () =>
        runStubAgent({ changedPaths: ['src/a.test.ts'], assertionDelta: -4 }),
    })
    expect(r.outcome).toBe('needs-human')
    expect(r.stopDecision?.violations.some((v) => v.rule === 'SR6-weakened-tests')).toBe(true)
  })

  it('新增未核可的相依套件 → needs-human', () => {
    const r = runWorkItem({
      issueNumber: 108,
      initial: LOW_RISK,
      runAgent: () =>
        runStubAgent({ changedPaths: ['package.json'], addedDependencies: ['left-pad'] }),
    })
    expect(r.outcome).toBe('needs-human')
    expect(r.stopDecision?.violations.some((v) => v.rule === 'SR5-new-dependency')).toBe(true)
  })

  it('連續兩次 sync 失敗 → needs-human', () => {
    const r = runWorkItem({
      issueNumber: 109,
      initial: LOW_RISK,
      runAgent: () => runStubAgent({ changedPaths: ['src/a.ts'], syncFailures: 2 }),
    })
    expect(r.outcome).toBe('needs-human')
    expect(r.stopDecision?.violations.some((v) => v.rule === 'SR1-sync-failed')).toBe(true)
  })

  it('缺少可驗證的驗收條件 → needs-human (SR4)', () => {
    const r = runWorkItem({
      issueNumber: 115,
      initial: LOW_RISK,
      runAgent: () =>
        runStubAgent({ changedPaths: ['src/a.ts'], hasAcceptanceCriteria: false }),
    })
    expect(r.outcome).toBe('needs-human')
    expect(r.stopDecision?.violations.some((v) => v.rule === 'SR4-unclear-acceptance')).toBe(true)
  })
})

describe('E2E：DSH 執行失敗的處置', () => {
  it('exit 1 → needs-human 且附上 stderr，不自動重試', () => {
    const r = runWorkItem({
      issueNumber: 110,
      initial: LOW_RISK,
      runAgent: () => runStubAgent({ fail: { exitCode: 1, stderr: 'model unavailable' } }),
    })

    expect(r.outcome).toBe('needs-human')
    expect(r.dshResult?.outcome).toBe('failed')
    expect(r.summary).toContain('model unavailable')
  })

  it('逾時 → needs-human', () => {
    const r = runWorkItem({
      issueNumber: 111,
      initial: LOW_RISK,
      runAgent: () => runStubAgent({ timeout: true }),
    })
    expect(r.outcome).toBe('needs-human')
    expect(r.summary).toContain('逾時')
  })

  it('未提供執行器 → needs-human，不會被誤判為成功', () => {
    const r = runWorkItem({ issueNumber: 112, initial: LOW_RISK })
    expect(r.outcome).toBe('needs-human')
  })
})

describe('E2E：不變量', () => {
  it('每一條路徑都有明確終點，agent 絕不靜默失敗', () => {
    const scenarios = [
      { initial: LOW_RISK, runAgent: () => runStubAgent({ changedPaths: ['a.ts'] }) },
      { initial: LOW_RISK, runAgent: () => runStubAgent({ fail: { exitCode: 1, stderr: 'x' } }) },
      { initial: LOW_RISK, runAgent: () => runStubAgent({ timeout: true }) },
      { initial: LOW_RISK, runAgent: () => runStubAgent({ syncFailures: 2 }) },
      { initial: { annotations: {}, hardRulePatterns: PATTERNS } },
    ]
    const valid = ['blocked-in-loop', 'ready-to-automerge', 'ready-for-review', 'needs-human']

    for (const [i, s] of scenarios.entries()) {
      const r = runWorkItem({ issueNumber: 200 + i, ...s })
      expect(valid, `情境 ${i} 的終點無效`).toContain(r.outcome)
      expect(r.summary.length, `情境 ${i} 缺少說明`).toBeGreaterThan(0)
      expect(r.labels.length).toBeGreaterThan(0)
    }
  })

  it('taskVerified 恆為 false，exit 0 不等於任務正確', () => {
    const r = runWorkItem({
      issueNumber: 113,
      initial: LOW_RISK,
      runAgent: () => runStubAgent({ changedPaths: ['a.ts'] }),
    })
    expect(r.dshResult?.taskVerified).toBe(false)
  })

  it('agent 回報最小資訊（全部選填欄位皆缺）時仍能安全完成', () => {
    // A minimal runner reports only the invocation. The pipeline must not crash
    // or silently treat missing data as "nothing changed and all is well".
    const r = runWorkItem({
      issueNumber: 114,
      initial: LOW_RISK,
      runAgent: () => ({ invocation: { exitCode: 0, stdout: 'DONE', stderr: '' } }),
    })

    expect(r.dshResult?.outcome).toBe('completed')
    expect(['ready-to-automerge', 'ready-for-review']).toContain(r.outcome)
    expect(r.stopDecision?.mustStop).toBe(false)
    expect(r.finalScore.total).toBe(r.initialScore.total)
  })

  it('stacked PR 分支命名符合 docs/07 §3.2', () => {
    expect(stackBranchNames(123)).toEqual([
      'factory/123/01-test',
      'factory/123/02-impl',
      'factory/123/03-docs',
    ])
  })
})
