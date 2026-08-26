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

export interface ComplexityAnalysis {
  /** 判定的複雜度等級（與 src/scoring/types.ts 的 Complexity 同源）。 */
  complexity: Complexity
  /** 0=low、1=medium、2=high（≥2 一律 high）。 */
  score: number
  /** 給人看的判據清單——每條都要能回溯到需求文字。 */
  evidence: string[]
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

  const lowHits = LOW_SCOPE_KEYWORDS.filter((k) => requirement.includes(k))
  if (lowHits.length > 0 && score === 0) {
    evidence.push(`scope 低：${lowHits.join('、')}`)
  }

  if (evidence.length === 0) {
    evidence.push('未偵測到明顯 scope/風險訊號 → 預設 low')
  }

  const complexity: Complexity = score >= 2 ? 'high' : score === 1 ? 'medium' : 'low'
  return { complexity, score, evidence }
}
