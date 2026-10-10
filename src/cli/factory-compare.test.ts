import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  buildVariantData,
  main,
  parseArgs,
  renderCompareMarkdown,
  type CompareSummary,
} from './factory-compare.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'factory-compare-test-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeJson(filename: string, data: unknown): string {
  const p = join(tmpDir, filename)
  writeFileSync(p, JSON.stringify(data), 'utf8')
  return p
}

describe('parseArgs', () => {
  it('正確解析必填與選填參數', () => {
    const args = parseArgs([
      '--issue-number',
      '42',
      '--branch-a',
      'factory/42-a-01-test',
      '--branch-b',
      'factory/42-b-01-test',
      '--provider-a',
      'qwen',
      '--model-a',
      'qwen3.8-flash',
      '--provider-b',
      'anthropic',
      '--model-b',
      'claude-sonnet-5-5',
      '--format',
      'markdown',
    ])
    expect(args.issueNumber).toBe(42)
    expect(args.branchA).toBe('factory/42-a-01-test')
    expect(args.branchB).toBe('factory/42-b-01-test')
    expect(args.providerA).toBe('qwen')
    expect(args.modelA).toBe('qwen3.8-flash')
    expect(args.providerB).toBe('anthropic')
    expect(args.modelB).toBe('claude-sonnet-5-5')
    expect(args.format).toBe('markdown')
  })

  it('缺少 --issue-number 拋出 CliError', () => {
    expect(() => parseArgs([])).toThrow(/缺少必填參數 --issue-number/)
  })

  it('非法 --issue-number 拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number', 'invalid'])).toThrow(/--issue-number 必須為正整數/)
    expect(() => parseArgs(['--issue-number', '-5'])).toThrow(/--issue-number 必須為正整數/)
  })

  it('非法 --format 拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number', '42', '--format', 'yaml'])).toThrow(/--format 必須是 markdown\|json/)
  })

  it('未知參數拋出 CliError', () => {
    expect(() => parseArgs(['--issue-number', '42', '--unknown'])).toThrow(/unknown argument/)
  })
})

describe('buildVariantData & renderCompareMarkdown', () => {
  it('從 report/judge/usage 檔案載入變體資料並生成 Markdown 比對表', () => {
    const reportPath = writeJson('report-a.json', {
      invocation: { provider: 'qwen' },
      tokensUsed: 120000,
    })
    const judgePath = writeJson('judge-a.json', {
      result: { outcome: 'ready-to-automerge', score: 6 },
    })
    const usagePath = writeJson('usage-a.json', {
      totals: { totalTokens: 120000, costUsd: 0.045 },
      routes: [{ provider: 'qwen', model: 'qwen3.8-flash' }],
    })

    const variantA = buildVariantData({
      variant: 'a',
      reportPath,
      judgePath,
      usagePath,
      branch: 'factory/42-a-01-test',
      prUrl: 'https://github.com/aswf-dev/software_factory/pull/101',
    })

    expect(variantA.provider).toBe('qwen')
    expect(variantA.model).toBe('qwen3.8-flash')
    expect(variantA.outcome).toBe('ready-to-automerge')
    expect(variantA.costUsd).toBe(0.045)
    expect(variantA.tokensUsed).toBe(120000)
    expect(variantA.score).toBe(6)

    const variantB = buildVariantData({
      variant: 'b',
      branch: 'factory/42-b-01-test',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    })

    const summary: CompareSummary = {
      issueNumber: 42,
      variantA,
      variantB,
    }

    const md = renderCompareMarkdown(summary)
    expect(md).toContain('## ⚔️ 雙模型競賽比對報告 (Issue #42)')
    expect(md).toContain('`qwen/qwen3.8-flash`')
    expect(md).toContain('`anthropic/claude-sonnet-5-5`')
    expect(md).toContain('[factory/42-a-01-test](https://github.com/aswf-dev/software_factory/pull/101)')
    expect(md).toContain('$0.0450')
  })
})

describe('main', () => {
  it('main 生成 markdown 輸出並可寫入 --out 檔案', () => {
    const outPath = join(tmpDir, 'compare.md')
    const res = main([
      '--issue-number',
      '42',
      '--provider-a',
      'qwen',
      '--model-a',
      'qwen3.8-flash',
      '--provider-b',
      'anthropic',
      '--model-b',
      'claude-sonnet-5-5',
      '--out',
      outPath,
    ])

    expect(typeof res).toBe('string')
    expect(res).toContain('Issue #42')
    expect(res).toContain('qwen3.8-flash')
    expect(res).toContain('claude-sonnet-5-5')
  })

  it('main --format json 輸出結構化資料', () => {
    const res = main([
      '--issue-number',
      '42',
      '--format',
      'json',
      '--provider-a',
      'qwen',
      '--model-a',
      'qwen3.8-flash',
    ])

    expect(typeof res).toBe('object')
    if (typeof res === 'object') {
      expect(res.issueNumber).toBe(42)
      expect(res.variantA.provider).toBe('qwen')
      expect(res.variantA.model).toBe('qwen3.8-flash')
    }
  })
})
