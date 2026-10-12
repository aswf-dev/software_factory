/**
 * factory-terminal 測試：compare job 作為 Issue 終態的唯一寫入者（ADR-021）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  aggregateTerminal,
  deriveVariant,
  main,
  terminalMarker,
  type StepOutcomes,
  type VariantTerminal,
} from './factory-terminal.js'

const ok: StepOutcomes = { agent: 'success', crosscheck: 'success', specverify: 'skipped', judge: 'success' }
const judge = (outcome: string, labels: string[] = ['oversight/review'], summary = 's', skillGap?: unknown) => ({
  result: { outcome, labels, summary },
  ...(skillGap === undefined ? {} : { report: { skillGap } }),
})
const gap = { category: 'monorepo-test-path', needed: '知道測試在哪', context: 'ctx' }

describe('terminalMarker', () => {
  it('含 run id，作為 G1／G2 判斷「終態已寫入」的唯一依據', () => {
    expect(terminalMarker(123)).toBe('<!-- factory:terminal run=123 -->')
  })
})

describe('deriveVariant', () => {
  it('沒有任何產物 → missing（job 可能被中止）', () => {
    const v = deriveVariant('a', {})
    expect(v.state).toBe('missing')
    expect(v.outcome).toBe('needs-human')
  })

  it('agent 沒有啟動（前置閘門擋下）→ not-started，終態由前置閘門自己負責', () => {
    for (const agent of ['skipped', '']) {
      expect(deriveVariant('a', { steps: { ...ok, agent } }).state).toBe('not-started')
    }
  })

  it('agent 失敗或被取消 → needs-human；report 標記逾時時寫明逾時', () => {
    expect(deriveVariant('a', { steps: { ...ok, agent: 'failure' } })).toMatchObject({ outcome: 'needs-human', reason: 'agent 執行失敗' })
    expect(deriveVariant('a', { steps: { ...ok, agent: 'cancelled' } }).outcome).toBe('needs-human')
    expect(deriveVariant('a', { steps: { ...ok, agent: 'failure' }, report: { timedOut: true } }).reason).toBe('agent 逾時')
  })

  it('crosscheck 或規格驗證失敗 → needs-human 並寫明原因', () => {
    expect(deriveVariant('a', { steps: { ...ok, crosscheck: 'failure' } }).reason).toContain('crosscheck')
    expect(deriveVariant('a', { steps: { ...ok, specverify: 'failure' } }).reason).toContain('規格驗證')
  })

  it('有合法 judge → 沿用其終態、標籤、摘要與技能缺口', () => {
    const v = deriveVariant('b', { steps: ok, judge: judge('ready-for-review', ['oversight/review'], '完成', gap) })
    expect(v).toMatchObject({ state: 'judged', outcome: 'ready-for-review', labels: ['oversight/review'], reason: '完成' })
    expect(v.skillGap?.category).toBe('monorepo-test-path')
  })

  it('agent 成功但 judge 缺席或格式不符 → needs-human（judge 步驟失敗）', () => {
    expect(deriveVariant('a', { steps: ok }).reason).toContain('judge')
    expect(deriveVariant('a', { steps: ok, judge: { result: { outcome: 'weird' } } }).outcome).toBe('needs-human')
  })

  it('judge 缺席時，技能缺口改取 report.json（與舊 G1 守衛相同來源）', () => {
    const v = deriveVariant('a', { steps: { ...ok, agent: 'failure' }, report: { skillGap: gap } })
    expect(v.skillGap?.category).toBe('monorepo-test-path')
  })

  it('judge 沒有 summary → 說明為空字串，不拋錯', () => {
    const v = deriveVariant('a', { steps: ok, judge: { result: { outcome: 'ready-for-review', labels: [] } } })
    expect(v).toMatchObject({ state: 'judged', reason: '' })
  })

  it('技能缺口格式不符 → 忽略，不讓終態寫入失敗', () => {
    expect(deriveVariant('a', { steps: ok, judge: judge('ready-for-review', ['oversight/review'], 's', { category: 'Bad Cat' }) }).skillGap).toBeUndefined()
  })
})

const judged = (variant: 'a' | 'b', outcome: VariantTerminal['outcome'], labels: string[], extra: Partial<VariantTerminal> = {}): VariantTerminal => ({
  variant,
  state: 'judged',
  outcome,
  labels,
  reason: `${variant}-summary`,
  ...extra,
})

describe('aggregateTerminal', () => {
  it('所有變體都沒啟動 agent → 不寫入（前置閘門已有自己的訊號）', () => {
    const r = aggregateTerminal({ runId: 1, nversion: true, variants: [deriveVariant('a', { steps: { ...ok, agent: 'skipped' } }), deriveVariant('b', { steps: { ...ok, agent: 'skipped' } })] })
    expect(r.write).toBe(false)
  })

  it('N-version：任一變體可審查 → ready-for-review，取可審查變體中最嚴格的監督標籤', () => {
    const r = aggregateTerminal({
      runId: 9,
      nversion: true,
      variants: [judged('a', 'ready-to-automerge', ['oversight/on-loop']), judged('b', 'ready-for-review', ['oversight/review'])],
    })
    expect(r).toMatchObject({ write: true, outcome: 'ready-for-review', labels: ['oversight/review'] })
    expect(r.comment).toContain(terminalMarker(9))
    expect(r.comment).toContain('## 工廠執行結果：ready-for-review')
    expect(r.comment).toContain('Factory N-version Pick')
  })

  it('N-version：一邊可審查、一邊失敗 → 仍是 ready-for-review，且不貼 needs-human', () => {
    const r = aggregateTerminal({
      runId: 9,
      nversion: true,
      variants: [judged('a', 'ready-for-review', ['oversight/review']), deriveVariant('b', { steps: { ...ok, crosscheck: 'failure' } })],
    })
    expect(r.outcome).toBe('ready-for-review')
    expect(r.labels).not.toContain('needs-human')
    expect(r.comment).toContain('crosscheck')
  })

  it('兩邊都失敗 → needs-human，監督標籤取全部變體中最嚴格者', () => {
    const r = aggregateTerminal({
      runId: 9,
      nversion: true,
      variants: [judged('a', 'needs-human', ['oversight/in-loop', 'needs-human']), deriveVariant('b', {})],
    })
    expect(r.outcome).toBe('needs-human')
    expect(r.labels).toEqual(['oversight/in-loop', 'needs-human'])
  })

  it('沒有可審查、也沒有 needs-human，只有 blocked-in-loop → blocked-in-loop', () => {
    const r = aggregateTerminal({ runId: 9, nversion: true, variants: [judged('a', 'blocked-in-loop', ['oversight/in-loop']), judged('b', 'blocked-in-loop', ['oversight/in-loop'])] })
    expect(r).toMatchObject({ outcome: 'blocked-in-loop', labels: ['oversight/in-loop'] })
  })

  it('一邊沒啟動、一邊有結果 → 只依有結果的變體判定', () => {
    const r = aggregateTerminal({ runId: 9, nversion: true, variants: [deriveVariant('a', { steps: { ...ok, agent: 'skipped' } }), judged('b', 'ready-for-review', ['oversight/review'])] })
    expect(r.outcome).toBe('ready-for-review')
  })

  it('任一變體回報技能缺口 → 加 skill-gap 標籤，且每個缺口段落標明變體', () => {
    const r = aggregateTerminal({
      runId: 9,
      nversion: true,
      variants: [judged('a', 'ready-for-review', ['oversight/review'], { skillGap: gap }), judged('b', 'needs-human', ['oversight/review', 'needs-human'])],
    })
    expect(r.labels).toContain('skill-gap')
    expect(r.comment).toContain('### 🧩 技能缺口回報')
    expect(r.comment).toContain('（變體 A）')
  })

  it('單一變體回報技能缺口 → 段落不標變體（與舊 apply-judge-labels 的留言格式一致）', () => {
    const r = aggregateTerminal({ runId: 9, nversion: false, variants: [judged('a', 'ready-for-review', ['oversight/review'], { skillGap: gap })] })
    expect(r.comment).toContain('### 🧩 技能缺口回報')
    expect(r.comment).not.toContain('（變體 A）')
  })

  it('單一變體（nversion=false）：沿用該變體的終態；ready-to-automerge 仍附第 1 期註記；不提選勝者', () => {
    const r = aggregateTerminal({ runId: 9, nversion: false, variants: [judged('a', 'ready-to-automerge', ['oversight/on-loop'])] })
    expect(r.outcome).toBe('ready-to-automerge')
    expect(r.comment).toContain('第 1 期')
    expect(r.comment).not.toContain('Factory N-version Pick')
  })

  it('用量段落附在終態留言（docs/08 §2.3）；N-version 標明變體，單一變體不標', () => {
    const withUsage = (v: 'a' | 'b') => deriveVariant(v, { steps: ok, judge: judge('ready-for-review'), usageMarkdown: `  ### 用量 ${v}\n` })
    const nv = aggregateTerminal({ runId: 9, nversion: true, variants: [withUsage('a'), withUsage('b')] })
    expect(nv.comment).toContain('**變體 A 用量**')
    expect(nv.comment).toContain('### 用量 b')
    const single = aggregateTerminal({ runId: 9, nversion: false, variants: [withUsage('a')] })
    expect(single.comment).toContain('### 用量 a')
    expect(single.comment).not.toContain('**變體 A 用量**')
  })

  it('用量為空白 → 視為缺席，不輸出空段落', () => {
    const v = deriveVariant('a', { steps: ok, judge: judge('ready-for-review'), usageMarkdown: '   \n' })
    expect(v.usageMarkdown).toBeUndefined()
  })

  it('沒有任何監督標籤可用時，不輸出空標籤', () => {
    const r = aggregateTerminal({ runId: 9, nversion: true, variants: [deriveVariant('a', {}), deriveVariant('b', {})] })
    expect(r.labels).toEqual(['needs-human'])
  })

  it('同一變體的標籤中出現非監督標籤時保留（例如 stopDecision 的 needs-human 已由終態處理，不重複）', () => {
    const r = aggregateTerminal({ runId: 9, nversion: false, variants: [judged('a', 'needs-human', ['oversight/review', 'needs-human'])] })
    expect(r.labels.filter((l) => l === 'needs-human')).toHaveLength(1)
  })
})

describe('main', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-terminal-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const write = (rel: string, value: unknown): void => {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value))
  }

  it('讀取兩個變體目錄的 steps.json、judge.json、report.json 並彙整', () => {
    write('a/.factory/steps.json', ok)
    write('a/.factory/judge.json', judge('ready-for-review'))
    write('b/.factory/steps.json', { ...ok, agent: 'failure' })
    write('b/target/.factory/run/report.json', { timedOut: true })
    write('b/target/.factory/run/usage.md', '### 用量 B')
    const r = main(['--run-id', '77', '--nversion', 'true', '--variant-dir', `a=${join(dir, 'a')}`, '--variant-dir', `b=${join(dir, 'b')}`])
    expect(r.outcome).toBe('ready-for-review')
    expect(r.comment).toContain('agent 逾時')
    expect(r.comment).toContain('### 用量 B')
  })

  it('壞 JSON 視為缺檔，不拋錯', () => {
    write('c/.factory/steps.json', '{not json')
    const r = main(['--run-id', '1', '--nversion', 'false', '--variant-dir', `a=${join(dir, 'c')}`])
    expect(r.outcome).toBe('needs-human')
  })

  it('參數檢查：缺 run id、缺變體目錄、變體代號不合法、未知旗標', () => {
    expect(() => main(['--nversion', 'true', '--variant-dir', 'a=x'])).toThrow(CliError)
    expect(() => main(['--run-id', '1', '--nversion', 'true'])).toThrow(CliError)
    expect(() => main(['--run-id', '1', '--variant-dir', 'c=x'])).toThrow(CliError)
    expect(() => main(['--run-id', '1', '--variant-dir', 'noequals'])).toThrow(CliError)
    expect(() => main(['--run-id', 'x', '--variant-dir', 'a=x'])).toThrow(CliError)
    expect(() => main(['--run-id', '1', '--variant-dir', 'a=x', '--wat'])).toThrow(CliError)
    expect(() => main(['--run-id'])).toThrow(CliError)
  })

  it('--nversion 未給時預設為 true（與 dispatch input 預設一致）', () => {
    write('d/.factory/steps.json', ok)
    write('d/.factory/judge.json', judge('ready-to-automerge', ['oversight/on-loop']))
    const r = main(['--run-id', '1', '--variant-dir', `a=${join(dir, 'd')}`])
    expect(r.outcome).toBe('ready-for-review')
  })
})
