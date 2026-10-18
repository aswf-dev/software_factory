import { describe, expect, it } from 'vitest'
import { list, main, parseOptions, resolve, type TemplateCliDeps } from './factory-template.js'

const templateYaml = (tenant: string, name: string, version = 1): string =>
  [
    `tenant: ${tenant}`,
    `name: ${name}`,
    `version: ${version}`,
    'source: test',
    'phases: [P0]',
    'gates: [HG1, HG2, HG4, HG5, HG6]',
    'steps:',
    '  - {id: S0, phase: P0, action: x, kind: human}',
  ].join('\n')

const entry = (tenant: string, name: string, version = 1) => ({
  id: `${tenant}/${name}`,
  tenant,
  name,
  version,
  path: `templates/${tenant}/${name}.yaml`,
})

const registryJson = (entries: unknown[]): string =>
  JSON.stringify({ schema_version: 1, templates: entries })

const files = (overrides: Record<string, string> = {}): Record<string, string> => ({
  './templates/index.json': registryJson([entry('factory', 'S'), entry('factory', 'M')]),
  './templates/factory/S.yaml': templateYaml('factory', 'S'),
  './templates/factory/M.yaml': templateYaml('factory', 'M'),
  ...overrides,
})

function deps(
  overrides: { files?: Record<string, string>; list?: string[] } = {},
): TemplateCliDeps {
  const contents = overrides.files ?? files()
  return {
    readFile: (path) => {
      const value = contents[path]
      if (value === undefined) throw new Error(`unexpected readFile: ${path}`)
      return value
    },
    listTemplateFiles: () => overrides.list ?? ['templates/factory/S.yaml', 'templates/factory/M.yaml'],
  }
}

describe('parseOptions', () => {
  it('list 預設 root 為 .', () => {
    expect(parseOptions(['list'])).toEqual({ command: 'list', root: '.' })
  })

  it('resolve 需要 --id', () => {
    expect(() => parseOptions(['resolve'])).toThrow('resolve 需要 --id')
    expect(parseOptions(['resolve', '--root', 'x', '--id', 'factory/M'])).toEqual({
      command: 'resolve',
      root: 'x',
      id: 'factory/M',
    })
  })

  it('拒絕未知子命令與缺值旗標', () => {
    expect(() => parseOptions(['wat'])).toThrow('未知的子命令')
    expect(() => parseOptions([])).toThrow('(缺少)')
    expect(() => parseOptions(['list', 'extra'])).toThrow('無法辨識的參數')
    expect(() => parseOptions(['list', '--root'])).toThrow('需要一個值')
    expect(() => parseOptions(['list', '--root', '--id'])).toThrow('需要一個值')
  })
})

describe('list / resolve', () => {
  it('list 依 id 排序並印出目錄', () => {
    expect(list({ command: 'list', root: '.' }, deps())).toEqual({
      schema_version: 1,
      templates: [entry('factory', 'M'), entry('factory', 'S')],
    })
  })

  it('main 走 resolve 分支', () => {
    expect(main(['resolve', '--id', 'factory/M'], deps())).toEqual({
      id: 'factory/M',
      version: 1,
      path: 'templates/factory/M.yaml',
    })
  })

  it('resolve 回傳版本與路徑', () => {
    expect(resolve({ command: 'resolve', root: '.', id: 'factory/M' }, deps())).toEqual({
      id: 'factory/M',
      version: 1,
      path: 'templates/factory/M.yaml',
    })
  })

  it('未知 id 丟出 CliError', () => {
    expect(() => resolve({ command: 'resolve', root: '.', id: 'acme/x' }, deps())).toThrow(
      '目錄沒有這個模板：acme/x',
    )
  })

  it('目錄與模板檔不一致時丟出 CliError', () => {
    expect(() =>
      list({ command: 'list', root: '.' }, deps({ list: ['templates/factory/S.yaml'] })),
    ).toThrow(/不一致/)
  })

  it('目錄或模板檔無效時丟出 CliError', () => {
    expect(() =>
      main(['list'], deps({ files: { ...files(), './templates/index.json': 'not json' } })),
    ).toThrow(/templates\/index\.json 無效/)

    expect(() =>
      main(
        ['list'],
        deps({
          files: { ...files(), './templates/factory/M.yaml': 'tenant: factory\nname: M\nversion: 1\nphases: [P0]\ngates: [HG1]\nsteps: []' },
        }),
      ),
    ).toThrow(/templates\/factory\/M\.yaml 無效/)
  })
})
