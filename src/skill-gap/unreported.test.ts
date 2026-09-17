import { describe, expect, it } from 'vitest'
import {
  adviseUnreportedSkillGap,
  hasUnreportedSkillGapAdvisory,
  SKILL_GAP_UNREPORTED_KIND,
  type UnreportedTrigger,
} from './unreported.js'

const TRIGGERS: UnreportedTrigger[] = ['crosscheck-mismatch', 'no-output', 'needs-human']

describe('adviseUnreportedSkillGap', () => {
  it('無觸發情境 → 不發話（乾淨完成的 run 不該被提醒）', () => {
    expect(adviseUnreportedSkillGap(null, false)).toEqual([])
    expect(adviseUnreportedSkillGap(null, true)).toEqual([])
  })

  it('已回報缺口 → 不發話（三種觸發皆然）', () => {
    for (const t of TRIGGERS) {
      expect(adviseUnreportedSkillGap(t, true), `trigger=${t}`).toEqual([])
    }
  })

  it('三種觸發且未回報 → 各發一條，kind 一致、detail 指出偵測點', () => {
    for (const t of TRIGGERS) {
      const out = adviseUnreportedSkillGap(t, false)
      expect(out).toHaveLength(1)
      expect(out[0]?.kind).toBe(SKILL_GAP_UNREPORTED_KIND)
      expect(out[0]?.detail).toContain('skillGap')
    }
  })

  /**
   * 三種觸發的 detail 必須彼此不同：它們是三個**不同的偵測點**
   * （crosscheck 失敗／零產出／judge 終態），事後查因時要能分辨是哪一條路徑
   * 發現的。若有人把 detail 統一成同一句，這個資訊就沒了。
   */
  it('三種觸發的 detail 互不相同', () => {
    const details = TRIGGERS.map((t) => adviseUnreportedSkillGap(t, false)[0]?.detail)
    expect(new Set(details).size).toBe(TRIGGERS.length)
  })

  /**
   * 釘死本模組**不得**猜測缺口內容：advisory 只說「請確認」，不得出現
   * category/needed 等欄位。虛構的缺口會污染 docs/25 §3 的 ≥3 次門檻。
   */
  it('advisory 不得包含代擬的 category 或 needed 欄位', () => {
    const detail = adviseUnreportedSkillGap('needs-human', false)[0]?.detail ?? ''
    expect(detail).not.toContain('category')
    expect(detail).not.toContain('needed')
  })
})

describe('hasUnreportedSkillGapAdvisory', () => {
  it('含本 kind → true', () => {
    expect(hasUnreportedSkillGapAdvisory([{ kind: SKILL_GAP_UNREPORTED_KIND, detail: 'x' }])).toBe(true)
  })

  it('只含其他 kind → false', () => {
    expect(hasUnreportedSkillGapAdvisory([{ kind: 'requirements-uncovered', detail: 'x' }])).toBe(false)
  })

  it('空陣列 / 非陣列 / null / 元素非物件 → false（下游輸入不可信，不得 throw）', () => {
    expect(hasUnreportedSkillGapAdvisory([])).toBe(false)
    expect(hasUnreportedSkillGapAdvisory(undefined)).toBe(false)
    expect(hasUnreportedSkillGapAdvisory(null)).toBe(false)
    expect(hasUnreportedSkillGapAdvisory('not-an-array')).toBe(false)
    expect(hasUnreportedSkillGapAdvisory([null, 'x', 42])).toBe(false)
  })
})
