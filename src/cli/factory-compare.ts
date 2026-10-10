/**
 * factory-compare — 雙模型 N-version 競賽比對 CLI。
 *
 * 讀取 Variant A 與 Variant B 的執行結果（judge.json, usage.json, report.json），
 * 產生 Markdown 比對卡片，供 Issue 留言與審查者評估合併決策。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export interface VariantData {
  variant: 'a' | 'b'
  provider?: string | undefined
  model?: string | undefined
  branch?: string | undefined
  prUrl?: string | undefined
  outcome?: string | undefined
  tokensUsed?: number | undefined
  costUsd?: number | undefined
  score?: number | undefined
}

export interface CompareSummary {
  issueNumber: number
  variantA: VariantData
  variantB: VariantData
}

export interface CompareCliArgs {
  issueNumber: number
  reportAPath?: string | undefined
  reportBPath?: string | undefined
  judgeAPath?: string | undefined
  judgeBPath?: string | undefined
  usageAPath?: string | undefined
  usageBPath?: string | undefined
  branchA?: string | undefined
  branchB?: string | undefined
  prUrlA?: string | undefined
  prUrlB?: string | undefined
  providerA?: string | undefined
  providerB?: string | undefined
  modelA?: string | undefined
  modelB?: string | undefined
  outPath?: string | undefined
  format: 'markdown' | 'json'
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} requires a value`)
  }
  return value
}

export function parseArgs(argv: string[]): CompareCliArgs {
  let issueNumber: number | undefined
  let reportAPath: string | undefined
  let reportBPath: string | undefined
  let judgeAPath: string | undefined
  let judgeBPath: string | undefined
  let usageAPath: string | undefined
  let usageBPath: string | undefined
  let branchA: string | undefined
  let branchB: string | undefined
  let prUrlA: string | undefined
  let prUrlB: string | undefined
  let providerA: string | undefined
  let providerB: string | undefined
  let modelA: string | undefined
  let modelB: string | undefined
  let outPath: string | undefined
  let format: 'markdown' | 'json' = 'markdown'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--issue-number') {
      const raw = requireValue(argv, ++i, '--issue-number')
      const num = Number(raw)
      if (!Number.isInteger(num) || num <= 0) {
        throw new CliError(`--issue-number 必須為正整數，收到 "${raw}"`)
      }
      issueNumber = num
    } else if (arg === '--report-a') {
      reportAPath = requireValue(argv, ++i, '--report-a')
    } else if (arg === '--report-b') {
      reportBPath = requireValue(argv, ++i, '--report-b')
    } else if (arg === '--judge-a') {
      judgeAPath = requireValue(argv, ++i, '--judge-a')
    } else if (arg === '--judge-b') {
      judgeBPath = requireValue(argv, ++i, '--judge-b')
    } else if (arg === '--usage-a') {
      usageAPath = requireValue(argv, ++i, '--usage-a')
    } else if (arg === '--usage-b') {
      usageBPath = requireValue(argv, ++i, '--usage-b')
    } else if (arg === '--branch-a') {
      branchA = requireValue(argv, ++i, '--branch-a')
    } else if (arg === '--branch-b') {
      branchB = requireValue(argv, ++i, '--branch-b')
    } else if (arg === '--pr-url-a') {
      prUrlA = requireValue(argv, ++i, '--pr-url-a')
    } else if (arg === '--pr-url-b') {
      prUrlB = requireValue(argv, ++i, '--pr-url-b')
    } else if (arg === '--provider-a') {
      providerA = requireValue(argv, ++i, '--provider-a')
    } else if (arg === '--provider-b') {
      providerB = requireValue(argv, ++i, '--provider-b')
    } else if (arg === '--model-a') {
      modelA = requireValue(argv, ++i, '--model-a')
    } else if (arg === '--model-b') {
      modelB = requireValue(argv, ++i, '--model-b')
    } else if (arg === '--out') {
      outPath = requireValue(argv, ++i, '--out')
    } else if (arg === '--format') {
      const val = requireValue(argv, ++i, '--format')
      if (val !== 'markdown' && val !== 'json') {
        throw new CliError(`--format 必須是 markdown|json，收到 "${val}"`)
      }
      format = val
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }

  if (issueNumber === undefined) {
    throw new CliError('缺少必填參數 --issue-number')
  }

  return {
    issueNumber,
    reportAPath,
    reportBPath,
    judgeAPath,
    judgeBPath,
    usageAPath,
    usageBPath,
    branchA,
    branchB,
    prUrlA,
    prUrlB,
    providerA,
    providerB,
    modelA,
    modelB,
    outPath,
    format,
  }
}

function tryReadJson(path: string | undefined): Record<string, unknown> | undefined {
  if (path === undefined) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function buildVariantData(options: {
  variant: 'a' | 'b'
  reportPath?: string | undefined
  judgePath?: string | undefined
  usagePath?: string | undefined
  branch?: string | undefined
  prUrl?: string | undefined
  provider?: string | undefined
  model?: string | undefined
}): VariantData {
  const { variant, reportPath, judgePath, usagePath, branch, prUrl } = options
  let provider = options.provider
  let model = options.model
  let outcome: string | undefined
  let tokensUsed: number | undefined
  let costUsd: number | undefined
  let score: number | undefined

  const report = tryReadJson(reportPath)
  if (report !== undefined) {
    if (typeof report.tokensUsed === 'number') {
      tokensUsed = report.tokensUsed
    }
    const inv = report.invocation as { provider?: unknown } | undefined
    if (typeof inv?.provider === 'string' && provider === undefined) {
      provider = inv.provider
    }
  }

  const judge = tryReadJson(judgePath)
  if (judge !== undefined) {
    const result = judge.result as { outcome?: unknown; score?: unknown } | undefined
    if (typeof result?.outcome === 'string') {
      outcome = result.outcome
    }
    if (typeof result?.score === 'number') {
      score = result.score
    }
  }

  const usage = tryReadJson(usagePath)
  if (usage !== undefined) {
    const totals = usage.totals as { totalTokens?: unknown; costUsd?: unknown } | undefined
    if (typeof totals?.totalTokens === 'number') {
      tokensUsed = totals.totalTokens
    }
    if (typeof totals?.costUsd === 'number') {
      costUsd = totals.costUsd
    }
    const routes = usage.routes as Array<{ provider?: unknown; model?: unknown }> | undefined
    if (Array.isArray(routes) && routes[0] !== undefined) {
      if (typeof routes[0].provider === 'string' && provider === undefined) {
        provider = routes[0].provider
      }
      if (typeof routes[0].model === 'string' && model === undefined) {
        model = routes[0].model
      }
    }
  }

  return {
    variant,
    provider,
    model,
    branch,
    prUrl,
    outcome,
    tokensUsed,
    costUsd,
    score,
  }
}

export function renderCompareMarkdown(summary: CompareSummary): string {
  const { issueNumber, variantA, variantB } = summary

  const formatModel = (v: VariantData): string => {
    if (v.provider && v.model) return `\`${v.provider}/${v.model}\``
    if (v.model) return `\`${v.model}\``
    return '未知'
  }

  const formatPr = (v: VariantData): string => {
    if (v.prUrl && v.branch) return `[${v.branch}](${v.prUrl})`
    if (v.prUrl) return `[PR 連結](${v.prUrl})`
    if (v.branch) return `\`${v.branch}\`（未發 PR）`
    return '未產生 PR'
  }

  const formatCost = (cost?: number): string => {
    if (cost === undefined) return '-'
    return `$${cost.toFixed(4)}`
  }

  const formatTokens = (tokens?: number): string => {
    if (tokens === undefined) return '-'
    return tokens.toLocaleString()
  }

  const formatOutcome = (outcome?: string): string => {
    if (!outcome) return '-'
    if (outcome === 'ready-to-automerge' || outcome === 'ready-for-review') return `✅ ${outcome}`
    if (outcome === 'blocked-in-loop') return `⚠️ ${outcome}`
    return `❌ ${outcome}`
  }

  const formatScore = (score?: number): string => {
    if (score === undefined) return '-'
    return `${score}`
  }

  return [
    `## ⚔️ 雙模型競賽比對報告 (Issue #${issueNumber})`,
    '',
    '本工作項由兩個獨立 LLM 模型變體平行執行，請審閱產生的程式碼與測試並決定合併版本：',
    '',
    '| 評估指標 | 變體 A (Variant A) | 變體 B (Variant B) |',
    '| :--- | :--- | :--- |',
    `| **模型** | ${formatModel(variantA)} | ${formatModel(variantB)} |`,
    `| **執行狀態** | ${formatOutcome(variantA.outcome)} | ${formatOutcome(variantB.outcome)} |`,
    `| **Pull Request** | ${formatPr(variantA)} | ${formatPr(variantB)} |`,
    `| **品質評分** | ${formatScore(variantA.score)} | ${formatScore(variantB.score)} |`,
    `| **推論成本** | ${formatCost(variantA.costUsd)} | ${formatCost(variantB.costUsd)} |`,
    `| **Token 用量** | ${formatTokens(variantA.tokensUsed)} | ${formatTokens(variantB.tokensUsed)} |`,
    '',
    '### 建議動作',
    '- 點擊上方 Pull Request 連結檢視 Diff 與測試產出。',
    '- 決定採用其中一個版本合併至主分支；合併後落選變體的 PR 將被自動關閉。',
    '',
  ].join('\n')
}

export function main(argv: string[]): string | CompareSummary {
  const args = parseArgs(argv)

  const variantA = buildVariantData({
    variant: 'a',
    reportPath: args.reportAPath,
    judgePath: args.judgeAPath,
    usagePath: args.usageAPath,
    branch: args.branchA,
    prUrl: args.prUrlA,
    provider: args.providerA,
    model: args.modelA,
  })

  const variantB = buildVariantData({
    variant: 'b',
    reportPath: args.reportBPath,
    judgePath: args.judgeBPath,
    usagePath: args.usageBPath,
    branch: args.branchB,
    prUrl: args.prUrlB,
    provider: args.providerB,
    model: args.modelB,
  })

  const summary: CompareSummary = {
    issueNumber: args.issueNumber,
    variantA,
    variantB,
  }

  if (args.format === 'json') {
    if (args.outPath !== undefined) {
      writeFileSync(args.outPath, JSON.stringify(summary, null, 2), 'utf8')
    }
    return summary
  }

  const markdown = renderCompareMarkdown(summary)
  if (args.outPath !== undefined) {
    writeFileSync(args.outPath, markdown, 'utf8')
  }
  return markdown
}

/* v8 ignore start */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => {
    const res = main(process.argv.slice(2))
    return typeof res === 'string' ? res : JSON.stringify(res, null, 2)
  })
}
/* v8 ignore stop */
