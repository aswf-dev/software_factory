/**
 * factory-usage — 量測一次 factory run 的 token 用量與估算成本（docs/04 §5、
 * docs/08 §2.3）。
 *
 * 輸入：DSH sessions root（$HOME/.dsh/sessions）+ 定價表 + 目標 report.json。
 * 輸出：
 *   - stdout：UsageReport JSON（CI 存成 .factory/usage.json 供 apply-judge-labels
 *     附加至 Issue 留言，並上傳 artifacts）；
 *   - --usage-md <path>：留言用 markdown 段落（同內容另存檔）；
 *   - --report <path>：把 usage 區塊寫回 report.json（執行報告留底）。
 *
 * 量測是「附註」不是 gate：session log 找不到/壞檔時 exit 0 且
 * unavailableReason 非空（誠實標示，不偽造、不擋 run）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { foldSessionLogs, type SessionUsage } from '../usage/aggregate.js'
import { loadPricing, type PricingTable } from '../usage/pricing.js'
import { buildUsageReport, renderUnavailableMarkdown, renderUsageMarkdown } from '../usage/render.js'
import { discoverSessions } from '../usage/session-log.js'
import type { UsageReport } from '../usage/types.js'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export interface FactoryUsageArgs {
  sessionsRoot: string
  pricingPath: string
  /** 只取該 ms 之後建立的 session（防呆；0 = 全部）。 */
  sinceMs: number
  /** 寫入留言 markdown 的目標路徑（可省略）。 */
  usageMdPath?: string | undefined
  /** 要寫回 usage 區塊的 report.json 路徑（可省略）。 */
  reportPath?: string | undefined
}

/** 解析位置參數與旗標：`--sessions-root <dir> --pricing <yaml> [--since-ms <n>] [--usage-md <p>] [--report <p>]`。 */
export function parseArgs(argv: string[]): FactoryUsageArgs {
  let sessionsRoot: string | undefined
  let pricingPath: string | undefined
  let sinceMs = 0
  let usageMdPath: string | undefined
  let reportPath: string | undefined
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const next = (): string | undefined => argv[++i]
    if (arg === '--sessions-root') {
      sessionsRoot = next()
      if (sessionsRoot === undefined || sessionsRoot.startsWith('--')) throw new CliError('--sessions-root requires a directory')
    } else if (arg === '--pricing') {
      pricingPath = next()
      if (pricingPath === undefined || pricingPath.startsWith('--')) throw new CliError('--pricing requires a file path')
    } else if (arg === '--since-ms') {
      const v = next()
      if (v === undefined || v.startsWith('--')) throw new CliError('--since-ms requires an epoch ms number')
      sinceMs = Number(v)
      if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new CliError(`--since-ms must be a non-negative number, got ${v}`)
    } else if (arg === '--usage-md') {
      usageMdPath = next()
      if (usageMdPath === undefined || usageMdPath.startsWith('--')) throw new CliError('--usage-md requires a file path')
    } else if (arg === '--report') {
      reportPath = next()
      if (reportPath === undefined || reportPath.startsWith('--')) throw new CliError('--report requires a file path')
    } else if (arg.startsWith('--')) {
      throw new CliError(`unknown argument: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (sessionsRoot === undefined) throw new CliError('--sessions-root is required')
  if (pricingPath === undefined) throw new CliError('--pricing is required')
  if (positional.length > 0) throw new CliError(`unexpected positional arguments: ${positional.join(', ')}`)
  return { sessionsRoot, pricingPath, sinceMs, usageMdPath, reportPath }
}

/** 讀現有 report.json 並保留原欄位，附加 usage 區塊（無 report 檔則跳過）。 */
function attachUsageToReport(reportPath: string, usage: UsageReport): void {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    return // report 不存在/壞 JSON：量測是附註，不在此製造檔案
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const next = { ...(raw as Record<string, unknown>), usage }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(next, null, 2)}\n`)
}

export interface FactoryUsageOutput {
  /** 量測結果；unavailableReason 非空表示未能量測。 */
  usage: UsageReport
  /** 留言用 markdown（同 usage.json 內容）。 */
  markdown: string
}

/** 主流程：掃 session log → fold → 換算 → 輸出。 */
export function main(argv: string[], now: () => Date = () => new Date()): FactoryUsageOutput {
  const args = parseArgs(argv)
  const pricing = loadPricing(args.pricingPath)
  const discovered = discoverSessions({ sessionsRoot: args.sessionsRoot, sinceMs: args.sinceMs })
  const measuredAt = now().toISOString()

  let usage: UsageReport
  let markdown: string
  if (discovered.logs.length === 0) {
    const skippedNote = discovered.skipped.length > 0 ? `（另有 ${discovered.skipped.length} 個 session log 無法解碼，已跳過）` : ''
    const reason = `找不到本次 run 的 DSH session log（sessions-root: ${args.sessionsRoot}${args.sinceMs > 0 ? `，since ${args.sinceMs}` : ''}）${skippedNote}`
    usage = {
      source: 'dsh-session-log',
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        unpricedModels: [],
        cacheReadUnpriced: false,
      },
      routes: [],
      pricingRef: args.pricingPath,
      measuredAt,
      sessionCount: 0,
      unavailableReason: reason,
    }
    markdown = renderUnavailableMarkdown(reason)
  } else {
    const folded: SessionUsage = foldSessionLogs(discovered.logs)
    usage = buildUsageReport(folded, pricing, args.pricingPath, measuredAt)
    markdown = renderUsageMarkdown(usage)
  }

  if (args.usageMdPath !== undefined) {
    mkdirSync(dirname(args.usageMdPath), { recursive: true })
    writeFileSync(args.usageMdPath, markdown)
  }
  if (args.reportPath !== undefined) {
    attachUsageToReport(args.reportPath, usage)
  }
  return { usage, markdown }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
