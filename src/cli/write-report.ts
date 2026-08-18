/**
 * write-report — agent 執行後 report 的 fallback 產生器。
 *
 * 正常路徑：agent 依 factory-workflow skill 自行寫出 .factory/run/report.json。
 * fallback 路徑：agent 失敗或未寫（例如啟動即掛），CI 依 exit code/stderr
 * 補一份最小 report，使 factory-judge 仍能走完 needs-human 判定。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export interface WriteReportInput {
  issueNumber: number
  exitCode: number
  stderr: string
  stdout: string
  timedOut: boolean
  cwd: string
}

export interface WriteReportArgs {
  issueNumber: number
  exitCode: number
  stdoutFile: string
  stderrFile: string
  timedOut: boolean
}

/** 解析位置參數：`<issueNumber> <exitCode> <stdoutFile> <stderrFile> [--timed-out]`。 */
export function parseArgs(argv: string[]): WriteReportArgs {
  const timedOut = argv.includes('--timed-out')
  const positional = argv.filter((a) => a !== '--timed-out')
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
  }
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
    cwd,
  })
  return { reportPath }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
