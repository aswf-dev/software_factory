import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TemplateSchema, loadTemplate, type Template } from './spec.js'
import { findTemplate, loadRegistry, validateRegistry, type TemplateRegistry } from './registry.js'

const entry = (tenant: string, name: string, version = 1) => ({
  id: `${tenant}/${name}`,
  tenant,
  name,
  version,
  path: `templates/${tenant}/${name}.yaml`,
})

const registry = (templates: unknown[]): unknown => ({ schema_version: 1, templates })

const templateOf = (tenant: string, name: string, version = 1): Template =>
  TemplateSchema.parse({
    tenant,
    name,
    version,
    source: 'test',
    phases: ['P0'],
    gates: ['HG1', 'HG2', 'HG4', 'HG5', 'HG6'],
    steps: [{ id: 'S0', phase: 'P0', action: 'x', kind: 'human' }],
  })

describe('loadRegistry', () => {
  it('接受合法目錄', () => {
    const result = loadRegistry(JSON.stringify(registry([entry('factory', 'S'), entry('factory', 'M')])))
    expect(result).toEqual({ ok: true, errors: [], registry: expect.objectContaining({ schema_version: 1 }) })
    expect(result.registry?.templates).toHaveLength(2)
  })

  it('回報 JSON 解析失敗與 schema 錯誤', () => {
    expect(loadRegistry('not json').errors).toEqual(['目錄 JSON 無法解析'])
    expect(loadRegistry('null').errors[0]).toContain('<root>')
    expect(loadRegistry(JSON.stringify({ schema_version: 2, templates: [] })).ok).toBe(false)
  })

  it('id 重複、id 與 tenant/name 不一致、path 與 id 不一致都被拒', () => {
    expect(loadRegistry(JSON.stringify(registry([entry('factory', 'S'), entry('factory', 'S')]))).errors).toContain(
      'factory/S: id 重複',
    )

    const wrongId = { ...entry('factory', 'S'), id: 'acme/S' }
    expect(loadRegistry(JSON.stringify(registry([wrongId]))).errors.join(' ')).toContain('不一致')

    const wrongPath = { ...entry('factory', 'S'), path: 'templates/factory/M.yaml' }
    expect(loadRegistry(JSON.stringify(registry([wrongPath]))).errors.join(' ')).toContain('path 必須是')
  })

  it('findTemplate 以 id 查詢', () => {
    const loaded = loadRegistry(JSON.stringify(registry([entry('factory', 'S')], )))
    expect(findTemplate(loaded.registry as TemplateRegistry, 'factory/S')?.path).toBe('templates/factory/S.yaml')
    expect(findTemplate(loaded.registry as TemplateRegistry, 'acme/x')).toBeUndefined()
  })
})

describe('validateRegistry', () => {
  const loaded = loadRegistry(JSON.stringify(registry([entry('factory', 'S'), entry('factory', 'M')])))
  const base = loaded.registry as TemplateRegistry
  const templates = new Map<string, Template>([
    ['factory/S', templateOf('factory', 'S')],
    ['factory/M', templateOf('factory', 'M')],
  ])

  it('目錄與模板檔一致時通過', () => {
    expect(validateRegistry(base, templates)).toEqual({ ok: true, errors: [] })
  })

  it('目錄有但找不到模板檔', () => {
    const missing = new Map(templates)
    missing.delete('factory/M')
    expect(validateRegistry(base, missing).errors).toContain('factory/M: 目錄有但找不到模板檔 templates/factory/M.yaml')
  })

  it('版本或 tenant/name 不一致', () => {
    const stale = new Map(templates)
    stale.set('factory/M', templateOf('factory', 'M', 2))
    expect(validateRegistry(base, stale).errors.join(' ')).toContain('version')

    const renamed = new Map(templates)
    renamed.set('factory/S', templateOf('acme', 'S'))
    expect(validateRegistry(base, renamed).errors.join(' ')).toContain('與目錄不一致')
  })

  it('模板檔未列入目錄', () => {
    const extra = new Map(templates)
    extra.set('acme/review-first', templateOf('acme', 'review-first'))
    expect(validateRegistry(base, extra).errors).toEqual(['acme/review-first: 模板檔未列入目錄'])
  })
})

describe('repo 的 templates/index.json', () => {
  it('與 templates/** 的模板檔一致（版本、id、path）', () => {
    const root = process.cwd()
    const loaded = loadRegistry(readFileSync(`${root}/templates/index.json`, 'utf8'))
    expect(loaded.errors).toEqual([])
    const registryValue = loaded.registry as TemplateRegistry

    const templates = new Map<string, Template>()
    const dirs = readdirSync(`${root}/templates`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    for (const dir of dirs) {
      for (const file of readdirSync(`${root}/templates/${dir}`)) {
        if (!file.endsWith('.yaml')) continue
        const result = loadTemplate(readFileSync(`${root}/templates/${dir}/${file}`, 'utf8'))
        expect(result.errors).toEqual([])
        const template = result.template as Template
        templates.set(`${template.tenant}/${template.name}`, template)
      }
    }

    expect(validateRegistry(registryValue, templates)).toEqual({ ok: true, errors: [] })
  })
})
