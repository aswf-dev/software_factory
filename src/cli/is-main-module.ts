/**
 * 判斷「這個模組是否以執行檔身分被啟動」——所有 factory CLI 共用。
 *
 * 用 realpath 比對而非 `pathToFileURL(process.argv[1])`：後者不解析 symlink，
 * 透過 symlink 執行時條件不成立，CLI 會「無輸出且 exit 0」—— 對 CI 而言是
 * 最危險的失敗模式（gate 被當成通過）。
 *
 * ⚠️ `import.meta.filename` 必須由**呼叫端（entry 模組自身）**傳入：它指向
 * 「目前所在的模組」——若在本 helper 內讀取，會指到 is-main-module.js 自己，
 * 比較將永遠失敗（這正是本函式要防的 silent-fail）。
 *
 * 刻意不使用預設參數（`entry = process.argv[1]`）：若呼叫端傳入 undefined，
 * 會落回預設值，使「undefined 分支」永遠測不到，測試將假綠。
 *
 * @param entry 進入點路徑（呼叫端傳入 `process.argv[1]`）。
 * @param selfPath 目前模組的絕對路徑（呼叫端傳入 `import.meta.filename`）。
 */
import { realpathSync } from 'node:fs'

export function isMainModule(entry: string | undefined, selfPath: string | undefined): boolean {
  if (entry === undefined || selfPath === undefined) return false
  try {
    return selfPath === realpathSync(entry)
  } catch {
    return false
  }
}
