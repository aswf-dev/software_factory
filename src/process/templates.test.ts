import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TEMPLATE_NAMES, loadTemplate, loadProcessSpec, requiredSteps, validateProcess } from './spec.js'
import type { Template, TemplateName } from './spec.js'

function readTemplateYaml(name: TemplateName): string {
  const url = new URL(`../../templates/factory/${name}.yaml`, import.meta.url)
  return readFileSync(url, 'utf8')
}

function templateOf(name: TemplateName): Template {
  const result = loadTemplate(readTemplateYaml(name))
  if (result.template === undefined) throw new Error(`${name} 模板無法載入：${result.errors.join('; ')}`)
  return result.template
}

describe.each(TEMPLATE_NAMES)('%s 模板', (name) => {
  it('可被 schema 與內部一致性驗證接受', () => {
    expect(loadTemplate(readTemplateYaml(name)).errors).toEqual([])
  })

  it('檔案內宣告的模板名稱與檔名一致', () => {
    expect(templateOf(name).name).toBe(name)
  })

  it('步驟 id 以模板名稱為前綴，且依文件順序遞增', () => {
    const ids = templateOf(name).steps.map((step) => step.id)
    for (const id of ids) expect(id.startsWith(name)).toBe(true)
    const numbers = ids.map((id) => Number(id.slice(name.length)))
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers)
  })

  it('每個步驟的 phase 都在模板 phases 內', () => {
    const template = templateOf(name)
    for (const step of template.steps) expect(template.phases).toContain(step.phase)
  })

  it('忠於模板的 process.yaml 可通過驗證', () => {
    const template = templateOf(name)
    const text = [
      'system: aswf-dev/example',
      'scale: ' + name,
      'scale_evidence: docs/research/example-a0.md',
      `template: factory/${name}`,
      'template_version: 1',
      `phases: [${template.phases.join(', ')}]`,
      `gates: [${template.gates.join(', ')}]`,
    ].join('\n')
    const loaded = loadProcessSpec(text)
    expect(loaded.errors).toEqual([])
    if (loaded.process === undefined) throw new Error('process 未解析')
    expect(validateProcess(loaded.process, template)).toEqual({ ok: true, errors: [] })
  })

  it('移除任一模板閘門都會被拒絕', () => {
    const template = templateOf(name)
    const gates = template.gates.slice(1)
    const text = [
      'system: aswf-dev/example',
      `scale: ${name}`,
      'scale_evidence: docs/research/example-a0.md',
      `template: factory/${name}`,
      'template_version: 1',
      `phases: [${template.phases.join(', ')}]`,
      `gates: [${gates.join(', ')}]`,
    ].join('\n')
    const loaded = loadProcessSpec(text)
    if (loaded.process === undefined) throw new Error('process 未解析')
    const result = validateProcess(loaded.process, template)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain(`${template.gates[0]} 不得移除`)
  })
})

describe('模板內容', () => {
  it('S 不含 P5；M、L 含 P5', () => {
    expect(templateOf('S').phases).not.toContain('P5')
    expect(templateOf('M').phases).toContain('P5')
    expect(templateOf('L').phases).toContain('P5')
  })

  it('大型模板的閘門涵蓋 HG0–HG7', () => {
    expect(templateOf('L').gates).toEqual(['HG0', 'HG1', 'HG2', 'HG3', 'HG4', 'HG5', 'HG6', 'HG7'])
  })

  it('P4 的維護步驟是「非必要」（依需要）', () => {
    for (const name of TEMPLATE_NAMES) {
      const maintenance = templateOf(name).steps.find((step) => step.phase === 'P4')
      expect(maintenance?.required).toBe(false)
    }
  })

  it('必要步驟數量（總步驟數扣掉標記為非必要的維護步驟）：S 11、M 15、L 18', () => {
    expect(requiredSteps(templateOf('S'))).toHaveLength(11)
    expect(requiredSteps(templateOf('M'))).toHaveLength(15)
    expect(requiredSteps(templateOf('L'))).toHaveLength(18)
  })
})
