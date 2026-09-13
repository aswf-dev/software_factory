import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildReport } from './write-report.js'

let tmp: string
let ws: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'write-report-mutation-'))
})

beforeEach(() => {
  ws = join(tmp, `ws-${Math.random().toString(36).slice(2)}`)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Mutation-strength tests for `buildReport` (src/cli/write-report.ts).
 *
 * 與 src/cli/parse-args-mutation.test.ts、src/scoring/rescore-mutation.test.ts
 * 相同原則：證明套件有「牙齒」而非只是行覆蓋。每段是一次具體的 buildReport
 * 變異，並斷言該變異會破壞的行為。
 *
 * Mutation log（以手改 src/cli/write-report.ts 套用變異後重跑驗證、再還原）：
 *
 *  | ID | Mutation                                                    | Before | After  |
 *  |----|-------------------------------------------------------------|--------|--------|
 *  | M1 | 移除 preserve-if-exists 守衛（agent 已寫也強制覆寫 fallback） | GREEN  | RED    |
 *  | M2 | invocation.timedOut 被硬編成 true（丟失 false 的真實性）      | GREEN  | RED    |
 *  | M3 | 保留既有 report 時改為「合併 fallback 欄位」注入               | GREEN  | RED    |
 *
 * 「Before」= 既有套件（src/cli/write-report.test.ts）單獨執行；
 * 「After」= 加入本檔案後。M1/M2/M3 在既有套件下都是 GREEN（存活變異），
 * 是本檔案新增的價值；詳見下方每段 `survives` 註記。
 *
 * 驗證方式：手改 write-report.ts 套用該變異 → `npx vitest run
 * src/cli/write-report-mutation.test.ts` 變紅 → 還原 → 變綠。
 */

/** 既有套件會填入的「最小 fallback report」長相（僅 exitCode/stdout/stderr/timedOut）。 */
const fallbackShape = (over: Record<string, unknown> = {}) =>
  expect.objectContaining({
    issueNumber: expect.any(Number),
    invocation: expect.objectContaining({
      exitCode: expect.any(Number),
      stdout: expect.any(String),
      stderr: expect.any(String),
      timedOut: expect.any(Boolean),
      // A2：止原因必須具名（34735315950 的 stop_reason 曾是 null）
      stopReason: expect.any(String),
    }),
    ...over,
  })

describe('M1 變異：preserve-if-exists 守衛被移除（agent 已寫也被 fallback 覆寫）', () => {
  /**
   * 既有套件的 preserve 測試（write-report.test.ts 的「agent 已寫 report → 保留
   * 原檔不覆寫」）用的是 issueNumber 恰與輸入相同、且無額外欄位的 `{issueNumber: 7}`
   * 舊 report。若有人直接把 `if (existsSync(target)) return target` 這段守衛刪掉，
   * fallback 會把該 report 覆寫成一樣的 `issueNumber:7` 最小結構——既有套件仍全綠
   * （survives）。下列測試改用一份「比最小 fallback 更豐富」的 agent report
   * （含 fallback 不會有的 `changedLines`/`tooling` 欄位、issueNumber 也與輸入不同），
   * 任何覆寫行為都會破壞它。
   */
  it('agent 已寫較豐富 report → buildReport 逐位元保留，不覆寫成最小 fallback', () => {
    const agentReport = {
      issueNumber: 99,
      changedLines: 40,
      tooling: { stack: 'typescript' },
      invocation: {
        exitCode: 7,
        stdout: 'agent ran',
        stderr: '',
        timedOut: false,
      },
    }
    const target = join(ws, '.factory/run/report.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(agentReport, null, 2))

    const p = buildReport({
      issueNumber: 5,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      cwd: ws,
    })

    // return 的就是原檔路徑，內容需與 agent 所寫完全一致。
    expect(p).toBe(target)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(agentReport)
  })

  it('既有 report 的空位欄位（stdout/stderr 空字串）不得被 fallback 回填', () => {
    // agent report 沒有 fallback 慣用的 `invocation.timedOut`；覆寫會把它補上。
    const agentReport = { issueNumber: 21, stdout: '', stderr: '' }
    const target = join(ws, '.factory/run/report.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(agentReport, null, 2))

    buildReport({
      issueNumber: 21,
      exitCode: 3,
      stdout: '',
      stderr: '',
      timedOut: true,
      cwd: ws,
    })

    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(agentReport)
  })
})

describe('M2 變異：invocation.timedOut 被硬編成 true（false 的真實性遺失）', () => {
  /**
   * 既有套件只測過 timedOut=true 的路徑（write-report.test.ts 的「逾時 → timedOut
   * 為 true」），從未在 fallback 路徑斷言「傳入 false 時必須記錄 false」。若有人把
   * 序列化硬編成 `timedOut: true`，既有套件仍全綠（survives）。下列測試釘住 false。
   */
  it('未逾時（timedOut=false）→ fallback 必須如實記錄 false', () => {
    const p = buildReport({
      issueNumber: 8,
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
      timedOut: false,
      cwd: ws,
    })
    const r = JSON.parse(readFileSync(p, 'utf8')) as { invocation: { timedOut: boolean } }
    expect(r.invocation.timedOut).toBe(false)
  })

  it('fallback 完整結構仍須具備最小欄位形狀（exitCode/stdout/stderr/timedOut/stopReason）', () => {
    const p = buildReport({
      issueNumber: 9,
      exitCode: 124,
      stdout: '',
      stderr: '',
      timedOut: true,
      cwd: ws,
    })
    // 不再覆寫 invocation：讓 fallbackShape 的 objectContaining 生效，新增欄位
    // （A2 stopReason）不會讓這條變成「精確等於」而無聲失準。
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(fallbackShape({ issueNumber: 9 }))
  })
})

describe('M3 變異：保留既有 report 時改為「合併 fallback 欄位」注入', () => {
  /**
   * 另一種 preserve 破壞方式：不整檔覆寫，而是把最小 fallback 的欄位合併進既有
   * agent report（例如補上 `invocation`），使資料混雜。既有套件只斷言
   * `issueNumber` 仍正確，合併後無損、照樣全綠（survives）。下列測試用不含
   * `invocation` 的既有 report，斷言 buildReport 不可注入任何 fallback 欄位。
   */
  it('既有 report 無 invocation → buildReport 不得注入 fallback.invocation', () => {
    const agentReport = { issueNumber: 31, changedLines: 12 }
    const target = join(ws, '.factory/run/report.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(agentReport, null, 2))

    buildReport({
      issueNumber: 31,
      exitCode: 4,
      stdout: 'none',
      stderr: 'none',
      timedOut: false,
      cwd: ws,
    })

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
    // 合併注入變異會把 { invocation: {...}, ... } 塞進來；保留語意下不應出現。
    expect(parsed.invocation).toBeUndefined()
    expect(parsed).toEqual(agentReport)
  })
})
