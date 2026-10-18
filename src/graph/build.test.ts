import { describe, expect, it } from 'vitest'
import { buildGraph, moduleOfIssue, workItemState } from './build.js'
import type { BuildInput, IssueInput } from './build.js'
import type { ModuleEntry, ProcessSpec } from '../process/spec.js'

const issue = (number: number, body = '', labels: string[] = [], state: 'OPEN' | 'CLOSED' = 'OPEN'): IssueInput => ({
  number,
  title: `issue ${number}`,
  body,
  labels,
  state,
})

const prd = (target: string, prereqs = ''): string =>
  [
    '### 任務類型',
    '',
    'agent-analyze',
    '',
    '### 需求描述（PRD）',
    '',
    `目標模組 / 檔案：${target}`,
    '',
    '### 前置工作項（可留空）',
    '',
    prereqs,
  ].join('\n')

const moduleEntry = (id: string, paths: string[]): ModuleEntry => ({ id, paths })

const spec = {
  system: 'aswf-dev/example',
  scale: 'S',
  scale_evidence: 'docs/research/1.md',
  template: 'S',
  phases: ['P0', 'P1'],
  gates: ['HG1'],
} as unknown as ProcessSpec

const base: BuildInput = { system: 'aswf-dev/example', issues: [], generatedAt: '2026-10-18T00:00:00Z' }

describe('moduleOfIssue', () => {
  it('依 PRD 宣告路徑比對模組 glob', () => {
    const modules = [moduleEntry('billing', ['src/billing/**'])]
    expect(moduleOfIssue(issue(1, prd('src/billing/invoice.ts')), modules)?.id).toBe('billing')
  })

  it('沒有宣告路徑時回 undefined', () => {
    expect(moduleOfIssue(issue(1, '沒有 PRD'), [moduleEntry('billing', ['src/billing/**'])])).toBeUndefined()
  })

  it('沒有命中任何模組時回 undefined', () => {
    expect(moduleOfIssue(issue(1, prd('docs/x.md')), [moduleEntry('billing', ['src/billing/**'])])).toBeUndefined()
  })
})

describe('workItemState', () => {
  const map = (issues: IssueInput[]) => new Map(issues.map((i) => [i.number, i]))

  it('needs-human 標籤優先', () => {
    const target = issue(1, prd('src/a.ts'), ['needs-human'])
    expect(workItemState(target, map([target]))).toEqual({ state: 'needs-human', unresolved: [] })
  })

  it('前置未完成 → waiting-prereq', () => {
    const prereq = issue(1, prd('src/a.ts'))
    const target = issue(2, prd('src/a.ts', '#1'))
    expect(workItemState(target, map([prereq, target]))).toEqual({ state: 'waiting-prereq', unresolved: [1] })
  })

  it('前置標記 stage/done → 不再等待', () => {
    const prereq = issue(1, prd('src/a.ts'), ['stage/done'])
    const target = issue(2, prd('src/a.ts', '#1'))
    expect(workItemState(target, map([prereq, target]))).toEqual({ state: 'open', unresolved: [] })
  })

  it('前置不存在 → 視為未完成', () => {
    const target = issue(2, prd('src/a.ts', '#99'))
    expect(workItemState(target, map([target]))).toEqual({ state: 'waiting-prereq', unresolved: [99] })
  })

  it('已關閉且前置完成 → closed', () => {
    const target = issue(3, prd('src/a.ts'), [], 'CLOSED')
    expect(workItemState(target, map([target]))).toEqual({ state: 'closed', unresolved: [] })
  })
})

describe('buildGraph', () => {
  it('沒有 process 與模組時仍輸出系統與工作項，並附 warnings', () => {
    const doc = buildGraph({ ...base, issues: [issue(1, prd('src/a.ts'))] })
    expect(doc.nodes.map((n) => n.id)).toEqual(['aswf-dev/example', 'issue:1'])
    expect(doc.warnings).toContain('未提供 process.yaml：無法輸出規模與階段')
    expect(doc.warnings).toContain('未提供模組清單：工作項掛在系統節點下')
    expect(doc.edges).toEqual([{ from: 'aswf-dev/example', to: 'issue:1', kind: 'contains' }])
  })

  it('有 process 時帶出規模與第一個階段', () => {
    const doc = buildGraph({ ...base, issues: [], process: spec })
    expect(doc.nodes[0]).toMatchObject({ id: 'aswf-dev/example', kind: 'system', scale: 'S', phase: 'P0' })
  })

  it('有模組時建立模組節點與 contains 邊，工作項掛在模組下', () => {
    const doc = buildGraph({
      ...base,
      issues: [issue(1, prd('src/billing/invoice.ts'))],
      modules: [moduleEntry('billing', ['src/billing/**'])],
    })
    const moduleNode = doc.nodes.find((n) => n.id === 'aswf-dev/example/billing')
    expect(moduleNode).toMatchObject({ kind: 'module', label: 'billing' })
    expect(doc.edges).toContainEqual({
      from: 'aswf-dev/example/billing',
      to: 'issue:1',
      kind: 'contains',
    })
  })

  it('模組節點帶出 readiness／owner／spec', () => {
    const doc = buildGraph({
      ...base,
      issues: [],
      modules: [
        {
          id: 'billing',
          paths: ['src/billing/**'],
          readiness: 'R1',
          owner: 'payment-team',
          spec: 'docs/business-rules/billing.md',
        },
      ],
    })
    expect(doc.nodes[1]).toMatchObject({
      id: 'aswf-dev/example/billing',
      readiness: 'R1',
      owner: 'payment-team',
      spec: 'docs/business-rules/billing.md',
    })
  })

  it('輸出前置邊與 waiting-prereq 狀態', () => {
    const doc = buildGraph({
      ...base,
      issues: [issue(1, prd('src/a.ts')), issue(2, prd('src/a.ts', '#1'))],
    })
    expect(doc.edges).toContainEqual({ from: 'issue:1', to: 'issue:2', kind: 'prerequisite' })
    expect(doc.nodes.find((n) => n.id === 'issue:2')).toMatchObject({ state: 'waiting-prereq', prereqs: [1] })
  })

  it('前置指向不存在的 Issue 時產生 warning', () => {
    const doc = buildGraph({ ...base, issues: [issue(2, prd('src/a.ts', '#99'))] })
    expect(doc.warnings).toContain('#2: 前置 #99 不在清單中')
  })

  it('缺少任務類型時產生 warning，並對有前置的系統提示 v1 限制', () => {
    const doc = buildGraph({
      ...base,
      issues: [issue(1, '### 需求描述（PRD）\n\n沒有類型'), issue(2, prd('src/a.ts', '#1'))],
    })
    expect(doc.warnings).toContain('#1: 缺少任務類型欄位')
    expect(doc.warnings).toContain('前置完成判定僅依 stage/done 標籤，未含 PR 合併狀態（v1 限制）')
  })

  it('帶出 oversight 與 needs_human', () => {
    const doc = buildGraph({
      ...base,
      issues: [issue(1, prd('src/a.ts'), ['oversight/review', 'needs-human'])],
    })
    expect(doc.nodes.find((n) => n.id === 'issue:1')).toMatchObject({
      oversight: 'review',
      needs_human: true,
      state: 'needs-human',
    })
  })

  it('未簽的閘門產生 warning，並依 id／scope 排序', () => {
    const doc = buildGraph({
      ...base,
      gates: [
        { id: 'HG2', scope: 'system', state: 'missing' },
        { id: 'HG1', scope: 'billing', state: 'signed', signed_by: 'alice', signed_at: 'x', evidence: 'https://a.test' },
        { id: 'HG1', scope: 'system', state: 'missing' },
      ],
    })
    expect(doc.gates.map((g) => `${g.id}/${g.scope}`)).toEqual(['HG1/billing', 'HG1/system', 'HG2/system'])
    expect(doc.warnings).toContain('HG2（system）尚未簽核')
  })

  it('工作項依編號排序、邊依 from/to/kind 排序', () => {
    const doc = buildGraph({
      ...base,
      issues: [issue(5, prd('src/a.ts')), issue(2, prd('src/a.ts'))],
    })
    expect(doc.nodes.filter((n) => n.kind === 'workitem').map((n) => n.id)).toEqual(['issue:2', 'issue:5'])
    const keys = doc.edges.map((e) => `${e.from}->${e.to}:${e.kind}`)
    expect([...keys].sort()).toEqual(keys)
  })

  it('source 可覆寫 github 與 rev', () => {
    const doc = buildGraph({ ...base, github: 'aswf-dev/other', rev: 'abc123' })
    expect(doc.source).toEqual({ github: 'aswf-dev/other', rev: 'abc123' })
  })
})
