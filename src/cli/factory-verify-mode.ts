/**
 * factory-verify-mode — 驗證模式判定與 `base_branch` guard 豁免（ADR-029 §5、§6）。
 *
 * 由 `factory-run.yml` 在解析出 task_type 之後、任何 LLM 成本之前呼叫。這也是
 * **base_branch guard 的唯一實作**：`ADR-013` 的「非驗證類不得用 main」與
 * `ADR-029 §6` 的「驗證類改用目標 repo 的預設分支」都只寫在這裡，workflow 只
 * 讀 stdout 的 JSON 決定放行或停止——兩處各寫一份規則就會漂移，而漂移的方向
 * 可能是「非驗證類碰了 main」或「驗證類永遠跑不起來」，兩者都不會有第二次訊號。
 *
 * 判定結果的六個欄位就是 workflow 需要的全部資訊：
 *
 *   verify               是否走驗證流程（四個 `agent-verify-*`；未知類型一律 false）
 *   baseBranchAllowed    guard 放行與否；false 時 error 必為可讀原因
 *   requiresCatalog      `catalog-info.yaml`（三軸計分與 write-spec 門檻的輸入）
 *   requiresRiskPaths    `.github/factory/risk-paths.yml`
 *   requiresStagePrereqs ADR-022 的 `factory-stage prereqs`
 *   error               不允許時的原因（null＝允許）
 *
 * 為什麼未知 task type 走「非驗證」規則：驗證模式是**豁免**（允許 main、跳過
 * 計分／prereqs），所以名單必須是白名單——拼錯的類型若被當成驗證類，就會在
 * 沒有計分與前置檢查的情況下開跑；當成一般類型的失敗模式只是被 guard 擋下。
 *
 * CLI 是「判定產生器」而不是 gate 本身（同 `factory-spec-phase` 的先例）：
 * 合法輸入一律 exit 0 並印出 JSON，即使 `baseBranchAllowed=false`——由
 * workflow 讀該欄位決定是否 `exit 1`。只有參數錯誤才以非零結束，這樣
 * workflow 才能在失敗前先把六個欄位寫進 step outputs／artifact 供稽核。
 */
import { isVerifyTaskType } from '../pipeline/verify-task-types.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/** `ADR-013` 的 factory trunk；驗證類在過渡期仍接受它（ADR-029 §6）。 */
export const VERIFY_LEGACY_BASE_BRANCH = 'software-factory'

export interface VerifyModeInput {
  taskType: string
  baseBranch: string
  defaultBranch: string
}

export interface VerifyModeDecision {
  verify: boolean
  baseBranchAllowed: boolean
  requiresCatalog: boolean
  requiresRiskPaths: boolean
  requiresStagePrereqs: boolean
  error: string | null
}

/**
 * 純函式判定；不做 I/O，也不讀 dispatch input 以外的狀態。
 *
 * @param input.defaultBranch 目標 repo 的預設分支（workflow 以 App token 查
 *   `repos/<owner>/<name>` 取得）。驗證類的 PR 由機制端對預設分支開出，故它
 *   是驗證類唯一合法的 base（加上過渡期相容值）。
 */
export function decideVerifyMode(input: VerifyModeInput): VerifyModeDecision {
  const { taskType, baseBranch, defaultBranch } = input

  if (!isVerifyTaskType(taskType)) {
    const baseBranchAllowed = baseBranch !== 'main'
    return {
      verify: false,
      baseBranchAllowed,
      requiresCatalog: true,
      requiresRiskPaths: true,
      requiresStagePrereqs: true,
      error: baseBranchAllowed
        ? null
        : `base_branch 不得為 main（ADR-013／Q-P2-1：所有 repo 的 main 絕不觸碰，factory trunk 一律 ${VERIFY_LEGACY_BASE_BRANCH}），` +
          `收到 "${baseBranch}"；task type ${taskType} 不適用 ADR-029 §6 的驗證類豁免`,
    }
  }

  // ADR-029 §6：驗證類的 PR 一律對目標 repo 的預設分支開出，故只接受預設分支；
  // `software-factory` 是過渡期相容值（機制 repo 的 dispatch 預設仍填它）。
  const baseBranchAllowed =
    baseBranch === defaultBranch || baseBranch === VERIFY_LEGACY_BASE_BRANCH
  return {
    verify: true,
    baseBranchAllowed,
    requiresCatalog: false,
    requiresRiskPaths: false,
    requiresStagePrereqs: false,
    error: baseBranchAllowed
      ? null
      : `驗證類 task（${taskType}）的 base_branch 必須是目標 repo 的預設分支 "${defaultBranch}"` +
        `（過渡期相容值："${VERIFY_LEGACY_BASE_BRANCH}"），收到 "${baseBranch}"（ADR-029 §6）`,
  }
}

const FLAGS = {
  '--task-type': 'taskType',
  '--base-branch': 'baseBranch',
  '--default-branch': 'defaultBranch',
} as const satisfies Record<string, keyof VerifyModeInput>

export function parseArgs(argv: string[]): VerifyModeInput {
  const values: Partial<VerifyModeInput> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const key = (FLAGS as Record<string, keyof VerifyModeInput | undefined>)[arg]
    if (key === undefined) throw new CliError(`unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    // 空字串不是「沒填」：它會讓 `baseBranch === defaultBranch` 之類的比較出現
    // 非預期的相等（兩個空字串），所以在此 fail-loud。
    if (value.trim() === '') throw new CliError(`${arg} must not be empty`)
    values[key] = value
  }
  const { taskType, baseBranch, defaultBranch } = values
  if (taskType === undefined) throw new CliError('--task-type is required')
  if (baseBranch === undefined) throw new CliError('--base-branch is required')
  if (defaultBranch === undefined) throw new CliError('--default-branch is required')
  return { taskType, baseBranch, defaultBranch }
}

export function main(argv: string[]): VerifyModeDecision {
  return decideVerifyMode(parseArgs(argv))
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
