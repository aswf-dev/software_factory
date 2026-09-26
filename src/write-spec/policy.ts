/**
 * write-spec 類型層級禁止自動合併（ADR-018 §9 護欄②）。
 *
 * 刻意放在計分**之後**、而不是改 `src/scoring`：計分以 Quint 規格
 * `specs/scoring/score.qnt` 驗證（ADR-008），只讀 catalog 與 risk-paths 等客觀
 * 來源。工單類型不是計分輸入；把它塞進計分會同時動到規格與不變量。這裡只做一件
 * 事：write-spec 就算計分允許自動合併，也一律交給人審查——不變量是判斷對錯的
 * 標準，模型結果則是之後修復的依據，兩者都必須有人看過。
 */
import type { PipelineResult } from '../pipeline/run-work-item.js'

export const WRITE_SPEC_TASK_TYPE = 'agent-write-spec'

export function applyWriteSpecMergePolicy(result: PipelineResult, taskType: string | undefined): PipelineResult {
  if (taskType !== WRITE_SPEC_TASK_TYPE || result.outcome !== 'ready-to-automerge') return result
  return {
    ...result,
    outcome: 'ready-for-review',
    summary: `${result.summary}；但 ${WRITE_SPEC_TASK_TYPE} 類型一律需人類審查，不自動合併（ADR-018 護欄②）`,
  }
}
