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
 *
 * 2026-09（docs/18 §4 G5、#200）擴充：DoD 具體性提示（checkDodSpecificity）——
 * 表單三個 checkbox 對每個 Issue 逐字相同，「字面存在」不等於「具體可驗證」；
 * 對自訂條目／驗證方式逐條做形式檢查（每條含可觀察結果、無空泛詞彙），不具體時
 * 留言輸出 💡 提示。屬 Verification 而非 Validation：不判「該不該做」、不改
 * 合規判定與計分邏輯。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { minimatch } from 'minimatch'
import { analyzeComplexity, type ComplexityAnalysis } from '../issue-analysis/complexity.js'
import {
  CRITICAL_MIN_TOTAL,
  loadDeclaredProviders,
  loadTiers,
  resolveModelTier,
  type ModelEntry,
  type ModelTier,
} from '../model-tier/resolve.js'
import {
  loadQuintSpecAnnotated,
  reviewSpecIntake,
  type SpecIntakeContext,
  type SpecIntakeReview,
} from '../write-spec/intake.js'
import {
  findPbtEditRequests,
  reviewPbtAuditIntake,
  PBT_AUDIT_TASK_TYPE,
  type PbtAuditIntakeContext,
  type PbtAuditIntakeReview,
} from '../pbt-audit/intake.js'
import { repoFs } from '../pbt-audit/repo-fs.js'
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
  // agent-write-spec 專用（ADR-018 §5、§11）：其他類型留空（`_No response_`）。
  // 標題在 Backstage 模板、ISSUE_TEMPLATE、buildIssueBody 四處逐字一致
  //（對抗性測試 factory-assets 釘住）。
  spec_name: '規格名稱',
  spec_source: '規格來源',
}

/** GitHub Issue Forms 對未填選填欄位輸出的字樣；Backstage 模板比照輸出，一律視為未填。 */
export const NO_RESPONSE = '_No response_'

/** write-spec 開單欄位檢查所需、只在 dispatch 時才有的目標 repo 情境。 */
export interface SpecCheckContext {
  quintSpecAnnotated?: boolean | undefined
  fileExists?: ((relPath: string) => boolean) | undefined
  /** agent-pbt-audit 的稽核目標檢查（ADR-019 R3）；同樣只在 dispatch 時才有。 */
  pathKind?: PbtAuditIntakeContext['pathKind']
  listFiles?: PbtAuditIntakeContext['listFiles']
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

/* ── REQ id 錨定（RTM 語意補實）─────────────────────────────────────────
 *
 * 動機：G8（docs/20 B1）要求 agent 在 report.json 回報
 * `requirements: [{id, status}]`，crosscheck 驗證其「存在且非空」。但 **id 由
 * agent 自行命名**，不對應任何真實驗收條件——agent 可回報 `{id:"req-1"}` 而該
 * id 不指向 Issue 的任何一條 DoD，G8 仍然通過。RTM 於是形式存在、語意落空。
 *
 * 本節把驗收條目**編號並回寫 Issue 留言**（REQ-1…REQ-n），成為該工作項的穩定
 * 契約錨點。錨定之後才可能統計「哪一類驗收條件最常 failed」——那是不依賴 agent
 * 自報的技能缺口訊號（docs/25 §2.3 T3）。
 *
 * **刻意不改變 ok/missing 合規判定**：與 G5 具體性提示同為 advisory。
 */

/** 一條被編號的驗收條件（REQ-n ↔ 原文）。 */
export interface RequirementAnchor {
  id: string
  text: string
}

/**
 * 由 DoD 審查結果產生穩定編號。
 *
 * 順序即編號來源，因此編號的穩定性取決於 Issue body 不被改寫——這正是
 * 「Issue 是工作項契約」的既有前提（docs/02 §3.2）。
 */
export function buildRequirementAnchors(dod: DodReview): RequirementAnchor[] {
  return dod.items.map((item, i) => ({ id: `REQ-${i + 1}`, text: item.text }))
}

/**
 * REQ 清單留言列（advisory）。
 *
 * 空清單時不發話——該情況已由 `buildDodSpecificityHint` 的「只有表單固定 3 項」
 * 提示涵蓋，重複提醒只會稀釋訊號。
 */
export function buildRequirementAnchorLines(anchors: RequirementAnchor[]): string[] {
  if (anchors.length === 0) return []
  return [
    '🔖 **需求追蹤編號（REQ id）**：agent 於 `report.json` 的 `requirements[].id` ' +
      '請**沿用下列編號**，以便逐條對應驗收條件（G8 需求追蹤）：',
    ...anchors.map((a) => {
      const shown = a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text
      return `- \`${a.id}\`：${shown}`
    }),
  ]
}

/* ── 事前風險路徑檢查（路徑 3）───────────────────────────────────────────
 *
 * 動機（factory-scoreboard#3 實證）：初始計分**收不到 changedPaths**——
 * factory-run.yml 的 Initial score 只傳 --catalog/--risk-paths，
 * src/scoring/score.ts 的 changedPaths 預設 []，故 matchHardRules 恆為空。
 * H 規則要到 PR 之後的 factory-rescore（會傳 pr.files）才可能命中。
 * 結果：agent 啟動前**沒有任何風險訊號**。#3 的 PRD 明寫要改
 * `.github/workflows/ci.yml`（H5），仍一路放行，直到燒掉 156,018 tokens
 * 才由 agent 依 SR3 停手。
 *
 * 本檢查把該訊號提前到開單當下（零 LLM 成本）：解析 PRD 的
 * 「目標模組 / 檔案」段落，比對 risk-paths.yml 的 H1–H7 glob。
 *
 * **效力：advisory**（使用者裁決 2026-09）——只留言提示，不改 ok/missing、
 * 不貼 oversight/* 標籤。理由：PRD 是自由文字，若讓它成為計分輸入，會破壞
 * docs/06「計分只讀 catalog + risk-paths 客觀來源」的邊界。人類仍握有
 * dispatch 決定權；真正的強制判定留給 factory-rescore 的 changedPaths。
 */

/** risk-paths.yml 的 hard_rules 結構（rule id → glob 陣列）。 */
export type HardRulePatterns = Readonly<Record<string, readonly string[]>>

/** 單一命中：哪條規則、哪個宣告路徑、命中哪個 pattern。 */
export interface RiskPathHit {
  rule: string
  path: string
  pattern: string
}

export interface RiskPathReview {
  /** PRD 宣告的目標路徑；空陣列代表未宣告（觸發 fail-safe 提示）。 */
  declared: string[]
  /** 命中的硬規則；空陣列代表未命中（或未提供 hardRules）。 */
  hits: RiskPathHit[]
}

/** 「目標模組 / 檔案」段落的標題變體（容忍全半形與有無空格）。 */
const TARGET_SECTION_RE = /目標(模組|檔案|模組\s*[／/]\s*檔案)/

/**
 * 由 PRD 抽出宣告的目標路徑：支援「標題：\n  - 路徑」與「標題：路徑」兩式。
 * 括號註記（全形或半形）與尾隨空白會被剝除——`a.yml（新增步驟）` → `a.yml`。
 */
export function extractDeclaredPaths(body: string): string[] {
  const requirement = extractField(body, 'requirement')
  if (requirement === undefined) return []
  const lines = requirement.split('\n')
  const idx = lines.findIndex((l) => TARGET_SECTION_RE.test(l))
  if (idx === -1) return []
  const clean = (s: string): string => (s.split(/[（(]/)[0] as string).trim()
  // 單行形式：冒號後直接寫路徑
  const inline = (lines[idx] as string).split(/[：:]/).slice(1).join('：').trim()
  if (inline.length > 0) return [clean(inline)].filter((p) => p.length > 0)
  // 清單形式：連續 bullet，遇非 bullet 行即停（不吞噬後續段落）
  const out: string[] = []
  for (const line of lines.slice(idx + 1)) {
    const t = line.trim()
    if (t.length === 0) continue
    const m = t.match(/^[-*]\s+(.+)$/)
    if (m === null) break
    const p = clean(m[1] as string)
    if (p.length > 0) out.push(p)
  }
  return out
}

/** 比對 PRD 宣告路徑與 risk-paths 硬規則（glob 語意與 src/scoring 一致）。 */
export function checkRiskPaths(body: string, hardRules?: HardRulePatterns): RiskPathReview {
  const declared = extractDeclaredPaths(body)
  const hits: RiskPathHit[] = []
  for (const [rule, globs] of Object.entries(hardRules ?? {})) {
    for (const pattern of globs) {
      const path = declared.find((p) => minimatch(p, pattern, { dot: true }))
      if (path !== undefined) {
        hits.push({ rule, path, pattern })
        break
      }
    }
  }
  return { declared, hits }
}

/** 讀 risk-paths.yml 的 hard_rules；檔案缺失或格式不符 → undefined（不誤報）。 */
export function loadHardRules(path: string): HardRulePatterns | undefined {
  let raw: unknown
  try {
    raw = load(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  const rules = (raw as { hard_rules?: unknown } | null)?.hard_rules
  if (typeof rules !== 'object' || rules === null) return undefined
  const out: Record<string, readonly string[]> = {}
  for (const [id, globs] of Object.entries(rules as Record<string, unknown>)) {
    if (Array.isArray(globs) && globs.every((g) => typeof g === 'string')) {
      out[id] = globs as string[]
    }
  }
  return out
}

/**
 * ⚠️ 事前風險路徑提示（advisory）。兩類輸出：
 * - 命中硬規則：逐條列出 rule／路徑／pattern，提醒此工作項將觸發強制人類審查；
 * - 未宣告目標檔案：fail-safe 提示（呼應 SR4「驗收條件不明確」的精神）。
 * 措辭刻意不含「格式不合規」——workflow 以該字串 grep 決定是否紅燈停派。
 */
export function buildRiskPathHint(risk: RiskPathReview): string[] {
  if (risk.hits.length > 0) {
    const details = risk.hits.map(
      (h) => `- \`${h.path}\` → **${h.rule}**（pattern：\`${h.pattern}\`）`,
    )
    return [
      '⚠️ **事前風險路徑提示**（形式檢查，不影響合規判定與計分）：PRD 宣告的目標檔案' +
        '命中 `risk-paths.yml` 的硬性規則——此工作項預期會**強制 risk=2 → 人類審查**，' +
        'agent 亦可能依 `factory-stop-rules` SR2/SR3 停手：',
      ...details,
      '若此為預期行為，請於 dispatch 前確認由人類接手；若非預期，請調整 PRD 範圍。',
    ]
  }
  if (risk.declared.length === 0) {
    return [
      '💡 **PRD 未宣告目標檔案**（形式檢查，不影響合規判定與計分）：需求描述沒有' +
        '「目標模組 / 檔案：」段落，無法在開跑前比對高風險路徑。建議補上具體檔案路徑，' +
        '讓風險在花費 LLM 成本前就能被判斷。',
    ]
  }
  return []
}

export interface CheckResult {
  ok: boolean
  missing: RequiredField[]
  taskType?: string | undefined
  /** 需求複雜度分析（零 LLM 成本；fail-safe 方向為 high）。 */
  analysis: ComplexityAnalysis
  /** DoD 具體性審查（advisory；不影響 ok，docs/18 §4 G5）。 */
  dod: DodReview
  /** 事前風險路徑審查（advisory）；未提供 hardRules 時為 undefined。 */
  risk?: RiskPathReview | undefined
  /** 驗收條件的穩定編號（advisory；RTM 錨點，供 report.requirements[].id 沿用）。 */
  requirements: RequirementAnchor[]
  /** agent-write-spec 的規格欄位審查（ADR-018）；其他類型為 undefined。errors 非空即不合規。 */
  spec?: SpecIntakeReview | undefined
  /** agent-pbt-audit 的稽核目標審查（ADR-019 R3）；其他類型為 undefined。errors 非空即不合規。 */
  pbtAudit?: PbtAuditIntakeReview | undefined
  /**
   * 非 audit 類型的 PRD 要求新增或修改的 PBT 測試檔（ADR-019 §2）；audit 類型為 undefined。
   * 非空即不合規：派工後必定被 crosscheck 判 pbt-outside-audit（philipz/fubon-tradingbot#654）。
   */
  pbtOutsideAudit?: string[] | undefined
}

/** 留言中的建議模型（由 model-tier resolve 產出，供人確認，非實際路由的承諾）。 */
export interface ModelRecommendation {
  tier: ModelTier
  selected: ModelEntry
  chain: readonly ModelEntry[]
  reason: string
  /**
   * critical tier 的 primary（來自 model-tiers.yaml，非硬編碼）。
   *
   * 本檢查流程**不計分**（計分屬 factory-run 的 Initial score 步驟），因此
   * `resolveModelTier` 的 critical 升級分支在此不可達，建議天花板永遠是 high。
   * 但 factory-run 會傳入計分，複雜度 high 且總分 ≥ CRITICAL_MIN_TOTAL 時會升級
   * 為 critical——留言必須誠實揭露這個差異，否則人看到的建議與實際執行不符
   * （2026-09-11 實測：fubon-tradingbot#611 留言 deepseek-flash、實跑 opus-5）。
   * 有值時才輸出揭露行；由 tiers 設定供給，設定改了揭露文字就跟著改。
   */
  criticalPrimary?: ModelEntry | undefined
}

/** 從表單 body 抽取欄位值：`### <欄位標題>\n\n<值>`（值為首個非空段落）。 */
export function extractField(body: string, field: string): string | undefined {
  const title = FIELD_TITLES[field]
  if (title === undefined) return undefined
  const re = new RegExp(`###\\s*${title}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`)
  const m = body.match(re)
  if (!m) return undefined
  const value = m[1]?.trim()
  return value && value.length > 0 && value !== NO_RESPONSE ? value : undefined
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

export function checkIssue(
  body: string,
  hardRules?: HardRulePatterns,
  specCtx: SpecCheckContext = {},
): CheckResult {
  const missing: RequiredField[] = []
  if (extractField(body, 'task_type') === undefined) missing.push('task_type')
  if (extractField(body, 'requirement') === undefined) missing.push('requirement')
  if (!hasCheckedAcceptance(body)) missing.push('acceptance')
  const taskType = extractField(body, 'task_type')
  const dod = checkDodSpecificity(body)
  const risk = hardRules === undefined ? undefined : checkRiskPaths(body, hardRules)
  // write-spec 專用檢查（ADR-018 §4、§5）：缺欄位、格式錯誤、非高風險模組皆為不合規。
  const spec =
    taskType === 'agent-write-spec'
      ? reviewSpecIntake(extractField(body, 'spec_name'), extractField(body, 'spec_source'), {
          riskHits: risk?.hits.length,
          quintSpecAnnotated: specCtx.quintSpecAnnotated,
          fileExists: specCtx.fileExists,
        } satisfies SpecIntakeContext)
      : undefined
  // pbt-audit 專用檢查（ADR-019 R3）：恰好一個稽核目標、存在、不是測試檔、語言受支援。
  const pbtAudit =
    taskType === PBT_AUDIT_TASK_TYPE
      ? reviewPbtAuditIntake(extractDeclaredPaths(body), {
          pathKind: specCtx.pathKind,
          listFiles: specCtx.listFiles,
        })
      : undefined
  // 其他類型不得變更 PBT 檔（ADR-019 §2）：在花費 LLM 成本前攔下必定被 crosscheck 擋的工單。
  const pbtOutsideAudit =
    taskType === PBT_AUDIT_TASK_TYPE ? undefined : findPbtEditRequests(extractField(body, 'requirement') ?? '')
  return {
    ok:
      missing.length === 0 &&
      (spec?.errors.length ?? 0) === 0 &&
      (pbtAudit?.errors.length ?? 0) === 0 &&
      (pbtOutsideAudit?.length ?? 0) === 0,
    missing,
    taskType,
    analysis: analyzeComplexity({
      taskType,
      requirement: extractField(body, 'requirement'),
    }),
    dod,
    // 未提供 hardRules（既有呼叫端／設定缺失）→ undefined，留言完全不提風險段落
    risk,
    requirements: buildRequirementAnchors(dod),
    spec,
    pbtAudit,
    pbtOutsideAudit,
  }
}

/**
 * 建構檢查留言：格式合規/不合規 ＋ 複雜度分析 ＋ 建議模型（recommendation 有值時）。
 * ＋ DoD 具體性提示（💡，advisory，docs/18 §4 G5——僅在不具體時出現）。
 * 分析行即使格式不合規也輸出（best-effort；缺需求欄位 → fail-safe high）。
 */
export function buildCheckComment(r: CheckResult, recommendation?: ModelRecommendation): string {
  const lines: string[] = []
  if (r.ok) {
    lines.push(
      `✅ **Issue 格式合規**（factory-issue-check）：任務類型 \`${r.taskType}\`、需求、DoD 齊全。`,
    )
  } else {
    if (r.missing.length > 0) {
      lines.push(
        `❌ **Issue 格式不合規**（factory-issue-check）：缺 ` +
          r.missing.map((f) => `\`${f}\``).join('、') +
          '。請依 `.github/ISSUE_TEMPLATE/factory-work-item.yml` 表單補齊後再編輯 Issue（編輯會重新檢查）。',
      )
    }
    if (r.spec !== undefined && r.spec.errors.length > 0) {
      lines.push(
        '❌ **Issue 格式不合規**（factory-issue-check）：`agent-write-spec` 的規格欄位未通過檢查（ADR-018）：',
        ...r.spec.errors.map((e) => `- ${e}`),
      )
    }
    if (r.pbtAudit !== undefined && r.pbtAudit.errors.length > 0) {
      lines.push(
        '❌ **Issue 格式不合規**（factory-issue-check）：`agent-pbt-audit` 的稽核目標未通過檢查（ADR-019）：',
        ...r.pbtAudit.errors.map((e) => `- ${e}`),
      )
    }
    if (r.pbtOutsideAudit !== undefined && r.pbtOutsideAudit.length > 0) {
      lines.push(
        `❌ **Issue 格式不合規**（factory-issue-check）：\`${r.taskType ?? '(未宣告類型)'}\` 工單要求新增或修改 PBT 測試檔：` +
          r.pbtOutsideAudit.map((p) => `\`${p}\``).join('、') +
          '。PBT 測試檔只能由 `agent-pbt-audit` 變更（ADR-019 §2），派工後必定被 crosscheck 判 `pbt-outside-audit`。' +
          '請改寫成一般範例測試；修正後要加回的 property，請在修正合併後另開 `agent-pbt-audit` 工單' +
          '（以該 property 為驗收條件，docs/30 §7）。',
      )
    }
  }
  if (r.ok && r.pbtAudit !== undefined) {
    const lang = r.pbtAudit.language === undefined ? '語言待 dispatch 時判定' : `語言 \`${r.pbtAudit.language}\``
    lines.push(
      `🔬 **PBT 稽核**（ADR-019）：稽核目標 \`${r.pbtAudit.target}\`（${lang}）。` +
        '目標 repo 須已完成前置作業（Hegel 依賴精確釘版、`.gitignore` 含 `.hegel/`），否則 dispatch 時直接失敗。',
    )
    if (r.pbtAudit.deferred.length > 0) {
      lines.push(
        '💡 **dispatch 時才判定的項目**（此處沒有目標 repo 的 checkout）：',
        ...r.pbtAudit.deferred.map((d) => `- ${d}`),
      )
    }
  }
  if (r.ok && r.spec !== undefined) {
    lines.push(
      `📐 **規格流程**（ADR-018）：規格名稱 \`${r.spec.specName}\` → \`specs/${r.spec.specName}/\`；` +
        `規格來源 \`${r.spec.specSource}\`（${r.spec.sourceKind}）。`,
    )
    if (r.spec.deferred.length > 0) {
      lines.push(
        '💡 **dispatch 時才判定的項目**（此處缺少目標 repo 的設定）：',
        ...r.spec.deferred.map((d) => `- ${d}`),
      )
    }
  }
  lines.push(`📊 **複雜度分析**：${r.analysis.complexity}（判據：${r.analysis.evidence.join('；')}）`)
  // B5（34735315950 事故）：計算強度是與複雜度正交的第二個軸，且它會同時決定
  // 模型 tier（強制 critical）與 agent 逾時預算（heavy-verify 放寬）。把判準
  // 顯示在留言上，讓人類在 dispatch 前就能發現誤判（同 ADR-011 §5 的揭露精神）。
  if (r.analysis.computationalIntensity === 'heavy-verify') {
    lines.push(
      '🧮 **計算強度**：heavy-verify（模型檢查/求解器迭代）→ 模型強制 critical tier，' +
        'agent 逾時預算放寬至 110 分。若誤判（例如只是文件的「驗證方式」段落被關鍵字命中），' +
        'dispatch 時以 `model_tier` / `agent_timeout_minutes` 手動覆寫。',
    )
  }
  if (recommendation !== undefined) {
    const fallback = recommendation.chain
      .slice(1)
      .map((e) => `${e.provider}/${e.model}`)
      .join('、')
    lines.push(
      `🤖 **建議模型**：${recommendation.selected.provider}/${recommendation.selected.model}` +
        `（${recommendation.tier} tier；fallback: ${fallback}）`,
    )
    // 誠實揭露：本流程不計分，故建議天花板為 high；實跑會加上初始計分，
    // 複雜度 high 且總分 ≥ CRITICAL_MIN_TOTAL 會升級為 critical（較貴的旗艦）。
    // 只在「真的可能被升級」時提示（tier=high 且 critical 有宣告 primary）。
    if (recommendation.tier === 'high' && recommendation.criticalPrimary !== undefined) {
      const c = recommendation.criticalPrimary
      lines.push(
        `⚠️ **實際執行可能升級**：本檢查不含計分，故建議止於 high。` +
          `Factory Run 會先做初始計分，若總分 ≥ ${CRITICAL_MIN_TOTAL} 則升級為 critical` +
          `（${c.provider}/${c.model}），成本較高。實際路由以執行紀錄的 \`model.json\` 為準。`,
      )
    }
  }
  if (!r.dod.specific) {
    lines.push(...buildDodSpecificityHint(r.dod))
  }
  if (r.risk !== undefined) {
    lines.push(...buildRiskPathHint(r.risk))
  }
  lines.push(...buildRequirementAnchorLines(r.requirements))
  if (r.ok) {
    lines.push(
      '可 dispatch（software_factory → Actions → Factory Run，或貼 `factory/approved` label 由同 repo 自動觸發）。',
    )
  }
  return lines.join('\n')
}

/** 路徑是否為既有的一般檔案（目錄或不存在皆為 false）。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** gh CLI 注入點（測試以 fake 取代）。 */
export type GhRunner = (args: string[]) => string

/* v8 ignore start -- 真實 gh 二進位的薄包裝：單元測試一律注入 fake runner */
const realGh: GhRunner = (args) => execFileSync('gh', args, { encoding: 'utf8' })
/* v8 ignore stop */

export interface IssueCheckPaths {
  tiersPath: string
  providersPath: string
  /** risk-paths.yml；未指定 → 不做事前風險比對（向後相容）。 */
  riskPathsPath?: string | undefined
  /** 目標 repo 的 catalog-info.yaml；未指定 → write-spec 門檻延後判定。 */
  catalogPath?: string | undefined
  /** 目標 repo 的 checkout 根目錄；未指定 → write-spec 規格來源存在性延後判定。 */
  targetRoot?: string | undefined
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
  let riskPathsPath: string | undefined
  let catalogPath: string | undefined
  let targetRoot: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--tiers') {
      tiersPath = requireValue(argv, ++i, '--tiers')
    } else if (arg === '--providers') {
      providersPath = requireValue(argv, ++i, '--providers')
    } else if (arg === '--risk-paths') {
      riskPathsPath = requireValue(argv, ++i, '--risk-paths')
    } else if (arg === '--catalog') {
      catalogPath = requireValue(argv, ++i, '--catalog')
    } else if (arg === '--target-root') {
      targetRoot = requireValue(argv, ++i, '--target-root')
    } else if (issueNumber === undefined) {
      issueNumber = arg
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  if (issueNumber === undefined) throw new CliError('issueNumber is required')
  return {
    issueNumber,
    paths: { tiersPath, providersPath, riskPathsPath, catalogPath, targetRoot },
  }
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
  // 事前風險比對（advisory）：未指定 --risk-paths 或檔案不可讀 → undefined，
  // 留言完全不提風險段落（不因設定缺失而誤報，也不因此紅燈）。
  const hardRules =
    paths.riskPathsPath === undefined ? undefined : loadHardRules(paths.riskPathsPath)
  // write-spec 情境（ADR-018）：只有 factory-run 會 checkout 目標 repo 並傳入這兩個旗標；
  // 機制 repo 的 issues 事件沒有這些資料 → 門檻與存在性延後到 dispatch 時判定。
  const targetRoot = paths.targetRoot
  const specCtx: SpecCheckContext = {
    quintSpecAnnotated:
      paths.catalogPath === undefined ? undefined : loadQuintSpecAnnotated(paths.catalogPath),
    fileExists:
      targetRoot === undefined ? undefined : (rel) => isFile(join(targetRoot, rel)),
    ...(targetRoot === undefined
      ? {}
      : (({ pathKind, listFiles }) => ({ pathKind, listFiles }))(repoFs(targetRoot))),
  }
  const result = checkIssue(body, hardRules, specCtx)

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
    // 由設定供給（非硬編碼）：critical tier 若未宣告則不輸出揭露行。
    criticalPrimary: tiers.critical?.primary,
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
