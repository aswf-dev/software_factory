import { describe, expect, it } from 'vitest'
import { graph, main, parseIssues, parseOptions, parsePullRequests } from './factory-graph.js'
import type { GhRunner, GraphDeps } from './factory-graph.js'

const issuesJson = JSON.stringify([
  {
    number: 1,
    title: 'add tests',
    body: '### 任務類型\n\nagent-add-tests\n',
    labels: [{ name: 'oversight/review' }],
    state: 'OPEN',
  },
])

const commentsJson = JSON.stringify([
  [
    {
      id: 10,
      body: '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->',
      user: { login: 'alice' },
      created_at: '2026-10-18T00:00:00Z',
    },
  ],
])

const processYaml = [
  'system: aswf-dev/example',
  'scale: S',
  'scale_evidence: docs/research/1.md',
  'template: factory/S',
  'template_version: 1',
  'phases: [P0]',
  'gates: [HG1]',
].join('\n')

const modulesYaml = [
  'system: aswf-dev/example',
  'modules:',
  '  - id: billing',
  '    paths: ["src/billing/**"]',
].join('\n')

function deps(overrides: Partial<GraphDeps> = {}): GraphDeps {
  const gh: GhRunner = (args) => {
    if (args[0] === 'issue') return issuesJson
    if (args[0] === 'pr') return '[]'
    return commentsJson
  }
  return {
    gh,
    readFile: (path) => (path.endsWith('modules.yaml') ? modulesYaml : processYaml),
    now: () => '2026-10-18T01:00:00Z',
    ...overrides,
  }
}

describe('parseOptions', () => {
  it('解析必要參數並套用預設值', () => {
    expect(parseOptions(['--repo', 'a/b'])).toEqual({ repo: 'a/b', system: 'a/b', limit: 200 })
  })

  it('接受所有選填參數', () => {
    const options = parseOptions([
      '--repo',
      'a/b',
      '--system',
      'aswf-dev/x',
      '--process',
      'p.yaml',
      '--modules',
      'm.yaml',
      '--tracking-issue',
      '7',
      '--limit',
      '50',
      '--generated-at',
      '2026-10-18T00:00:00Z',
    ])
    expect(options).toEqual({
      repo: 'a/b',
      system: 'aswf-dev/x',
      processPath: 'p.yaml',
      modulesPath: 'm.yaml',
      trackingIssue: 7,
      limit: 50,
      generatedAt: '2026-10-18T00:00:00Z',
    })
  })

  it('拒絕非旗標參數與缺值', () => {
    expect(() => parseOptions(['x'])).toThrow('無法辨識的參數')
    expect(() => parseOptions(['--repo'])).toThrow('需要一個值')
    expect(() => parseOptions(['--repo', '--system', 'x'])).toThrow('需要一個值')
  })

  it('拒絕缺少或格式錯誤的 repo', () => {
    expect(() => parseOptions([])).toThrow('缺少 --repo')
    expect(() => parseOptions(['--repo', 'noslash'])).toThrow('--repo 格式不正確')
  })

  it('拒絕不合法的 limit', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--limit', '0'])).toThrow('--limit 必須是正整數')
    expect(() => parseOptions(['--repo', 'a/b', '--limit', 'x'])).toThrow('--limit 必須是正整數')
  })

  it('拒絕不合法的 tracking issue', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--tracking-issue', '0'])).toThrow('--tracking-issue 必須是正整數')
    expect(() => parseOptions(['--repo', 'a/b', '--tracking-issue', 'x'])).toThrow('--tracking-issue 必須是正整數')
  })
})

describe('parseIssues', () => {
  it('轉換欄位並正規化 state', () => {
    const issues = parseIssues(
      JSON.stringify([
        { number: 2, title: 't', body: null, labels: [{ name: 'a' }], state: 'CLOSED' },
      ]),
    )
    expect(issues).toEqual([{ number: 2, title: 't', body: '', labels: ['a'], state: 'CLOSED' }])
  })

  it('OPEN 以外的狀態視為 OPEN', () => {
    const issues = parseIssues(
      JSON.stringify([{ number: 3, title: 't', body: 'x', labels: [], state: 'OPEN' }]),
    )
    expect(issues[0]?.state).toBe('OPEN')
  })

  it('回報 JSON 解析失敗與結構不符', () => {
    expect(() => parseIssues('nope')).toThrow('Issue 清單 JSON 無法解析')
    expect(() => parseIssues('{"number":1}')).toThrow('Issue 清單結構不符')
  })
})

describe('graph', () => {
  it('只用 Issue 清單時輸出工作項', () => {
    const doc = graph({ repo: 'a/b', system: 'a/b', limit: 200 }, deps())
    expect(doc.system).toBe('a/b')
    expect(doc.generated_at).toBe('2026-10-18T01:00:00Z')
    expect(doc.nodes.map((n) => n.id)).toContain('issue:1')
  })

  it('帶入 process、模組與閘門', () => {
    const doc = graph(
      {
        repo: 'a/b',
        system: 'aswf-dev/example',
        processPath: 'process.yaml',
        modulesPath: 'modules.yaml',
        trackingIssue: 9,
        limit: 200,
      },
      deps(),
    )
    expect(doc.nodes.find((n) => n.kind === 'system')).toMatchObject({ scale: 'S' })
    expect(doc.nodes.find((n) => n.kind === 'module')?.id).toBe('aswf-dev/example/billing')
    expect(doc.gates.map((gate) => gate.id)).toEqual(['HG1', 'HG2', 'HG4', 'HG5', 'HG6', 'HG7'])
    expect(doc.gates.find((gate) => gate.id === 'HG2')).toMatchObject({ state: 'signed', signed_by: 'alice' })
    expect(doc.gates.find((gate) => gate.id === 'HG1')).toMatchObject({ state: 'missing' })
  })

  it('模板已宣告 gates 時不硬列 HG7（P5 專用）', () => {
    const doc = graph(
      {
        repo: 'a/b',
        system: 'aswf-dev/example',
        processPath: 'process.yaml',
        modulesPath: 'modules.yaml',
        templatePath: 'template.yaml',
        trackingIssue: 9,
        limit: 200,
      },
      deps({
        readFile: (path) =>
          path.endsWith('modules.yaml')
            ? modulesYaml
            : path.endsWith('template.yaml')
              ? [
                  'tenant: factory',
                  'name: S',
                  'version: 1',
                  'source: test fixture',
                  'phases: [P0]',
                  'gates: [HG1, HG2, HG4, HG5, HG6]',
                  'steps:',
                  '  - {id: S1, phase: P0, action: 需求, kind: human}',
                ].join('\n')
              : processYaml,
      }),
    )
    expect(doc.gates.map((gate) => gate.id)).toEqual(['HG1', 'HG2', 'HG4', 'HG5', 'HG6'])
  })

  it('指定 generated-at 時不呼叫 now', () => {
    const doc = graph(
      { repo: 'a/b', system: 'a/b', limit: 200, generatedAt: '2026-10-18T09:00:00Z' },
      deps({ now: () => { throw new Error('now 不該被呼叫') } }),
    )
    expect(doc.generated_at).toBe('2026-10-18T09:00:00Z')
  })

  it('process 或模組檔案無效時拋出 CliError', () => {
    const broken = deps({ readFile: () => 'system: [unclosed' })
    expect(() => graph({ repo: 'a/b', system: 'a/b', limit: 200, processPath: 'p.yaml' }, broken)).toThrow('p.yaml 無效')
    expect(() => graph({ repo: 'a/b', system: 'a/b', limit: 200, modulesPath: 'm.yaml' }, broken)).toThrow('m.yaml 無效')
  })

  it('把正確的 gh 參數傳給 CLI', () => {
    const calls: string[][] = []
    const gh: GhRunner = (args) => {
      calls.push(args)
      if (args[0] === 'issue') return issuesJson
      if (args[0] === 'pr') return '[]'
      return commentsJson
    }
    graph({ repo: 'a/b', system: 'a/b', limit: 5, trackingIssue: 9 }, deps({ gh }))
    expect(calls[0]).toEqual([
      'issue',
      'list',
      '--repo',
      'a/b',
      '--state',
      'all',
      '--limit',
      '5',
      '--json',
      'number,title,body,labels,state',
    ])
    expect(calls[1]).toEqual(['api', '--paginate', '--slurp', 'repos/a/b/issues/9/comments'])
    expect(calls[2]).toEqual([
      'pr',
      'list',
      '--repo',
      'a/b',
      '--state',
      'all',
      '--limit',
      '5',
      '--json',
      'number,state,mergedAt,headRefName,body',
    ])
  })
})

describe('main', () => {
  it('由 argv 組出文件', () => {
    const doc = main(['--repo', 'a/b', '--system', 'aswf-dev/example'], deps())
    expect(doc.nodes[0]?.id).toBe('aswf-dev/example')
  })
})

describe('offline inputs（--issues-file／--comments-file）', () => {
  it('--issues-file 取代 gh issue list，完全不呼叫 gh', () => {
    const calls: string[][] = []
    const fake: GraphDeps = {
      gh: (args) => {
        calls.push(args)
        throw new Error('gh should not be called in offline mode')
      },
      readFile: (path) => (path === 'issues.json' ? issuesJson : processYaml),
      now: () => '2026-10-18T01:00:00Z',
    }
    const doc = graph(parseOptions(['--repo', 'a/b', '--issues-file', 'issues.json']), fake)
    expect(doc.nodes.some((node) => node.id === 'issue:1')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('--comments-file 取代 comments API，HG 狀態仍可解讀', () => {
    const fake: GraphDeps = {
      gh: () => {
        throw new Error('gh should not be called in offline mode')
      },
      readFile: (path) => {
        if (path === 'issues.json') return issuesJson
        if (path === 'comments.json') return commentsJson
        return processYaml
      },
      now: () => '2026-10-18T01:00:00Z',
    }
    const doc = graph(
      parseOptions([
        '--repo',
        'a/b',
        '--issues-file',
        'issues.json',
        '--tracking-issue',
        '391',
        '--comments-file',
        'comments.json',
      ]),
      fake,
    )
    expect(doc.gates.find((gate) => gate.id === 'HG2')).toMatchObject({ state: 'signed', signed_by: 'alice' })
  })
})

describe('--prs-file（離線 PR 狀態）', () => {
  it('merged PR 讓離線 Issue 視為完成', () => {
    const prsJson = JSON.stringify([
      {
        number: 900,
        state: 'MERGED',
        mergedAt: '2026-10-18T00:00:00Z',
        headRefName: 'factory/1-01-test',
        body: '',
      },
    ])
    const fake: GraphDeps = {
      gh: () => {
        throw new Error('gh should not be called in offline mode')
      },
      readFile: (path) => {
        if (path === 'issues.json') return issuesJson
        if (path === 'prs.json') return prsJson
        return processYaml
      },
      now: () => '2026-10-18T01:00:00Z',
    }
    const doc = graph(
      parseOptions(['--repo', 'a/b', '--issues-file', 'issues.json', '--prs-file', 'prs.json']),
      fake,
    )
    expect(doc.nodes.find((node) => node.id === 'issue:1')?.state).toBe('closed')
  })
})

describe('parsePullRequests', () => {
  it('JSON 無法解析時丟出 CliError', () => {
    expect(() => parsePullRequests('not json')).toThrowError(/PR 清單 JSON 無法解析/)
  })

  it('結構不符時丟出 CliError', () => {
    expect(() => parsePullRequests(JSON.stringify([{ number: 1 }]))).toThrowError(/PR 清單結構不符/)
  })

  it('body 為 null 時正規化為空字串', () => {
    const [pr] = parsePullRequests(
      JSON.stringify([{ number: 1, state: 'OPEN', mergedAt: null, headRefName: 'x', body: null }]),
    )
    expect(pr?.body).toBe('')
  })
})
