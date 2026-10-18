import { describe, expect, it } from 'vitest'
import {
  PHASES,
  ProcessSpecSchema,
  TemplateSchema,
  loadModuleSpec,
  loadProcessSpec,
  loadTemplate,
  requiredSteps,
  validateProcess,
  validateSteps,
  validateTemplate,
} from './spec.js'
import type { Step, Template } from './spec.js'

const human = (id: string, extra: Record<string, unknown> = {}): Step =>
  ({
    id,
    phase: 'P0',
    action: '人做的事',
    kind: 'human',
    ...extra,
  }) as unknown as Step

const workItem = (id: string, extra: Record<string, unknown> = {}): Step =>
  ({
    id,
    phase: 'P1',
    action: '工單',
    kind: 'work-item',
    task_type: 'agent-analyze',
    ...extra,
  }) as unknown as Step

const minimalTemplate = {
  template: 'S',
  version: 1,
  source: 'test',
  phases: ['P0', 'P1'],
  gates: ['HG1'],
  steps: [human('S0'), workItem('S1', { gates: ['HG1'] })],
}

function templateOf(overrides: Record<string, unknown> = {}): Template {
  const parsed = TemplateSchema.parse({ ...minimalTemplate, ...overrides })
  return parsed
}

describe('validateSteps', () => {
  it('接受合法步驟', () => {
    expect(validateSteps([human('A'), workItem('B')])).toEqual({ ok: true, errors: [] })
  })

  it('拒絕重複的 id', () => {
    const result = validateSteps([human('A'), human('A')])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('id 重複')
  })

  it('拒絕 human 帶 task_type', () => {
    const result = validateSteps([human('A', { task_type: 'agent-analyze' })])
    expect(result.errors[0]).toContain('human 步驟不得帶 task_type')
  })

  it('拒絕沒有任務類型的 work-item', () => {
    const result = validateSteps([{ id: 'A', phase: 'P0', action: 'x', kind: 'work-item' }])
    expect(result.errors[0]).toContain('必須有 task_type 或 alternatives')
  })

  it('拒絕同時有 task_type 與 alternatives', () => {
    const result = validateSteps([
      workItem('A', { alternatives: [{ kind: 'human', action: 'x' }] }),
    ])
    expect(result.errors[0]).toContain('只能擇一')
  })

  it('拒絕缺少 task_type 的 work-item 替代方案', () => {
    const result = validateSteps([
      { id: 'A', phase: 'P0', action: 'x', kind: 'work-item', alternatives: [{ kind: 'work-item' }] },
    ])
    expect(result.errors[0]).toContain('替代方案缺少 task_type')
  })

  it('拒絕帶 task_type 的 human 替代方案', () => {
    const result = validateSteps([
      {
        id: 'A',
        phase: 'P0',
        action: 'x',
        kind: 'work-item',
        alternatives: [{ kind: 'human', task_type: 'agent-analyze' }],
      },
    ])
    expect(result.errors[0]).toContain('human 的替代方案不得帶 task_type')
  })
})

describe('validateTemplate', () => {
  it('接受合法模板', () => {
    const result = validateTemplate(minimalTemplate)
    expect(result.ok).toBe(true)
    expect(result.template?.template).toBe('S')
  })

  it('拒絕 schema 不符的模板，並標出欄位路徑', () => {
    const result = validateTemplate({ ...minimalTemplate, version: -1 })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('version')
  })

  it('缺少 root 欄位時路徑顯示 <root>', () => {
    const result = validateTemplate('不是物件')
    expect(result.errors[0]).toContain('<root>')
  })

  it('拒絕順序錯誤的 phases', () => {
    const result = validateTemplate({ ...minimalTemplate, phases: ['P1', 'P0'] })
    expect(result.errors[0]).toContain('順序不正確')
  })

  it('彙整步驟的錯誤', () => {
    const result = validateTemplate({ ...minimalTemplate, steps: [human('A'), human('A')] })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
  })
})

describe('validateProcess', () => {
  const template = templateOf()

  const process = {
    system: 'aswf-dev/x',
    scale: 'S',
    scale_evidence: 'docs/research/1-a0.md',
    template: 'S',
    phases: ['P0', 'P1'],
    gates: ['HG1'],
  }

  it('接受忠於模板的 process', () => {
    expect(validateProcess(process, template)).toEqual({ ok: true, errors: [] })
  })

  it('拒絕 schema 不符的 process', () => {
    const result = validateProcess({ ...process, system: '' }, template)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('system')
  })

  it('拒絕 template 不一致', () => {
    const result = validateProcess({ ...process, template: 'S' }, templateOf({ template: 'M' }))
    expect(result.errors[0]).toContain('模板是 M')
  })

  it('拒絕 scale 與 template 不一致', () => {
    const result = validateProcess({ ...process, scale: 'M' }, template)
    expect(result.errors[0]).toContain('必須對應同名的模板')
  })

  it('拒絕非連續前綴的 phases', () => {
    const longTemplate = templateOf({ phases: ['P0', 'P1', 'P2'] })
    const result = validateProcess({ ...process, phases: ['P0', 'P2'] }, longTemplate)
    expect(result.errors[0]).toContain('連續前綴')
  })

  it('拒絕模板未定義的 phase', () => {
    const result = validateProcess({ ...process, phases: ['P0', 'P5'] }, template)
    expect(result.errors.some((e) => e.includes('模板未定義 P5'))).toBe(true)
  })

  it('拒絕移除模板的閘門', () => {
    const result = validateProcess({ ...process, gates: [] }, template)
    expect(result.errors[0]).toContain('HG1 不得移除')
  })

  it('允許新增閘門', () => {
    const result = validateProcess({ ...process, gates: ['HG1', 'HG3'] }, template)
    expect(result.ok).toBe(true)
  })

  it('拒絕與模板衝突的 extra_steps id', () => {
    const result = validateProcess({ ...process, extra_steps: [human('S0')] }, template)
    expect(result.errors[0]).toContain('與模板步驟 id 衝突')
  })

  it('拒絕階段不在已宣告 phases 內的 extra_steps', () => {
    const result = validateProcess(
      { ...process, extra_steps: [human('X1', { phase: 'P2' })] },
      template,
    )
    expect(result.errors[0]).toContain('不在已宣告的 phases 內')
  })

  it('彙整 extra_steps 的步驟錯誤', () => {
    const result = validateProcess({ ...process, extra_steps: [human('X1'), human('X1')] }, template)
    expect(result.errors.some((e) => e.includes('extra_steps.X1'))).toBe(true)
  })

  it('接受合法的 extra_steps', () => {
    const result = validateProcess({ ...process, extra_steps: [human('X1', { phase: 'P1' })] }, template)
    expect(result.ok).toBe(true)
  })
})

describe('loadTemplate / loadProcessSpec', () => {
  it('載入合法 YAML', () => {
    const text = [
      'template: S',
      'version: 1',
      'source: test',
      'phases: [P0]',
      'gates: [HG1]',
      'steps:',
      '  - {id: S0, phase: P0, action: x, kind: human}',
    ].join('\n')
    expect(loadTemplate(text).ok).toBe(true)
  })

  it('回報 YAML 解析失敗', () => {
    expect(loadTemplate('template: [unclosed').errors).toEqual(['YAML 無法解析'])
    expect(loadProcessSpec('a: [unclosed').errors).toEqual(['YAML 無法解析'])
  })

  it('回報 schema 錯誤', () => {
    expect(loadTemplate('template: X').ok).toBe(false)
    expect(loadProcessSpec('system: a').ok).toBe(false)
  })

  it('載入合法的 process spec', () => {
    const text = [
      'system: a/b',
      'scale: S',
      'scale_evidence: docs/research/x.md',
      'template: S',
      'phases: [P0]',
      'gates: [HG1]',
    ].join('\n')
    const result = loadProcessSpec(text)
    expect(result.ok).toBe(true)
    expect(result.process?.system).toBe('a/b')
  })
})

describe('requiredSteps', () => {
  it('排除 required: false 的步驟', () => {
    const template = templateOf({
      steps: [human('A'), human('B', { required: false })],
    })
    expect(requiredSteps(template).map((step) => step.id)).toEqual(['A'])
  })
})

describe('常數', () => {
  it('phases 由 P0 到 P5', () => {
    expect([...PHASES]).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5'])
  })

  it('ProcessSpecSchema 可單獨用於驗證', () => {
    expect(ProcessSpecSchema.safeParse({}).success).toBe(false)
  })
})

describe('loadModuleSpec', () => {
  const valid = [
    'system: aswf-dev/example',
    'modules:',
    '  - id: billing',
    '    paths: ["src/billing/**"]',
    '    readiness: R1',
    '    readiness_evidence: docs/research/1-a2.md',
  ].join('\n')

  it('載入合法模組清單', () => {
    const result = loadModuleSpec(valid)
    expect(result.ok).toBe(true)
    expect(result.modules?.modules[0]?.id).toBe('billing')
  })

  it('回報 YAML 解析失敗', () => {
    expect(loadModuleSpec('a: [unclosed').errors).toEqual(['YAML 無法解析'])
  })

  it('回報 schema 錯誤', () => {
    expect(loadModuleSpec('system: a').ok).toBe(false)
  })

  it('拒絕 readiness 沒有 evidence', () => {
    const text = ['system: a/b', 'modules:', '  - id: billing', '    paths: ["x/**"]', '    readiness: R2'].join('\n')
    expect(loadModuleSpec(text).errors[0]).toContain('必須附 readiness_evidence')
  })

  it('拒絕重複的 module id', () => {
    const text = [
      'system: a/b',
      'modules:',
      '  - id: billing',
      '    paths: ["x/**"]',
      '  - id: billing',
      '    paths: ["y/**"]',
    ].join('\n')
    expect(loadModuleSpec(text).errors[0]).toContain('id 重複')
  })

  it('拒絕不合法的 module id', () => {
    const text = ['system: a/b', 'modules:', '  - id: Billing', '    paths: ["x/**"]'].join('\n')
    expect(loadModuleSpec(text).ok).toBe(false)
  })
})
