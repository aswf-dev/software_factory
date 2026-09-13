/**
 * Issue 需求複雜度分析（零 LLM 成本，docs/06 §3.3 判準的機械化）。
 *
 * 背景（Q06-2 / ADR-011）：複雜度軸向來是「最難自動判定」的軸，docs/06 §3.3
 * 只給人類判準（低=單一檔案/模組；中=跨數模組；高=跨服務/新架構模式/共用抽象）。
 * 本模組把這些判準變成決定性的關鍵字/計數規則，供兩處使用：
 *
 *   1. `factory-issue-check`：Issue 開立時留言回報複雜度分析＋建議模型（零成本、給人看）；
 *   2. `factory-model`：factory-run 依同一分析決定實際使用的模型 tier（單一 code path，
 *      檢查與執行永不打架）。
 *
 * 誠實揭露（ADR-011 §5）：啟發式是粗略近似，不是對需求的語意理解。誤判由兩層緩解：
 * 留言展示判據給人看（dispatch 前可發現），且 `model_tier` input 可手動覆寫。
 * LLM 分析列為日後選項（需 key＋成本，不符本 gate 的零成本設計）。
 */

import type { Complexity } from '../scoring/types.js'

/**
 * 任務的**計算強度**（與複雜度正交的第二個軸，B5 修正）。
 *
 * 背景（34735315950 事故）：複雜度軸量的是「變更廣度/風險」，但模型選擇還受
 * 「任務是否把 CPU-bound 工作迴圈塞進 run」支配。模型檢查（`quint verify` /
 * Apalache / TLC / Z3）每跑一次要好幾分鐘且只能序列嘗試，agent 必須在
 * 「寫模型 → 量牆鐘 → 重寫」之間反覆迭代；這種任務的瓶頸是**牆鐘與迭代次數**，
 * 不是推理品質。
 *
 * 實證：run 34735315950（Issue #7，as-is Quint 規格 + 反例存證）複雜度判據
 * 僅「目標檔案提及 13 處」→ high → `deepseek-flash`。Agent 在 50 分鐘內重寫
 * 模型 4 版、起停 10+ 個 Apalache job，最後卡在 state 8/12 被 step timeout
 * 砍掉，交付為零（0 commit、0 PR）。強模型不會讓 Apalache 變快，但能更早做出
 * 「降界並記錄」的取捨；關鍵是這裡必須**給足時間**（見 factory-run 的
 * agent_timeout_minutes 依此軸自動放寬）。
 */
export type ComputationalIntensity = 'standard' | 'heavy-verify'

/** 一旦出現即代表任務含模型檢查/求解器迭代（單獨命中就成立）。 */
export const HEAVY_COMPUTE_TOOL_KEYWORDS = [
  'quint',
  'apalache',
  'tlc',
  // TLA+ 常見兩種寫法（`TLA+` 為官方拼法）；比對是大小寫敏感的 includes，
  // 故大小寫變體都要列——漏一個就等於該工具完全不被偵測（實測抓到的缺陷）。
  'tla+',
  'TLA+',
  'model checking',
  '模型檢查',
  '形式化',
  'formal verification',
  '形式驗證',
  'itf',
  'z3',
  'Z3',
  'alloy',
] as const

/** 泛用詞：只有在同一需求文字中同時出現 SHARPENER 才算 heavy-verify（避免誤判一般「驗證」工作）。 */
export const COMPUTE_GENERIC_KEYWORDS = [
  'verify',
  '反例',
  'counterexample',
  '求解',
  'solver',
] as const
export const COMPUTE_SHARPENER_KEYWORDS = [
  'spec',
  '規格',
  'qnt',
  'max-steps',
  '不變式',
  'invariant',
] as const

/**
 * 判定計算強度。
 *
 * 兩段式（刻意保守，誤報會讓每個普通任務都吃 critical tier 的成本）：
 *  1. 工具級關鍵字任一命中 → heavy-verify；
 *  2. 否則泛用詞（verify/反例/…）**且**規格級 sharpener（spec/規格/max-steps/…）
 *     同時命中 → heavy-verify。單獨的「verify」不算——幾乎每個任務都有「驗證方式」。
 */
export function detectComputationalIntensity(text: string): {
  intensity: ComputationalIntensity
  signals: string[]
} {
  const tools = HEAVY_COMPUTE_TOOL_KEYWORDS.filter((k) => text.includes(k))
  if (tools.length > 0) return { intensity: 'heavy-verify', signals: [...tools] }

  const generic = COMPUTE_GENERIC_KEYWORDS.filter((k) => text.includes(k))
  if (generic.length > 0) {
    const sharp = COMPUTE_SHARPENER_KEYWORDS.filter((k) => text.includes(k))
    if (sharp.length > 0) return { intensity: 'heavy-verify', signals: [...generic, ...sharp] }
  }
  return { intensity: 'standard', signals: [] }
}

export interface ComplexityAnalysis {
  /** 判定的複雜度等級（與 src/scoring/types.ts 的 Complexity 同源）。 */
  complexity: Complexity
  /** 0=low、1=medium、2=high（≥2 一律 high）。 */
  score: number
  /** 給人看的判據清單——每條都要能回溯到需求文字。 */
  evidence: string[]
  /**
   * 計算強度（B5）。`heavy-verify` 代表模型應升級 critical tier 並放寬 agent
   * 逾時；缺席視同 `standard`（向後相容：既有呼叫端與測試不需帶此欄位）。
   */
  computationalIntensity?: ComputationalIntensity | undefined
}

/** 分析輸入：檢查器已抽好的表單欄位（本模組不自行解析 body，避免循環依賴）。 */
export interface ComplexityInput {
  taskType?: string | undefined
  requirement?: string | undefined
}

/** 低 scope 關鍵字（docs/06 §3.3：單一檔案或單一模組內）。 */
export const LOW_SCOPE_KEYWORDS = ['單一檔案', '單一模組', '單個檔案', '單個模組', '單檔'] as const

/** 中 scope 關鍵字（docs/06 §3.3：跨數個模組；或新增元件但沿用既有模式）。 */
export const MEDIUM_SCOPE_KEYWORDS = [
  '跨模組',
  '跨數個模組',
  '多個模組',
  '多模組',
  '數個模組',
  '多檔案',
  '數個檔案',
  '新增元件',
  '新元件',
] as const

/** 高 scope 關鍵字（docs/06 §3.3：跨服務/跨系統；或新架構模式；或共用抽象）。 */
export const HIGH_SCOPE_KEYWORDS = [
  '跨服務',
  '跨系統',
  '跨服務/跨系統',
  '架構',
  '新架構',
  '共用抽象',
  '介面變更',
  'API 變更',
  '破壞性變更',
  '遷移',
  'schema',
  '資料庫',
  '微服務',
  '分散式',
] as const

/**
 * 風險關鍵字（對齊 docs/06 §3.2 的 H1–H3 語意：授權/金流/敏感資料）。
 * 出現任一 → 複雜度至少 high（即使 scope 看起來小，也值得用較強模型保險）。
 */
export const RISK_KEYWORDS = [
  '授權',
  '認證',
  '權限',
  '金流',
  '財務',
  '計費',
  '敏感資料',
  'PII',
  '憑證',
  '加密',
] as const

/**
 * f 是否被其他提及涵蓋：s 以 f 結尾，且 f 前一字元為 `.` 或 `/`
 * （service.ts ⊂ src/order/service.ts；test.ts ⊂ order.test.ts）。
 */
function isSubsumed(f: string, others: readonly string[]): boolean {
  return others.some((s) => {
    if (s === f || !s.endsWith(f)) return false
    const before = s[s.length - f.length - 1]
    return before === '.' || before === '/'
  })
}

/** 目標檔案/模組的提及計數：src/…、lib/…、test/… 路徑或已知副檔名。 */
export function countFileMentions(text: string): number {
  const pathRe = /\b(?:src|lib|test|tests|packages|apps|services|components)\/[\w./-]+/g
  const fileRe = /\b[\w-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|md|yml|yaml|json|qnt)\b/g
  const paths = [...new Set([...text.matchAll(pathRe)].map((m) => m[0]))]
  const files = [...new Set([...text.matchAll(fileRe)].map((m) => m[0]))]
  const all = [...paths, ...files]
  const standalone = files.filter((f) => !isSubsumed(f, all))
  return paths.length + standalone.length
}

/**
 * 啟發式複雜度分析。
 *
 * 規則（決定性，逐條進 evidence）：
 *  - scope 關鍵字：高 → score ≥ 2；中 → score ≥ 1（Math.max 語意，累加不互斥）；
 *  - 目標檔案/模組 ≥ 6 → score ≥ 2；≥ 3 → score ≥ 1；
 *  - 風險關鍵字任一 → score ≥ 2；
 *  - 計算強度 heavy-verify（B5）→ score ≥ 2（模型檢查/求解器迭代：等價於 high）；
 *  - score 0 → low、1 → medium、≥2 → high。
 *  - 需求欄位缺失/空白 → fail-safe high（不可知 ⇒ 用最強，與計分 fail-safe 同方向）。
 */
export function analyzeComplexity(input: ComplexityInput): ComplexityAnalysis {
  const requirement = (input.requirement ?? '').trim()
  const evidence: string[] = []

  if (requirement === '') {
    return {
      complexity: 'high',
      score: 2,
      evidence: ['需求欄位缺失 → fail-safe 採最高複雜度'],
      // 強度軸不臆測（無文字可判）；缺欄位時 complexity 已 fail-safe high，
      // 且 resolveModelTier 對 heavy-verify 的 critical 升級不會被觸發——
      // 這是刻意的：沒有證據就不假設任務是 CPU-bound。
      computationalIntensity: 'standard',
    }
  }

  let score = 0

  const highHits = HIGH_SCOPE_KEYWORDS.filter((k) => requirement.includes(k))
  if (highHits.length > 0) {
    score = Math.max(score, 2)
    evidence.push(`scope 高：${highHits.join('、')}`)
  }

  const mediumHits = MEDIUM_SCOPE_KEYWORDS.filter((k) => requirement.includes(k))
  if (mediumHits.length > 0) {
    score = Math.max(score, 1)
    evidence.push(`scope 中：${mediumHits.join('、')}`)
  }

  const files = countFileMentions(requirement)
  if (files >= 6) {
    score = Math.max(score, 2)
    evidence.push(`目標檔案/模組提及 ${files} 處（≥6 → 高）`)
  } else if (files >= 3) {
    score = Math.max(score, 1)
    evidence.push(`目標檔案/模組提及 ${files} 處（≥3 → 中以上）`)
  }

  const riskHits = RISK_KEYWORDS.filter((k) => requirement.includes(k))
  if (riskHits.length > 0) {
    score = Math.max(score, 2)
    evidence.push(`風險關鍵字：${riskHits.join('、')} → 至少 high（H1–H3 語意）`)
  }

  // 計算強度（B5）：模型檢查/求解器迭代任務把 CPU-bound 工作迴圈塞進 run，
  // 瓶頸是牆鐘非推理品質。與風險關鍵字同語意：至少 high（並由 resolveModelTier
  // 進一步強制 critical——heavy-verify 的模型若只是 high tier 仍會挑到 flash）。
  const intensity = detectComputationalIntensity(requirement)
  if (intensity.intensity === 'heavy-verify') {
    score = Math.max(score, 2)
    evidence.push(
      `計算強度 heavy-verify：${intensity.signals.join('、')} → 至少 high（模型檢查/求解器迭代，34735315950 事故）`,
    )
  }

  const lowHits = LOW_SCOPE_KEYWORDS.filter((k) => requirement.includes(k))
  if (lowHits.length > 0 && score === 0) {
    evidence.push(`scope 低：${lowHits.join('、')}`)
  }

  if (evidence.length === 0) {
    evidence.push('未偵測到明顯 scope/風險訊號 → 預設 low')
  }

  const complexity: Complexity = score >= 2 ? 'high' : score === 1 ? 'medium' : 'low'
  return { complexity, score, evidence, computationalIntensity: intensity.intensity }
}
