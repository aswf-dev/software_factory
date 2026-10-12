/**
 * factory-compare — 雙模型 N-version 競賽比對 CLI。
 *
 * 讀取變體 A／B 的 run artifact（report.json、judge.json、usage.json）與 compare job 以
 * `gh pr list` 查到的 PR 清單，產生 Issue 留言用的比對卡片。
 *
 * 卡片只陳述機器事實（實際跑了哪個模型、終態、交付在哪、花了多少），**不評品質**——
 * 勝者由人工比對決定，卡片附上比對紀錄範本。judge 沒有品質分數：`finalScore.total`
 * 是監督風險分數（越高越需要人審），標示時必須講明，不得稱為「品質評分」。
 *
 * 輸入檔一律容錯：缺檔、壞 JSON、欄位型別不符都視為「未知」，不讓單一變體的殘缺
 * artifact 擋住另一變體的比對（compare job 是 `if: always()`）。
 *
 * 2026-10-10 fubon-tradingbot#713 回歸：卡片全部顯示「未知／-／未產生 PR」，根因三個——
 * usage.json 是 `{usage, markdown}` 包裝、judge.json 沒上傳且沒有 `score`、PR 以精確
 * 分支名查找（`gh pr list --head` 不做前綴比對）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export type VariantId = 'a' | 'b'

export interface VariantPr {
  number: number
  url: string
  headRefName: string
  state: string
  additions?: number | undefined
  deletions?: number | undefined
}

export interface VariantData {
  variant: VariantId
  /** session log 實測的 `provider/model`，依出現順序去重；多於一個代表發生 fallback。 */
  routes: string[]
  outcome?: string | undefined
  /** judge `finalScore.total`：監督風險分數，不是品質。 */
  riskTotal?: number | undefined
  riskLabel?: string | undefined
  pr?: VariantPr | undefined
  costUsd?: number | undefined
  /** 成本被低估的原因（cache-read 未計價、未計價模型）；空陣列 = 無已知低估。 */
  costUnderstated: string[]
  tokens?: number | undefined
  /** report.requirements 的 status 統計（agent 自報）。 */
  requirements?: { passed: number; failed: number; skipped: number } | undefined
  /** 本次 run 沒有新變更、交付是本變體先前 run 開的 PR。 */
  reusedExisting: boolean
}

export interface CompareSummary {
  issueNumber: number
  variantA: VariantData
  variantB: VariantData
}

export interface VariantPaths {
  reportPath?: string
  judgePath?: string
  usagePath?: string
  /** `gh pr list --json number,url,headRefName,state,additions,deletions` 的輸出檔。 */
  prPath?: string
}

export interface CompareCliArgs {
  issueNumber: number
  a: VariantPaths
  b: VariantPaths
  outPath?: string
  format: 'markdown' | 'json'
}

const PATH_FLAGS: Record<string, [VariantId, keyof VariantPaths]> = {
  '--report-a': ['a', 'reportPath'],
  '--report-b': ['b', 'reportPath'],
  '--judge-a': ['a', 'judgePath'],
  '--judge-b': ['b', 'judgePath'],
  '--usage-a': ['a', 'usagePath'],
  '--usage-b': ['b', 'usagePath'],
  '--pr-a': ['a', 'prPath'],
  '--pr-b': ['b', 'prPath'],
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
  const paths: Record<VariantId, VariantPaths> = { a: {}, b: {} }
  let outPath: string | undefined
  let format: 'markdown' | 'json' = 'markdown'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const pathFlag = PATH_FLAGS[arg]
    if (pathFlag !== undefined) {
      const [variant, key] = pathFlag
      paths[variant][key] = requireValue(argv, ++i, arg)
    } else if (arg === '--issue-number') {
      const raw = requireValue(argv, ++i, arg)
      const num = Number(raw)
      if (!Number.isInteger(num) || num <= 0) {
        throw new CliError(`--issue-number 必須為正整數，收到 "${raw}"`)
      }
      issueNumber = num
    } else if (arg === '--out') {
      outPath = requireValue(argv, ++i, arg)
    } else if (arg === '--format') {
      const val = requireValue(argv, ++i, arg)
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
  return { issueNumber, a: paths.a, b: paths.b, ...(outPath !== undefined ? { outPath } : {}), format }
}

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 讀 JSON；缺檔或壞 JSON → undefined（容錯，見檔頭）。 */
function tryReadJson(path: string | undefined): unknown {
  if (path === undefined) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** usage 區塊：usage.json 是 `{usage, markdown}` 包裝；未包裝的也接受。 */
function unwrapUsage(raw: unknown): Json | undefined {
  if (!isObject(raw)) return undefined
  return isObject(raw.usage) ? raw.usage : raw
}

/**
 * 從 `gh pr list` 的結果挑出本變體的 PR：只認 `factory/<n>-<variant>-` 開頭（search 的
 * `head:` 是模糊比對，可能混入他張 Issue 或另一變體），open 優先，否則取第一筆。
 */
export function pickPr(raw: unknown, issueNumber: number, variant: VariantId): VariantPr | undefined {
  if (!Array.isArray(raw)) return undefined
  const prefix = `factory/${issueNumber}-${variant}-`
  const mine: VariantPr[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const headRefName = str(item.headRefName)
    const number = num(item.number)
    const url = str(item.url)
    if (headRefName === undefined || number === undefined || url === undefined) continue
    if (!headRefName.startsWith(prefix)) continue
    mine.push({
      number,
      url,
      headRefName,
      state: str(item.state) ?? '',
      additions: num(item.additions),
      deletions: num(item.deletions),
    })
  }
  return mine.find((p) => p.state === 'OPEN') ?? mine[0]
}

function readRoutes(usage: Json | undefined): string[] {
  const routes: string[] = []
  const raw = usage?.routes
  if (!Array.isArray(raw)) return routes
  for (const r of raw) {
    if (!isObject(r)) continue
    const provider = str(r.provider)
    const model = str(r.model)
    if (provider === undefined || model === undefined) continue
    const id = `${provider}/${model}`
    if (!routes.includes(id)) routes.push(id)
  }
  return routes
}

function readRequirements(report: Json | undefined): VariantData['requirements'] {
  const raw = report?.requirements
  if (!Array.isArray(raw)) return undefined
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const r of raw) {
    if (!isObject(r)) continue
    const status = r.status
    if (status === 'passed' || status === 'failed' || status === 'skipped') counts[status]++
  }
  return counts
}

export function buildVariantData(issueNumber: number, variant: VariantId, paths: VariantPaths): VariantData {
  const rawReport = tryReadJson(paths.reportPath)
  const report = isObject(rawReport) ? rawReport : undefined
  const rawJudge = tryReadJson(paths.judgePath)
  const result = isObject(rawJudge) && isObject(rawJudge.result) ? rawJudge.result : undefined
  const finalScore = isObject(result?.finalScore) ? result.finalScore : undefined
  // usage.json 優先；缺席時退回 report.json 內嵌的同一份量測（write-report 會附上）
  const usage = unwrapUsage(tryReadJson(paths.usagePath)) ?? unwrapUsage(report?.usage)
  const totals = isObject(usage?.totals) ? usage.totals : undefined
  const pr = pickPr(tryReadJson(paths.prPath), issueNumber, variant)

  const costUnderstated: string[] = []
  if (totals?.cacheReadUnpriced === true) costUnderstated.push('cache-read 未計價')
  const unpriced = Array.isArray(totals?.unpricedModels) ? totals.unpricedModels.filter((m) => typeof m === 'string') : []
  if (unpriced.length > 0) costUnderstated.push(`未計價模型 ${unpriced.join(', ')}`)

  const changedPaths = report?.changedPaths
  return {
    variant,
    routes: readRoutes(usage),
    outcome: str(result?.outcome),
    riskTotal: num(finalScore?.total),
    riskLabel: str(finalScore?.label),
    pr,
    costUsd: num(totals?.costUsd),
    costUnderstated,
    tokens: num(totals?.totalTokens) ?? num(report?.tokensUsed),
    requirements: readRequirements(report),
    reusedExisting: pr !== undefined && Array.isArray(changedPaths) && changedPaths.length === 0,
  }
}

function formatModel(v: VariantData): string {
  if (v.routes.length === 0) return '未知'
  const chain = v.routes.map((r) => `\`${r}\``).join(' → ')
  return v.routes.length > 1 ? `${chain}（fallback）` : chain
}

function formatOutcome(outcome: string | undefined): string {
  if (outcome === undefined) return '-'
  if (outcome === 'ready-to-automerge' || outcome === 'ready-for-review') return `✅ ${outcome}`
  if (outcome === 'blocked-in-loop') return `⚠️ ${outcome}`
  return `❌ ${outcome}`
}

function formatPr(v: VariantData): string {
  if (v.pr === undefined) return '未產生 PR'
  const { number, url, headRefName, additions, deletions } = v.pr
  const size = additions !== undefined && deletions !== undefined ? ` +${additions}/−${deletions}` : ''
  const reuse = v.reusedExisting ? '（本次沿用既有 PR）' : ''
  return `[#${number}](${url}) \`${headRefName}\`${size}${reuse}`
}

function formatRequirements(r: VariantData['requirements']): string {
  if (r === undefined) return '-'
  const parts = [`${r.passed} passed`]
  if (r.failed > 0) parts.push(`${r.failed} failed`)
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`)
  return parts.join('／')
}

function formatRisk(v: VariantData): string {
  if (v.riskTotal === undefined) return '-'
  return v.riskLabel === undefined ? `${v.riskTotal}` : `${v.riskTotal}（${v.riskLabel}）`
}

function formatCost(v: VariantData): string {
  if (v.costUsd === undefined) return '-'
  const note = v.costUnderstated.length > 0 ? `（低估：${v.costUnderstated.join('、')}）` : ''
  return `$${v.costUsd.toFixed(4)}${note}`
}

function formatTokens(tokens: number | undefined): string {
  return tokens === undefined ? '-' : tokens.toLocaleString('en-US')
}

/** 讓審查者在讀表之前就知道哪些比對不成立。 */
function warnings(a: VariantData, b: VariantData): string[] {
  const out: string[] = []
  for (const v of [a, b]) {
    const name = `變體 ${v.variant.toUpperCase()}`
    if (v.pr === undefined) out.push(`${name} 沒有找到 PR——沒有可比對的交付。`)
    if (v.routes.length === 0) out.push(`${name} 的實際模型未知（沒有 session log 量測）。`)
  }
  // 比最後一個 route：fallback 後真正產出交付的是最後的模型（#713 首輪 critical：
  // B 的 sonnet-5-5 不存在、fallback 到 opus-5-5，與 A 相同）
  if (a.routes.length > 0 && a.routes.at(-1) === b.routes.at(-1)) {
    out.push('兩個變體實際執行的模型相同（fallback 坍縮）——本次比對不具模型對照意義。')
  }
  return out
}

export function renderCompareMarkdown(summary: CompareSummary): string {
  const { issueNumber, variantA: a, variantB: b } = summary
  const row = (label: string, f: (v: VariantData) => string) => `| ${label} | ${f(a)} | ${f(b)} |`
  const warn = warnings(a, b)
  return [
    `## ⚔️ 雙模型競賽比對報告（Issue #${issueNumber}）`,
    '',
    '> 下表只陳述機器事實（跑了哪個模型、終態、交付在哪、花多少），**不代表品質**。勝者由人工比對兩個 PR 後決定。',
    '',
    ...(warn.length > 0 ? ['⚠️ **注意**', ...warn.map((w) => `- ${w}`), ''] : []),
    '| 項目 | 變體 A | 變體 B |',
    '| :--- | :--- | :--- |',
    row('**模型**（session log 實測）', formatModel),
    row('**機器終態**', (v) => formatOutcome(v.outcome)),
    row('**Pull Request**', formatPr),
    row('**需求涵蓋**（agent 自報）', (v) => formatRequirements(v.requirements)),
    row('**監督風險分數**（越高越需人審，非品質）', formatRisk),
    row('**推論成本**', formatCost),
    row('**Token 用量**', (v) => formatTokens(v.tokens)),
    '',
    '### 人工比對紀錄',
    '審閱兩個 PR 後，複製下列範本留言填寫（各維度 1–3 分）：',
    '',
    '```markdown',
    '## N-version 比對紀錄',
    '| 維度 (1–3) | 變體 A | 變體 B |',
    '| :--- | :--- | :--- |',
    '| 正確性 | | |',
    '| 證據品質（file:line／測試） | | |',
    '| 精簡度 | | |',
    '| 可讀性 | | |',
    '| 對工單規格的貼合度 | | |',
    '判定：A / B / 平手 / 兩者皆不收',
    '理由：',
    '```',
    '',
    '### 合併後',
    '- 兩個變體的 PR 都是 draft。比對後執行「Factory N-version Pick」workflow（輸入 Issue 編號與勝出變體）：勝者轉為正式 PR，落選方的 draft 會被關閉，**分支保留**，若勝者審查時被否決仍可改選。',
    '',
  ].join('\n')
}

export function main(argv: string[]): string | CompareSummary {
  const args = parseArgs(argv)
  const summary: CompareSummary = {
    issueNumber: args.issueNumber,
    variantA: buildVariantData(args.issueNumber, 'a', args.a),
    variantB: buildVariantData(args.issueNumber, 'b', args.b),
  }
  const output = args.format === 'json' ? summary : renderCompareMarkdown(summary)
  if (args.outPath !== undefined) {
    writeFileSync(args.outPath, typeof output === 'string' ? output : JSON.stringify(output, null, 2), 'utf8')
  }
  return output
}

/* v8 ignore start */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => {
    const res = main(process.argv.slice(2))
    return typeof res === 'string' ? res : JSON.stringify(res, null, 2)
  })
}
/* v8 ignore stop */
