/**
 * factory-verify-status — 驗證模式唯一允許貼到 Issue 的留言（ADR-029 §5；ruling R6）。
 *
 * 驗證類的 Issue 開在使用者的 repo（ADR-001），body／留言只寫範圍與階段，**不寫
 * 任何發現**。一般模式的 crosscheck 中止留言帶 mismatch 明細（目標 repo 的路徑）
 * 與 usage.md，agent 逾時留言帶 handover／usage——這些在驗證模式都改由本 CLI
 * 產生一行無內容的狀態：
 *
 *   驗證階段 <stage>[（<phase>）]：<ok|needs-human|timeout> — <run URL>
 *
 * 無內容是**由輸入面保證**的：stage 只收四個 `agent-verify-*`、phase 只收
 * statements／proofs、outcome 只收三個結果字、run URL 必須是固定形狀
 * （`https://<host>/<owner>/<repo>/actions/runs/<數字>`，不得有 query／fragment／
 * 空白）。沒有任何旗標接受自由文字——若之後有人想「多帶一點診斷」，必須改這裡
 * 並讓 test/verify-status.test.ts 紅燈，而不是在 workflow 的 shell 裡悄悄串字串。
 *
 * 輸出 `{ comment }` JSON（同 factory-stage prereqs 的 `.comment` 慣例），
 * workflow 以 `jq -r .comment` 寫成留言檔（jq 補上結尾換行，故 comment 本身不帶）。
 */
import { isVerifyTaskType, type VerifyTaskType } from '../pipeline/verify-task-types.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/** 結果字：完成、交還人類、逾時。 */
export const VERIFY_STATUS_OUTCOMES = ['ok', 'needs-human', 'timeout'] as const
export type VerifyStatusOutcome = (typeof VERIFY_STATUS_OUTCOMES)[number]

/** `agent-verify-lean` 的兩次執行（workflow input `verify_phase`）。 */
export const VERIFY_LEAN_PHASES = ['statements', 'proofs'] as const
export type VerifyLeanPhase = (typeof VERIFY_LEAN_PHASES)[number]

export interface VerifyStatusInput {
  stage: VerifyTaskType
  phase?: VerifyLeanPhase
  outcome: VerifyStatusOutcome
  runUrl: string
}

/** `${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}` 的形狀。 */
const RUN_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/

/** phase 只對 lean 有意義；其他階段即使收到也不顯示（workflow 一律傳 inputs.verify_phase）。 */
export function renderVerifyStatus(input: VerifyStatusInput): string {
  const phase = input.stage === 'agent-verify-lean' && input.phase !== undefined ? `（${input.phase}）` : ''
  return `驗證階段 ${input.stage}${phase}：${input.outcome} — ${input.runUrl}`
}

const FLAGS = ['--stage', '--phase', '--outcome', '--run-url'] as const
type Flag = (typeof FLAGS)[number]

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`${flag} must be one of ${allowed.join('|')}`)
  }
  return value as T
}

export function parseArgs(argv: string[]): VerifyStatusInput {
  const values: Partial<Record<Flag, string>> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!(FLAGS as readonly string[]).includes(arg)) throw new CliError(`unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    values[arg as Flag] = value
  }
  const stage = values['--stage']
  const outcome = values['--outcome']
  const runUrl = values['--run-url']
  if (stage === undefined) throw new CliError('--stage is required')
  if (outcome === undefined) throw new CliError('--outcome is required')
  if (runUrl === undefined) throw new CliError('--run-url is required')
  if (!isVerifyTaskType(stage)) throw new CliError(`--stage must be an agent-verify-* task type, got ${stage}`)
  if (!RUN_URL.test(runUrl)) {
    throw new CliError('--run-url must be https://<host>/<owner>/<repo>/actions/runs/<id>')
  }
  const input: VerifyStatusInput = {
    stage: stage as VerifyTaskType,
    outcome: oneOf('--outcome', outcome, VERIFY_STATUS_OUTCOMES),
    runUrl,
  }
  const phase = values['--phase']
  if (phase !== undefined) input.phase = oneOf('--phase', phase, VERIFY_LEAN_PHASES)
  return input
}

export function main(argv: string[]): { comment: string } {
  return { comment: renderVerifyStatus(parseArgs(argv)) }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
