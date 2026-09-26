/**
 * factory-model — 依 Issue 複雜度選擇 LLM 模型 tier（docs/ADR/011, docs/04 §7）。
 *
 * 由 factory-run.yml 的「Select model tier」步驟執行（cwd = 機制 repo 根）：
 * 讀取 `gh issue view --json body` 的輸出＋初始計分（.factory/score.json），
 * 解析出 model tier 與完整 chain（primary + fallback），輸出 JSON：
 *
 *   { tier, complexity, complexitySource, evidence, reason, selected, chain }
 *
 * bash 端以 `jq -c '.chain[]'` 迭代 chain，逐項寫 `agent-default-model` 到
 * `$HOME/.dsh/settings.yaml` 後跑 dsh；provider 層失敗沿 chain fallback。
 *
 * 與 factory-issue-check 共用同一解析核心（src/model-tier/resolve.ts）：
 * 檢查留言的建議與實際路由永遠一致。
 */
import { readFileSync } from 'node:fs'
import { analyzeComplexity, type ComplexityAnalysis } from '../issue-analysis/complexity.js'
import {
  loadDeclaredProviders,
  loadTiers,
  resolveModelTier,
  MODEL_TIERS,
  type ModelResolution,
  type ModelTier,
} from '../model-tier/resolve.js'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { extractField } from './factory-issue-check.js'

export interface ModelCliPaths {
  issuePath?: string | undefined
  scorePath?: string | undefined
  tiersPath: string
  providersPath: string
  tier: ModelTier | 'auto'
  provider: string
  /**
   * agent-write-spec 的階段（ADR-018）：由 factory-spec-phase 推導後傳入。
   * 不變量階段一律不套用 heavy-verify、模型階段一律套用——計算強度由階段決定，
   * 不由 Issue 文字的關鍵字決定（內文幾乎必然提到 Quint／形式化）。
   */
  specPhase?: 'invariants' | 'model' | undefined
}

const DEFAULT_TIERS_PATH = 'config/dsh/model-tiers.yaml'
const DEFAULT_PROVIDERS_PATH = 'config/dsh/settings.providers.yaml'

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} requires a value`)
  }
  return value
}

export function parseArgs(argv: string[]): ModelCliPaths {
  let issuePath: string | undefined
  let scorePath: string | undefined
  let tiersPath = DEFAULT_TIERS_PATH
  let providersPath = DEFAULT_PROVIDERS_PATH
  let tier: ModelTier | 'auto' = 'auto'
  let provider = 'auto'
  let specPhase: 'invariants' | 'model' | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--issue') {
      issuePath = requireValue(argv, ++i, '--issue')
    } else if (arg === '--score') {
      scorePath = requireValue(argv, ++i, '--score')
    } else if (arg === '--tiers') {
      tiersPath = requireValue(argv, ++i, '--tiers')
    } else if (arg === '--providers') {
      providersPath = requireValue(argv, ++i, '--providers')
    } else if (arg === '--tier') {
      const value = requireValue(argv, ++i, '--tier')
      if (value !== 'auto' && !(MODEL_TIERS as readonly string[]).includes(value)) {
        throw new CliError(`--tier 必須是 auto|${MODEL_TIERS.join('|')}，收到 "${value}"`)
      }
      tier = value as ModelTier | 'auto'
    } else if (arg === '--provider') {
      provider = requireValue(argv, ++i, '--provider')
    } else if (arg === '--spec-phase') {
      const value = requireValue(argv, ++i, '--spec-phase')
      if (value !== 'invariants' && value !== 'model') {
        throw new CliError(`--spec-phase 必須是 invariants|model，收到 "${value}"`)
      }
      specPhase = value
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  return { issuePath, scorePath, tiersPath, providersPath, tier, provider, specPhase }
}

/** 讀 JSON 檔並回傳 parsed 值；檔案缺失/格式錯誤 → CliError（絕不靜默）。 */
function readJsonFile(path: string, label: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new CliError(`${label} (${path}) 無法讀取：${(err as NodeJS.ErrnoException).message}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError(`${label} (${path}) 不是合法 JSON`)
  }
}

export function main(argv: string[]): ModelResolution {
  const paths = parseArgs(argv)
  const declaredProviders = loadDeclaredProviders(paths.providersPath)
  const tiers = loadTiers(paths.tiersPath, declaredProviders)

  let analysis: ComplexityAnalysis | undefined
  if (paths.issuePath !== undefined) {
    const raw = readJsonFile(paths.issuePath, 'issue json')
    const body = (raw as { body?: unknown }).body
    if (typeof body !== 'string') {
      throw new CliError(`issue json (${paths.issuePath}) 缺 body 欄位`)
    }
    analysis = analyzeComplexity({
      taskType: extractField(body, 'task_type'),
      requirement: extractField(body, 'requirement'),
    })
  }
  if (paths.specPhase !== undefined) {
    if (analysis === undefined) throw new CliError('--spec-phase requires --issue')
    analysis = {
      ...analysis,
      computationalIntensity: paths.specPhase === 'model' ? 'heavy-verify' : 'standard',
      evidence: [
        ...analysis.evidence,
        paths.specPhase === 'model'
          ? 'write-spec 模型階段：強制 heavy-verify（ADR-018）'
          : 'write-spec 不變量階段：不套用 heavy-verify（ADR-018）',
      ],
    }
  }

  let catalogComplexity: string | undefined
  let scoreTotal: number | undefined
  if (paths.scorePath !== undefined) {
    const raw = readJsonFile(paths.scorePath, 'score json') as {
      annotations?: { complexity?: unknown }
      score?: { total?: unknown }
    }
    const catalog = raw.annotations?.complexity
    if (typeof catalog === 'string') catalogComplexity = catalog
    const total = raw.score?.total
    if (typeof total === 'number') scoreTotal = total
  }

  return resolveModelTier({
    tiers,
    declaredProviders,
    manualTier: paths.tier === 'auto' ? undefined : paths.tier,
    analysis,
    catalogComplexity,
    scoreTotal,
    preferredProvider: paths.provider === 'auto' ? undefined : paths.provider,
  })
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入，
   由 test/integration/factory-model-cli.test.ts 以實機執行涵蓋 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
