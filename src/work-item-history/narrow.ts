/**
 * 不可信 JSON 的收窄工具（純函式）。
 *
 * 本目錄的兩個模組（task-record、issue-url）都吃 scaffolder API 回傳的
 * JSON，欄位可能缺失或型別不符。收窄一律走這裡，避免各自長出不同寫法。
 */

/**
 * 物件才回傳其本身，null 與其餘原始型別回傳 null。
 *
 * 陣列同樣是物件，會原樣通過：本函式只保證「拿去用 `?.` 取欄位不會爆」，
 * 需要區分陣列的呼叫端自己用 Array.isArray 判斷（issue-url 的 links 即是）。
 */
export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

/** 字串才回傳其本身，其餘一律回傳空字串。 */
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
