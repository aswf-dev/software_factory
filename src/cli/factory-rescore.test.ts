import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildRescoreComment,
  computeRescore,
  findLinkedIssue,
  initialTierFromLabels,
  main,
  parsePrInfo,
} from './factory-rescore.js'
import { CliError } from './run-cli.js'

let tmp: string
let catalog: string
let riskPaths: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-rescore-'))
  catalog = join(tmp, 'catalog-info.yaml')
  writeFileSync(
    catalog,
    [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: demo',
      '  annotations:',
      '    factory.io/business-criticality: tactical',
      '    factory.io/risk-profile: low',
      '    factory.io/complexity: low',
      '',
    ].join('\n'),
  )
  riskPaths = join(tmp, 'risk-paths.yml')
  writeFileSync(riskPaths, 'hard_rules:\n  H1: ["src/auth/**"]\n')
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const PR_JSON = JSON.stringify({
  number: 12,
  headRefName: 'factory/12-01-test',
  files: [{ path: 'src/auth/session.ts' }],
  body: 'Closes #12',
})

describe('parsePrInfo', () => {
  it('解析 PR JSON 的 files', () => {
    const pr = parsePrInfo(PR_JSON)
    expect(pr.files).toEqual(['src/auth/session.ts'])
    expect(pr.headRefName).toBe('factory/12-01-test')
  })
  it('files 格式錯誤 → CliError', () => {
    expect(() => parsePrInfo(JSON.stringify({ number: 1, headRefName: 'x', files: 'nope' }))).toThrow(CliError)
  })
})

describe('findLinkedIssue', () => {
  it('從 body 的 Closes #N 找 Issue', () => {
    expect(findLinkedIssue(parsePrInfo(PR_JSON))).toBe(12)
  })
  it('從 head 分支 factory/N- 找 Issue（無 Closes 時）', () => {
    const pr = parsePrInfo(JSON.stringify({ number: 1, headRefName: 'factory/42-01-test', files: [], body: null }))
    expect(findLinkedIssue(pr)).toBe(42)
  })
  it('都找不到 → undefined', () => {
    const pr = parsePrInfo(JSON.stringify({ number: 1, headRefName: 'feature/x', files: [], body: '' }))
    expect(findLinkedIssue(pr)).toBeUndefined()
  })
})

describe('initialTierFromLabels', () => {
  it('讀到 oversight/review → review', () => {
    expect(initialTierFromLabels([{ name: 'oversight/review' }])).toBe('review')
  })
  it('無 oversight 標籤 → undefined', () => {
    expect(initialTierFromLabels([{ name: 'bug' }])).toBeUndefined()
  })
})

describe('computeRescore（單向升級）', () => {
  it('after 高於 before → escalated', () => {
    const r = computeRescore({ prNumber: 1, before: 'on-loop', after: 'review', total: 3, triggeredHardRules: [] })
    expect(r.escalated).toBe(true)
  })
  it('after 等於 before → 不升級', () => {
    const r = computeRescore({ prNumber: 1, before: 'review', after: 'review', total: 3, triggeredHardRules: [] })
    expect(r.escalated).toBe(false)
  })
  it('before 未知但觸發硬規則 → escalated（保守）', () => {
    const r = computeRescore({ prNumber: 1, before: undefined, after: 'review', total: 5, triggeredHardRules: ['H1'] })
    expect(r.escalated).toBe(true)
  })
  it('before 未知且無硬規則 → 不升級', () => {
    const r = computeRescore({ prNumber: 1, before: undefined, after: 'review', total: 3, triggeredHardRules: [] })
    expect(r.escalated).toBe(false)
  })
})

describe('buildRescoreComment', () => {
  it('升級時列出規則並警告', () => {
    const c = buildRescoreComment({ prNumber: 1, before: 'on-loop', after: 'review', total: 3, triggeredHardRules: ['H1'], escalated: true })
    expect(c).toContain('on-loop')
    expect(c).toContain('review')
    expect(c).toContain('H1')
    expect(c).toContain('升級')
  })
  it('升級但無硬性規則 → 不顯示規則清單', () => {
    const c = buildRescoreComment({ prNumber: 1, before: 'on-loop', after: 'review', total: 3, triggeredHardRules: [], escalated: true })
    expect(c).toContain('監督層級升級')
    expect(c).not.toContain('觸發硬性規則')
  })
  it('before 未知（無初始標籤）→ 顯示（未知）', () => {
    const c = buildRescoreComment({ prNumber: 1, before: undefined, after: 'review', total: 3, triggeredHardRules: [], escalated: false })
    expect(c).toContain('未知')
  })
  it('未升級時不警告', () => {
    const c = buildRescoreComment({ prNumber: 1, before: 'review', after: 'review', total: 3, triggeredHardRules: [], escalated: false })
    expect(c).not.toContain('升級')
  })
})

describe('main（注入 fake gh）', () => {
  it('改到 auth → 觸發 H1 → 升級', () => {
    const gh = (args: string[]): string => {
      if (args[0] === 'pr') return PR_JSON
      if (args[0] === 'issue') return JSON.stringify({ labels: [{ name: 'oversight/on-loop' }] })
      throw new Error('unexpected gh call')
    }
    const r = main(['12', catalog, riskPaths], gh)
    // tactical(0)+low(0)+low(0)，H1 觸發 → risk=2 → total=2 → review
    expect(r.before).toBe('on-loop')
    expect(r.after).toBe('review')
    expect(r.triggeredHardRules).toContain('H1')
    expect(r.escalated).toBe(true)
  })
  it('無關聯 Issue（head 非 factory/N- 且無 Closes）→ issueNumber undefined、不查 issue', () => {
    const gh = (args: string[]): string => {
      if (args[0] === 'pr') return JSON.stringify({ number: 7, headRefName: 'feature/x', files: [{ path: 'src/lib/util.ts' }], body: null })
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    }
    const r = main(['7', catalog, riskPaths], gh)
    expect(r.issueNumber).toBeUndefined()
    expect(r.before).toBeUndefined()
    expect(r.escalated).toBe(false)
  })
  it('缺 prNumber → CliError', () => {
    expect(() => main([], () => '')).toThrow(CliError)
  })
})
