/**
 * 類型層級禁止自動合併（ADR-018 §9 護欄②、ADR-019 §5）。
 */
import { describe, expect, it } from 'vitest'
import { applyNoAutomergePolicy, isNoAutomergeTaskType, NO_AUTOMERGE_TASK_TYPES } from './no-automerge.js'
import type { PipelineResult } from './run-work-item.js'

const result = (outcome: PipelineResult['outcome']): PipelineResult =>
  ({ outcome, summary: '計分 0 分且符合全部自動合併條件', labels: ['oversight/on-loop'] }) as PipelineResult

describe('applyNoAutomergePolicy', () => {
  it('名單恰為 write-spec 與 pbt-audit（新增或移除都要經 ADR）', () => {
    expect([...NO_AUTOMERGE_TASK_TYPES]).toEqual(['agent-write-spec', 'agent-pbt-audit'])
  })
  it('write-spec 的 ready-to-automerge → 降為 ready-for-review，說明原因，其餘欄位不變', () => {
    const r = applyNoAutomergePolicy(result('ready-to-automerge'), 'agent-write-spec')
    expect(r.outcome).toBe('ready-for-review')
    expect(r.summary).toContain('計分 0 分')
    expect(r.summary).toContain('agent-write-spec 類型一律需人類審查，不自動合併（ADR-018 護欄②）')
    expect(r.labels).toEqual(['oversight/on-loop'])
  })
  it('pbt-audit 的 ready-to-automerge → 降為 ready-for-review，引用 ADR-019', () => {
    const r = applyNoAutomergePolicy(result('ready-to-automerge'), 'agent-pbt-audit')
    expect(r.outcome).toBe('ready-for-review')
    expect(r.summary).toContain('agent-pbt-audit 類型一律需人類審查')
    expect(r.summary).toContain('ADR-019')
  })
  it('名單內類型的其他終態 → 原樣', () => {
    const r = result('needs-human')
    expect(applyNoAutomergePolicy(r, 'agent-write-spec')).toBe(r)
    expect(applyNoAutomergePolicy(r, 'agent-pbt-audit')).toBe(r)
  })
  it('其他類型或未提供類型 → 原樣（計分本身不改）', () => {
    const r = result('ready-to-automerge')
    expect(applyNoAutomergePolicy(r, 'agent-add-tests')).toBe(r)
    expect(applyNoAutomergePolicy(r, undefined)).toBe(r)
  })
  it('isNoAutomergeTaskType', () => {
    expect(isNoAutomergeTaskType('agent-pbt-audit')).toBe(true)
    expect(isNoAutomergeTaskType('agent-add-tests')).toBe(false)
    expect(isNoAutomergeTaskType(undefined)).toBe(false)
  })
})
