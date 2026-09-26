/**
 * factory-spec-phase 測試（src/cli/** 100% branch 閘門）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, parseArgs, type ExecRunner } from './factory-spec-phase.js'
import { CliError } from './run-cli.js'

const body = (fields: { name?: string; source?: string; prd?: string | null }): string =>
  [
    '### 任務類型',
    '',
    'agent-write-spec',
    '',
    ...(fields.prd === null ? [] : ['### 需求描述（PRD）', '', fields.prd ?? '第 3 步：經過時間必須小於有效期。', '']),
    '### 規格名稱',
    '',
    fields.name ?? 'redlock',
    '',
    '### 規格來源',
    '',
    fields.source ?? 'issue',
    '',
  ].join('\n')

interface Fake {
  state?: string
  labels?: string[]
  body?: string
  timeline?: { login: string; type: string }[]
  openHeads?: string[]
  sha?: string
}

function fakeExec(f: Fake, calls: string[][] = []): ExecRunner {
  return (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'gh' && args[0] === 'issue') {
      return JSON.stringify({
        state: f.state ?? 'OPEN',
        labels: (f.labels ?? []).map((name) => ({ name })),
        body: f.body ?? body({}),
      })
    }
    if (cmd === 'gh' && args[0] === 'api') {
      return (f.timeline ?? []).map((e) => JSON.stringify(e)).join('\n') + '\n'
    }
    if (cmd === 'gh' && args[0] === 'pr') {
      return JSON.stringify((f.openHeads ?? []).map((headRefName) => ({ headRefName })))
    }
    if (cmd === 'git') return `${f.sha ?? 'abc123'}\n`
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
}

const NOW = (): Date => new Date('2026-09-26T00:00:00Z')

function makeTarget(opts: { codeowners?: string; codeownersAt?: string; invariants?: boolean; files?: Record<string, string> } = {}): string {
  const t = mkdtempSync(join(tmpdir(), 'spec-phase-'))
  if (opts.codeowners !== undefined) {
    const at = join(t, opts.codeownersAt ?? '.github/CODEOWNERS')
    mkdirSync(join(at, '..'), { recursive: true })
    writeFileSync(at, opts.codeowners)
  }
  if (opts.invariants === true) {
    mkdirSync(join(t, 'specs/redlock'), { recursive: true })
    writeFileSync(join(t, 'specs/redlock/invariants.qnt'), 'module inv {}\n')
  }
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(t, p, '..'), { recursive: true })
    writeFileSync(join(t, p), c)
  }
  return t
}

describe('parseArgs', () => {
  it('issue、--repo、--target、--snapshot-out', () => {
    expect(parseArgs(['7', '--repo', 'o/r', '--target', 't', '--snapshot-out', 's.md'])).toEqual({
      issueNumber: 7,
      repo: 'o/r',
      target: 't',
      snapshotOut: 's.md',
    })
  })
  it('--target 預設 target', () => {
    expect(parseArgs(['7', '--repo', 'o/r']).target).toBe('target')
  })
  it('issue 不是正整數、缺或格式錯誤的 --repo、未知參數、缺值 → CliError', () => {
    expect(() => parseArgs(['x', '--repo', 'o/r'])).toThrow(CliError)
    expect(() => parseArgs(['--repo', 'o/r'])).toThrow(/\(missing\)/)
    expect(() => parseArgs(['7'])).toThrow(/--repo/)
    expect(() => parseArgs(['7', '--repo', 'no-slash'])).toThrow(/--repo/)
    expect(() => parseArgs(['7', '--repo', 'o/r', 'extra'])).toThrow(/unknown/)
    expect(() => parseArgs(['7', '--repo'])).toThrow(/requires a value/)
  })
})

describe('main：不變量階段與快照', () => {
  it('來源 issue → 寫 source.md（target 內與 --snapshot-out 兩份相同）', () => {
    const t = makeTarget()
    const out = join(t, '..', `snap-${Date.now()}.md`)
    const r = main(['12', '--repo', 'o/r', '--target', t, '--snapshot-out', out], fakeExec({}), NOW)
    expect(r.decision).toBe('invariants')
    expect(r.specName).toBe('redlock')
    expect(r.sourceKind).toBe('issue')
    const inTarget = readFileSync(join(t, 'specs/redlock/source.md'), 'utf8')
    expect(inTarget).toContain('o/r#12')
    expect(inTarget).toContain('第 3 步：經過時間必須小於有效期。')
    expect(readFileSync(out, 'utf8')).toBe(inTarget)
    expect(r.snapshotPath).toBe(join(t, 'specs/redlock/source.md'))
  })
  it('來源 repo 內路徑 → 複製檔案原文，標頭含 trunk commit', () => {
    const t = makeTarget({ files: { 'docs/specs/redlock.md': '# Redlock\n' } })
    const r = main(
      ['12', '--repo', 'o/r', '--target', t],
      fakeExec({ body: body({ source: 'docs/specs/redlock.md' }), sha: 'deadbeef' }),
      NOW,
    )
    expect(r.sourceKind).toBe('path')
    const s = readFileSync(join(t, 'specs/redlock/source.md'), 'utf8')
    expect(s).toContain('docs/specs/redlock.md @ deadbeef')
    expect(s.endsWith('# Redlock\n')).toBe(true)
  })
  it('PRD 欄位缺漏 → 快照本文為空（不當機）', () => {
    const t = makeTarget()
    main(['12', '--repo', 'o/r', '--target', t], fakeExec({ body: body({ prd: null }) }), NOW)
    expect(existsSync(join(t, 'specs/redlock/source.md'))).toBe(true)
  })
  it('未注入時鐘 → 以目前時間作為擷取時間（ISO 8601）', () => {
    const t = makeTarget()
    main(['12', '--repo', 'o/r', '--target', t], fakeExec({}))
    expect(readFileSync(join(t, 'specs/redlock/source.md'), 'utf8')).toMatch(/擷取：\d{4}-\d{2}-\d{2}T/)
  })
  it('未貼 spec/approved → 不查 timeline', () => {
    const calls: string[][] = []
    main(['12', '--repo', 'o/r', '--target', makeTarget()], fakeExec({}, calls), NOW)
    expect(calls.some((c) => c[1] === 'api')).toBe(false)
  })
})

describe('main：模型階段與拒絕', () => {
  const approved = { labels: ['spec/phase-invariants', 'spec/approved'] }
  it('CODEOWNERS 人類核准、trunk 有 invariants.qnt → 模型階段，不寫快照', () => {
    const t = makeTarget({ codeowners: '* @philipz\n', invariants: true })
    const r = main(
      ['12', '--repo', 'o/r', '--target', t],
      fakeExec({ ...approved, timeline: [{ login: 'philipz', type: 'User' }] }),
      NOW,
    )
    expect(r.decision).toBe('model')
    expect(r.snapshotPath).toBeUndefined()
    expect(existsSync(join(t, 'specs/redlock/source.md'))).toBe(false)
  })
  it('CODEOWNERS 在 repo 根目錄也讀得到', () => {
    const t = makeTarget({ codeowners: '* @philipz\n', codeownersAt: 'CODEOWNERS', invariants: true })
    const r = main(
      ['12', '--repo', 'o/r', '--target', t],
      fakeExec({ ...approved, timeline: [{ login: 'philipz', type: 'User' }] }),
      NOW,
    )
    expect(r.decision).toBe('model')
  })
  it('bot 貼的 spec/approved → 拒絕', () => {
    const t = makeTarget({ codeowners: '* @philipz\n', invariants: true })
    const r = main(
      ['12', '--repo', 'o/r', '--target', t],
      fakeExec({ ...approved, timeline: [{ login: 'software-factory-worker[bot]', type: 'Bot' }] }),
      NOW,
    )
    expect(r.decision).toBe('refuse')
  })
  it('沒有 CODEOWNERS → 無人可核准 → 拒絕（fail-closed）', () => {
    const t = makeTarget({ invariants: true })
    const r = main(
      ['12', '--repo', 'o/r', '--target', t],
      fakeExec({ ...approved, timeline: [{ login: 'philipz', type: 'User' }] }),
      NOW,
    )
    expect(r.decision).toBe('refuse')
  })
  it('本工作項有開著的 factory PR（兩種分支命名）→ 拒絕；其他 Issue 的 PR 不算', () => {
    const t = makeTarget()
    const refused = main(['12', '--repo', 'o/r', '--target', t], fakeExec({ openHeads: ['factory/12-01-spec'] }), NOW)
    expect(refused.decision).toBe('refuse')
    expect(
      main(['12', '--repo', 'o/r', '--target', t], fakeExec({ openHeads: ['factory/12/01-spec'] }), NOW).decision,
    ).toBe('refuse')
    expect(
      main(['12', '--repo', 'o/r', '--target', t], fakeExec({ openHeads: ['factory/120-01-x', 'dependabot/x'] }), NOW)
        .decision,
    ).toBe('invariants')
  })
  it('Issue 已關閉 → 拒絕', () => {
    expect(main(['12', '--repo', 'o/r', '--target', makeTarget()], fakeExec({ state: 'CLOSED' }), NOW).decision).toBe(
      'refuse',
    )
  })
  it('規格名稱或來源缺漏、不合法 → 拒絕（應已由 issue-check 擋下）', () => {
    const t = makeTarget()
    for (const b of [
      body({ name: '_No response_' }),
      body({ name: 'Bad Name' }),
      body({ source: '_No response_' }),
      body({ source: 'https://example.com/v1.0/spec' }),
    ]) {
      const r = main(['12', '--repo', 'o/r', '--target', t], fakeExec({ body: b }), NOW)
      expect(r.decision).toBe('refuse')
      expect(r.reason).toMatch(/issue-check/)
    }
  })
})
