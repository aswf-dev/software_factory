import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildReport, main, parseArgs } from './write-report.js'
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
    })
  })

  it('檔案路徑可省略（預設空字串）', () => {
    expect(parseArgs(['7', '0'])).toEqual({
      issueNumber: 7,
      exitCode: 0,
      stdoutFile: '',
      stderrFile: '',
      timedOut: false,
    })
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
