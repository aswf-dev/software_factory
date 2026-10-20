import { describe, expect, it } from 'vitest'
import {
  HG_IDS,
  TRACKED_GATE_IDS,
  collectEvents,
  gateReport,
  isBotAuthor,
  parseCommentEvents,
  reduceGates,
  signersOf,
} from './parse.js'
import type { HgComment, HgEvent } from './parse.js'

function comment(
  id: number,
  body: string,
  createdAt = '2026-10-18T00:00:00Z',
  author = 'alice',
  /** `null` = 留言沒有 author_association 欄位。 */
  association: string | null = 'MEMBER',
): HgComment {
  return association === null ? { id, body, author, createdAt } : { id, body, author, createdAt, association }
}

describe('isBotAuthor', () => {
  it('以 [bot] 結尾者視為機器人', () => {
    expect(isBotAuthor('aswf-factory[bot]')).toBe(true)
  })

  it('一般帳號不是機器人', () => {
    expect(isBotAuthor('alice')).toBe(false)
  })
})

describe('parseCommentEvents', () => {
  it('解析合法的簽核標記', () => {
    const { events, warnings } = parseCommentEvents(
      comment(
        1,
        '<!-- factory:hg id=HG2 state=signed evidence=https://example.test/issue/1 -->\nHG2 已簽核。',
      ),
    )
    expect(warnings).toEqual([])
    expect(events).toEqual([
      {
        id: 'HG2',
        scope: 'system',
        action: 'signed',
        by: 'alice',
        at: '2026-10-18T00:00:00Z',
        evidence: 'https://example.test/issue/1',
      },
    ])
  })

  it('一個留言可以帶多個標記', () => {
    const { events } = parseCommentEvents(
      comment(
        2,
        '<!-- factory:hg id=HG1 state=signed evidence=https://a.test -->\n<!-- factory:hg id=HG2 scope=system state=signed evidence=https://b.test -->',
      ),
    )
    expect(events.map((e) => e.id)).toEqual(['HG1', 'HG2'])
  })

  it('revoked 不需要證據連結，且 evidence 為空字串', () => {
    const { events, warnings } = parseCommentEvents(comment(3, '<!-- factory:hg id=HG2 state=revoked -->'))
    expect(warnings).toEqual([])
    expect(events[0]?.action).toBe('revoked')
    expect(events[0]?.evidence).toBe('')
  })

  it('忽略機器人的留言', () => {
    const { events } = parseCommentEvents(
      comment(4, '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->', undefined, 'x[bot]'),
    )
    expect(events).toEqual([])
  })

  it('沒有標記的留言不產生事件也不產生 warning', () => {
    expect(parseCommentEvents(comment(5, '只是一段說明'))).toEqual({ events: [], warnings: [] })
  })

  it('未知的閘門 id 產生 warning 並跳過', () => {
    const { events, warnings } = parseCommentEvents(
      comment(6, '<!-- factory:hg id=HG9 state=signed evidence=https://a.test -->'),
    )
    expect(events).toEqual([])
    expect(warnings[0]).toContain('未知的閘門 id')
  })

  it('缺少 id 時產生 warning', () => {
    const { warnings } = parseCommentEvents(comment(7, '<!-- factory:hg state=signed evidence=https://a.test -->'))
    expect(warnings[0]).toContain('未知的閘門 id')
  })

  it('state 不合法時產生 warning 並跳過', () => {
    const { events, warnings } = parseCommentEvents(
      comment(8, '<!-- factory:hg id=HG2 state=bogus evidence=https://a.test -->'),
    )
    expect(events).toEqual([])
    expect(warnings[0]).toContain('state 必須是 signed 或 revoked')
  })

  it('缺少 state 時產生 warning', () => {
    const { warnings } = parseCommentEvents(comment(9, '<!-- factory:hg id=HG2 -->'))
    expect(warnings[0]).toContain('state 必須是 signed 或 revoked')
  })

  it('簽核缺少證據連結時拒絕', () => {
    const { events, warnings } = parseCommentEvents(comment(10, '<!-- factory:hg id=HG2 state=signed -->'))
    expect(events).toEqual([])
    expect(warnings[0]).toContain('缺證據連結')
  })

  it('證據不是 http(s) URL 時拒絕', () => {
    const { warnings } = parseCommentEvents(
      comment(11, '<!-- factory:hg id=HG2 state=signed evidence=ftp://a.test -->'),
    )
    expect(warnings[0]).toContain('缺證據連結')
  })

  it('忽略沒有等號的屬性片段與多餘空白', () => {
    const { events } = parseCommentEvents(
      comment(12, '<!-- factory:hg  id=HG2   flag  state=signed  evidence=https://a.test -->'),
    )
    expect(events).toHaveLength(1)
  })
})

describe('collectEvents', () => {
  it('依時間排序，後者覆蓋前者所需的順序', () => {
    const comments = [
      comment(20, '<!-- factory:hg id=HG2 state=revoked -->', '2026-10-18T02:00:00Z', 'bob'),
      comment(10, '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->', '2026-10-18T01:00:00Z'),
    ]
    const { events } = collectEvents(comments)
    expect(events.map((e) => e.action)).toEqual(['signed', 'revoked'])
  })

  it('時間相同時以留言 id 決勝', () => {
    const comments = [
      comment(31, '<!-- factory:hg id=HG2 state=revoked -->'),
      comment(30, '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->'),
    ]
    const { events } = collectEvents(comments)
    expect(events.map((e) => e.action)).toEqual(['signed', 'revoked'])
  })

  it('彙整所有留言的 warnings', () => {
    const comments = [
      comment(40, '<!-- factory:hg id=HG9 state=signed evidence=https://a.test -->'),
      comment(41, '<!-- factory:hg id=HG2 state=bogus -->'),
    ]
    expect(collectEvents(comments).warnings).toHaveLength(2)
  })
})

describe('reduceGates', () => {
  const signed = (id: HgEvent['id'], at = '2026-10-18T00:00:00Z', scope = 'system'): HgEvent => ({
    id,
    scope,
    action: 'signed',
    by: 'alice',
    at,
    evidence: 'https://a.test',
  })

  it('沒有事件的閘門為 missing', () => {
    expect(reduceGates([], ['HG1', 'HG2'])).toEqual([
      { id: 'HG1', scope: 'system', state: 'missing' },
      { id: 'HG2', scope: 'system', state: 'missing' },
    ])
  })

  it('已簽核的閘門帶簽核人、時間與證據', () => {
    const [gate] = reduceGates([signed('HG2')], ['HG2'])
    expect(gate).toEqual({
      id: 'HG2',
      scope: 'system',
      state: 'signed',
      signed_by: 'alice',
      signed_at: '2026-10-18T00:00:00Z',
      evidence: 'https://a.test',
    })
  })

  it('撤回後回到 missing', () => {
    const events: HgEvent[] = [signed('HG2'), { ...signed('HG2'), action: 'revoked', evidence: '' }]
    expect(reduceGates(events, ['HG2'])[0]?.state).toBe('missing')
  })

  it('模組層級（非預設 scope）的閘門另外列出', () => {
    const gates = reduceGates([signed('HG5', '2026-10-18T00:00:00Z', 'billing')], ['HG5'])
    expect(gates).toEqual([
      { id: 'HG5', scope: 'billing', state: 'signed', signed_by: 'alice', signed_at: '2026-10-18T00:00:00Z', evidence: 'https://a.test' },
      { id: 'HG5', scope: 'system', state: 'missing' },
    ])
  })

  it('非預設 scope 但不在 expectedIds 的閘門不輸出', () => {
    const gates = reduceGates([signed('HG5', '2026-10-18T00:00:00Z', 'billing')], ['HG1'])
    expect(gates.map((g) => g.id)).toEqual(['HG1'])
  })

  it('同一閘門多個 scope 時依 scope 排序', () => {
    const gates = reduceGates(
      [signed('HG5', '2026-10-18T00:00:00Z', 'billing'), signed('HG5', '2026-10-18T00:00:00Z', 'system')],
      ['HG5'],
    )
    expect(gates.map((g) => g.scope)).toEqual(['billing', 'system'])
  })

  it('輸出依閘門 id 排序', () => {
    const gates = reduceGates([], ['HG6', 'HG1', 'HG2'])
    expect(gates.map((g) => g.id)).toEqual(['HG1', 'HG2', 'HG6'])
  })
})

describe('gateReport', () => {
  it('預設使用導入追蹤 Issue 記錄的閘門', () => {
    const report = gateReport([])
    expect(report.gates.map((g) => g.id)).toEqual([...TRACKED_GATE_IDS])
    expect(report.warnings).toEqual([])
  })

  it('回報 warnings 與狀態', () => {
    const report = gateReport(
      [comment(1, '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->'), comment(2, '<!-- factory:hg id=HG9 state=signed evidence=https://a.test -->')],
      ['HG2'],
    )
    expect(report.gates).toEqual([
      { id: 'HG2', scope: 'system', state: 'signed', signed_by: 'alice', signed_at: '2026-10-18T00:00:00Z', evidence: 'https://a.test' },
    ])
    expect(report.warnings).toHaveLength(1)
  })

  it('HG_IDS 涵蓋 0–7', () => {
    expect([...HG_IDS]).toEqual(['HG0', 'HG1', 'HG2', 'HG3', 'HG4', 'HG5', 'HG6', 'HG7'])
  })
})

describe('自訂閘門（ADR-025）', () => {
  const custom = comment(
    20,
    '<!-- factory:gate id=ACME-SECURITY state=signed evidence=https://example.test/sec -->',
  )

  it('模板已宣告時，解析成事件並在期望清單中顯示', () => {
    const { events, warnings } = parseCommentEvents(custom, ['HG1', 'ACME-SECURITY'])
    expect(warnings).toEqual([])
    expect(events[0]).toMatchObject({ id: 'ACME-SECURITY', action: 'signed', scope: 'system' })

    const report = gateReport([custom], ['HG1', 'ACME-SECURITY'], 'system', ['HG1', 'ACME-SECURITY'])
    expect(report.gates.find((gate) => gate.id === 'ACME-SECURITY')).toMatchObject({ state: 'signed' })
    expect(report.gates.find((gate) => gate.id === 'HG1')).toMatchObject({ state: 'missing' })
  })

  it('未提供模板時不靜默接受', () => {
    const { events, warnings } = parseCommentEvents(custom)
    expect(events).toEqual([])
    expect(warnings[0]).toContain('未提供模板')
  })

  it('模板未宣告的自訂閘門產生 warning', () => {
    const { events, warnings } = parseCommentEvents(custom, ['HG1'])
    expect(events).toEqual([])
    expect(warnings[0]).toContain('模板未宣告')
  })

  it('factory:hg 不接受自訂 id；factory:gate 不接受 HG id', () => {
    const hgWithCustom = parseCommentEvents(
      comment(21, '<!-- factory:hg id=ACME-SECURITY state=signed evidence=https://a.test -->'),
      ['ACME-SECURITY'],
    )
    expect(hgWithCustom.events).toEqual([])
    expect(hgWithCustom.warnings[0]).toContain('未知的閘門 id')

    const gateWithHg = parseCommentEvents(
      comment(22, '<!-- factory:gate id=HG2 state=signed evidence=https://a.test -->'),
    )
    expect(gateWithHg.events).toEqual([])
    expect(gateWithHg.warnings[0]).toContain('TENANT-NAME')
  })

  it('缺少 id 的自訂閘門標記被拒', () => {
    const { events, warnings } = parseCommentEvents(
      comment(24, '<!-- factory:gate state=signed evidence=https://a.test -->'),
      ['ACME-SECURITY'],
    )
    expect(events).toEqual([])
    expect(warnings[0]).toContain('TENANT-NAME')
  })

  it('格式不符（沒有連字號）也被拒', () => {
    const { events, warnings } = parseCommentEvents(
      comment(23, '<!-- factory:gate id=ACME state=signed evidence=https://a.test -->'),
      ['ACME'],
    )
    expect(events).toEqual([])
    expect(warnings[0]).toContain('TENANT-NAME')
  })
})

describe('簽核身份（author_association 與 gate_defs.signers）', () => {
  const HG2 = '<!-- factory:hg id=HG2 state=signed evidence=https://a.test -->'

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('%s 可以簽核', (association) => {
    const { events, warnings } = parseCommentEvents(comment(1, HG2, undefined, 'alice', association))
    expect(events).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', null])(
    '%s（含缺席）不能簽核：不採計並寫 warning',
    (association) => {
      const { events, warnings } = parseCommentEvents(comment(2, HG2, undefined, 'stranger', association))
      expect(events).toEqual([])
      expect(warnings[0]).toContain('stranger 對此 repo 沒有簽核權限')
    },
  )

  it('無權限者也不能撤回別人的簽核', () => {
    const report = gateReport(
      [
        comment(1, HG2, '2026-10-18T00:00:00Z', 'owner', 'OWNER'),
        comment(2, '<!-- factory:hg id=HG2 state=revoked -->', '2026-10-18T01:00:00Z', 'stranger', 'NONE'),
      ],
      ['HG2'],
    )
    expect(report.gates[0]).toMatchObject({ state: 'signed', signed_by: 'owner' })
    expect(report.warnings).toHaveLength(1)
  })

  it('沒有標記的一般留言不檢查身份、不產生 warning', () => {
    expect(parseCommentEvents(comment(3, '只是討論', undefined, 'stranger', 'NONE'))).toEqual({ events: [], warnings: [] })
  })

  it('自訂閘門只接受 signers 名單內的帳號；HG 閘門不受 signers 影響', () => {
    const signers = signersOf([{ id: 'ACME-SECURITY', signers: ['security-lead'] }])
    const custom = '<!-- factory:gate id=ACME-SECURITY state=signed evidence=https://a.test -->'
    const declared = ['HG2', 'ACME-SECURITY']

    const byLead = parseCommentEvents(comment(4, custom, undefined, 'security-lead'), declared, signers)
    expect(byLead.events).toHaveLength(1)

    const byOther = parseCommentEvents(comment(5, custom, undefined, 'alice'), declared, signers)
    expect(byOther.events).toEqual([])
    expect(byOther.warnings[0]).toContain('alice 不在 ACME-SECURITY 的 signers（security-lead）')

    const hgByOther = parseCommentEvents(comment(6, HG2, undefined, 'alice'), declared, signers)
    expect(hgByOther.events).toHaveLength(1)
  })

  it('signersOf：沒有 gate_defs 時是空表（不限制）', () => {
    expect(signersOf(undefined).size).toBe(0)
  })
})
