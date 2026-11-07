/**
 * LLM 草稿 JSON 的健壯解析（純函式）。
 *
 * LLM 輸出不可信：容忍 ```json fence、前後雜訊文字、缺欄位，
 * 只在 requirement 為非空字串時視為成功。
 */
export interface DraftResult {
  // exactOptionalPropertyTypes: 明確允許 undefined 賦值（回傳物件以 undefined 表示缺席）
  title?: string | undefined
  requirement: string
  dod: string[]
  targetRepo?: string | undefined
  notes: string[]
}

export function parseDraftJson(text: string): DraftResult | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (typeof o.requirement !== 'string' || o.requirement.trim().length === 0) return null
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    title: str(o.title),
    requirement: o.requirement.trim(),
    dod: strList(o.dod),
    targetRepo: str(o.targetRepo),
    notes: strList(o.notes),
  }
}

// ---------------------------------------------------------------------------
// PRD 多輪釐清（ADR-031，2026-11-07）
// ---------------------------------------------------------------------------

/** 一題：頁面畫成一張卡。`recommended` 一定是 `options` 之一（不是就丟掉）。 */
export interface PrdQuestion {
  id: string
  text: string
  options: string[]
  recommended: string | null
}

export interface PrdClarifyResult {
  questions: PrdQuestion[]
  /** LLM 認為資訊已足夠寫 PRD。 */
  done: boolean
}

const PRD_QUESTION_LIMIT = 4
const PRD_OPTION_LIMIT = 6

/**
 * 解析 PRD 釐清的 JSON（LLM 輸出不可信）。
 *
 * - 容忍 fence、前後雜訊；
 * - 每題要有非空 `text`；`id` 缺或重複就補成 `q<n>`；選項只留非空字串（最多 6 個）；
 * - 最多 4 題；`done:false` 卻沒有任何有效題目 → 回 null（呼叫端重試或退回純文字）。
 */
export function parsePrdClarifyJson(text: string): PrdClarifyResult | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const done = o.done === true
  const rawQuestions = Array.isArray(o.questions) ? o.questions : []
  const seen = new Set<string>()
  const questions: PrdQuestion[] = []
  for (const raw of rawQuestions) {
    if (questions.length >= PRD_QUESTION_LIMIT) break
    if (typeof raw !== 'object' || raw === null) continue
    const q = raw as Record<string, unknown>
    const questionText = typeof q.text === 'string' ? q.text.trim() : ''
    if (questionText === '') continue
    let id = typeof q.id === 'string' ? q.id.trim() : ''
    if (id === '' || seen.has(id)) id = `q${questions.length + 1}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    const options = Array.isArray(q.options)
      ? q.options
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter((x) => x !== '')
          .slice(0, PRD_OPTION_LIMIT)
      : []
    const recommended = typeof q.recommended === 'string' && options.includes(q.recommended.trim()) ? q.recommended.trim() : null
    questions.push({ id, text: questionText, options, recommended })
  }
  if (!done && questions.length === 0) return null
  return { questions: done ? [] : questions, done }
}

/** PRD 草稿缺了哪些必要段落（頁面提示用；不擋確認——人有最後決定權）。 */
export function missingPrdSections(markdown: string, sections: readonly string[]): string[] {
  return sections.filter((section) => !markdown.includes(section))
}
