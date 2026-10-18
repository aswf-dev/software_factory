import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GraphDocumentSchema, buildGraph } from './build.js'

/**
 * canonical fixture 是 Scoreboard 會 vendor 的檔案（#59）。它必須：
 *   1. 通過輸出契約 schema；
 *   2. 真的長得像 buildGraph 的輸出（節點／邊的 id 規則一致）；
 *   3. 標明是 SAMPLE DATA。
 * 若這支測試紅了，代表契約改了但 fixture 沒跟上——那正是漂移的起點。
 */
function readFixture(): unknown {
  const url = new URL('../../docs/research/fixtures/factory-graph.sample.json', import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8'))
}

describe('factory-graph canonical fixture', () => {
  it('通過輸出契約 schema', () => {
    const parsed = GraphDocumentSchema.safeParse(readFixture())
    expect(parsed.success).toBe(true)
  })

  it('標明是 SAMPLE DATA', () => {
    const fixture = readFixture() as { _comment: string }
    expect(fixture._comment).toContain('SAMPLE DATA')
  })

  it('節點與邊的 id 規則與 buildGraph 一致', () => {
    const fixture = GraphDocumentSchema.parse(readFixture())
    const ids = new Set(fixture.nodes.map((node) => node.id))
    for (const node of fixture.nodes) {
      if (node.kind === 'module') expect(node.id.startsWith(`${fixture.system}/`)).toBe(true)
      if (node.kind === 'workitem') expect(node.id.startsWith('issue:')).toBe(true)
    }
    for (const edge of fixture.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })

  it('工作項的前置邊與 prereqs 欄位一致', () => {
    const fixture = GraphDocumentSchema.parse(readFixture())
    for (const node of fixture.nodes) {
      if (node.kind !== 'workitem' || node.prereqs === undefined) continue
      const outbound = fixture.edges
        .filter((edge) => edge.kind === 'prerequisite' && edge.to === node.id)
        .map((edge) => Number(edge.from.replace('issue:', '')))
      expect(outbound.sort()).toEqual([...node.prereqs].sort())
    }
  })

  it('至少有一個已簽與一個未簽的閘門，足以驗證 UI 的「鎖」', () => {
    const fixture = GraphDocumentSchema.parse(readFixture())
    expect(fixture.gates.some((gate) => gate.state === 'signed')).toBe(true)
    expect(fixture.gates.some((gate) => gate.state === 'missing')).toBe(true)
  })

  it('warnings 只描述狀態，不包含派工指令（advisory 分離）', () => {
    const fixture = GraphDocumentSchema.parse(readFixture())
    for (const warning of fixture.warnings) {
      expect(warning.toLowerCase()).not.toContain('dispatch')
      expect(warning).not.toContain('請派工')
    }
  })

  it('buildGraph 的輸出與 fixture 具有相同的頂層欄位', () => {
    const doc = buildGraph({ system: 'a/b', issues: [], generatedAt: '2026-10-18T00:00:00Z' })
    expect(Object.keys(doc).sort()).toEqual(Object.keys(GraphDocumentSchema.parse(readFixture())).sort())
  })
})
