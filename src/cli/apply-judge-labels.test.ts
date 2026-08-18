import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildJudgeComment,
  computeJudgeLabels,
  main,
  PHASE1_HUMAN_REVIEW_NOTE,
} from './apply-judge-labels.js'
import { CliError } from './run-cli.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'apply-judge-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeJudge(result: unknown, name = 'judge.json'): string {
  const p = join(tmp, name)
  writeFileSync(p, JSON.stringify({ result }))
  return p
}

const RESULT = (outcome: string, labels: string[], summary: string): unknown => ({
  outcome,
  labels,
  summary,
})

describe('computeJudgeLabels（純函式）', () => {
  it('ready-to-automerge → Phase 1 仍標記等待人類審查，不自動合併', () => {
    const out = computeJudgeLabels(RESULT('ready-to-automerge', ['oversight/on-loop'], 'ok') as never)
    expect(out.labels).toContain('oversight/on-loop')
    expect(out.requiresHuman).toBe(true)
    expect(buildJudgeComment('ready-to-automerge', 'ok')).toContain(PHASE1_HUMAN_REVIEW_NOTE)
  })
  it('needs-human → 貼 needs-human 標籤並附交還說明', () => {
    const out = computeJudgeLabels(RESULT('needs-human', ['needs-human'], 'SR3 觸發') as never)
    expect(out.labels).toContain('needs-human')
    expect(out.requiresHuman).toBe(true)
  })
  it('needs-human 但 labels 缺 needs-human → 補上（不重複）', () => {
    const out = computeJudgeLabels(RESULT('needs-human', ['oversight/review'], 'x') as never)
    expect(out.labels).toEqual(['oversight/review', 'needs-human'])
  })
  it('blocked-in-loop → 不貼 needs-human（agent 從未執行，apply-score-labels 已留言）', () => {
    const out = computeJudgeLabels(RESULT('blocked-in-loop', ['oversight/in-loop'], 'x') as never)
    expect(out.labels).not.toContain('needs-human')
    expect(out.requiresHuman).toBe(false)
  })
  it('非 automerge 結局 → 留言不含 Phase 1 人審註記（false 分支）', () => {
    const comment = buildJudgeComment('needs-human', 'SR3 觸發')
    expect(comment).toContain('SR3 觸發')
    expect(comment).not.toContain(PHASE1_HUMAN_REVIEW_NOTE)
  })
})

describe('main（注入 fake gh）', () => {
  it('貼標籤並留言（含 Phase 1 人審註記）', () => {
    const gh = vi.fn()
    const out = main(
      [String(201), writeJudge(RESULT('ready-to-automerge', ['oversight/on-loop'], 'ok'))],
      gh,
    )
    expect(out.labels).toContain('oversight/on-loop')
    expect(gh).toHaveBeenCalledWith(['issue', 'edit', '201', '--add-label', 'oversight/on-loop'])
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '201', '--body', expect.stringContaining(PHASE1_HUMAN_REVIEW_NOTE)])
  })

  it('judge.json 格式錯誤 → CliError（fail-loud）', () => {
    const p = writeJudge(RESULT('bogus', [], ''), 'bad.json')
    expect(() => main(['202', p], vi.fn())).toThrow(CliError)
  })

  it('judge.json 不是物件（root-level 錯誤）→ CliError，訊息含 (root)', () => {
    const p = join(tmp, 'root.json')
    writeFileSync(p, JSON.stringify('not-an-object'))
    expect(() => main(['203', p], vi.fn())).toThrow(/\(root\)/)
  })

  it('缺 judgePath（有 issueNumber）→ CliError', () => {
    expect(() => main(['204'], vi.fn())).toThrow(/judgePath/)
  })

  it('缺參數 → CliError', () => {
    expect(() => main([], vi.fn())).toThrow(CliError)
  })
})
