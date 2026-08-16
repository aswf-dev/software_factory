/**
 * Stop-rule evaluation (docs/04 §3.3, docs/07 §4).
 *
 * Design stance: this module answers "must the agent stop?" and never "may the
 * agent proceed anyway?". There is deliberately no override parameter — an
 * escape hatch here would let a stuck agent argue its way past the one mechanism
 * that protects the work from it.
 *
 * SR6 deserves special note. An agent that deletes assertions to make tests pass
 * produces a green build over broken code, which is strictly worse than an
 * honest failure: it destroys the signal the whole factory depends on.
 */

import { minimatch } from 'minimatch'
import {
  MAX_SYNC_ATTEMPTS,
  NEEDS_HUMAN_LABEL,
  type StopDecision,
  type StopRuleContext,
  type StopRuleViolation,
} from './types.js'

/**
 * Guardrail paths the agent must never modify (docs/05 §1.1).
 * Kept as an independent copy of the H5 patterns on purpose: this is the prompt-
 * layer check, and it must still fire if risk-paths.yml is ever misconfigured.
 */
const GUARDRAIL_PATTERNS = [
  '.github/**',
  'CODEOWNERS',
  'catalog-info.yaml',
  '.dsh/skills/**',
] as const

export function evaluateStopRules(ctx: StopRuleContext): StopDecision {
  const violations: StopRuleViolation[] = []

  // SR1 — repeated sync failure means a real semantic conflict (docs/07 §4.1).
  const syncFailures = ctx.syncFailures ?? 0
  if (syncFailures >= MAX_SYNC_ATTEMPTS) {
    violations.push({
      rule: 'SR1-sync-failed',
      reason: `\`gh stack sync\` 連續 ${syncFailures} 次失敗（上限 ${MAX_SYNC_ATTEMPTS}），疑似語意衝突，需人類判斷意圖`,
    })
  }

  // SR2 — high-risk domains require human judgement (docs/00 §6, docs/06 §3.2).
  const hardRules = ctx.triggeredHardRules ?? []
  const nonGuardrailRules = hardRules.filter((r) => r !== 'H5')
  if (nonGuardrailRules.length > 0) {
    violations.push({
      rule: 'SR2-high-risk-domain',
      reason: `變更觸及高風險領域（${nonGuardrailRules.join('、')}）：授權、金流或敏感資料等，依 docs/06 §4.3 須由人類主導`,
    })
  }

  // SR3 — the agent must never edit the rules that constrain it (docs/05 §1.1).
  const changedPaths = ctx.changedPaths ?? []
  const guardrailHits = changedPaths.filter((p) =>
    GUARDRAIL_PATTERNS.some((g) => minimatch(p, g, { dot: true })),
  )
  if (guardrailHits.length > 0) {
    violations.push({
      rule: 'SR3-guardrail-change',
      reason: `嘗試修改 guardrail 自身：${guardrailHits.join('、')}。agent 不得變更約束自己的規則`,
    })
  }

  // SR4 — without testable acceptance criteria, "done" cannot be judged.
  if (ctx.hasAcceptanceCriteria === false) {
    violations.push({
      rule: 'SR4-unclear-acceptance',
      reason: '工作項缺少可驗證的驗收條件，無法判斷完成與否；猜測並繼續比停手更危險',
    })
  }

  // SR5 — new dependencies are a supply-chain decision, not an implementation detail.
  const addedDeps = ctx.addedDependencies ?? []
  if (addedDeps.length > 0) {
    violations.push({
      rule: 'SR5-new-dependency',
      reason: `新增未在既有相依清單中的套件：${addedDeps.join('、')}。供應鏈決策須由人類核可`,
    })
  }

  // SR6 — removing assertions turns a red build green without fixing anything.
  if (ctx.assertionDelta !== undefined && ctx.assertionDelta < 0) {
    violations.push({
      rule: 'SR6-weakened-tests',
      reason: `測試斷言淨減少 ${Math.abs(ctx.assertionDelta)} 條。絕不允許為通過測試而弱化斷言`,
    })
  }

  // SR7 — cost ceiling (docs/05 §5). Only enforced once a budget is set.
  if (
    ctx.tokenBudget !== undefined &&
    ctx.tokensUsed !== undefined &&
    ctx.tokensUsed > ctx.tokenBudget
  ) {
    violations.push({
      rule: 'SR7-cost-exceeded',
      reason: `token 消耗 ${ctx.tokensUsed} 超過單一工作項上限 ${ctx.tokenBudget}`,
    })
  }

  // SR8 — wall-clock timeout (docs/02 §6).
  if (ctx.timedOut === true) {
    violations.push({
      rule: 'SR8-timeout',
      reason: '執行超過時間上限，已中止',
    })
  }

  return {
    mustStop: violations.length > 0,
    violations,
    label: NEEDS_HUMAN_LABEL,
    report: buildHandoverReport(violations),
  }
}

/**
 * Builds the issue comment posted on stop (docs/07 §4.2).
 *
 * The point is that a human can resume rather than restart, so the report names
 * every triggered rule instead of only the first.
 */
export function buildHandoverReport(violations: readonly StopRuleViolation[]): string {
  if (violations.length === 0) return ''

  const lines = [
    '## 工廠執行中止',
    '',
    `**觸發規則**：${violations.length} 條`,
    '',
  ]
  for (const v of violations) {
    lines.push(`- **${v.rule}**：${v.reason}`)
  }
  lines.push('', '**下一步**：需人類接手處理。agent 不會自行重試或放寬規則。')
  return lines.join('\n')
}
