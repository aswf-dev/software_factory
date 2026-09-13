/**
 * write-report — agent 執行後 report 的 fallback 產生器。
 *
 * 正常路徑：agent 依 factory-workflow skill 自行寫出 .factory/run/report.json。
 * fallback 路徑：agent 失敗或未寫（例如啟動即掛），CI 依 exit code/stderr
 * 補一份最小 report，使 factory-judge 仍能走完 needs-human 判定。
 *
 * A2（34735315950 事故修正）：逾時必須**具名**。
 *
 * 事故實證：run 34735315950 的 scoreboard 事件 `stop_reason: null`、
 * `crosscheck_mismatches: []`——50 分鐘的失敗在資料層完全沒有名字，judge 與
 * 事後統計都無從歸因（無法區分「agent 迷路」與「任務對 50 分鐘不可行」）。
 * 因此 fallback report 的 invocation 必須帶上決定性的 `stopReason`，由 CI 依
 * `timeout(1)` 的 124 等訊號明確標示，而不是留給人類從 log 猜。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

/**
 * 終止原因（封閉集合，fail-loud：未知值一律 CliError）。
 *
 *  - `agent-step-timeout`：工作流 step 級逾時（GitHub Actions timeout-minutes）——
 *    process 被 runner 直接砍掉，agent 沒有任何機會寫 report。
 *  - `agent-inner-timeout`：bash `timeout(1)` 觸發（本檔 A4 新增的內層逾時），
 *    可歸因到單一 provider 嘗試。
 *  - `provider-error`：provider 層失敗（credential/rate limit/model 不存在）。
 *  - `agent-error`：agent 非零退出但非上述（任務層失敗）。
 *  - `agent-exit-zero`:exit 0 但 agent 未寫 report（異常，需人看）。
 */
export const STOP_REASONS = [
  'agent-step-timeout',
  'agent-inner-timeout',
  'provider-error',
  'agent-error',
  'agent-exit-zero',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

export interface WriteReportInput {
  issueNumber: number
  exitCode: number
  stderr: string
  stdout: string
  timedOut: boolean
  cwd: string
  stopReason?: StopReason | undefined
  /** 最後嘗試的 provider（chain 迭代；供事後歸因，agent 自報不可信故由 CI 填）。 */
  provider?: string | undefined
  /** chain 中已嘗試的次數（含 fallback／逾時升級）。 */
  attempts?: number | undefined
}

export interface WriteReportArgs {
  issueNumber: number
  exitCode: number
  stdoutFile: string
  stderrFile: string
  timedOut: boolean
  stopReason?: StopReason | undefined
  provider?: string | undefined
  attempts?: number | undefined
}

/** 讀 `--flag value` 形式的可選旗標；缺值 → CliError（不靜默吞掉）。 */
function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    throw new CliError(`${flag} requires a value`)
  }
  return v
}

/**
 * 解析位置參數：
 * `<issueNumber> <exitCode> <stdoutFile> <stderrFile> [--timed-out] [--stop-reason R] [--provider P] [--attempts N]`。
 */
export function parseArgs(argv: string[]): WriteReportArgs {
  const timedOut = argv.includes('--timed-out')

  let stopReason: StopReason | undefined
  let provider: string | undefined
  let attempts: number | undefined
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--timed-out') continue
    if (arg === '--stop-reason') {
      const raw = takeValue(argv, i, arg)
      i++
      if (!(STOP_REASONS as readonly string[]).includes(raw)) {
        throw new CliError(`--stop-reason 必須是 ${STOP_REASONS.join('|')}，收到 "${raw}"`)
      }
      stopReason = raw as StopReason
      continue
    }
    if (arg === '--provider') {
      provider = takeValue(argv, i, arg)
      i++
      continue
    }
    if (arg === '--attempts') {
      const raw = takeValue(argv, i, arg)
      i++
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0) {
        throw new CliError(`--attempts 必須是非負整數，收到 "${raw}"`)
      }
      attempts = n
      continue
    }
    if (arg.startsWith('--')) {
      throw new CliError(`unknown argument: ${arg}`)
    }
    positional.push(arg)
  }

  const extra = positional[4]
  if (extra !== undefined) {
    throw new CliError(`unexpected argument: ${extra}`)
  }
  const issueNumber = Number(positional[0])
  const exitCode = Number(positional[1])
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError(`issueNumber must be a positive integer, got ${positional[0] ?? '(missing)'}`)
  }
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new CliError(`exitCode must be a non-negative integer, got ${positional[1] ?? '(missing)'}`)
  }
  return {
    issueNumber,
    exitCode,
    stdoutFile: positional[2] ?? '',
    stderrFile: positional[3] ?? '',
    timedOut,
    stopReason,
    provider,
    attempts,
  }
}

/**
 * stopReason 缺席時的推導（單一真相來源，避免 CI 每個呼叫點各推一次而漂移）：
 * 逾時 → step 級逾時；其餘非零 → agent-error；exit 0 未寫 report → agent-exit-zero。
 * `agent-inner-timeout`／`provider-error` 無法由 exit code 區分，必須由 CI 顯式傳入。
 */
export function deriveStopReason(input: { exitCode: number; timedOut: boolean }): StopReason {
  if (input.timedOut) return 'agent-step-timeout'
  return input.exitCode === 0 ? 'agent-exit-zero' : 'agent-error'
}

export function buildReport(input: WriteReportInput): string {
  const target = join(input.cwd, '.factory/run/report.json')
  if (existsSync(target)) return target // agent 已寫，保留
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    JSON.stringify(
      {
        issueNumber: input.issueNumber,
        invocation: {
          exitCode: input.exitCode,
          stdout: input.stdout,
          stderr: input.stderr,
          timedOut: input.timedOut,
          stopReason: input.stopReason ?? deriveStopReason(input),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
        },
      },
      null,
      2,
    ),
  )
  return target
}

export function main(argv: string[], cwd = process.cwd()): { reportPath: string } {
  const args = parseArgs(argv)
  const read = (p: string): string => (p && existsSync(p) ? readFileSync(p, 'utf8') : '')
  const reportPath = buildReport({
    issueNumber: args.issueNumber,
    exitCode: args.exitCode,
    stdout: read(args.stdoutFile),
    stderr: read(args.stderrFile),
    timedOut: args.timedOut,
    stopReason: args.stopReason,
    provider: args.provider,
    attempts: args.attempts,
    cwd,
  })
  return { reportPath }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
