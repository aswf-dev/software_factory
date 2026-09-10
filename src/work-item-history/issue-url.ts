/**
 * 從任務產物中取出「本次建立的 GitHub Issue」連結（純函式）。
 *
 * 兩條來源：
 * 1. template 的 output.links（2026-09-10 起的新任務，結構化、穩定）；
 * 2. log 事件字串（更早的任務，唯一留有 URL 的地方）。
 *
 * 兩者皆無時回傳 undefined——呼叫端不顯示連結即可，不得假造。
 *
 * 與 task-record.ts 同一套邊界規則：參數以 unknown 收、逐欄 narrow、絕不丟例外。
 * 詳細理由見該檔頭部；此處只重申結論——links 元素是 null 或 logLines 混入非字串
 * 都只能少一個連結，不得讓詳情頁整頁掛掉。
 */
import { asObject, asString } from './narrow.js'

/**
 * GitHub issue URL 的形狀。刻意不比對 action 的 log 措辭
 * （"Successfully created issue #N:" 是 github:issues:create 的實作細節，
 * 升版即可能改），也不比對 Actions 頁面那類非 issue 連結。
 *
 * 刻意不加 `^`／`$` 錨點：log 行的 URL 前後本來就有時間戳、ANSI 色碼與後綴
 * （`/comments`、`#issuecomment-123`），不錨定才能從中截出正規化的
 * `.../issues/N`——那正是 UI 要的形狀。補上 `$` 會讓 log 比對全面失效。
 */
const ISSUE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/

export function extractIssueUrl(input: {
  output?: unknown
  /**
   * 收 readonly unknown[] 而非 string[]：真實呼叫端把 Backstage 的 stepLogs
   * 攤平後傳進來，且住在 backstage/plugins/** 不受 tsc 檢查，故元素型別毫無保證。
   * 簽章標成 string[] 會讓下面的 asString 看起來像多餘的防禦，實際上它是必要的。
   */
  logLines?: readonly unknown[] | undefined
}): string | undefined {
  const links = asObject(input.output)?.links
  if (Array.isArray(links)) {
    for (const link of links) {
      const url = asString(asObject(link)?.url)
      if (ISSUE_URL.test(url)) return url
    }
  }
  // 掃到底取「最後一個」而不是第一個：順帶提及的 issue URL 只可能出現在前面
  // （需求文字回顯、前置步驟引用既有 issue），本次真正建立的那個由 create 步驟
  // 在接近結尾處印出，其後的步驟不再吐 issue URL。取第一個會連到別人的 issue，
  // 那是安靜的錯答案，比回傳 undefined 更糟。
  let fromLogs: string | undefined
  for (const line of input.logLines ?? []) {
    const matched = ISSUE_URL.exec(asString(line))
    if (matched !== null) fromLogs = matched[0]
  }
  return fromLogs
}
