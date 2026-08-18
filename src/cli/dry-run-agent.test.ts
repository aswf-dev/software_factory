import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dryRunReport, main, parseArgs } from './dry-run-agent.js'
import { CliError } from './run-cli.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dry-run-agent-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('scenario 與 issueNumber 依序解析', () => {
    expect(parseArgs(['success', '101']).scenario).toBe('success')
    expect(parseArgs(['guardrail', '101']).issueNumber).toBe(101)
  })

  it('缺 issueNumber → 預設 scenario 仍被解析，但 issueNumber 檢查拋錯', () => {
    // argv[0] 缺席時 scenario 落回 'success'，但 issueNumber 必填 → CliError
    expect(() => parseArgs([])).toThrow(CliError)
  })

  it('未知 scenario → CliError', () => {
    expect(() => parseArgs(['bogus', '101'])).toThrow(/unknown scenario/)
  })

  it('非正整數 issueNumber → CliError', () => {
    expect(() => parseArgs(['success', '0'])).toThrow(CliError)
  })

  it('多餘參數 → CliError', () => {
    expect(() => parseArgs(['success', '101', 'extra'])).toThrow(/unexpected argument/)
  })
})

describe('dryRunReport', () => {
  it('success 情境：改動測試檔、斷言淨增、有驗收條件', () => {
    const r = dryRunReport({ scenario: 'success', issueNumber: 101, cwd: tmp })
    expect(r.invocation.exitCode).toBe(0)
    expect(r.changedPaths).toContain('src/util/format.test.ts')
    expect(r.assertionDelta).toBeGreaterThan(0)
    expect(r.hasAcceptanceCriteria).toBe(true)
    expect(r.tokensUsed).toBeGreaterThan(0) // SR7 接線（Q02-5）
  })

  it('guardrail 情境：宣稱改到 .github → SR3 應觸發', () => {
    const r = dryRunReport({ scenario: 'guardrail', issueNumber: 103, cwd: tmp })
    expect(r.changedPaths).toContain('.github/workflows/test.yml')
  })

  it('blocked 情境：in-loop 初始計分（agent 不該執行）', () => {
    const r = dryRunReport({ scenario: 'blocked', issueNumber: 102, cwd: tmp })
    expect(r.scenario).toBe('blocked')
  })
})

describe('main', () => {
  it('在指定 cwd 寫出 .factory/run/report.json 並回傳內容', () => {
    const report = main(['success', '104'], tmp)
    expect(report.issueNumber).toBe(104)
    const onDisk = JSON.parse(readFileSync(join(tmp, '.factory/run/report.json'), 'utf8'))
    expect(onDisk.issueNumber).toBe(104)
  })
})
