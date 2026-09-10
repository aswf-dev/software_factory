/**
 * Issue URL 抽取測試。
 *
 * 兩條來源刻意分開測：新任務走 template 的 output.links（結構化），
 * 舊任務只能從 log 字串撈——後者是退化路徑，失效只該少一個連結。
 */
import { describe, expect, it } from 'vitest'
import { extractIssueUrl } from './issue-url.js'

describe('extractIssueUrl', () => {
  const ISSUE = 'https://github.com/philipz/camunda_hazelcast/issues/28'

  it('優先讀 output.links 的結構化 URL', () => {
    expect(
      extractIssueUrl({
        output: { links: [{ title: '已建立的 Issue', url: ISSUE }] },
        logLines: [],
      }),
    ).toBe(ISSUE)
  })

  it('兩邊都有 issue URL 時以 output.links 為準', () => {
    // 上一條的 logLines 是空的，證明不了順序。log 裡出現別的 issue URL 是真實情境
    // （需求文字或 action 訊息可能引用其他 issue），此時結構化來源才是本次建立的那個。
    expect(
      extractIssueUrl({
        output: { links: [{ url: ISSUE }] },
        logLines: ['see also https://github.com/philipz/software_factory/issues/99'],
      }),
    ).toBe(ISSUE)
  })

  it('沒有 output.links 時退回解析 log（容忍緊貼 URL 的 ANSI 色碼）', () => {
    // 色碼刻意緊貼 URL 前後：實務上 log formatter 上色的就是 URL 本身。
    // 若只把色碼擺在行首那種遠處，即使 regex 一碰到跳脫字元就斷掉也照樣會過，
    // 這條測試就名不副實了。尾端的 \u001b[39m 同時釘住 `\d+` 會在跳脫字元處停下、
    // 不會把色碼吞進 issue 編號。
    expect(
      extractIssueUrl({
        output: undefined,
        logLines: [
          `2026-09-10 \u001b[32minfo\u001b[39m: Successfully created issue #28: \u001b[36m${ISSUE}\u001b[39m`,
        ],
      }),
    ).toBe(ISSUE)
  })

  it('log 內有多個 issue URL 時取最後一個，不取第一個', () => {
    // 順帶提及的 issue URL 只可能出現在前面（需求文字回顯、前置步驟引用既有 issue）；
    // 本次真正建立的那個由 github:issues:create 在接近結尾處印出，其後的步驟不再吐 issue URL。
    // 取第一個會讓詳情頁連到別人的 issue——安靜的錯答案，比 undefined 更糟。
    expect(
      extractIssueUrl({
        output: undefined,
        logLines: [
          'context: 參考 https://github.com/philipz/software_factory/issues/99',
          `Successfully created issue #28: ${ISSUE}`,
        ],
      }),
    ).toBe(ISSUE)
  })

  it('logLines 混入非字串元素時跳過，不做字串轉換', () => {
    // 真實呼叫端把 Backstage 的 stepLogs（Record<string, unknown[]>）攤平後傳進來，
    // 且住在 backstage/plugins/** 不受 tsc 檢查，故簽章收 readonly unknown[]——
    // 底下的 asString 不是贅字，是唯一擋得住這種輸入的地方。
    //
    // 最後一個元素刻意放會 toString 成另一個 issue URL 的物件，且排在有效行之後：
    // 配合「取最後一個」規則，把 asString 換成 String()／直接丟給 exec 隱式轉型，
    // 結果就會變成 issues/99。少了它這條會退化成「怎麼改都會過」的空測試。
    expect(
      extractIssueUrl({
        output: undefined,
        logLines: [
          null,
          42,
          `Successfully created issue #28: ${ISSUE}`,
          { toString: () => 'https://github.com/philipz/software_factory/issues/99' },
        ],
      }),
    ).toBe(ISSUE)
  })

  it('output.links 有但非 issue 連結時，仍會退回掃 log', () => {
    expect(
      extractIssueUrl({
        output: { links: [{ url: 'https://github.com/philipz/software_factory/actions' }] },
        logLines: [`Successfully created issue #28: ${ISSUE}`],
      }),
    ).toBe(ISSUE)
  })

  it('只有 Actions 連結、log 也沒有時回傳 undefined', () => {
    expect(
      extractIssueUrl({
        output: { links: [{ url: 'https://github.com/philipz/software_factory/actions' }] },
        logLines: [],
      }),
    ).toBeUndefined()
  })

  it('links 內混入非物件元素時跳過，不丟例外', () => {
    // output 來自 scaffolder API 的 JSON，links 的元素形狀沒有任何保證。
    // 少一個連結可接受，整個詳情頁被一個 null 炸掉不行——`null.url` 會丟 TypeError，
    // 這條釘住「取 url 前必須先收窄」這件事。
    expect(
      extractIssueUrl({
        output: { links: [null, 'nonsense', 42, { url: ISSUE }] },
        logLines: [],
      }),
    ).toBe(ISSUE)
  })

  it('兩邊都沒有時回傳 undefined，不猜測', () => {
    expect(extractIssueUrl({})).toBeUndefined()
    expect(extractIssueUrl({ output: 'nonsense', logLines: ['no url here'] })).toBeUndefined()
  })
})
