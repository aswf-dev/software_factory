import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('提供 usage markdown → 附加在留言尾段（--- 分隔）', () => {
    const comment = buildJudgeComment('ready-for-review', 'ok', '## 📊 Token 用量與成本\n\n- 總 token：100')
    expect(comment).toContain('---')
    expect(comment).toContain('## 📊 Token 用量與成本')
    expect(comment).toContain('總 token：100')
  })
  it('usage markdown 為空 → 不附加空段落', () => {
    const comment = buildJudgeComment('ready-for-review', 'ok', '   ')
    expect(comment).not.toContain('---')
    expect(comment).toBe('## 工廠執行結果：ready-for-review\n\nok')
  })

  // --- skill-gap（docs/25 §2.1、docs/20 E4）---

  it('hasSkillGap → 貼 skill-gap 標籤，且不改變 requiresHuman（分類訊號≠監督層級）', () => {
    const out = computeJudgeLabels(RESULT('ready-for-review', ['oversight/review'], 'ok') as never, true)
    expect(out.labels).toEqual(['oversight/review', 'skill-gap'])
    // requiresHuman 必須僅由 outcome 決定
    const noGap = computeJudgeLabels(RESULT('ready-for-review', ['oversight/review'], 'ok') as never, false)
    expect(out.requiresHuman).toBe(noGap.requiresHuman)
  })

  it('blocked-in-loop + skillGap → requiresHuman 仍為 false（skillGap 不得提升監督層級）', () => {
    const out = computeJudgeLabels(RESULT('blocked-in-loop', ['oversight/in-loop'], 'x') as never, true)
    expect(out.requiresHuman).toBe(false)
    expect(out.labels).toContain('skill-gap')
  })

  it('labels 已含 skill-gap → 不重複貼', () => {
    const out = computeJudgeLabels(RESULT('ready-for-review', ['skill-gap'], 'x') as never, true)
    expect(out.labels.filter((l) => l === 'skill-gap')).toHaveLength(1)
  })

  it('hasSkillGap 預設 false → 標籤與現況相同（既有呼叫端不受影響）', () => {
    const out = computeJudgeLabels(RESULT('ready-for-review', ['oversight/review'], 'x') as never)
    expect(out.labels).toEqual(['oversight/review'])
  })

  it('提供 skillGap markdown → 附加於 usage 之後', () => {
    const comment = buildJudgeComment('ready-for-review', 'ok', '## 用量', '### 🧩 技能缺口回報\n- **分類**：`a-b`')
    expect(comment.indexOf('## 用量')).toBeLessThan(comment.indexOf('### 🧩 技能缺口回報'))
  })

  it('無 usage 但有 skillGap → 仍以 --- 分隔附加', () => {
    const comment = buildJudgeComment('ready-for-review', 'ok', undefined, '### 🧩 技能缺口回報')
    expect(comment).toBe('## 工廠執行結果：ready-for-review\n\nok\n\n---\n\n### 🧩 技能缺口回報')
  })

  it('skillGap markdown 為空白 → 不附加空段落', () => {
    const comment = buildJudgeComment('ready-for-review', 'ok', undefined, '   ')
    expect(comment).toBe('## 工廠執行結果：ready-for-review\n\nok')
  })

  /**
   * D-1 回歸釘死：未回報 skillGap 時，留言必須與「本功能加入前」**逐字相同**。
   * docs/25 §2.1 明訂「skillGap 缺席 → 留言與現況逐字相同（容錯，不擋終態）」。
   */
  it('未回報 skillGap → 留言逐字等同現況（byte-identical 回歸）', () => {
    expect(buildJudgeComment('ready-for-review', 'ok')).toBe('## 工廠執行結果：ready-for-review\n\nok')
    expect(buildJudgeComment('ready-to-automerge', 'ok')).toBe(
      `## 工廠執行結果：ready-to-automerge\n\nok\n\n${PHASE1_HUMAN_REVIEW_NOTE}`,
    )
    expect(buildJudgeComment('ready-for-review', 'ok', '## 用量')).toBe(
      '## 工廠執行結果：ready-for-review\n\nok\n\n---\n\n## 用量',
    )
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

  it('第三參數為 usage markdown 檔 → 留言含用量段落', () => {
    const gh = vi.fn()
    const usagePath = join(tmp, 'usage.md')
    writeFileSync(usagePath, '## 📊 Token 用量與成本\n\n- 總 token：100')
    main([String(201), writeJudge(RESULT('ready-for-review', ['oversight/review'], 'ok'), 'with-usage.json'), usagePath], gh)
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '201', '--body', expect.stringContaining('總 token：100')])
  })

  it('第三參數指向不存在的檔 → 不附用量、不拋錯（量測是附註不是 gate）', () => {
    const gh = vi.fn()
    main([String(201), writeJudge(RESULT('ready-for-review', ['oversight/review'], 'ok'), 'missing-usage.json'), join(tmp, 'nope.md')], gh)
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '201', '--body', expect.not.stringContaining('Token 用量')])
  })

  it('第三參數為空字串 → 不附用量', () => {
    const gh = vi.fn()
    main([String(201), writeJudge(RESULT('ready-for-review', ['oversight/review'], 'ok'), 'empty-usage.json'), ''], gh)
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '201', '--body', expect.not.stringContaining('Token 用量')])
  })

  // --- skill-gap 端到端（judge.json 的 report.skillGap → 標籤 + 留言段落）---

  /** 寫一份含 report 區塊的 judge.json（factory-judge 的 JudgeCliOutput 形狀）。 */
  function writeJudgeWithReport(result: unknown, report: unknown, name: string): string {
    const p = join(tmp, name)
    writeFileSync(p, JSON.stringify({ result, report }))
    return p
  }

  it('judge.json 含 report.skillGap → 貼 skill-gap 標籤且留言含技能缺口段落', () => {
    const gh = vi.fn()
    const p = writeJudgeWithReport(
      RESULT('ready-for-review', ['oversight/review'], 'ok'),
      {
        issueNumber: 201,
        invocation: { exitCode: 0 },
        skillGap: { category: 'monorepo-test-path', needed: 'vitest 路徑解析 SOP', context: 'issue #201' },
      },
      'gap.json',
    )
    const out = main([String(201), p], gh)
    expect(out.labels).toContain('skill-gap')
    expect(gh).toHaveBeenCalledWith(['issue', 'edit', '201', '--add-label', 'oversight/review,skill-gap'])
    expect(gh).toHaveBeenCalledWith([
      'issue',
      'comment',
      '201',
      '--body',
      expect.stringContaining('### 🧩 技能缺口回報'),
    ])
    expect(gh).toHaveBeenCalledWith([
      'issue',
      'comment',
      '201',
      '--body',
      expect.stringContaining('- **分類**：`monorepo-test-path`'),
    ])
  })

  it('judge.json 無 report 區塊 → 行為與現況相同（向後相容：舊 judge.json 仍可讀）', () => {
    const gh = vi.fn()
    const out = main([String(201), writeJudge(RESULT('ready-for-review', ['oversight/review'], 'ok'), 'no-report.json')], gh)
    expect(out.labels).toEqual(['oversight/review'])
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '201', '--body', '## 工廠執行結果：ready-for-review\n\nok'])
  })

  it('report 存在但無 skillGap → 不貼標籤、不附段落', () => {
    const gh = vi.fn()
    const p = writeJudgeWithReport(
      RESULT('ready-for-review', ['oversight/review'], 'ok'),
      { issueNumber: 201, invocation: { exitCode: 0 } },
      'report-no-gap.json',
    )
    const out = main([String(201), p], gh)
    expect(out.labels).toEqual(['oversight/review'])
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '201', '--body', '## 工廠執行結果：ready-for-review\n\nok'])
  })

  it('report.skillGap 格式非法（category 非 kebab-case）→ CliError（fail-loud，不靜默丟棄）', () => {
    const p = writeJudgeWithReport(
      RESULT('ready-for-review', ['oversight/review'], 'ok'),
      { issueNumber: 201, invocation: { exitCode: 0 }, skillGap: { category: 'BadCase', needed: 'x' } },
      'bad-gap.json',
    )
    expect(() => main([String(201), p], vi.fn())).toThrow(CliError)
  })

  it('usage 與 skillGap 同時存在 → 兩段皆附加，順序為 usage 在前', () => {
    const gh = vi.fn()
    const usagePath = join(tmp, 'usage2.md')
    writeFileSync(usagePath, '## 📊 Token 用量與成本\n\n- 總 token：100')
    const p = writeJudgeWithReport(
      RESULT('ready-for-review', ['oversight/review'], 'ok'),
      { issueNumber: 201, invocation: { exitCode: 0 }, skillGap: { category: 'a-b', needed: 'x' } },
      'both.json',
    )
    main([String(201), p, usagePath], gh)
    const body = gh.mock.calls.find((c) => c[0][1] === 'comment')?.[0][4] as string
    expect(body.indexOf('總 token：100')).toBeLessThan(body.indexOf('### 🧩 技能缺口回報'))
  })
})
