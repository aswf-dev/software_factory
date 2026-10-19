import { describe, expect, it } from 'vitest'
import {
  STAGE_DONE_LABEL,
  isStepDone,
  isStepInFlight,
  usesStepProvenance,
  isSystemStep,
  nextActions,
  taskTypesOf,
} from './next-actions.js'
import type { NextActionsInput } from './next-actions.js'
import type { IssueInput } from '../graph/build.js'
import type { GateStatus } from '../hg/parse.js'
import { TemplateSchema } from './spec.js'
import type { ModuleEntry, ProcessSpec, Step } from './spec.js'

const template = TemplateSchema.parse({
  tenant: 'factory',
  name: 'S',
  version: 1,
  source: 'test',
  phases: ['P0', 'P1'],
  gates: ['HG5'],
  steps: [
    { id: 'S4', phase: 'P0', action: 'A0', kind: 'work-item', task_type: 'agent-analyze', per: 'system' },
    { id: 'S8', phase: 'P1', action: '補測試', kind: 'work-item', task_type: 'agent-add-tests', per: 'module' },
    { id: 'S9', phase: 'P1', action: '修缺陷', kind: 'work-item', task_type: 'agent-fix-bug', per: 'defect', conditional: true },
    {
      id: 'S10',
      phase: 'P1',
      action: '驗證閘門',
      kind: 'work-item',
      per: 'module',
      alternatives: [
        { kind: 'work-item', action: 'Quint', task_type: 'agent-write-spec' },
        { kind: 'work-item', action: 'Hegel', task_type: 'agent-pbt-audit' },
        { kind: 'human', action: '豁免單' },
      ],
      gates: ['HG5'],
    },
  ],
})

const process = {
  system: 'a/b',
  scale: 'S',
  scale_evidence: 'docs/x.md',
  template: 'factory/S',
  template_version: 1,
  phases: ['P0', 'P1'],
  gates: ['HG5'],
} as unknown as ProcessSpec

const billing: ModuleEntry = { id: 'billing', paths: ['src/billing/**'] }

function issue(
  number: number,
  taskType: string,
  target = 'src/billing/a.ts',
  labels: string[] = [],
  state: 'OPEN' | 'CLOSED' = 'OPEN',
  stepId?: string,
): IssueInput {
  const prefix = stepId === undefined ? '' : `> 流程步驟：${stepId}\n\n`
  return {
    number,
    title: `#${number}`,
    body: `${prefix}### 任務類型\n\n${taskType}\n\n### 需求描述（PRD）\n\n目標模組 / 檔案：${target}\n`,
    labels,
    state,
  }
}

const signedGate = (scope = 'system'): GateStatus => ({
  id: 'HG5',
  scope,
  state: 'signed',
  signed_by: 'alice',
  signed_at: 'x',
  evidence: 'https://a.test',
})

const missingGate = (scope = 'system'): GateStatus => ({ id: 'HG5', scope, state: 'missing' })

function input(overrides: Partial<NextActionsInput> = {}): NextActionsInput {
  return {
    system: 'a/b',
    template,
    process,
    modules: [billing],
    issues: [],
    gates: [],
    generatedAt: '2026-10-18T00:00:00Z',
    ...overrides,
  }
}

describe('isSystemStep', () => {
  it('per: system 或 repo 屬於系統層', () => {
    expect(isSystemStep(template.steps[0] as Step)).toBe(true)
    expect(isSystemStep(template.steps[1] as Step)).toBe(false)
  })
})

describe('taskTypesOf', () => {
  it('單一 task_type', () => {
    expect(taskTypesOf(template.steps[0] as Step)).toEqual(['agent-analyze'])
  })

  it('替代方案的任務類型（去重、排除 human）', () => {
    expect(taskTypesOf(template.steps[3] as Step)).toEqual(['agent-write-spec', 'agent-pbt-audit'])
  })

  it('沒有任務類型時為空', () => {
    const step: Step = { id: 'X', phase: 'P1', action: 'x', kind: 'human' }
    expect(taskTypesOf(step)).toEqual([])
  })
})

describe('isStepDone / isStepInFlight', () => {
  const step = template.steps[1] as Step

  it('已關閉視為完成', () => {
    expect(isStepDone(step, [issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'CLOSED')])).toBe(true)
  })

  it('stage/done 標籤視為完成', () => {
    expect(isStepDone(step, [issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL])])).toBe(true)
  })

  it('開啟中不算完成', () => {
    expect(isStepDone(step, [issue(1, 'agent-add-tests')])).toBe(false)
  })

  it('任務類型不同不算完成', () => {
    expect(isStepDone(step, [issue(1, 'agent-analyze')])).toBe(false)
  })

  it('沒有任務類型欄位的 Issue 不算完成、也不算進行中', () => {
    const untitled: IssueInput = { number: 9, title: 'x', body: '沒有表單欄位', labels: [], state: 'OPEN' }
    expect(isStepDone(step, [untitled])).toBe(false)
    expect(isStepInFlight(step, [untitled])).toBe(false)
  })

  it('開啟中的同類工單視為進行中', () => {
    expect(isStepInFlight(step, [issue(1, 'agent-add-tests')])).toBe(true)
  })

  it('已完成的同類工單不算進行中', () => {
    expect(isStepInFlight(step, [issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'CLOSED')])).toBe(false)
  })
})

describe('nextActions', () => {
  it('全新專案：先建議系統層步驟，再建議第一個模組步驟，並警告系統層未完成', () => {
    const doc = nextActions(input())
    expect(doc.actions).toEqual([
      {
        kind: 'work-item',
        scope: 'a/b',
        template_step: 'S4',
        task_type: 'agent-analyze',
        task_types: ['agent-analyze'],
        reason: 'S4 尚未有完成紀錄（系統層）',
      },
      {
        kind: 'work-item',
        scope: 'a/b/billing',
        template_step: 'S8',
        task_type: 'agent-add-tests',
        task_types: ['agent-add-tests'],
        reason: 'S8 尚未有完成紀錄',
      },
    ])
    expect(doc.warnings[0]).toContain('系統層步驟尚未完成：S4')
  })

  it('系統層步驟只建議一次（不因模組數而重複）', () => {
    const doc = nextActions(input({ modules: [billing, { id: 'auth', paths: ['src/auth/**'] }] }))
    const systemActions = doc.actions.filter((action) => action.template_step === 'S4')
    expect(systemActions).toHaveLength(1)
    expect(systemActions[0]).toMatchObject({ scope: 'a/b', kind: 'work-item' })
  })

  it('系統層閘門未簽時建議簽核，而不是開單', () => {
    const gated = TemplateSchema.parse({
      ...template,
      steps: [
        { id: 'S4', phase: 'P0', action: '規格', kind: 'work-item', task_type: 'agent-write-spec', per: 'system', gates: ['HG4'] },
      ],
    })
    const doc = nextActions(input({ template: gated, gates: [missingGate('system')] }))
    expect(doc.actions[0]).toMatchObject({ kind: 'gate', scope: 'a/b', gate: 'HG4', template_step: 'S4' })
  })

  it('系統層人類步驟閘門未簽時建議簽核', () => {
    const humanGated = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S4', phase: 'P1', action: '安全審查', kind: 'human', gates: ['HG4'] }],
    })
    const doc = nextActions(input({ template: humanGated, gates: [missingGate('system')] }))
    expect(doc.actions[0]).toMatchObject({ kind: 'gate', scope: 'a/b', gate: 'HG4', template_step: 'S4' })
  })

  it('系統層人類步驟沒有閘門時不建議', () => {
    const humanPlain = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S4', phase: 'P1', action: '會議', kind: 'human' }],
    })
    expect(nextActions(input({ template: humanPlain })).actions).toEqual([])
  })

  it('系統層 conditional／required:false 步驟不建議', () => {
    const conditional = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S4', phase: 'P0', action: 'x', kind: 'work-item', task_type: 'agent-analyze', per: 'system', conditional: true }],
    })
    expect(nextActions(input({ template: conditional })).actions).toEqual([])

    const optional = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S4', phase: 'P0', action: 'x', kind: 'work-item', task_type: 'agent-analyze', per: 'system', required: false }],
    })
    expect(nextActions(input({ template: optional })).actions).toEqual([])
  })

  it('系統層步驟沒有可建議任務類型時跳過', () => {
    const noTypes = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S4', phase: 'P0', action: 'x', kind: 'work-item', per: 'system', alternatives: [{ kind: 'human', action: '人工處理' }] }],
    })
    expect(nextActions(input({ template: noTypes })).actions).toEqual([])
  })

  it('系統層步驟進行中時不重複建議', () => {
    const doc = nextActions(input({ issues: [issue(1, 'agent-analyze')] }))
    expect(doc.actions.some((action) => action.template_step === 'S4')).toBe(false)
  })

  it('系統層完成後不再警告', () => {
    const doc = nextActions(input({ issues: [issue(9, 'agent-analyze', 'src/billing/a.ts', [], 'CLOSED')] }))
    expect(doc.warnings.some((w) => w.includes('系統層步驟'))).toBe(false)
  })

  it('S8 完成後推進到下一個非條件式步驟', () => {
    const doc = nextActions(input({ issues: [issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL])] }))
    expect(doc.actions.find((action) => action.scope === 'a/b/billing')).toMatchObject({
      kind: 'work-item',
      template_step: 'S10',
      task_type: 'agent-write-spec',
    })
  })

  it('條件式步驟不自動建議', () => {
    const doc = nextActions(input({ issues: [issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL])] }))
    expect(doc.warnings).toContain('a/b/billing：S9 為條件式步驟，未自動建議')
  })

  it('完成但閘門未簽時，建議簽核而不是下一張工單', () => {
    const doc = nextActions(
      input({
        issues: [
          issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL]),
          issue(2, 'agent-write-spec', 'src/billing/a.ts', [STAGE_DONE_LABEL]),
        ],
      }),
    )
    const moduleActions = doc.actions.filter((action) => action.scope === 'a/b/billing')
    expect(moduleActions).toEqual([
      {
        kind: 'gate',
        scope: 'a/b/billing',
        gate: 'HG5',
        template_step: 'S10',
        reason: 'S10 已完成，但 HG5 尚未簽核',
      },
    ])
  })

  it('模組層級的閘門簽核也算數', () => {
    const doc = nextActions(
      input({
        issues: [
          issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL]),
          issue(2, 'agent-write-spec', 'src/billing/a.ts', [STAGE_DONE_LABEL]),
        ],
        gates: [signedGate('a/b/billing')],
      }),
    )
    expect(doc.actions.filter((action) => action.scope === 'a/b/billing')).toEqual([])
  })

  it('已有進行中的同類工單時不重複建議', () => {
    const doc = nextActions(input({ issues: [issue(1, 'agent-add-tests')] }))
    expect(doc.actions.filter((action) => action.scope === 'a/b/billing')).toEqual([])
    expect(doc.warnings).toContain('a/b/billing：S8 已有進行中的工單，不重複建議')
  })

  it('沒有模組時仍建議系統層步驟（系統層不依賴模組）', () => {
    const doc = nextActions(input({ modules: [] }))
    expect(doc.actions).toEqual([
      {
        kind: 'work-item',
        scope: 'a/b',
        template_step: 'S4',
        task_type: 'agent-analyze',
        task_types: ['agent-analyze'],
        reason: 'S4 尚未有完成紀錄（系統層）',
      },
    ])
  })

  it('步驟沒有任務類型時警告並停止該模組', () => {
    const noType = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S1', phase: 'P1', action: 'x', kind: 'work-item', per: 'module', alternatives: [{ kind: 'human', action: '豁免' }] }],
    })
    const doc = nextActions(input({ template: noType }))
    expect(doc.warnings).toContain('a/b/billing：S1 沒有可建議的任務類型')
  })

  it('required: false 的步驟不列入建議', () => {
    const optional = TemplateSchema.parse({
      ...template,
      steps: [{ id: 'S1', phase: 'P1', action: 'x', kind: 'work-item', task_type: 'agent-update-deps', per: 'module', required: false }],
    })
    const doc = nextActions(input({ template: optional }))
    expect(doc.actions).toEqual([])
  })

  it('extra_steps 也納入推進順序', () => {
    const withExtra = {
      ...process,
      extra_steps: [{ id: 'X1', phase: 'P1', action: '額外', kind: 'work-item', task_type: 'agent-write-docs', per: 'module' }],
    } as unknown as ProcessSpec
    const doc = nextActions(
      input({
        process: withExtra,
        issues: [issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL])],
        template: TemplateSchema.parse({
          ...template,
          steps: [template.steps[0] as Step, template.steps[1] as Step],
        }),
      }),
    )
    expect(doc.actions.find((action) => action.template_step === 'X1')).toMatchObject({ task_type: 'agent-write-docs' })
  })

  it('閘門未簽時在建議理由中註明', () => {
    const gateOnly = TemplateSchema.parse({
      ...template,
      steps: [
        {
          id: 'S10',
          phase: 'P1',
          action: 'x',
          kind: 'work-item',
          task_type: 'agent-write-spec',
          per: 'module',
          gates: ['HG5'],
        },
      ],
    })
    const doc = nextActions(input({ template: gateOnly, gates: [missingGate('system')] }))
    expect(doc.actions[0]).toMatchObject({ kind: 'work-item', template_step: 'S10' })
    expect((doc.actions[0] as { reason: string }).reason).toContain('需 HG5 簽核')
  })
})

describe('人類步驟的完成訊號（閘門）', () => {
  const humanWithGate: Step = { id: 'H1', phase: 'P1', action: '安全審查', kind: 'human', gates: ['HG4'] }

  it('閘門已簽 → 人類步驟視為完成', () => {
    expect(isStepDone(humanWithGate, [], [{ id: 'HG4', scope: 'system', state: 'signed' }])).toBe(true)
  })

  it('閘門缺簽或未提供 → 未完成', () => {
    expect(isStepDone(humanWithGate, [], [{ id: 'HG4', scope: 'system', state: 'missing' }])).toBe(false)
    expect(isStepDone(humanWithGate, [])).toBe(false)
  })

  it('簽了閘門後不再產生「系統層步驟尚未完成」warning', () => {
    const doc = nextActions(
      input({
        template: TemplateSchema.parse({
          ...template,
          steps: [humanWithGate],
        }),
        issues: [],
        gates: [{ id: 'HG4', scope: 'system', state: 'signed' }],
      }),
    )
    expect(doc.warnings.some((warning) => warning.includes('系統層步驟尚未完成'))).toBe(false)
  })
})

describe('人類步驟（模板裡沒有 per 的 kind: human）', () => {
  const humanTemplate = TemplateSchema.parse({
    tenant: 'factory',
    name: 'S',
    version: 1,
    source: 'test',
    phases: ['P0', 'P1', 'P2'],
    gates: ['HG4'],
    steps: [
      { id: 'A', phase: 'P1', action: '分析', kind: 'work-item', task_type: 'agent-analyze', per: 'module' },
      { id: 'B', phase: 'P2', action: '撰寫業務規則', kind: 'human', gates: ['HG4'] },
      { id: 'C', phase: 'P2', action: '補測試', kind: 'work-item', task_type: 'agent-add-tests', per: 'module' },
    ],
  })

  it('P0／P1／P5 的人類步驟算系統層，P2–P4 算模組層', () => {
    expect(isSystemStep({ id: 'X', phase: 'P0', action: 'x', kind: 'human' })).toBe(true)
    expect(isSystemStep({ id: 'X', phase: 'P1', action: 'x', kind: 'human' })).toBe(true)
    expect(isSystemStep({ id: 'X', phase: 'P5', action: 'x', kind: 'human' })).toBe(true)
    expect(isSystemStep({ id: 'X', phase: 'P2', action: 'x', kind: 'human' })).toBe(false)
    expect(isSystemStep({ id: 'X', phase: 'P3', action: 'x', kind: 'human' })).toBe(false)
  })

  it('上一個工作項完成、人類步驟的閘門未簽 → 建議簽核，而不是下一個工作項', () => {
    const doc = nextActions({
      system: 'a/b',
      template: humanTemplate,
      process: { ...process, phases: ['P0', 'P1', 'P2'] } as ProcessSpec,
      modules: [billing],
      issues: [issue(1, 'agent-analyze', 'src/billing/a.ts', [], 'CLOSED')],
      gates: [],
      generatedAt: '2026-10-18T00:00:00Z',
    })
    expect(doc.actions).toEqual([
      expect.objectContaining({ kind: 'gate', gate: 'HG4', template_step: 'B', scope: 'a/b/billing' }),
    ])
  })

  it('人類步驟的閘門已簽 → 視為完成，繼續建議下一個工作項', () => {
    const doc = nextActions({
      system: 'a/b',
      template: humanTemplate,
      process: { ...process, phases: ['P0', 'P1', 'P2'] } as ProcessSpec,
      modules: [billing],
      issues: [issue(1, 'agent-analyze', 'src/billing/a.ts', [], 'CLOSED')],
      gates: [{ id: 'HG4', scope: 'a/b/billing', state: 'signed', signed_by: 'alice', signed_at: 'x', evidence: 'https://a.test' }],
      generatedAt: '2026-10-18T00:00:00Z',
    })
    expect(doc.actions).toEqual([
      expect.objectContaining({ kind: 'work-item', task_type: 'agent-add-tests', template_step: 'C' }),
    ])
  })
})

describe('provenance 優先的完成判定（step_id）', () => {
  const stepS8: Step = {
    id: 'S8',
    phase: 'P1',
    action: '補測試',
    kind: 'work-item',
    task_type: 'agent-add-tests',
    per: 'module',
  }

  it('usesStepProvenance：任一工單帶 step_id 即視為已遷移', () => {
    expect(usesStepProvenance([issue(1, 'agent-add-tests')])).toBe(false)
    expect(usesStepProvenance([issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'OPEN', 'S8')])).toBe(true)
  })

  it('strict：同 task_type 但 step_id 不符 → 不算完成（避免舊工單假完成）', () => {
    const other = issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'CLOSED', 'X9')
    expect(isStepDone(stepS8, [other], [], { requireStepId: true })).toBe(false)
  })

  it('strict：step_id 相符且已關閉 → 完成；進行中同理', () => {
    const done = issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'CLOSED', 'S8')
    const running = issue(2, 'agent-add-tests', 'src/billing/a.ts', [], 'OPEN', 'S8')
    expect(isStepDone(stepS8, [done], [], { requireStepId: true })).toBe(true)
    expect(isStepInFlight(stepS8, [running], { requireStepId: true })).toBe(true)
    expect(isStepInFlight(stepS8, [done], { requireStepId: true })).toBe(false)
  })

  it('legacy fallback：完全沒有 provenance 時仍用 task_type', () => {
    const legacy = issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'CLOSED')
    expect(isStepDone(stepS8, [legacy])).toBe(true)
  })

  it('nextActions：repo 有 provenance 後，舊的同類型 closed 工單不再讓步驟完成', () => {
    const doc = nextActions(
      input({
        issues: [
          issue(1, 'agent-add-tests', 'src/billing/a.ts', [], 'CLOSED', 'X9'),
          issue(2, 'agent-analyze', 'src/billing/a.ts', [], 'CLOSED', 'X1'),
        ],
      }),
    )
    expect(doc.actions.some((action) => action.kind === 'work-item' && action.template_step === 'S8')).toBe(true)
  })
})

describe('Q-ORCH-1 A+：跳步警示（advisory）', () => {
  it('開立較後面步驟的工單、且前面步驟未完成 → 警示', () => {
    // 模板：S4（系統層）→ S8（模組）→ S9（條件式）→ S10（模組）。
    // 直接對 S10 開一張進行中的工單，S8（S10 的必要前置）還沒完成。
    const skip = issue(77, 'agent-write-spec', 'src/billing/a.ts', [], 'OPEN', 'S10')
    const doc = nextActions(input({ issues: [skip] }))
    const drift = doc.warnings.filter((warning) => warning.includes('跳步'))
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('工單 #77（S10）')
    expect(drift[0]).toContain('跳過了目前建議的 S8')
    expect(drift[0]).toContain('不擋派工')
  })

  it('沒有跳步（依序完成）→ 不警示', () => {
    const doc = nextActions(
      input({
        issues: [
          issue(1, 'agent-analyze'),
          issue(2, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL]),
        ],
      }),
    )
    expect(doc.warnings.filter((warning) => warning.includes('跳步'))).toEqual([])
  })

  it('警示不改變建議內容（advisory）', () => {
    const skip = issue(77, 'agent-write-spec', 'src/billing/a.ts', [], 'OPEN', 'S10')
    const withDrift = nextActions(input({ issues: [skip] }))
    const baseline = nextActions(input())
    // 建議的「動作」集合不因跳步警示而改變。
    expect(withDrift.actions.map((action) => action.template_step)).toEqual(
      baseline.actions.map((action) => action.template_step),
    )
  })
})

describe('Q-ORCH-1 A+：跳步警示的邊界', () => {
  const auth: ModuleEntry = { id: 'auth', paths: ['src/auth/**'] }

  it('沒有 step_id 的工單不列入跳步判定', () => {
    const doc = nextActions(input({ issues: [issue(88, 'agent-add-tests')] }))
    expect(doc.warnings.filter((warning) => warning.includes('跳步'))).toEqual([])
  })

  it('未知的 step_id 不誤報', () => {
    const doc = nextActions(input({ issues: [issue(89, 'agent-write-docs', 'src/billing/a.ts', [], 'OPEN', 'X9')] }))
    expect(doc.warnings.filter((warning) => warning.includes('跳步'))).toEqual([])
  })

  it('同一跳步步驟的多張工單只警示一次', () => {
    const doc = nextActions(
      input({
        issues: [
          issue(90, 'agent-write-spec', 'src/billing/a.ts', [], 'OPEN', 'S10'),
          issue(91, 'agent-write-spec', 'src/billing/a.ts', [], 'OPEN', 'S10'),
        ],
      }),
    )
    const drift = doc.warnings.filter((warning) => warning.includes('跳步'))
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('工單 #90')
  })

  it('只警示該 scope 的工單（模組 B 的跳步不會出現在模組 A）', () => {
    const doc = nextActions(
      input({
        modules: [billing, auth],
        issues: [
          issue(92, 'agent-analyze'),
          issue(93, 'agent-write-spec', 'src/auth/x.ts', [], 'OPEN', 'S10'),
        ],
      }),
    )
    const drift = doc.warnings.filter((warning) => warning.includes('跳步'))
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('/auth：')
  })

  it('系統層步驟的跳步也會警示', () => {
    const gatedSystem = TemplateSchema.parse({
      ...template,
      steps: [
        { id: 'S4', phase: 'P0', action: '分析', kind: 'work-item', task_type: 'agent-analyze', per: 'system' },
        { id: 'S5', phase: 'P0', action: '規格', kind: 'work-item', task_type: 'agent-write-spec', per: 'system' },
        ...template.steps.filter((step) => !isSystemStep(step)),
      ],
    })
    const doc = nextActions(
      input({ template: gatedSystem, issues: [issue(94, 'agent-write-spec', 'src/billing/a.ts', [], 'OPEN', 'S5')] }),
    )
    const drift = doc.warnings.filter((warning) => warning.includes('跳步'))
    expect(drift[0]).toContain('a/b：工單 #94（S5）跳過了目前建議的 S4')
  })
})
