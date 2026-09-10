/**
 * Backstage scaffolder task → 工作項歷史紀錄（純函式）。
 *
 * 資料來源不可信：task 來自 scaffolder API 的 JSON，欄位可能缺失或型別不符。
 * 所有函式以 unknown 收、逐欄 narrow、絕不丟例外——歷史查閱頁寧可少顯示
 * 一個欄位，也不能因一筆壞資料整頁掛掉。
 *
 * 使用者：backstage/plugins/factory-draft/src/work-item-history/*
 */

/** template 名稱（entityRef 的最後一段），與 backstage/templates/factory-work-item/ 對齊。 */
export const FACTORY_WORK_ITEM_TEMPLATE = 'factory-work-item'

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * decodeURIComponent 遇到畸形百分比編碼（如 `%zz`）會丟 URIError。
 * 依「絕不丟例外」契約，解不開就退回原本的編碼字串——顯示上仍看得出是哪個 repo。
 */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * 以 spec.templateInfo.entityRef 認出 factory-work-item 任務。
 *
 * 後端 list 端點只支援 createdBy/status 篩選，沒有 template 篩選
 * （DatabaseTaskStore.list 已確認），故過濾必須在前端做。
 */
export function isFactoryWorkItemTask(spec: unknown): boolean {
  const ref = asString(asRecord(asRecord(spec)?.templateInfo)?.entityRef)
  if (ref.length === 0) return false
  return ref.split('/').pop() === FACTORY_WORK_ITEM_TEMPLATE
}

/** RepoUrlPicker 的 `github.com?owner=X&repo=Y` → `X/Y`；其餘格式原樣返回。 */
export function normalizeRepo(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  const owner = /[?&]owner=([^&]+)/.exec(raw)?.[1]
  const repo = /[?&]repo=([^&]+)/.exec(raw)?.[1]
  if (owner === undefined) return raw
  const decodedOwner = decodeSegment(owner)
  return repo === undefined ? decodedOwner : `${decodedOwner}/${decodeSegment(repo)}`
}
