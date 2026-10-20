import { describe, expect, it } from 'vitest'
import { main, next, parseOptions } from './factory-next.js'
import type { GhRunner, NextDeps } from './factory-next.js'

const issuesJson = JSON.stringify([
  {
    number: 1,
    title: 'add tests',
    body: '### 任務類型\n\nagent-add-tests\n\n### 需求描述（PRD）\n\n目標模組 / 檔案：src/billing/a.ts\n',
    labels: [],
    state: 'OPEN',
  },
])

const commentsJson = JSON.stringify([
  [
    {
      id: 10,
      body: '<!-- factory:hg id=HG5 state=signed evidence=https://a.test -->',
      user: { login: 'alice' },
      created_at: '2026-10-18T00:00:00Z', author_association: 'MEMBER',
    },
  ],
])

const processYaml = [
  'system: aswf-dev/example',
  'scale: S',
  'scale_evidence: docs/research/1.md',
  'template: factory/S',
  'template_version: 1',
  'phases: [P0, P1]',
  'gates: [HG5]',
].join('\n')

const templateYaml = [
  'tenant: factory',
  'name: S',
  'version: 1',
  'source: test',
  'phases: [P0, P1]',
  'gates: [HG1, HG2, HG4, HG5, HG6]',
  'steps:',
  '  - {id: S8, phase: P1, action: 補測試, kind: work-item, task_type: agent-add-tests, per: module}',
].join('\n')

const modulesYaml = [
  'system: aswf-dev/example',
  'modules:',
  '  - id: billing',
  '    paths: ["src/billing/**"]',
].join('\n')

function deps(overrides: Partial<NextDeps> = {}): NextDeps {
  return {
    gh: (args) => (args[0] === 'issue' ? issuesJson : commentsJson),
    readFile: (path) => {
      if (path.endsWith('modules.yaml')) return modulesYaml
      if (path.includes('templates/')) return templateYaml
      return processYaml
    },
    now: () => '2026-10-18T01:00:00Z',
    ...overrides,
  }
}

const baseOptions = {
  repo: 'aswf-dev/example',
  processPath: 'process.yaml',
  modulesPath: 'modules.yaml',
  templatesDir: 'templates',
  limit: 200,
}

describe('parseOptions', () => {
  it('解析必要參數並套用預設值', () => {
    expect(
      parseOptions(['--repo', 'a/b', '--process', 'p.yaml', '--modules', 'm.yaml']),
    ).toEqual({
      repo: 'a/b',
      processPath: 'p.yaml',
      modulesPath: 'm.yaml',
      templatesDir: 'templates',
      limit: 200,
    })
  })

  it('接受所有選填參數', () => {
    const options = parseOptions([
      '--repo',
      'a/b',
      '--process',
      'p.yaml',
      '--modules',
      'm.yaml',
      '--templates-dir',
      'x/templates',
      '--tracking-issue',
      '9',
      '--limit',
      '10',
      '--generated-at',
      '2026-10-18T00:00:00Z',
    ])
    expect(options).toMatchObject({
      templatesDir: 'x/templates',
      trackingIssue: 9,
      limit: 10,
      generatedAt: '2026-10-18T00:00:00Z',
    })
  })

  it('拒絕非旗標與缺值', () => {
    expect(() => parseOptions(['x'])).toThrow('無法辨識的參數')
    expect(() => parseOptions(['--repo'])).toThrow('需要一個值')
  })

  it('拒絕缺少必要參數', () => {
    expect(() => parseOptions([])).toThrow('缺少 --repo')
    expect(() => parseOptions(['--repo', 'noslash', '--process', 'p', '--modules', 'm'])).toThrow('--repo 格式不正確')
    expect(() => parseOptions(['--repo', 'a/b'])).toThrow('缺少 --process')
    expect(() => parseOptions(['--repo', 'a/b', '--process', 'p'])).toThrow('缺少 --modules')
  })

  it('拒絕不合法的 limit 與 tracking issue', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--process', 'p', '--modules', 'm', '--limit', '0'])).toThrow('--limit 必須是正整數')
    expect(() =>
      parseOptions(['--repo', 'a/b', '--process', 'p', '--modules', 'm', '--tracking-issue', 'x']),
    ).toThrow('--tracking-issue 必須是正整數')
  })
})

describe('next', () => {
  it('產生待開工作項清單', () => {
    const doc = next(baseOptions, deps())
    expect(doc.system).toBe('aswf-dev/example')
    expect(doc.generated_at).toBe('2026-10-18T01:00:00Z')
    expect(doc.actions).toEqual([])
    expect(doc.warnings).toContain('aswf-dev/example/billing：S8 已有進行中的工單，不重複建議')
  })

  it('指定的 generated-at 優先於 now', () => {
    const doc = next({ ...baseOptions, generatedAt: '2026-10-18T09:00:00Z' }, deps({ now: () => { throw new Error('now 不該被呼叫') } }))
    expect(doc.generated_at).toBe('2026-10-18T09:00:00Z')
  })

  it('帶入 tracking-issue 時讀取閘門', () => {
    const calls: string[][] = []
    const gh: GhRunner = (args) => {
      calls.push(args)
      return args[0] === 'issue' ? issuesJson : commentsJson
    }
    next({ ...baseOptions, trackingIssue: 9 }, deps({ gh }))
    expect(calls[1]).toEqual(['api', '--paginate', '--slurp', 'repos/aswf-dev/example/issues/9/comments'])
  })

  it('process、template、modules 無效時拋出 CliError', () => {
    expect(() => next(baseOptions, deps({ readFile: () => 'system: [unclosed' }))).toThrow('process.yaml 無效')
    const brokenProcess = deps({
      readFile: (path) => {
        if (path.includes('/templates/')) return 'template: [unclosed'
        if (path.endsWith('modules.yaml')) return modulesYaml
        return processYaml
      },
    })
    expect(() => next(baseOptions, brokenProcess)).toThrow('無效')
    const brokenModules = deps({
      readFile: (path) => {
        if (path.endsWith('modules.yaml')) return 'system: x'
        if (path.includes('templates/')) return templateYaml
        return processYaml
      },
    })
    expect(() => next(baseOptions, brokenModules)).toThrow('modules.yaml 無效')
  })

  it('templates-dir 結尾的斜線會被正規化', () => {
    const calls: string[] = []
    next(
      { ...baseOptions, templatesDir: 'x/templates/' },
      deps({
        readFile: (path) => {
          calls.push(path)
          if (path.endsWith('modules.yaml')) return modulesYaml
          if (path.startsWith('x/templates/factory/S.yaml')) return templateYaml
          return processYaml
        },
      }),
    )
    expect(calls.some((path) => path === 'x/templates/factory/S.yaml')).toBe(true)
  })
})

describe('main', () => {
  it('由 argv 組出清單', () => {
    const doc = main(['--repo', 'aswf-dev/example', '--process', 'process.yaml', '--modules', 'modules.yaml'], deps())
    expect(doc.system).toBe('aswf-dev/example')
  })
})
