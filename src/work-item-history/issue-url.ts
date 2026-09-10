/**
 * 從任務產物中取出「本次建立的 GitHub Issue」連結（純函式）。
 *
 * 兩條來源：
 * 1. template 的 output.links（2026-09-10 起的新任務，結構化、穩定）；
 * 2. log 事件字串（更早的任務，唯一留有 URL 的地方）。
 *
 * 兩者皆無時回傳 undefined——呼叫端不顯示連結即可，不得假造。
 */
import { asRecord, asString } from './narrow.js'

/**
 * GitHub issue URL 的形狀。刻意不比對 action 的 log 措辭
 * （"Successfully created issue #N:" 是 github:issues:create 的實作細節，
 * 升版即可能改），也不比對 Actions 頁面那類非 issue 連結。
 */
const ISSUE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/

export function extractIssueUrl(input: {
  output?: unknown
  logLines?: readonly string[] | undefined
}): string | undefined {
  const links = asRecord(input.output)?.links
  if (Array.isArray(links)) {
    for (const link of links) {
      const url = asString(asRecord(link)?.url)
      if (ISSUE_URL.test(url)) return url
    }
  }
  for (const line of input.logLines ?? []) {
    const matched = ISSUE_URL.exec(asString(line))
    if (matched !== null) return matched[0]
  }
  return undefined
}
