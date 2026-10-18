import { describe, expect, it } from 'vitest'
import { main, parseComments, parseOptions, show } from './factory-hg.js'
import type { GhRunner } from './factory-hg.js'

function page(items: unknown[]): string {
  return JSON.stringify([items])
}

const signedComment = {
  id: 1,
  body: '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->',
  user: { login: 'alice' },
  created_at: '2026-10-18T00:00:00Z',
}

describe('parseOptions', () => {
  it('解析 repo 與 issue', () => {
    expect(parseOptions(['--repo', 'aswf-dev/software_factory', '--issue', '12'])).toEqual({
      repo: 'aswf-dev/software_factory',
      issue: 12,
      gates: ['HG1', 'HG2', 'HG4', 'HG5', 'HG6', 'HG7'],
      scope: 'system',
    })
  })

  it('接受 --gates 與 --scope，並去除重複', () => {
    const options = parseOptions([
      '--repo',
      'a/b',
      '--issue',
      '3',
      '--gates',
      'HG2, HG5,HG2',
      '--scope',
      'billing',
    ])
    expect(options.gates).toEqual(['HG2', 'HG5'])
    expect(options.scope).toBe('billing')
  })

  it('拒絕非旗標參數', () => {
    expect(() => parseOptions(['show'])).toThrow('無法辨識的參數')
  })

  it('拒絕缺少值的旗標', () => {
    expect(() => parseOptions(['--repo'])).toThrow('需要一個值')
    expect(() => parseOptions(['--repo', '--issue', '1'])).toThrow('需要一個值')
  })

  it('拒絕缺少 --repo', () => {
    expect(() => parseOptions(['--issue', '1'])).toThrow('缺少 --repo')
  })

  it('拒絕格式不正確的 --repo', () => {
    expect(() => parseOptions(['--repo', 'no-slash', '--issue', '1'])).toThrow('--repo 格式不正確')
  })

  it('拒絕缺少 --issue', () => {
    expect(() => parseOptions(['--repo', 'a/b'])).toThrow('缺少 --issue')
  })

  it('拒絕非數字 --issue', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--issue', 'x'])).toThrow('--issue 必須是正整數')
  })

  it('拒絕 0', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--issue', '0'])).toThrow('--issue 必須是正整數')
  })

  it('拒絕未知的閘門 id', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--issue', '1', '--gates', 'HG9'])).toThrow('未知的閘門 id')
  })

  it('拒絕空的閘門清單', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--issue', '1', '--gates', ','])).toThrow('至少要指定一個閘門')
  })

  it('拒絕空白的 --scope', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--issue', '1', '--scope', ' '])).toThrow('--scope 不可為空')
  })
})

describe('parseComments', () => {
  it('攤平多頁輸出', () => {
    const raw = JSON.stringify([[signedComment], [{ ...signedComment, id: 2 }]])
    expect(parseComments(raw).map((c) => c.id)).toEqual([1, 2])
  })

  it('body 與 user 為 null 時帶入空字串', () => {
    const raw = page([{ id: 3, body: null, user: null, created_at: '2026-10-18T00:00:00Z' }])
    expect(parseComments(raw)).toEqual([
      { id: 3, body: '', author: '', createdAt: '2026-10-18T00:00:00Z' },
    ])
  })

  it('JSON 無法解析時報錯', () => {
    expect(() => parseComments('not json')).toThrow('留言 JSON 無法解析')
  })

  it('結構不符時報錯', () => {
    expect(() => parseComments('{"id":1}')).toThrow('留言 JSON 結構不符')
  })
})

describe('show', () => {
  it('呼叫 gh api 並回傳閘門狀態', () => {
    const calls: string[][] = []
    const gh: GhRunner = (args) => {
      calls.push(args)
      return page([signedComment])
    }
    const result = show({ repo: 'a/b', issue: 7, gates: ['HG1', 'HG2'], scope: 'system' }, gh)

    expect(calls).toEqual([['api', '--paginate', '--slurp', 'repos/a/b/issues/7/comments']])
    expect(result.repo).toBe('a/b')
    expect(result.issue).toBe(7)
    expect(result.scope).toBe('system')
    expect(result.gates).toEqual([
      { id: 'HG1', scope: 'system', state: 'missing' },
      {
        id: 'HG2',
        scope: 'system',
        state: 'signed',
        signed_by: 'alice',
        signed_at: '2026-10-18T00:00:00Z',
        evidence: 'https://a.test',
      },
    ])
    expect(result.warnings).toEqual([])
  })
})

describe('main', () => {
  it('由 argv 組出結果', () => {
    const gh: GhRunner = () => page([signedComment])
    const result = main(['--repo', 'a/b', '--issue', '7', '--gates', 'HG2'], gh)
    expect(result.gates).toEqual([
      {
        id: 'HG2',
        scope: 'system',
        state: 'signed',
        signed_by: 'alice',
        signed_at: '2026-10-18T00:00:00Z',
        evidence: 'https://a.test',
      },
    ])
  })
})

const templateYaml = [
  'tenant: acme',
  'name: review-first',
  'version: 1',
  'source: test',
  'phases: [P0]',
  'gates: [HG1, HG2, HG4, HG5, HG6, ACME-SECURITY]',
  'gate_defs:',
  '  - {id: ACME-SECURITY, signers: [security-lead], scope: phase, evidence: adr}',
  'steps:',
  '  - {id: M0, phase: P0, action: x, kind: human}',
].join('\n')

const customComment = {
  id: 2,
  body: '<!-- factory:gate id=ACME-SECURITY state=signed evidence=https://a.test -->',
  user: { login: 'bob' },
  created_at: '2026-10-18T01:00:00Z',
}

describe('自訂閘門（--template，ADR-025）', () => {
  it('parseOptions 接受 --template 與自訂 gate id', () => {
    const options = parseOptions([
      '--repo',
      'a/b',
      '--issue',
      '3',
      '--gates',
      'HG2,ACME-SECURITY',
      '--template',
      't.yaml',
    ])
    expect(options.gates).toEqual(['HG2', 'ACME-SECURITY'])
    expect(options.templatePath).toBe('t.yaml')
  })

  it('模板宣告的自訂閘門可被解析為 signed', () => {
    const result = show(
      { repo: 'a/b', issue: 7, gates: ['HG1'], scope: 'system', templatePath: 't.yaml' },
      () => page([customComment]),
      () => templateYaml,
    )
    expect(result.warnings).toEqual([])
    expect(result.gates.find((gate) => gate.id === 'ACME-SECURITY')).toMatchObject({ state: 'signed', signed_by: 'bob' })
    expect(result.gates.find((gate) => gate.id === 'HG2')).toMatchObject({ state: 'missing' })
  })

  it('模板無效時丟出 CliError', () => {
    expect(() =>
      show(
        { repo: 'a/b', issue: 7, gates: ['HG1'], scope: 'system', templatePath: 'bad.yaml' },
        () => page([]),
        () => 'not: [valid',
      ),
    ).toThrowError(/bad\.yaml 無效/)
  })

  it('--gates 的格式不符會被拒', () => {
    expect(() => parseOptions(['--repo', 'a/b', '--issue', '3', '--gates', 'acme-lower'])).toThrow(
      /未知的閘門 id/,
    )
  })
})
