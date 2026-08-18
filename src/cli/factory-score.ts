/**
 * factory-score — agent 啟動前的初始計分 CLI（docs/06 §5.1, docs/02 §4 step 2）。
 *
 * 輸入：catalog-info.yaml 的三軸 annotation + .github/factory/risk-paths.yml。
 * 輸出：計分結果 JSON（stdout）。agent 永不參與此判定。
 *
 * 這支 CLI 是 CI 的 oversight gate，因此對外部輸入一律 fail-loud 驗證
 * （沿用 src/integration/gh-parse.ts 的 zod 慣例）：寧可讓 CI 紅燈，
 * 也不可因輸入格式異常而算出一個看似合理、實則錯誤的分數。
 */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { z } from 'zod'
import { score } from '../scoring/score.js'
import type { CatalogAnnotations, HardRuleId, ScoreResult } from '../scoring/types.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

const HARD_RULE_IDS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7'] as const

// 與 types.ts 的 HardRuleId 對齊；日後新增規則卻漏改這裡，會在編譯期報錯，
// 而不是在執行期把合法設定判成不合法。
type AssertSameIds = HardRuleId extends (typeof HARD_RULE_IDS)[number]
  ? (typeof HARD_RULE_IDS)[number] extends HardRuleId
    ? true
    : never
  : never
const _hardRuleIdsMatchType: AssertSameIds = true
void _hardRuleIdsMatchType

/**
 * YAML 純量 → 字串。
 *
 * `factory.io/agent-automerge: false`（未加引號）在 YAML 是 boolean，
 * 直接交給計分會讓 `agentAutomerge?.trim()` 拋 TypeError。這裡統一轉成字串：
 * 轉型不會放寬計分 —— 無法對應到合法選項的值仍由 score() 的 fail-safe 判為 2 分。
 */
const AnnotationValue = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((v) => String(v))
  .optional()

/**
 * annotations 區塊。
 *
 * 缺 metadata、缺 annotations、或 annotations 不是 map，都退回空 map 交給
 * score() 的 fail-safe（未標註 → 2 分）；這是「保守」而非「寬鬆」的方向。
 * 相對地，hard_rules 格式錯誤不能這樣處理 —— 見下方說明。
 */
const CatalogSchema = z.object({
  metadata: z
    .object({ annotations: z.record(z.string(), z.unknown()).catch({}) })
    .catch({ annotations: {} }),
})

/**
 * hard_rules 必須是「規則代號 → 路徑字串陣列」。
 *
 * 這裡刻意 **不** 用 .catch() 兜底：hard_rules 打錯格式若被靜默忽略，
 * 硬性規則就完全失效（risk 不會被強制拉到 2），屬於 fail-open。
 * 用 partialRecord 允許只宣告部分規則，但值與代號都必須合法。
 */
const RiskPathsSchema = z.object({
  hard_rules: z.partialRecord(z.enum(HARD_RULE_IDS), z.array(z.string())).nullable().optional(),
})

export interface ScoreCliOutput {
  annotations: CatalogAnnotations
  /** 技術棧規範（catalog 讀取；CI 依此決定驗證組合，Task 20）。 */
  stack: TechStack
  score: ScoreResult
}

/** 技術棧規範：機器可讀的驗證組合宣告（docs/03 §2.2, Task 20）。 */
export interface TechStack {
  stack?: string | undefined
  testFramework?: string | undefined
  quintSpec?: string | undefined
}

export interface CliPaths {
  catalogPath: string
  riskPathsPath: string
}

/** 取出旗標的值；缺值或值本身又是旗標時 fail-loud。 */
function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} requires a path argument`)
  }
  return value
}

export function parseArgs(argv: string[]): CliPaths {
  let catalogPath = 'catalog-info.yaml'
  let riskPathsPath = '.github/factory/risk-paths.yml'
  for (let i = 0; i < argv.length; i++) {
    // 迴圈上界保證 i 在範圍內，但 noUncheckedIndexedAccess 仍視其為可能 undefined。
    const arg = argv[i] as string
    if (arg === '--catalog') {
      catalogPath = requireValue(argv, ++i, '--catalog')
    } else if (arg === '--risk-paths') {
      riskPathsPath = requireValue(argv, ++i, '--risk-paths')
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  return { catalogPath, riskPathsPath }
}

/**
 * 解析 YAML 檔；空檔或只有註解視為空文件。
 *
 * js-yaml 5.x 對空輸入會拋 "expected a document, but the input is empty"，
 * 但「尚未填寫的設定檔」是合法狀態，應交由後續 fail-safe 計分處理。
 */
function loadYamlFile(path: string, label: string): unknown {
  const text = readFileSync(path, 'utf8')
  if (text.trim() === '' || text.trim().split('\n').every((l) => l.trim().startsWith('#'))) {
    return {}
  }
  try {
    return load(text) ?? {}
  } catch (err) {
    throw new CliError(`${label} (${path}) is not valid YAML: ${(err as Error).message}`)
  }
}

export function loadScoreInput(
  catalogPath: string,
  riskPathsPath: string,
): {
  annotations: CatalogAnnotations
  hardRulePatterns: Partial<Record<HardRuleId, readonly string[]>>
  stack: TechStack
} {
  const catalogRaw = loadYamlFile(catalogPath, 'catalog')
  if (typeof catalogRaw !== 'object' || catalogRaw === null || Array.isArray(catalogRaw)) {
    throw new CliError(`catalog (${catalogPath}) must be a YAML mapping`)
  }
  // CatalogSchema 每層都有 .catch()，因此對任何 map 輸入都必定回傳值。
  const raw = CatalogSchema.parse(catalogRaw).metadata.annotations

  const pick = (key: string): string | undefined => {
    const parsed = AnnotationValue.safeParse(raw[key])
    return parsed.success ? parsed.data : undefined
  }
  const annotations: CatalogAnnotations = {
    businessCriticality: pick('factory.io/business-criticality'),
    riskProfile: pick('factory.io/risk-profile'),
    complexity: pick('factory.io/complexity'),
    agentAutomerge: pick('factory.io/agent-automerge'),
  }
  const stack: TechStack = {
    stack: pick('factory.io/stack'),
    testFramework: pick('factory.io/test-framework'),
    quintSpec: pick('factory.io/quint-spec'),
  }

  const riskRaw = loadYamlFile(riskPathsPath, 'risk-paths')
  const riskParsed = RiskPathsSchema.safeParse(riskRaw)
  if (!riskParsed.success) {
    throw new CliError(
      `risk-paths (${riskPathsPath}) is invalid: hard_rules must map rule ids (${HARD_RULE_IDS.join(', ')}) to arrays of path globs`,
    )
  }
  return { annotations, hardRulePatterns: riskParsed.data.hard_rules ?? {}, stack }
}

export function main(argv: string[]): ScoreCliOutput {
  const { catalogPath, riskPathsPath } = parseArgs(argv)
  const { annotations, hardRulePatterns, stack } = loadScoreInput(catalogPath, riskPathsPath)
  return { annotations, stack, score: score({ annotations, hardRulePatterns }) }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入，
   由 test/integration/factory-score-cli.test.ts 以實機執行涵蓋 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
