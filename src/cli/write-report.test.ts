import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildReport, buildTimeoutSkillGap, deriveStopReason, main, parseArgs } from './write-report.js'
import { ReportSchema } from './factory-judge.js'
import { CliError } from './run-cli.js'

let tmp: string
let ws: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'write-report-'))
})

beforeEach(() => {
  // 每個測試獨立 workspace，避免前一個測試留下的 report 影響 existsSync 分支
  ws = join(tmp, `ws-${Math.random().toString(36).slice(2)}`)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('解析 issueNumber/exitCode/檔案路徑/--timed-out', () => {
    expect(parseArgs(['7', '1', 'out.txt', 'err.txt', '--timed-out'])).toEqual({
      issueNumber: 7,
      exitCode: 1,
      stdoutFile: 'out.txt',
      stderrFile: 'err.txt',
      timedOut: true,
      stopReason: undefined,
      provider: undefined,
      attempts: undefined,
    })
  })

  it('檔案路徑可省略（預設空字串）', () => {
    expect(parseArgs(['7', '0'])).toEqual({
      issueNumber: 7,
      exitCode: 0,
      stdoutFile: '',
      stderrFile: '',
      timedOut: false,
      stopReason: undefined,
      provider: undefined,
      attempts: undefined,
    })
  })

  // A2：逾時必須具名。CI 以 --stop-reason 傳入決定性原因，供 judge/scoreboard 歸因。
  it('解析 --stop-reason/--provider/--attempts（A2 歸因欄位）', () => {
    expect(
      parseArgs([
        '7', '124', 'out.txt', 'err.txt',
        '--timed-out', '--stop-reason', 'agent-inner-timeout',
        '--provider', 'deepseek', '--attempts', '2',
      ]),
    ).toEqual({
      issueNumber: 7,
      exitCode: 124,
      stdoutFile: 'out.txt',
      stderrFile: 'err.txt',
      timedOut: true,
      stopReason: 'agent-inner-timeout',
      provider: 'deepseek',
      attempts: 2,
    })
  })

  it('--stop-reason 非法值 → CliError（封閉集合，fail-loud）', () => {
    expect(() => parseArgs(['7', '1', '', '', '--stop-reason', 'agent-gave-up'])).toThrow(/stop-reason/)
  })

  it('--stop-reason 缺值 → CliError（不靜默吞掉）', () => {
    expect(() => parseArgs(['7', '1', '', '', '--stop-reason'])).toThrow(/requires a value/)
  })

  it('--attempts 非負整數驗證', () => {
    expect(() => parseArgs(['7', '1', '', '', '--attempts', '-1'])).toThrow(/attempts/)
    expect(() => parseArgs(['7', '1', '', '', '--attempts', 'x'])).toThrow(/attempts/)
  })

  it('未知旗標 → CliError', () => {
    expect(() => parseArgs(['7', '1', '', '', '--nope'])).toThrow(/unknown argument/)
  })

  it('非整數 issueNumber → CliError', () => {
    expect(() => parseArgs(['abc', '0'])).toThrow(CliError)
  })

  it('完全缺參數 → CliError 且訊息標示 missing（?? fallback 分支）', () => {
    expect(() => parseArgs([])).toThrow(/missing/)
  })

  it('缺 exitCode → CliError 且訊息標示 missing（?? fallback 分支）', () => {
    expect(() => parseArgs(['1'])).toThrow(/missing/)
  })

  it('issueNumber ≤ 0 → CliError', () => {
    expect(() => parseArgs(['0', '1'])).toThrow(CliError)
  })

  it('非整數 exitCode → CliError', () => {
    expect(() => parseArgs(['1', 'abc'])).toThrow(CliError)
  })

  it('負數 exitCode → CliError', () => {
    expect(() => parseArgs(['1', '-1'])).toThrow(CliError)
  })

  it('多餘參數 → CliError', () => {
    expect(() => parseArgs(['1', '0', '', '', '', 'extra'])).toThrow(/unexpected argument/)
  })
})

describe('buildReport', () => {
  it('agent 已寫 report → 保留原檔不覆寫', () => {
    const target = join(ws, '.factory/run/report.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ issueNumber: 7 }))
    const p = buildReport({ issueNumber: 7, exitCode: 0, stderr: '', stdout: '', timedOut: false, cwd: ws })
    expect(p).toBe(target)
    expect(JSON.parse(readFileSync(p, 'utf8')).issueNumber).toBe(7)
  })

  it('agent 未寫 → 以 exit code/stderr 補最小 report（失敗路徑可走 judge）', () => {
    const p = buildReport({ issueNumber: 8, exitCode: 1, stderr: 'boom', stdout: '', timedOut: false, cwd: ws })
    const r = JSON.parse(readFileSync(p, 'utf8')) as { invocation: { exitCode: number; stderr: string } }
    expect(r.invocation.exitCode).toBe(1)
    expect(r.invocation.stderr).toBe('boom')
  })

  it('逾時 → invocation.timedOut 為 true', () => {
    const p = buildReport({ issueNumber: 9, exitCode: 124, stderr: '', stdout: '', timedOut: true, cwd: ws })
    const r = JSON.parse(readFileSync(p, 'utf8')) as { invocation: { timedOut: boolean } }
    expect(r.invocation.timedOut).toBe(true)
  })

  // A2：34735315950 的 report 只有 timedOut=true，stop_reason 在上游為 null，
  // 導致 50 分鐘的失敗在資料層沒有名字。以下三條釘住「失敗必須具名」。
  it('逾時且未顯式指定 → stopReason 推導為 agent-step-timeout', () => {
    const p = buildReport({ issueNumber: 9, exitCode: 124, stderr: '', stdout: '', timedOut: true, cwd: ws })
    const r = JSON.parse(readFileSync(p, 'utf8')) as { invocation: { stopReason: string } }
    expect(r.invocation.stopReason).toBe('agent-step-timeout')
  })

  it('顯式 stopReason/provider/attempts → 寫入 invocation（CI 歸因欄位）', () => {
    const p = buildReport({
      issueNumber: 9,
      exitCode: 124,
      stderr: '',
      stdout: '',
      timedOut: true,
      stopReason: 'agent-inner-timeout',
      provider: 'anthropic',
      attempts: 3,
      cwd: ws,
    })
    const r = JSON.parse(readFileSync(p, 'utf8')) as {
      invocation: { stopReason: string; provider: string; attempts: number }
    }
    expect(r.invocation.stopReason).toBe('agent-inner-timeout')
    expect(r.invocation.provider).toBe('anthropic')
    expect(r.invocation.attempts).toBe(3)
  })

  it('provider/attempts 未指定 → 欄位缺席（不塞 undefined 進 JSON）', () => {
    const p = buildReport({ issueNumber: 9, exitCode: 1, stderr: '', stdout: '', timedOut: false, cwd: ws })
    const r = JSON.parse(readFileSync(p, 'utf8')) as { invocation: Record<string, unknown> }
    expect('provider' in r.invocation).toBe(false)
    expect('attempts' in r.invocation).toBe(false)
    expect(r.invocation.stopReason).toBe('agent-error')
  })

  it('exit 0 但 agent 未寫 report → stopReason 為 agent-exit-zero（異常需人看）', () => {
    const p = buildReport({ issueNumber: 9, exitCode: 0, stderr: '', stdout: '', timedOut: false, cwd: ws })
    const r = JSON.parse(readFileSync(p, 'utf8')) as { invocation: { stopReason: string } }
    expect(r.invocation.stopReason).toBe('agent-exit-zero')
  })
})

describe('deriveStopReason', () => {
  it('逾時優先於 exit code', () => {
    expect(deriveStopReason({ exitCode: 0, timedOut: true })).toBe('agent-step-timeout')
    expect(deriveStopReason({ exitCode: 124, timedOut: true })).toBe('agent-step-timeout')
  })
  it('非零 exit code → agent-error；零 → agent-exit-zero', () => {
    expect(deriveStopReason({ exitCode: 1, timedOut: false })).toBe('agent-error')
    expect(deriveStopReason({ exitCode: 0, timedOut: false })).toBe('agent-exit-zero')
  })
})

describe('main', () => {
  it('回傳產生的 report 路徑', () => {
    const out = main(['10', '1', '', ''], ws)
    expect(out.reportPath).toBe(join(ws, '.factory/run/report.json'))
    expect(JSON.parse(readFileSync(out.reportPath, 'utf8')).issueNumber).toBe(10)
  })

  it('stdout/stderr 檔案存在時讀入 report', () => {
    const outFile = join(tmp, 'out.txt')
    const errFile = join(tmp, 'err.txt')
    writeFileSync(outFile, 'agent output')
    writeFileSync(errFile, 'boom')
    const out = main(['11', '1', outFile, errFile], ws)
    const r = JSON.parse(readFileSync(out.reportPath, 'utf8')) as { invocation: { stdout: string; stderr: string } }
    expect(r.invocation.stdout).toBe('agent output')
    expect(r.invocation.stderr).toBe('boom')
  })

  it('stdout 檔案不存在 → 讀為空字串', () => {
    const out = main(['12', '0', join(tmp, 'nope.txt'), ''], ws)
    const r = JSON.parse(readFileSync(out.reportPath, 'utf8')) as { invocation: { stdout: string } }
    expect(r.invocation.stdout).toBe('')
  })
})

/**
 * 逾時 run 的技能缺口登記（docs/25 §2.1）。
 *
 * 結構性盲點：skillGap 只能由 agent 寫進 report.json，而逾時的 agent 來不及寫；
 * fallback report 先前又沒有這個欄位 → 逾時 run 在結構上不可能回報缺口，
 * 偏偏逾時正是最可能藏著缺口的情境（實證 run 34735315950：50 分鐘、$0.306 全損，
 * stdout 裡有成品級的 Apalache 調優發現，隨逾時一起丟失）。
 */
describe('逾時 → CI 登記 agent-timeout 缺口', () => {
  const load = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, '.factory/run/report.json'), 'utf8')) as Record<string, unknown>

  it('step 級逾時 → 寫入 skillGap，category 為 agent-timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-timeout-'))
    buildReport({
      issueNumber: 7,
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: true,
      cwd: dir,
    })
    const gap = load(dir)['skillGap'] as Record<string, string>
    expect(gap.category).toBe('agent-timeout')
    expect(gap.needed).not.toBe('')
    expect(gap.context).toContain('agent-step-timeout')
    rmSync(dir, { recursive: true, force: true })
  })

  it('內層逾時（provider 可歸因）→ context 帶 provider 與 attempts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-inner-'))
    buildReport({
      issueNumber: 7,
      exitCode: 124,
      stdout: '',
      stderr: '',
      timedOut: false,
      stopReason: 'agent-inner-timeout',
      provider: 'deepseek',
      attempts: 2,
      cwd: dir,
    })
    const gap = load(dir)['skillGap'] as Record<string, string>
    expect(gap.category).toBe('agent-timeout')
    expect(gap.context).toContain('provider=deepseek')
    expect(gap.context).toContain('attempts=2')
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 非逾時的失敗**不得**登記缺口：那會把每一次 agent-error 都變成一筆假缺口，
   * 污染 docs/25 §3 的「同 category ≥3 次」門檻。
   */
  it('非逾時失敗 → 不寫 skillGap 欄位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-err-'))
    buildReport({ issueNumber: 7, exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, cwd: dir })
    expect('skillGap' in load(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('成功但未寫 report（agent-exit-zero）→ 不寫 skillGap 欄位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-zero-'))
    buildReport({ issueNumber: 7, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cwd: dir })
    expect('skillGap' in load(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 契約：登記的缺口必須通過 factory-judge 的 SkillGapSchema（kebab-case category、
   * needed 非空）。否則 judge 會 fail-loud，逾時 run 反而變成「連 judge 都跑不完」。
   */
  it('登記的缺口可通過 ReportSchema（不得讓 judge 因自己寫的欄位炸掉）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-schema-'))
    buildReport({ issueNumber: 7, exitCode: 1, stdout: '', stderr: '', timedOut: true, cwd: dir })
    const parsed = ReportSchema.safeParse(load(dir))
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(parsed.data?.skillGap?.category).toBe('agent-timeout')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('buildTimeoutSkillGap（逾時判定的封閉集合）', () => {
  it('兩種逾時 → 皆登記', () => {
    for (const r of ['agent-step-timeout', 'agent-inner-timeout'] as const) {
      expect(buildTimeoutSkillGap({ stopReason: r })?.category, r).toBe('agent-timeout')
    }
  })

  it('非逾時的三種 stopReason → 皆不登記', () => {
    for (const r of ['provider-error', 'agent-error', 'agent-exit-zero'] as const) {
      expect(buildTimeoutSkillGap({ stopReason: r }), r).toBeUndefined()
    }
  })

  it('無 provider／attempts → context 仍可讀（只列 stopReason）', () => {
    const gap = buildTimeoutSkillGap({ stopReason: 'agent-step-timeout' })
    expect(gap?.context).toContain('stopReason=agent-step-timeout')
    expect(gap?.context).not.toContain('provider=')
    expect(gap?.context).not.toContain('attempts=')
  })
})
