/**
 * 類型層級禁止自動合併（ADR-018 §9 護欄②、ADR-019 §5、ADR-029 §5）。
 *
 * 刻意放在計分**之後**、而不是改 `src/scoring`：計分以 Quint 規格
 * `specs/scoring/score.qnt` 驗證（ADR-008），只讀 catalog 與 risk-paths 等客觀
 * 來源。工單類型不是計分輸入；把它塞進計分會同時動到規格與不變量。這裡只做一件
 * 事：名單內的類型就算計分允許自動合併，也一律交給人審查。
 *
 * - `agent-write-spec`：不變量是判斷對錯的標準，模型結果是之後修復的依據，兩者都
 *   必須有人看過。
 * - `agent-pbt-audit`：試行期要人工檢查 property 有沒有落入 `hegel-review` 的 12 點
 *   缺陷。它同時是 in-loop 豁免的前提之一（`apply-score-labels.ts`），拿掉它會讓
 *   對抗性測試轉紅。試行期結束後由人類以 PR 移除，留下紀錄。
 * - 四個 `agent-verify-*`（ADR-029 §5）：驗證類 agent **不推分支、不開 PR**，產出
 *   只進加密 artifact（公開 runner 上不得洩漏使用者內容）。G2 之後由機制端
 *   `factory.verify.publish` 發佈 PR，一律人審；沒有「計分允許就自動合併」這條路。
 */
import type { PipelineResult } from './run-work-item.js'
import { VERIFY_TASK_TYPES } from './verify-task-types.js'

export const NO_AUTOMERGE_TASK_TYPES = [
  'agent-write-spec',
  'agent-pbt-audit',
  ...VERIFY_TASK_TYPES,
] as const

/** 驗證類共用理由（ADR-029 §5）：四型各自列名，不靠計分或標籤判定。 */
const VERIFY_NEVER_AUTOMERGE = 'ADR-029 §5：驗證類 task 永不自動合併（PR 由機制端發佈並一律人審）'

const REASONS: Record<(typeof NO_AUTOMERGE_TASK_TYPES)[number], string> = {
  'agent-write-spec': 'ADR-018 護欄②',
  'agent-pbt-audit': 'ADR-019 §5，試行期內 audit PR 一律人工審查',
  'agent-verify-grill': VERIFY_NEVER_AUTOMERGE,
  'agent-verify-quint': VERIFY_NEVER_AUTOMERGE,
  'agent-verify-lean': VERIFY_NEVER_AUTOMERGE,
  'agent-verify-tests': VERIFY_NEVER_AUTOMERGE,
}

export function isNoAutomergeTaskType(taskType: string | undefined): boolean {
  return (NO_AUTOMERGE_TASK_TYPES as readonly string[]).includes(taskType ?? '')
}

export function applyNoAutomergePolicy(result: PipelineResult, taskType: string | undefined): PipelineResult {
  if (!isNoAutomergeTaskType(taskType) || result.outcome !== 'ready-to-automerge') return result
  const type = taskType as (typeof NO_AUTOMERGE_TASK_TYPES)[number]
  return {
    ...result,
    outcome: 'ready-for-review',
    summary: `${result.summary}；但 ${type} 類型一律需人類審查，不自動合併（${REASONS[type]}）`,
  }
}
