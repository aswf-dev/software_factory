import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildBlockComment, computeScoreLabels, main } from './apply-score-labels.js'
import { CliError } from './run-cli.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'apply-score-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeScore(score: unknown, name = 'score.json'): string {
  const p = join(tmp, name)
  writeFileSync(p, JSON.stringify(score))
  return p
}

describe('computeScoreLabels（純函式）', () => {
  it('on-loop → 貼 oversight/on-loop，不擋', () => {
    const out = computeScoreLabels({ total: 0, tier: 'on-loop', label: 'oversight/on-loop' })
    expect(out.labels).toEqual(['oversight/on-loop'])
    expect(out.blocked).toBe(false)
  })
  it('review → 貼標籤，不擋', () => {
    const out = computeScoreLabels({ total: 3, tier: 'review', label: 'oversight/review' })
    expect(out.blocked).toBe(false)
  })
  it('in-loop → 擋下 agent 並產出說明留言', () => {
    const out = computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' })
    expect(out.blocked).toBe(true)
    expect(buildBlockComment(6)).toContain('human-in-the-loop')
  })
})

describe('main（注入 fake gh）', () => {
  it('非 in-loop → 只貼標籤，不留言、不阻斷', () => {
    const gh = vi.fn()
    const out = main([String(101), writeScore({ score: { total: 0, tier: 'on-loop', label: 'oversight/on-loop' } })], gh)
    expect(out.blocked).toBe(false)
    expect(gh).toHaveBeenCalledWith(['issue', 'edit', '101', '--add-label', 'oversight/on-loop'])
    expect(gh).not.toHaveBeenCalledWith(expect.arrayContaining(['comment']))
  })

  it('in-loop → 貼標籤 + 留言（阻斷訊號由 entrypoint 轉 exit 1）', () => {
    const gh = vi.fn()
    const out = main([String(102), writeScore({ score: { total: 6, tier: 'in-loop', label: 'oversight/in-loop' } })], gh)
    expect(out.blocked).toBe(true)
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '102', '--body', expect.stringContaining('human-in-the-loop')])
  })

  it('score.json 格式錯誤 → CliError（fail-loud）', () => {
    const p = writeScore({ score: { total: 'x' } }, 'bad.json')
    expect(() => main(['103', p], vi.fn())).toThrow(CliError)
  })

  it('score.json 不是物件（root-level 錯誤）→ CliError，訊息含 (root)', () => {
    const p = join(tmp, 'root.json')
    writeFileSync(p, JSON.stringify('not-an-object'))
    expect(() => main(['104', p], vi.fn())).toThrow(/\(root\)/)
  })

  it('缺 scorePath（有 issueNumber）→ CliError', () => {
    expect(() => main(['105'], vi.fn())).toThrow(/scorePath/)
  })

  it('缺參數 → CliError', () => {
    expect(() => main([], vi.fn())).toThrow(CliError)
  })
})
