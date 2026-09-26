/**
 * write-spec 類型層級禁止自動合併（ADR-018 §9 護欄②）。
 */
import { describe, expect, it } from 'vitest'
import type { PipelineResult } from '../pipeline/run-work-item.js'
import { applyWriteSpecMergePolicy } from './policy.js'

const result = (outcome: PipelineResult['outcome']): PipelineResult =>
  ({ outcome, summary: '計分 0 分且符合全部自動合併條件', labels: ['oversight/on-loop'] }) as PipelineResult

describe('applyWriteSpecMergePolicy', () => {
  it('write-spec 的 ready-to-automerge → 降為 ready-for-review，說明原因，其餘欄位不變', () => {
    const r = applyWriteSpecMergePolicy(result('ready-to-automerge'), 'agent-write-spec')
    expect(r.outcome).toBe('ready-for-review')
    expect(r.summary).toContain('計分 0 分')
    expect(r.summary).toContain('agent-write-spec')
    expect(r.labels).toEqual(['oversight/on-loop'])
  })
  it('write-spec 的其他終態 → 原樣', () => {
    const r = result('needs-human')
    expect(applyWriteSpecMergePolicy(r, 'agent-write-spec')).toBe(r)
  })
  it('其他類型或未提供類型 → 原樣（計分本身不改）', () => {
    const r = result('ready-to-automerge')
    expect(applyWriteSpecMergePolicy(r, 'agent-add-tests')).toBe(r)
    expect(applyWriteSpecMergePolicy(r, undefined)).toBe(r)
  })
})
