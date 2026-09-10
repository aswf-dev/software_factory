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
import { asObject, asString } from './narrow.js'

/** template 名稱（entityRef 的最後一段），與 backstage/templates/factory-work-item/ 對齊。 */
export const FACTORY_WORK_ITEM_TEMPLATE = 'factory-work-item'

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
  const ref = asString(asObject(asObject(spec)?.templateInfo)?.entityRef)
  if (!ref.startsWith('template:')) return false
  return ref.split('/').pop() === FACTORY_WORK_ITEM_TEMPLATE
}

/**
 * RepoUrlPicker 的 `github.com?owner=X&repo=Y` → `X/Y`；只有其中一個參數時
 * 回傳該參數；找不到 owner 與 repo 參數時原樣返回。
 *
 * 例外：repo 解碼後若自帶斜線（`repo=philipz%2Fdocker_practice`——使用者把整串
 * `owner/repo` 填進 repo 欄），它本身就已經是完整路徑，再補 owner 會產出
 * `philipz/philipz/docker_practice`。實測 scaffolder DB 38 筆 factory-work-item
 * 中有 3 筆是這種值，故直接返回解碼結果。
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
  if (decodedRepo.includes('/')) return decodedRepo
  return owner === undefined ? decodedRepo : `${decodeSegment(owner)}/${decodedRepo}`
}

/** 歷史清單與詳情頁共用的一筆紀錄。所有欄位皆為字串，缺值以空字串表示。 */
export interface WorkItemRecord {
  taskId: string
  createdAt: string
  createdBy: string
  status: string
  oneLiner: string
  taskType: string
  targetRepo: string
  baseBranch: string
  requirement: string
}

/**
 * scaffolder task → WorkItemRecord。
 *
 * 個別欄位缺失一律補空字串；僅當連 id 都取不到（結構完全不可用）時回傳 null。
 * createdBy 優先取 task.createdBy，缺失時才退回 spec.user.ref。順序不可對調：
 * task.createdBy 是 scaffolder 自己的 created_by 欄位，spec.user.ref 只是送出
 * 當下凍進 spec JSON 的副本。兩者在實測資料中同值，但副本會過時。內建
 * ListTasksPage 讀的是後者。
 */
export function toWorkItemRecord(task: unknown): WorkItemRecord | null {
  const t = asObject(task)
  const taskId = asString(t?.id)
  if (taskId.length === 0) return null
  const spec = asObject(t?.spec)
  const parameters = asObject(spec?.parameters)
  const createdBy = asString(t?.createdBy) || asString(asObject(spec?.user)?.ref)
  return {
    taskId,
    createdAt: asString(t?.createdAt),
    createdBy,
    status: asString(t?.status),
    oneLiner: asString(parameters?.oneLiner),
    taskType: asString(parameters?.taskType),
    targetRepo: normalizeRepo(parameters?.targetRepo),
    baseBranch: asString(parameters?.baseBranch),
    requirement: asString(parameters?.requirement),
  }
}

/**
 * listTasks 的整包結果（`{ tasks: [...] }`）或裸陣列 → 可直接渲染的清單。
 * 兩種形狀都收，其餘一律回空陣列。
 *
 * 拆封 + 篩選 + 轉換 + 丟棄壞資料四步都在這裡完成，元件只拿結果。理由：元件住在
 * backstage/plugins/**，不在 tsconfig 與 vitest 範圍內——留在那裡的邏輯
 * 沒有任何自動化防護。`value?.tasks ?? []` 寫在元件裡也是邏輯，回應形狀一改，
 * 頁面會安靜地顯示「沒有工作項」而不是報錯，那是歷史頁最難察覺的壞法。
 */
export function toWorkItemRecords(input: unknown): WorkItemRecord[] {
  const tasks = Array.isArray(input) ? input : asObject(input)?.tasks
  if (!Array.isArray(tasks)) return []
  const records: WorkItemRecord[] = []
  for (const task of tasks) {
    if (!isFactoryWorkItemSpec(asObject(task)?.spec)) continue
    const record = toWorkItemRecord(task)
    if (record !== null) records.push(record)
  }
  return records
}

/** 只有這個形狀才交給 new Date：四位年-月-日後面必須接 `T`。 */
const ISO_DATE_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/

/**
 * ISO 時間 → 本地字串；空字串、只有空白或非字串顯示破折號，無法解析者原樣返回
 * （不假造時間）。
 *
 * 先擋形狀再解析：new Date 對非 ISO 字串過度寬容，`'12345'` 會變成西元 12345 年，
 * 純日期 `'2026-09-10'` 按 UTC 午夜解析、在 UTC 以西顯示成前一天，
 * `'2026-09-10 08:47:18'`（SQLite 原生 datetime 格式）則被當成本地時間靜靜位移。
 * 這三種都不該冒充成一個看起來很像真的時間。
 */
export function formatTimestamp(iso: unknown): string {
  const value = asString(iso)
  if (value.trim().length === 0) return '—'
  if (!ISO_DATE_TIME_PREFIX.test(value)) return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/** maxChars 不可用時的字元上限，約為清單欄位放得下的量。 */
const DEFAULT_SUMMARY_MAX_CHARS = 120

/**
 * 清單用的摘要：壓平空白後截斷。詳情頁一律顯示原文，不經過本函式。
 *
 * maxChars 同樣以 unknown 收：呼叫端不受 tsc 檢查，只接受有限的正數（取整），
 * 其餘（NaN、undefined、0、負數）一律退回預設上限——NaN 會讓所有比較為 false
 * 而 slice 切出空字串，整段內容只剩一個省略號，且沒有任何測試會攔到。
 *
 * 以字元（code point）而非 UTF-16 code unit 切：切在代理對中間會產生落單的
 * surrogate，渲染成 �。ZWJ 序列與組合字仍可能被拆開，那降級成可讀字元，可接受。
 */
export function summarize(text: unknown, maxChars: unknown): string {
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : DEFAULT_SUMMARY_MAX_CHARS
  const flat = asString(text).replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join('')}…`
}
