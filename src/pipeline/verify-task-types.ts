/**
 * 形式化驗證服務的 task type（ADR-029 §5）。
 *
 * 這份名單是「驗證模式」的單一判定依據：名單內的 task type 走驗證流程——允許
 * `base_branch` 等於目標 repo 的預設分支（ADR-029 §6 修訂 ADR-013）、不要求
 * `catalog-info.yaml` 與 `risk-paths.yml`、不做三軸計分、不檢查
 * `factory-stage prereqs`，而且**永不自動合併**（`no-automerge.ts`）。
 *
 * 陣列順序即流程順序（grill → quint → lean → tests），lean 再以 workflow input
 * `verify_phase` 分 statements／proofs 兩次執行。順序只是閱讀與測試的依據，階段
 * 推進由 aswf.dev 的 G1–G4 閘門決定，不是本常數的語意。
 *
 * 刻意不含 `agent-write-spec` 等其他類型：它們仍走一般模式（base_branch 不得為
 * main 等）。新增或移除驗證型別必須先改 ADR-029，再同步 workflow 的 task_type
 * 選項、Backstage／ISSUE_TEMPLATE 下拉、task-template 與 no-automerge；對抗性
 * 測試釘住這幾處的一致性。
 */
export const VERIFY_TASK_TYPES = [
  'agent-verify-grill',
  'agent-verify-quint',
  'agent-verify-lean',
  'agent-verify-tests',
] as const

export type VerifyTaskType = (typeof VERIFY_TASK_TYPES)[number]

/** 型別守衛；供驗證模式判定 CLI 與 no-automerge 共用。 */
export function isVerifyTaskType(taskType: string | undefined): boolean {
  return (VERIFY_TASK_TYPES as readonly string[]).includes(taskType ?? '')
}
