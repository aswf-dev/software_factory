/**
 * Backstage scaffolder task → 工作項歷史紀錄（純函式）。
 *
 * 資料來源不可信：task 來自 scaffolder API 的 JSON，欄位可能缺失或型別不符。
 *
 * 邊界規則（本檔一律遵守，無例外）：每個 export 出去的函式一律以 `unknown`
 * 收參數、在函式內逐欄 narrow、絕不丟例外——歷史查閱頁寧可少顯示一個欄位，
 * 也不能因一筆壞資料整頁掛掉。呼叫端住在 backstage/plugins/** 底下，不在本
 * repo 的 tsconfig.json 與 vitest.config.ts 範圍內，型別標註在那裡攔不到任何
 * 錯誤，所以型別收窄必須由這裡自己做。
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
 * 以 `spec.templateInfo.entityRef` 認出 factory-work-item 任務。
 *
 * 收的是 task.spec 而不是整個 task，命名刻意與後續的 toWorkItemRecord(task)
 * 區隔：兩者傳錯層級都只會安靜地得到 false，不會丟例外也沒有型別錯誤。
 *
 * 後端 list 端點只支援 createdBy/status 篩選，沒有 template 篩選
 * （DatabaseTaskStore.list 已確認），故過濾必須在前端做。
 *
 * kind 前綴釘死在 `template:`；namespace 則刻意保持萬用，因為 template 可能
 * 註冊在非 default 的 namespace。
 */
export function isFactoryWorkItemSpec(spec: unknown): boolean {
  const ref = asString(asRecord(asRecord(spec)?.templateInfo)?.entityRef)
  if (!ref.startsWith('template:')) return false
  return ref.split('/').pop() === FACTORY_WORK_ITEM_TEMPLATE
}

/**
 * RepoUrlPicker 的 `github.com?owner=X&repo=Y` → `X/Y`；只有其中一個參數時
 * 回傳該參數；找不到 owner 與 repo 參數時原樣返回。
 *
 * 注意兩個 regex 都沒有錨定在 query string 上，故 `philipz/repo&owner=evil`
 * 會取出 `evil`。實務上無害（repo 名稱不含 `&`），但別把它當成「其餘格式一律
 * 原樣返回」。
 */
export function normalizeRepo(raw: unknown): string {
  const value = asString(raw)
  if (value.length === 0) return ''
  const owner = /[?&]owner=([^&]+)/.exec(value)?.[1]
  const repo = /[?&]repo=([^&]+)/.exec(value)?.[1]
  if (repo === undefined) return owner === undefined ? value : decodeSegment(owner)
  const decodedRepo = decodeSegment(repo)
  return owner === undefined ? decodedRepo : `${decodeSegment(owner)}/${decodedRepo}`
}
