import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildAnalyzeComment,
  buildAuditComment,
  buildBlockComment,
  computeScoreLabels,
  IN_LOOP_ALLOWED_TASK_TYPES,
  main,
  OUTPUT_ONLY_TASK_TYPES,
} from './apply-score-labels.js'
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

  /**
   * 閘門留言必須內嵌 run id：factory-run-cleanup.yml 與 factory-run.yml 的
   * 終態守衛都以「留言是否含 run id」判定該 run 是否已留下終態紀錄。留言不含
   * run id 時去重失效，cleanup 會補貼「agent 已啟動但未留下終態判定」的假訊息
   * （2026-09-07 run 34132998252 實例）。
   */
  it('in-loop 閘門留言內嵌 run id（供終態守衛去重）', () => {
    expect(buildBlockComment(6, '34132998252')).toContain('34132998252')
  })

  it('未提供 run id → 留言不含 run 標記（向後相容，不輸出空的 run:）', () => {
    expect(buildBlockComment(6)).not.toContain('run:')
  })
  it('in-loop + agent-analyze → 不擋（僅分析模式），analyzeAllowed=true', () => {
    const out = computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' }, 'agent-analyze')
    expect(out.blocked).toBe(false)
    expect(out.analyzeAllowed).toBe(true)
    expect(buildAnalyzeComment(6)).toContain('僅分析不實作')
  })
  it('in-loop + 其他類型 → 照常擋（task_type 與計分正交，僅產出型是唯二例外）', () => {
    const out = computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' }, 'agent-fix-bug')
    expect(out.blocked).toBe(true)
    expect(out.analyzeAllowed).toBe(false)
  })
  it('非 in-loop + agent-analyze → 不擋、analyzeAllowed=false（analyze 模式只影響 in-loop）', () => {
    const out = computeScoreLabels({ total: 2, tier: 'review', label: 'oversight/review' }, 'agent-analyze')
    expect(out.blocked).toBe(false)
    expect(out.analyzeAllowed).toBe(false)
  })

  // --- agent-propose-skill（E6／ADR-016 §4）---

  it('in-loop + agent-propose-skill → 不擋（僅提案模式）', () => {
    const out = computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' }, 'agent-propose-skill')
    expect(out.blocked).toBe(false)
    expect(out.analyzeAllowed).toBe(true)
  })

  it('propose-skill 留言說明「誤合併也不生效」與人工 promote（ADR-016 的安全論述）', () => {
    const c = buildAnalyzeComment(6, 'agent-propose-skill')
    expect(c).toContain('僅提案不實作')
    expect(c).toContain('proposals/skills/')
    expect(c).toContain('誤合併也不會生效')
    expect(c).toContain('promote')
  })

  /**
   * tier／標籤不因型別改變（ADR-016 §4：這不是放寬監督層級）。
   */
  it('propose-skill 不改變 tier 標籤（監督層級不變）', () => {
    const out = computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' }, 'agent-propose-skill')
    expect(out.labels).toEqual(['oversight/in-loop'])
  })

  it('非 in-loop + agent-propose-skill → analyzeAllowed=false（只影響 in-loop）', () => {
    const out = computeScoreLabels({ total: 2, tier: 'review', label: 'oversight/review' }, 'agent-propose-skill')
    expect(out.blocked).toBe(false)
    expect(out.analyzeAllowed).toBe(false)
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

  it('in-loop + agent-analyze → 不阻斷，貼 analyze 說明留言', () => {
    const gh = vi.fn()
    const out = main(
      [
        String(106),
        writeScore({ score: { total: 6, tier: 'in-loop', label: 'oversight/in-loop' } }),
        'agent-analyze',
      ],
      gh,
    )
    expect(out.blocked).toBe(false)
    expect(out.analyzeAllowed).toBe(true)
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '106', '--body', expect.stringContaining('僅分析不實作')])
  })

  /**
   * 第四參數 runId 必須被帶進閘門留言——這是終態守衛去重的唯一依據。
   */
  it('in-loop + runId → 留言含該 run id', () => {
    const gh = vi.fn()
    main(
      [
        String(107),
        writeScore({ score: { total: 6, tier: 'in-loop', label: 'oversight/in-loop' } }),
        'agent-add-tests',
        '34132998252',
      ],
      gh,
    )
    expect(gh).toHaveBeenCalledWith([
      'issue',
      'comment',
      '107',
      '--body',
      expect.stringContaining('34132998252'),
    ])
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

describe('in-loop 豁免：agent-pbt-audit（ADR-019 R11）', () => {
  const IN_LOOP = { total: 6, tier: 'in-loop' as const, label: 'oversight/in-loop' }

  it('名單恰為 agent-pbt-audit，且不與 output-only 混用', () => {
    expect([...IN_LOOP_ALLOWED_TASK_TYPES]).toEqual(['agent-pbt-audit'])
    expect(OUTPUT_ONLY_TASK_TYPES as readonly string[]).not.toContain('agent-pbt-audit')
  })
  it('in-loop + agent-pbt-audit → 不擋、auditAllowed=true、analyzeAllowed=false，標籤照舊', () => {
    expect(computeScoreLabels(IN_LOOP, 'agent-pbt-audit')).toEqual({
      labels: ['oversight/in-loop'],
      blocked: false,
      analyzeAllowed: false,
      auditAllowed: true,
    })
  })
  it('非 in-loop + agent-pbt-audit → auditAllowed=false（豁免只影響 in-loop）', () => {
    expect(computeScoreLabels({ total: 3, tier: 'review', label: 'oversight/review' }, 'agent-pbt-audit').auditAllowed).toBe(false)
  })
  it('in-loop + 其他會開實作 PR 的類型 → 仍擋', () => {
    for (const t of ['agent-add-tests', 'agent-fix-bug', 'agent-write-spec', undefined]) {
      expect(computeScoreLabels(IN_LOOP, t).blocked, String(t)).toBe(true)
    }
  })
  it('說明留言點出兩個前提與監督層級不變', () => {
    const c = buildAuditComment(6)
    expect(c).toContain('agent-pbt-audit')
    expect(c).toContain('只能新增或修改 PBT 測試檔')
    expect(c).toContain('禁止自動合併')
    expect(c).toContain('監督層級不變')
  })
  it('main：in-loop + agent-pbt-audit → 不阻斷，貼 audit 說明留言', () => {
    const gh = vi.fn()
    const out = main(['108', writeScore(IN_LOOP_SCORE, 'audit.json'), 'agent-pbt-audit'], gh)
    expect(out).toMatchObject({ blocked: false, auditAllowed: true })
    expect(gh).toHaveBeenCalledWith(['issue', 'comment', '108', '--body', expect.stringContaining('事後稽核')])
  })
})

const IN_LOOP_SCORE = { score: { total: 6, tier: 'in-loop', label: 'oversight/in-loop' } }
