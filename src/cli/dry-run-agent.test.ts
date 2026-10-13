import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRY_RUN_USAGE, dryRunReport, dryRunUsage, main, parseArgs, routedModel } from './dry-run-agent.js'
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

  it('同時寫出固定 usage.json 與 usage.md（無 LLM 也能測 usage 留言接線）', () => {
    main(['success', '104'], tmp)
    const usage = JSON.parse(readFileSync(join(tmp, '.factory/run/usage.json'), 'utf8'))
    expect(usage.source).toBe('dsh-session-log')
    expect(usage.totals.totalTokens).toBeGreaterThan(0)
    const md = readFileSync(join(tmp, '.factory/run/usage.md'), 'utf8')
    expect(md).toContain('Token 用量與成本')
  })
})

// 2026-10-13 沙箱實測（agent-playground/node-redlock#10）：route 寫死 deepseek，
// 兩個變體回報同一模型，比對卡片誤判「fallback 坍縮」，dry-run 無法驗證變體路由。
describe('變體路由：usage 回報 model.json 的 chain[0]', () => {
  const modelJson = (name: string, content: unknown): string => {
    const p = join(tmp, name)
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
    return p
  }

  it('parseArgs 接受選用的 --model-json；缺值或多餘參數報錯', () => {
    expect(parseArgs(['success', '1', '--model-json', 'm.json']).modelJsonPath).toBe('m.json')
    expect(parseArgs(['success', '1']).modelJsonPath).toBeUndefined()
    expect(() => parseArgs(['success', '1', '--model-json'])).toThrow(/--model-json requires a value/)
    expect(() => parseArgs(['success', '1', '--model-json', ''])).toThrow(/--model-json requires a value/)
    expect(() => parseArgs(['success', '1', '--model-json', 'm.json', 'x'])).toThrow(/unexpected argument: x/)
  })

  it('routedModel 取 chain[0]；缺檔、壞 JSON、形狀不對都回 undefined', () => {
    const chain = { chain: [{ provider: 'qwen', model: 'qwen3.8-flash' }, { provider: 'deepseek', model: 'deepseek-flash' }] }
    expect(routedModel(modelJson('ok.json', chain))).toEqual({ provider: 'qwen', model: 'qwen3.8-flash' })
    expect(routedModel(join(tmp, 'missing.json'))).toBeUndefined()
    expect(routedModel(modelJson('bad.json', '{not json'))).toBeUndefined()
    for (const [i, c] of [{}, { chain: 'x' }, { chain: [] }, { chain: [{ provider: 'qwen' }] }, { chain: [{ provider: '', model: 'm' }] }, { chain: [{ provider: 'p', model: 1 }] }].entries()) {
      expect(routedModel(modelJson(`shape-${i}.json`, c)), JSON.stringify(c)).toBeUndefined()
    }
  })

  it('dryRunUsage 換掉 route 的模型，數量不變；沒有 route 時沿用固定值', () => {
    const u = dryRunUsage({ provider: 'qwen', model: 'qwen3.8-flash' })
    expect(u.routes.map((r) => `${r.provider}/${r.model}`)).toEqual(['qwen/qwen3.8-flash'])
    expect(u.totals).toEqual(DRY_RUN_USAGE.totals)
    expect(dryRunUsage(undefined)).toBe(DRY_RUN_USAGE)
  })

  it('main 帶 --model-json 時，usage.json 與 usage.md 都是本變體的模型', () => {
    const p = modelJson('variant-b.json', { chain: [{ provider: 'deepseek', model: 'deepseek-flash' }, { provider: 'qwen', model: 'qwen3.8-flash' }] })
    main(['success', '104', '--model-json', p], tmp)
    const usage = JSON.parse(readFileSync(join(tmp, '.factory/run/usage.json'), 'utf8'))
    expect(usage.routes[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' })
    const pa = modelJson('variant-a.json', { chain: [{ provider: 'qwen', model: 'qwen3.8-flash' }] })
    main(['success', '104', '--model-json', pa], tmp)
    expect(JSON.parse(readFileSync(join(tmp, '.factory/run/usage.json'), 'utf8')).routes[0].model).toBe('qwen3.8-flash')
    expect(readFileSync(join(tmp, '.factory/run/usage.md'), 'utf8')).toContain('qwen3.8-flash')
  })
})
