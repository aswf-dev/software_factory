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

  it('沒有 output.links 時退回解析 log（容忍 ANSI 色碼）', () => {
    expect(
      extractIssueUrl({
        output: undefined,
        logLines: [`2026-09-10 \u001b[32minfo\u001b[39m: Successfully created issue #28: ${ISSUE}`],
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
