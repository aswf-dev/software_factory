/**
 * write-spec 階段判定、核准者驗證、source.md 快照（ADR-018 §3、§5、§12）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSourceSnapshot,
  decidePhase,
  isHumanCodeownerApproval,
  parseCodeowners,
  SPEC_LABELS,
  type PhaseState,
} from './phase.js'

const FRESH: PhaseState = {
  issueOpen: true,
  labels: [],
  approvedByHuman: false,
  invariantsOnTrunk: false,
  openFactoryPrs: 0,
}

describe('decidePhase：§12 判定表', () => {
  it('未核准、沒有進行中的 PR → 跑不變量階段，貼 spec/phase-invariants', () => {
    const d = decidePhase(FRESH)
    expect(d.decision).toBe('invariants')
    expect(d.labelsToAdd).toEqual([SPEC_LABELS.phaseInvariants])
    expect(d.labelsToRemove).toEqual([])
  })
  it('不變量 PR 審查中 → 拒絕（避免重複產出）', () => {
    const d = decidePhase({ ...FRESH, openFactoryPrs: 1 })
    expect(d.decision).toBe('refuse')
    expect(d.reason).toMatch(/審查中/)
  })
  it('已核准但 trunk 上沒有 invariants.qnt → 拒絕（在合併前就先貼了標籤）', () => {
    const d = decidePhase({
      ...FRESH,
      labels: [SPEC_LABELS.approved],
      approvedByHuman: true,
    })
    expect(d.decision).toBe('refuse')
    expect(d.reason).toMatch(/invariants\.qnt/)
  })
  it('已核准且 trunk 上有 invariants.qnt → 跑模型階段，切換階段標籤並清除過期標記', () => {
    const d = decidePhase({
      ...FRESH,
      labels: [SPEC_LABELS.phaseInvariants, SPEC_LABELS.approved, SPEC_LABELS.outdated],
      approvedByHuman: true,
      invariantsOnTrunk: true,
    })
    expect(d.decision).toBe('model')
    expect(d.labelsToAdd).toEqual([SPEC_LABELS.phaseModel])
    expect(d.labelsToRemove).toEqual([SPEC_LABELS.phaseInvariants, SPEC_LABELS.outdated])
  })
  it('已放棄 → 拒絕', () => {
    expect(decidePhase({ ...FRESH, labels: [SPEC_LABELS.declined] }).decision).toBe('refuse')
  })
  it('Issue 已關閉 → 拒絕（重做須先重新打開）', () => {
    const d = decidePhase({ ...FRESH, issueOpen: false })
    expect(d.decision).toBe('refuse')
    expect(d.reason).toMatch(/重新打開/)
  })
})

describe('decidePhase：核准必須是人貼的', () => {
  it('有 spec/approved 但不是 CODEOWNERS 人類所貼 → 拒絕，不回頭重跑不變量', () => {
    const d = decidePhase({
      ...FRESH,
      labels: [SPEC_LABELS.approved],
      approvedByHuman: false,
      invariantsOnTrunk: true,
    })
    expect(d.decision).toBe('refuse')
    expect(d.reason).toMatch(/CODEOWNERS/)
  })
})

describe('decidePhase：過期偵測（Q28）', () => {
  it('重跑不變量階段時，若曾跑過模型 → 貼 spec/model-outdated、移除 spec/phase-model', () => {
    const d = decidePhase({ ...FRESH, labels: [SPEC_LABELS.phaseModel] })
    expect(d.decision).toBe('invariants')
    expect(d.labelsToAdd).toEqual([SPEC_LABELS.phaseInvariants, SPEC_LABELS.outdated])
    expect(d.labelsToRemove).toEqual([SPEC_LABELS.phaseModel])
  })
})

describe('parseCodeowners', () => {
  it('收集 @使用者（小寫），略過註解、團隊（@org/team）與 email', () => {
    const text = [
      '# 註解 @ghost',
      '* @PhilipZ',
      '/src/ @alice @org/team ops@example.com',
      '',
      '.github/** @bob # 行尾註解 @carol',
    ].join('\n')
    expect([...parseCodeowners(text)].sort()).toEqual(['alice', 'bob', 'philipz'])
  })
})

describe('isHumanCodeownerApproval', () => {
  const owners = new Set(['philipz'])
  it('最後一次貼標者是 CODEOWNERS 裡的人類 → true（大小寫不敏感）', () => {
    expect(isHumanCodeownerApproval([{ login: 'PhilipZ', type: 'User' }], owners)).toBe(true)
  })
  it('以最後一次為準：先人後 bot → false', () => {
    const events = [
      { login: 'philipz', type: 'User' },
      { login: 'softwarefactory-bot[bot]', type: 'Bot' },
    ]
    expect(isHumanCodeownerApproval(events, owners)).toBe(false)
  })
  it('bot、App、名稱以 [bot] 結尾、或不在 CODEOWNERS → false', () => {
    expect(isHumanCodeownerApproval([{ login: 'x[bot]', type: 'User' }], new Set(['x[bot]']))).toBe(false)
    expect(isHumanCodeownerApproval([{ login: 'philipz', type: 'Bot' }], owners)).toBe(false)
    expect(isHumanCodeownerApproval([{ login: 'mallory', type: 'User' }], owners)).toBe(false)
  })
  it('找不到貼標事件 → false（無法證明是人貼的）', () => {
    expect(isHumanCodeownerApproval([], owners)).toBe(false)
  })
})

describe('buildSourceSnapshot', () => {
  it('issue：標頭註明來源 Issue 與擷取時間，本文為 PRD 原文', () => {
    const s = buildSourceSnapshot({
      kind: 'issue',
      repo: 'agent-playground/node-redlock',
      issueNumber: 12,
      capturedAt: '2026-09-26T00:00:00Z',
      content: '第 3 步：經過時間必須小於有效期。',
    })
    expect(s).toContain('由 CI 寫入')
    expect(s).toContain('agent-playground/node-redlock#12')
    expect(s).toContain('2026-09-26T00:00:00Z')
    expect(s.endsWith('第 3 步：經過時間必須小於有效期。\n')).toBe(true)
  })
  it('path：標頭註明路徑與 trunk commit；本文保留原樣（已有結尾換行時不重複）', () => {
    const s = buildSourceSnapshot({
      kind: 'path',
      path: 'docs/specs/redlock.md',
      trunkSha: 'abc123',
      capturedAt: '2026-09-26T00:00:00Z',
      content: '# Redlock\n',
    })
    expect(s).toContain('docs/specs/redlock.md @ abc123')
    expect(s.endsWith('# Redlock\n')).toBe(true)
    expect(s.endsWith('# Redlock\n\n')).toBe(false)
  })
})
