/**
 * factory-attempt-classify — 分類一次失敗的 DSH 嘗試（docs/ADR/011）。
 *
 * 由 factory-run.yml 的 agent 步驟在嘗試以非 0、非逾時結束時執行：
 *
 *   node dist/cli/factory-attempt-classify.js --stderr .factory/run/stderr.txt --tier critical
 *
 * 輸出 JSON：{ outcome, fallback, code?, errorLine? }。workflow 依 `fallback`
 * 決定是否換 chain 下一項，並把 `errorLine` 印到 log 當證據。
 */
import { readFileSync } from 'node:fs'
import { classifyFailedAttempt, type AttemptClassification } from '../model-tier/attempt-outcome.js'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export interface AttemptClassifyArgs {
  stderr: string
  tier: string
}

export function parseArgs(argv: string[]): AttemptClassifyArgs {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string
    if (!['--stderr', '--tier'].includes(flag)) throw new CliError(`unknown argument: ${flag}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} requires a value`)
    values[flag] = value
    i++
  }
  for (const required of ['--stderr', '--tier']) {
    if (values[required] === undefined) throw new CliError(`${required} is required`)
  }
  return { stderr: values['--stderr'] as string, tier: values['--tier'] as string }
}

export function main(argv: string[]): AttemptClassification {
  const args = parseArgs(argv)
  return classifyFailedAttempt({ stderr: readFileSync(args.stderr, 'utf8'), tier: args.tier })
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
