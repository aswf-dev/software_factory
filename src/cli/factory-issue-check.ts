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

/**
 * 空泛詞彙清單（具體性檢查的形式黑名單，docs/18 §4 G5）。
 * 刻意保守：只收「幾乎必然無法第三方驗證」的詞，避免誤傷
 * 「錯誤率下降 20%」這類量化描述（提升/改善等不入列）。
 */
export const VAGUE_TERMS = [
  '更好',
  '最佳化',
  '優化',
  '完善',
  '盡量',
  '適當',
  '合理',
  '等等',
  '差不多',
  'improve',
  'optimize',
  'better',
  'enhance',
  'as appropriate',
  'etc.',
] as const

/**
 * 可觀察結果的形式線索（白名單）：code span（命令/檔案/API）、箭頭後果、
 * 測試/斷言/輸出類詞彙、量化閾值。命中任一即視為「含可觀察結果」。
 */
const OBSERVABLE_PATTERNS: readonly RegExp[] = [
  /`[^`]+`/,
  /→/,
  /(測試|斷言|驗證|紅燈|綠燈|輸出|回傳|返回|日誌|報錯|退出碼|通過|失敗|test|assert|output|exit|expect|coverage)/i,
  /[0-9]+\s*(%|ms|秒|次|行|個|kb|mb)/i,
]

/** 單條驗收條目的形式審查結果。 */
export interface DodItemReview {
  /** 條目原文（已 trim）。 */
  text: string
  /** 命中的空泛詞彙（英文比對不分大小寫）。 */
  vagueTerms: string[]
  /** 是否含可觀察結果線索。 */
  observable: boolean
}

/** DoD 具體性審查（docs/18 §4 G5：Verification——只查形式，不判該不該做）。 */
export interface DodReview {
  /** 受審條目：acceptance 欄位的自訂條目（排除模板固定三項）；無則退回 requirement 的「驗證方式」。 */
  items: DodItemReview[]
  /** 每條都具體（含可觀察結果且無空泛詞彙）；空清單 → false（無具體驗收描述）。 */
  specific: boolean
}

/** 逐條形式審查：空泛詞彙黑名單 ＋ 可觀察結果白名單。 */
export function reviewDodItem(text: string): DodItemReview {
  const lower = text.toLowerCase()
  const vagueTerms = VAGUE_TERMS.filter((t) => lower.includes(t.toLowerCase()))
  const observable = OBSERVABLE_PATTERNS.some((re) => re.test(text))
  return { text, vagueTerms, observable }
}

/** 由 `- `／`* `（含 checkbox）條目行抽取文字；排除模板固定三項與裸 checkbox。 */
function extractBulletTexts(value: string): string[] {
  const items: string[] = []
  for (const raw of value.split('\n')) {
    const m = raw.trim().match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/)
    if (m === null) continue
    const text = (m[1] as string).trim()
    if ((DOD_LABELS as readonly string[]).includes(text)) continue
    if (/^\[[ xX]\]$/.test(text)) continue
    items.push(text)
  }
  return items
}

/** requirement 中的「驗證方式」條目：冒號後單行，或冒號後的連續 bullet 清單。 */
function extractVerificationItems(requirementValue: string | undefined): string[] {
  if (requirementValue === undefined) return []
  const lines = requirementValue.split('\n')
  const idx = lines.findIndex((l) => l.includes('驗證方式'))
  if (idx === -1) return []
  const after = (lines[idx] as string).split(/[：:]/).slice(1).join('：').trim()
  if (after.length > 0) return [after]
  const rest: string[] = []
  for (const line of lines.slice(idx + 1)) {
    const m = line.trim().match(/^[-*]\s+(.+)$/)
    if (m === null) break
    rest.push((m[1] as string).trim())
  }
  return rest
}

/**
 * DoD 具體性檢查（docs/18 §4 G5）：模板的三個 checkbox 對每個 Issue 都逐字相同，
 * 「字面存在」不等於「具體可驗證」（SWEBOK Ch1 §4.3）。受審條目 = acceptance 欄位
 * 中自訂的驗收條目；若作者只勾模板三項（factory 慣例），退回 requirement 的
 * 「驗證方式」段落。這是提示（advisory），不改變 ok/missing 合規判定與計分。
 */
export function checkDodSpecificity(body: string): DodReview {
  const customItems = extractBulletTexts(extractField(body, 'acceptance') ?? '')
  const sources =
    customItems.length > 0
      ? customItems
      : extractVerificationItems(extractField(body, 'requirement'))
  const items = sources.map(reviewDodItem)
  const specific =
    items.length > 0 && items.every((i) => i.observable && i.vagueTerms.length === 0)
  return { items, specific }
}

/** 💡 提示留言列：空清單與逐條標記兩類；只對不具體的條目發話。 */
export function buildDodSpecificityHint(dod: DodReview): string[] {
  if (dod.items.length === 0) {
    return [
      '💡 **DoD 具體性提示**（形式檢查，不影響合規判定與計分）：驗收標準只有表單固定的 ' +
        '3 個勾選項，且需求未寫「驗證方式」——沒有本 Issue 專有的可驗證條目。請補至少一條含' +
        '可觀察結果的驗收（命令／輸出／斷言／檔案），避免空泛詞彙（更好／優化／完善…）。',
    ]
  }
  const flagged = dod.items.filter((i) => !i.observable || i.vagueTerms.length > 0)
  const details = flagged.map((i) => {
    const reasons: string[] = []
    if (!i.observable) reasons.push('缺可觀察結果線索（命令／輸出／斷言／量化閾值）')
    if (i.vagueTerms.length > 0) reasons.push(`空泛詞彙：${i.vagueTerms.join('、')}`)
    const shown = i.text.length > 60 ? `${i.text.slice(0, 60)}…` : i.text
    return `- 「${shown}」（${reasons.join('；')}）`
  })
  return [
    '💡 **DoD 具體性提示**（形式檢查，不影響合規判定與計分）：以下驗收條目疑似空泛，' +
      '建議改寫為第三方可驗證的形式（每條含可觀察結果）：',
    ...details,
  ]
}

export interface CheckResult {
  ok: boolean
  missing: RequiredField[]
  taskType?: string | undefined
  /** 需求複雜度分析（零 LLM 成本；fail-safe 方向為 high）。 */
  analysis: ComplexityAnalysis
  /** DoD 具體性審查（advisory；不影響 ok，docs/18 §4 G5）。 */
  dod: DodReview
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
    dod: checkDodSpecificity(body),
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
  if (!r.dod.specific) {
    lines.push(...buildDodSpecificityHint(r.dod))
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
