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

/** 逾時類的 stopReason（內外層各一，兩者都代表 agent 沒機會寫 report）。 */
const TIMEOUT_STOP_REASONS: readonly StopReason[] = ['agent-step-timeout', 'agent-inner-timeout']

/**
 * 逾時 run 的技能缺口（docs/25 §2.1）。
 *
 * **要修的結構性盲點**：`skillGap` 只能由 agent 自己寫進 report.json。agent 被
 * `timeout(1)` 砍掉時來不及寫，CI 補的 fallback report 又沒有這個欄位，於是
 * **逾時 run 在結構上不可能回報缺口**——而逾時正是最可能藏著缺口的情境。
 *
 * 實證：run 34735315950（node-redlock#7）跑了 50 分鐘、19.4M token、USD $0.306，
 * 全損收場。它的 stdout 裡有一個成品級的缺口——agent 自行發現「Quint 模型的
 * map 更新用 `fold` 會讓 Apalache 的狀態空間爆炸，改用 `mapBy` 後從 2.5 分鐘/步
 * 降到 1 分鐘跑完 7 步」。那段發現連同整場產出一起消失了。
 *
 * **這不是替 agent 虛構缺口**（SKILL 明文禁止虛報）：本函式只登記一件 CI 自己
 * 觀測到的客觀事實——「這次 run 以逾時收場、沒有產出」。`needed` 刻意寫成
 * 「需人類從 run log 判讀」而非編造一條 SOP，因為 CI 並不知道 agent 卡在哪。
 *
 * **對聚類的影響（刻意）**：`agent-timeout` 會累積計數；同一 category 反覆出現
 * 正是 docs/25 §3 要偵測的訊號——重複逾時代表任務類型與能力/預算的系統性落差，
 * 值得開提案或調整路由（2026-09-13 的 heavy-verify 升 tier 就是這樣的修正）。
 */
export function buildTimeoutSkillGap(input: {
  stopReason: StopReason
  provider?: string | undefined
  attempts?: number | undefined
}): { category: string; needed: string; context: string } | undefined {
  if (!TIMEOUT_STOP_REASONS.includes(input.stopReason)) return undefined
  const facts = [
    `stopReason=${input.stopReason}`,
    ...(input.provider === undefined ? [] : [`provider=${input.provider}`]),
    ...(input.attempts === undefined ? [] : [`attempts=${input.attempts}`]),
  ].join('、')
  return {
    category: 'agent-timeout',
    needed:
      '本次 run 逾時中止，agent 未能自報技能缺口。缺什麼 SOP 需由人類從 run log ' +
      '與 stdout 判讀（CI 只能觀測到「逾時且無產出」這件事實，不代為推論）',
    context: `CI 自動登記（非 agent 自報）：${facts}`,
  }
}

export function buildReport(input: WriteReportInput): string {
  const target = join(input.cwd, '.factory/run/report.json')
  if (existsSync(target)) return target // agent 已寫，保留
  mkdirSync(dirname(target), { recursive: true })
  const stopReason = input.stopReason ?? deriveStopReason(input)
  const skillGap = buildTimeoutSkillGap({
    stopReason,
    provider: input.provider,
    attempts: input.attempts,
  })
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
          stopReason,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
        },
        // 非逾時的 fallback 不寫此欄位——缺席即「未回報」，與 agent 自寫的
        // report 同語意，也讓 advisory（docs/25 §2.1）照常對它發話。
        ...(skillGap === undefined ? {} : { skillGap }),
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
