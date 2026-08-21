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
