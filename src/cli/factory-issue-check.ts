/**
 * factory-issue-check — Issue 格式檢查器（零 LLM 成本，事前攔截格式不合的工作項）
 * ＋ 需求複雜度分析與模型建議（docs/ADR/011）。
 *
 * 背景：現行流程的「缺驗收條件」檢查由 agent 在執行中做（SR4 停手）——那是事後、
 * 且已花費一次 LLM run。此 CLI 把檢查提前到「開 Issue 時」：解析 factory-work-item
 * 表單（.github/ISSUE_TEMPLATE/factory-work-item.yml）產生的結構化 body，
 * 確認必填欄位（任務類型 / 需求 / DoD）齊全，零 LLM 成本。
 *
 * 2026-08（ADR-011）擴充：同一流程以 src/issue-analysis/complexity.ts 的啟發式
 * 分析需求複雜度，留言同時回報「格式合規＋複雜度分析＋建議模型」。建議模型與
 * factory-run 的實際路由共用 src/model-tier/resolve.ts——檢查與執行永不打架。
 *
 * 輸入：`gh issue view <n> --json body` 的 body（表單欄位格式 `### <id>\n\n<值>`）。
 * 輸出：CheckResult（ok + 缺失欄位清單 + 複雜度分析）。
 *
 * 純函式可單元測試；gh 呼叫以注入（GhRunner）取代（模式同 factory-rescore）。
 */
import { execFileSync } from 'node:child_process'
import { analyzeComplexity, type ComplexityAnalysis } from '../issue-analysis/complexity.js'
import {
  loadDeclaredProviders,
  loadTiers,
  resolveModelTier,
  type ModelEntry,
  type ModelTier,
} from '../model-tier/resolve.js'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

/** 表單必填欄位（與 ISSUE_TEMPLATE/factory-work-item.yml 對齊）。 */
export const REQUIRED_FIELDS = ['task_type', 'requirement', 'acceptance'] as const
export type RequiredField = (typeof REQUIRED_FIELDS)[number]

/**
 * 驗收標準（DoD）的三個必勾選項 label，與 .github/ISSUE_TEMPLATE/factory-work-item.yml
 * 的 checkbox options 逐字對齊（對抗性測試 factory-assets 會釘住兩邊一致）。
 * 表單勾選項未勾選時不輸出；本清單要求三個全部以 `- [x] <label>` 出現才算合規
 * （docs/ADR/009 表單驗證與檢查器規則一致的承諾）。
 */
export const DOD_LABELS = [
  '有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）',
  '不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）',
  '跑測試確認綠燈（不跑需外部服務的 E2E）',
] as const

/** 欄位 id → 表單產生的 body 標題（GitHub Issue Forms 用 label 文字當 `###` 標題）。 */
export const FIELD_TITLES: Record<string, string> = {
  task_type: '任務類型',
  requirement: '需求描述（PRD）',
  acceptance: '驗收標準（DoD）',
}

export interface CheckResult {
  ok: boolean
  missing: RequiredField[]
  taskType?: string | undefined
  /** 需求複雜度分析（零 LLM 成本；fail-safe 方向為 high）。 */
  analysis: ComplexityAnalysis
}

/** 留言中的建議模型（由 model-tier resolve 產出，供人確認，非實際路由的承諾）。 */
export interface ModelRecommendation {
  tier: ModelTier
  selected: ModelEntry
  chain: readonly ModelEntry[]
  reason: string
}

/** 從表單 body 抽取欄位值：`### <欄位標題>\n\n<值>`（值為首個非空段落）。 */
export function extractField(body: string, field: string): string | undefined {
  const title = FIELD_TITLES[field]
  if (title === undefined) return undefined
  const re = new RegExp(`###\\s*${title}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`)
  const m = body.match(re)
  if (!m) return undefined
  const value = m[1]?.trim()
  return value && value.length > 0 ? value : undefined
}

/**
 * DoD 是否「全部勾選」：三個規定 label 都必須以 `- [x] <label>` 出現在 acceptance
 * 欄位中（表單未勾選的選項不輸出）。任何一項缺席即不合規——比「任一勾選即過」
 * 更嚴格，與 Backstage 表單驗證（docs/ADR/009）保持一致。
 */
export function hasCheckedAcceptance(body: string): boolean {
  const value = extractField(body, 'acceptance')
  if (value === undefined) return false
  return DOD_LABELS.every((label) => value.includes(`- [x] ${label}`))
}

export function checkIssue(body: string): CheckResult {
  const missing: RequiredField[] = []
  if (extractField(body, 'task_type') === undefined) missing.push('task_type')
  if (extractField(body, 'requirement') === undefined) missing.push('requirement')
  if (!hasCheckedAcceptance(body)) missing.push('acceptance')
  const taskType = extractField(body, 'task_type')
  return {
    ok: missing.length === 0,
    missing,
    taskType,
    analysis: analyzeComplexity({
      taskType,
      requirement: extractField(body, 'requirement'),
    }),
  }
}

/**
 * 建構檢查留言：格式合規/不合規 ＋ 複雜度分析 ＋ 建議模型（recommendation 有值時）。
 * 分析行即使格式不合規也輸出（best-effort；缺需求欄位 → fail-safe high）。
 */
export function buildCheckComment(r: CheckResult, recommendation?: ModelRecommendation): string {
  const lines: string[] = []
  if (r.ok) {
    lines.push(
      `✅ **Issue 格式合規**（factory-issue-check）：任務類型 \`${r.taskType}\`、需求、DoD 齊全。`,
    )
  } else {
    lines.push(
      `❌ **Issue 格式不合規**（factory-issue-check）：缺 ` +
        r.missing.map((f) => `\`${f}\``).join('、') +
        '。請依 `.github/ISSUE_TEMPLATE/factory-work-item.yml` 表單補齊後再編輯 Issue（編輯會重新檢查）。',
    )
  }
  lines.push(`📊 **複雜度分析**：${r.analysis.complexity}（判據：${r.analysis.evidence.join('；')}）`)
  if (recommendation !== undefined) {
    const fallback = recommendation.chain
      .slice(1)
      .map((e) => `${e.provider}/${e.model}`)
      .join('、')
    lines.push(
      `🤖 **建議模型**：${recommendation.selected.provider}/${recommendation.selected.model}` +
        `（${recommendation.tier} tier；fallback: ${fallback}）`,
    )
  }
  if (r.ok) {
    lines.push(
      '可 dispatch（software_factory → Actions → Factory Run，或貼 `factory/approved` label 由同 repo 自動觸發）。',
    )
  }
  return lines.join('\n')
}

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
/* v8 ignore stop */

export interface IssueCheckPaths {
  tiersPath: string
  providersPath: string
}

const DEFAULT_TIERS_PATH = 'config/dsh/model-tiers.yaml'
const DEFAULT_PROVIDERS_PATH = 'config/dsh/settings.providers.yaml'

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} requires a path argument`)
  }
  return value
}

/** 解析 CLI 參數：第一個 positional = issueNumber，其餘為 --tiers/--providers。 */
export function parseCheckArgs(argv: string[]): { issueNumber: string; paths: IssueCheckPaths } {
  let issueNumber: string | undefined
  let tiersPath = DEFAULT_TIERS_PATH
  let providersPath = DEFAULT_PROVIDERS_PATH
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--tiers') {
      tiersPath = requireValue(argv, ++i, '--tiers')
    } else if (arg === '--providers') {
      providersPath = requireValue(argv, ++i, '--providers')
    } else if (issueNumber === undefined) {
      issueNumber = arg
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  return { issueNumber, paths: { tiersPath, providersPath } }
}

export function main(
  argv: string[],
  gh: GhRunner = realGh,
): { issueNumber: string; result: CheckResult; comment: string } {
  const { issueNumber, paths } = parseCheckArgs(argv)
  const json = gh(['issue', 'view', issueNumber, '--json', 'body'])
  let body: string
  try {
    body = (JSON.parse(json) as { body: unknown }).body as string
  } catch {
    throw new CliError(`issue view JSON invalid: ${json.slice(0, 80)}`)
  }
  const result = checkIssue(body)

  // 建議模型：與 factory-run 共用的解析核心。設定檔損壞 → fail-loud（CliError），
  // 絕不靜默讓建議消失（guardrail 設定錯誤必須紅燈，docs/05）。
  const declaredProviders = loadDeclaredProviders(paths.providersPath)
  const tiers = loadTiers(paths.tiersPath, declaredProviders)
  const resolution = resolveModelTier({ tiers, declaredProviders, analysis: result.analysis })
  const recommendation: ModelRecommendation = {
    tier: resolution.tier,
    selected: resolution.selected,
    chain: resolution.chain,
    reason: resolution.reason,
  }
  return { issueNumber, result, comment: buildCheckComment(result, recommendation) }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const { issueNumber, result, comment } = main(process.argv.slice(2))
    process.stdout.write(comment + '\n')
    // 不合規 → exit 1（workflow 可據此在 Issue 留言後停止，避免繼續流程）
    if (!result.ok) process.exitCode = 1
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
