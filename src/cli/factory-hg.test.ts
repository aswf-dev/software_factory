import { describe, expect, it } from 'vitest'
import { main, parseComments, parseOptions, resolveSignerPermissions, show } from './factory-hg.js'
import type { GhRunner } from './factory-hg.js'

/** 權限查詢（collaborator permission API）的假回應；其他呼叫回傳留言頁。 */
const isPermissionCall = (args: readonly string[]): boolean => args.some((arg) => arg.endsWith('/permission'))
const withPermission =
  (comments: string, permission = 'write'): GhRunner =>
  (args) =>
    isPermissionCall(args) ? permission : comments

function page(items: unknown[]): string {
  return JSON.stringify([items])
}

const signedComment = {
  id: 1,
  body: '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->',
  user: { login: 'alice' },
  created_at: '2026-10-18T00:00:00Z', author_association: 'MEMBER',
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
      return withPermission(page([signedComment]))(args)
    }
    const result = show({ repo: 'a/b', issue: 7, gates: ['HG1', 'HG2'], scope: 'system' }, gh)

    expect(calls).toEqual([
      ['api', '--paginate', '--slurp', 'repos/a/b/issues/7/comments'],
      // 每位有標記留言的作者查一次 repo 權限（#126）
      ['api', `repos/a/b/collaborators/${signedComment.user.login}/permission`, '--jq', '.permission'],
    ])
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
    const gh: GhRunner = withPermission(page([signedComment]))
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
  user: { login: 'security-lead' },
  created_at: '2026-10-18T01:00:00Z', author_association: 'MEMBER',
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
      withPermission(page([customComment])),
      () => templateYaml,
    )
    expect(result.warnings).toEqual([])
    expect(result.gates.find((gate) => gate.id === 'ACME-SECURITY')).toMatchObject({
      state: 'signed',
      signed_by: 'security-lead',
    })
    expect(result.gates.find((gate) => gate.id === 'HG2')).toMatchObject({ state: 'missing' })
  })

  it('不在 gate_defs.signers 的帳號簽核自訂閘門 → 不採計並寫 warning', () => {
    const result = show(
      { repo: 'a/b', issue: 7, gates: ['HG1'], scope: 'system', templatePath: 't.yaml' },
      withPermission(page([{ ...customComment, user: { login: 'bob' } }])),
      () => templateYaml,
    )
    expect(result.gates.find((gate) => gate.id === 'ACME-SECURITY')).toMatchObject({ state: 'missing' })
    expect(result.warnings.join('\n')).toContain('bob 不在 ACME-SECURITY 的 signers')
  })

  it('parseComments 帶出 author_association；缺席時不填', () => {
    const [withAssoc, without] = parseComments(
      page([customComment, { id: 9, body: 'x', user: { login: 'z' }, created_at: '2026-10-18T02:00:00Z' }]),
    )
    expect(withAssoc?.association).toBe('MEMBER')
    expect(without).not.toHaveProperty('association')
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

describe('resolveSignerPermissions（#126）', () => {
  const marker = (id: number, author: string, association = 'NONE') => ({
    id,
    body: '<!-- factory:hg id=HG1 state=signed evidence=https://a.test -->',
    author,
    createdAt: `2026-10-21T0${id}:00:00Z`,
    association,
  })

  it('每位作者只查一次；bot、沒有標記、空作者不查', () => {
    const calls: string[][] = []
    const gh: GhRunner = (args) => {
      calls.push(args)
      return 'admin\n'
    }
    const { comments, warnings } = resolveSignerPermissions(
      [
        marker(1, 'philipz'),
        marker(2, 'philipz'),
        marker(3, 'softwarefactory-bot[bot]'),
        { id: 4, body: '只是討論', author: 'carol', createdAt: '2026-10-21T04:00:00Z' },
        marker(5, ''),
      ],
      'agent-playground/restate',
      gh,
    )
    expect(calls).toEqual([['api', 'repos/agent-playground/restate/collaborators/philipz/permission', '--jq', '.permission']])
    expect(comments.map((c) => c.permission)).toEqual(['admin', 'admin', undefined, undefined, undefined])
    expect(warnings).toEqual([])
  })

  it('404 → none（明確沒有權限）', () => {
    const gh: GhRunner = () => {
      throw new Error('gh: Not Found (HTTP 404)')
    }
    const { comments, warnings } = resolveSignerPermissions([marker(1, 'stranger')], 'a/b', gh)
    expect(comments[0]?.permission).toBe('none')
    expect(warnings).toEqual([])
  })

  it('其他錯誤 → 不填權限、寫 warning，交給 association 備援', () => {
    const gh: GhRunner = () => {
      throw new Error('gh: Must have push access to view collaborator permission. (HTTP 403)\nmore')
    }
    const { comments, warnings } = resolveSignerPermissions([marker(1, 'alice', 'OWNER')], 'a/b', gh)
    expect(comments[0]?.permission).toBeUndefined()
    expect(warnings[0]).toContain('查不到 alice 對 a/b 的權限（gh: Must have push access')
    expect(warnings[0]).not.toContain('more')
  })

  it('execFileSync 形式的錯誤：warning 顯示含 HTTP 狀態的那一行，而不是 Command failed', () => {
    const gh: GhRunner = () => {
      throw new Error('Command failed: gh api repos/a/b/collaborators/x/permission\n{"message":"Must have push access"}\ngh: Must have push access to view collaborator permission. (HTTP 403)')
    }
    const { warnings } = resolveSignerPermissions([marker(1, 'x')], 'a/b', gh)
    expect(warnings[0]).toContain('(HTTP 403)')
    expect(warnings[0]).not.toContain('Command failed')
  })

  it('錯誤訊息只有空行時退回整段訊息', () => {
    const gh: GhRunner = () => {
      throw new Error('\n')
    }
    expect(resolveSignerPermissions([marker(1, 'x')], 'a/b', gh).warnings[0]).toContain('查不到 x')
  })

  it('非 Error 的例外也能處理；空字串回應視為查不到', () => {
    const thrower: GhRunner = () => {
      throw 'boom'
    }
    expect(resolveSignerPermissions([marker(1, 'x')], 'a/b', thrower).warnings[0]).toContain('boom')
    expect(resolveSignerPermissions([marker(1, 'x')], 'a/b', () => '  ').comments[0]?.permission).toBeUndefined()
  })

  it('show：不公開組織成員（association=NONE、repo 權限 admin）的簽核被採計', () => {
    const result = show(
      { repo: 'a/b', issue: 7, gates: ['HG2'], scope: 'system' },
      withPermission(page([{ ...signedComment, author_association: 'NONE' }]), 'admin'),
    )
    expect(result.gates.find((g) => g.id === 'HG2')).toMatchObject({ state: 'signed', signed_by: 'alice' })
  })
})
