import { describe, expect, it } from 'vitest'
import {
  STAGE_DONE_LABEL,
  isStepDone,
  isStepInFlight,
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

function issue(number: number, taskType: string, target = 'src/billing/a.ts', labels: string[] = [], state: 'OPEN' | 'CLOSED' = 'OPEN'): IssueInput {
  return {
    number,
    title: `#${number}`,
    body: `### 任務類型\n\n${taskType}\n\n### 需求描述（PRD）\n\n目標模組 / 檔案：${target}\n`,
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
  it('全新模組：建議第一個模組步驟，並警告系統層未完成', () => {
    const doc = nextActions(input())
    expect(doc.actions).toEqual([
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

  it('系統層完成後不再警告', () => {
    const doc = nextActions(input({ issues: [issue(9, 'agent-analyze', 'src/billing/a.ts', [], 'CLOSED')] }))
    expect(doc.warnings.some((w) => w.includes('系統層步驟'))).toBe(false)
  })

  it('S8 完成後推進到下一個非條件式步驟', () => {
    const doc = nextActions(input({ issues: [issue(1, 'agent-add-tests', 'src/billing/a.ts', [STAGE_DONE_LABEL])] }))
    expect(doc.actions[0]).toMatchObject({ kind: 'work-item', template_step: 'S10', task_type: 'agent-write-spec' })
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
    expect(doc.actions).toEqual([
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
    expect(doc.actions).toEqual([])
    expect(doc.warnings).toContain('目前沒有可建議的下一步')
  })

  it('已有進行中的同類工單時不重複建議', () => {
    const doc = nextActions(input({ issues: [issue(1, 'agent-add-tests')] }))
    expect(doc.actions).toEqual([])
    expect(doc.warnings).toContain('a/b/billing：S8 已有進行中的工單，不重複建議')
  })

  it('沒有模組時不產生動作並給 warning', () => {
    const doc = nextActions(input({ modules: [] }))
    expect(doc.actions).toEqual([])
    expect(doc.warnings).toContain('目前沒有可建議的下一步')
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
    expect(doc.actions[0]).toMatchObject({ template_step: 'X1', task_type: 'agent-write-docs' })
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
