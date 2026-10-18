import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadProcessSpec, loadTemplate, validateProcess } from './spec.js'

const ROOT = process.cwd()

/** 真實租戶系統：system spec 在機制 repo，模板在 templates/<tenant>/。 */
const REAL_SYSTEMS = [
  {
    system: 'agent-playground/restate-cloudflare-workers-poc',
    process: 'processes/agent-playground/restate-cloudflare-workers-poc.yaml',
    template: 'templates/agent-playground/review-first.yaml',
  },
] as const

describe.each(REAL_SYSTEMS)('$system', ({ process: processPath, template: templatePath }) => {
  it('process spec 忠於它釘選的租戶模板', () => {
    const loadedTemplate = loadTemplate(readFileSync(`${ROOT}/${templatePath}`, 'utf8'))
    expect(loadedTemplate.errors).toEqual([])
    if (loadedTemplate.template === undefined) throw new Error('template 未解析')

    const loadedProcess = loadProcessSpec(readFileSync(`${ROOT}/${processPath}`, 'utf8'))
    expect(loadedProcess.errors).toEqual([])
    if (loadedProcess.process === undefined) throw new Error('process 未解析')

    expect(validateProcess(loadedProcess.process, loadedTemplate.template)).toEqual({ ok: true, errors: [] })
  })
})
