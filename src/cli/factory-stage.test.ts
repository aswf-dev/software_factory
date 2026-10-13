/**
 * factory-stage 測試：依序模式的階段完成判定與接力（ADR-022）。
 */
import { describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  downstreamIssues,
  evaluatePrereqs,
  groupOf,
  loserBranches,
  main,
  prereqDoneMarker,
  runFinalize,
  STAGE_DONE_LABEL,
  STAGE_MIXED_MARKER,
  stageStatus,
  type GhRunner,
  type PrInfo,
} from './factory-stage.js'
import { reviewPrerequisites } from './factory-issue-check.js'

const pr = (number: number, headRefName: string, state: PrInfo['state']): PrInfo => ({ number, headRefName, state })
const body = (prereq?: string): string =>
  ['### 任務類型', '', 'agent-fix-bug', '', ...(prereq === undefined ? [] : ['### 前置工作項（可留空）', '', prereq, ''])].join('\n')

describe('groupOf', () => {
  it('變體 a／b、沒有變體代號的交付歸為 single；其他 Issue 的分支不算（7210 對 721）', () => {
    expect(groupOf(721, 'factory/721-a-01-test')).toBe('a')
    expect(groupOf(721, 'factory/721-b-02-impl')).toBe('b')
    expect(groupOf(721, 'factory/721-01-test')).toBe('single')
    expect(groupOf(721, 'factory/721-ab-01-test')).toBe('single')
    expect(groupOf(721, 'factory/7210-a-01-test')).toBeUndefined()
    expect(groupOf(721, 'feature/x')).toBeUndefined()
  })
})

describe('stageStatus（Q4、Q11）', () => {
  it('stage/done 標籤 → 完成（人工覆寫），不看 PR', () => {
    expect(stageStatus(1, [pr(1, 'factory/1-a-01-test', 'OPEN')], [STAGE_DONE_LABEL])).toEqual({ state: 'complete', override: true })
  })

  it('一個變體全部合併、另一個還開著 → 完成，勝者是合併的那一個（Q11-3）', () => {
    const s = stageStatus(1, [pr(1, 'factory/1-a-01-test', 'MERGED'), pr(2, 'factory/1-a-02-impl', 'MERGED'), pr(3, 'factory/1-b-01-test', 'OPEN')], [])
    expect(s).toEqual({ state: 'complete', winner: 'a', override: false })
  })

  it('人接手修好並合併 → 完成；被關閉而未合併的層不計（Q11-1，stacked PR 重建）', () => {
    const s = stageStatus(1, [pr(1, 'factory/1-b-01-test', 'MERGED'), pr(2, 'factory/1-b-02-impl', 'CLOSED'), pr(3, 'factory/1-b-02-impl', 'MERGED')], ['needs-human'])
    expect(s).toEqual({ state: 'complete', winner: 'b', override: false })
  })

  it('兩個變體各合併一部分 → mixed，不替人猜（Q11-2）', () => {
    expect(stageStatus(1, [pr(1, 'factory/1-a-01-test', 'MERGED'), pr(2, 'factory/1-b-02-impl', 'MERGED')], []).state).toBe('mixed')
  })

  it('勝者還有開著的層 → 進行中', () => {
    expect(stageStatus(1, [pr(1, 'factory/1-a-01-test', 'MERGED'), pr(2, 'factory/1-a-02-impl', 'OPEN')], [])).toEqual({ state: 'in-progress', winner: 'a', override: false })
  })

  it('沒有任何合併：有開著的 PR → 進行中；沒有 → 尚未開始', () => {
    expect(stageStatus(1, [pr(1, 'factory/1-a-01-test', 'OPEN')], []).state).toBe('in-progress')
    expect(stageStatus(1, [pr(1, 'factory/1-a-01-test', 'CLOSED')], []).state).toBe('not-started')
    expect(stageStatus(1, [], []).state).toBe('not-started')
  })

  it('單一交付（沒有變體代號）全部合併 → 完成', () => {
    expect(stageStatus(1, [pr(1, 'factory/1-01-test', 'MERGED')], [])).toEqual({ state: 'complete', winner: 'single', override: false })
  })

  it('不屬於本 Issue 的 PR 被忽略', () => {
    expect(stageStatus(72, [pr(1, 'factory/721-a-01-test', 'MERGED')], []).state).toBe('not-started')
  })
})

describe('loserBranches', () => {
  const branches = ['factory/1-a-01-test', 'factory/1-b-01-test', 'factory/1-b-02-impl', 'factory/1-b-03-docs', 'factory/12-b-01-test']
  it('只刪落選變體的分支；仍是開著或已合併 PR 的 head 不刪；其他 Issue 不碰', () => {
    const prs = [pr(1, 'factory/1-b-02-impl', 'OPEN'), pr(2, 'factory/1-b-03-docs', 'MERGED'), pr(3, 'factory/1-b-01-test', 'CLOSED')]
    expect(loserBranches(1, 'a', branches, prs)).toEqual(['factory/1-b-01-test'])
    expect(loserBranches(1, 'b', branches, [])).toEqual(['factory/1-a-01-test'])
  })
  it('勝者是單一交付或不明（人工覆寫）→ 沒有落選方', () => {
    expect(loserBranches(1, 'single', branches, [])).toEqual([])
    expect(loserBranches(1, undefined, branches, [])).toEqual([])
  })
})

describe('downstreamIssues', () => {
  it('以前置欄位精確判定（內文順帶提到 #1 的不算），並排除自己', () => {
    const open = [
      { number: 2, body: body('#1, #5') },
      { number: 3, body: `${body()}\n提到 #1 但不是前置` },
      { number: 1, body: body('#1') },
      { number: 4, body: body('#10') },
    ]
    expect(downstreamIssues(1, open)).toEqual([2])
  })
})

describe('evaluatePrereqs（Q12）', () => {
  const review = (prereq?: string, title?: string) => reviewPrerequisites(body(prereq), title)
  const done = { state: 'complete' as const, override: false }

  it('沒有宣告前置，或前置全部完成 → 不擋', () => {
    expect(evaluatePrereqs(review(), [])).toEqual({ blocked: false })
    expect(evaluatePrereqs(review('#1'), [{ issue: 1, status: done }])).toEqual({ blocked: false })
  })

  it('有前置未完成或找不到 → 擋下，留言列出每一個的狀態與出口', () => {
    const r = evaluatePrereqs(review('#1, #2, #3'), [
      { issue: 1, status: done },
      { issue: 2, status: { state: 'in-progress', override: false } },
      { issue: 3, status: undefined },
    ])
    expect(r.blocked).toBe(true)
    expect(r.comment).toContain('| #2 | ⏳ 進行中')
    expect(r.comment).toContain('| #3 | ❌ 找不到這張 Issue |')
    expect(r.comment).not.toContain('| #1 |')
    expect(r.comment).toContain('欄位清空')
    // 不是 agent 的失敗，不得出現 needs-human；也不得含 hard gate 字串
    expect(r.comment).not.toContain('needs-human')
    expect(r.comment).not.toContain('格式不合規')
  })

  it('欄位無法解析（含跨 repo 的寫法，Q16）或指向自己 → 擋下（宣告有歧義時不放行）', () => {
    const malformed = evaluatePrereqs(review('owner/repo#12'), [])
    expect(malformed.blocked).toBe(true)
    expect(malformed.comment).toContain('`owner/repo#12`')
    const self = evaluatePrereqs(review('#7', '[factory] x (#7)'), [])
    expect(self.blocked).toBe(true)
    expect(self.comment).toContain('指向本 Issue 自己（#7）')
    expect(self.comment).not.toContain('| 前置 |')
  })
})

/* ── 以 fake gh 驗證實際的讀寫動作 ───────────────────────────────── */

interface Fake {
  gh: GhRunner
  calls: string[][]
}
function fakeGh(routes: (args: string[]) => string | undefined): Fake {
  const calls: string[][] = []
  return {
    calls,
    gh: (args) => {
      calls.push(args)
      const out = routes(args)
      if (out === undefined) throw new Error(`gh failed: ${args.join(' ')}`)
      return out
    },
  }
}
const j = (v: unknown): string => JSON.stringify(v)
const writes = (f: Fake): string[] =>
  f.calls.filter((a) => a[1] === 'comment' || a.includes('DELETE')).map((a) => (a.includes('DELETE') ? `DELETE ${a[3]}` : `comment ${a[2]}`))

/** 一個 repo 的狀態：每張 Issue 的 body／labels／comments 與所有 PR、分支。 */
function world(opts: {
  onboarded?: boolean
  issues: Record<number, { body?: string; title?: string; labels?: string[]; comments?: string[]; open?: boolean }>
  prs?: PrInfo[]
  branches?: string[]
}): Fake {
  return fakeGh((a) => {
    if (a[0] === 'api' && a[1]!.includes('catalog-info.yaml')) return opts.onboarded === false ? undefined : ''
    if (a[0] === 'api' && a[1]!.includes('matching-refs')) return j((opts.branches ?? []).map((b) => ({ ref: `refs/heads/${b}` })))
    if (a[0] === 'api' && a[1] === '-X') return ''
    if (a[0] === 'issue' && a[1] === 'view') {
      const i = opts.issues[Number(a[2])]
      if (i === undefined) return undefined
      const fields = a[a.length - 1]
      if (fields === 'labels') return j({ labels: (i.labels ?? []).map((name) => ({ name })) })
      if (fields === 'comments') return j({ comments: (i.comments ?? []).map((b) => ({ body: b })) })
      return j({ body: i.body ?? body(), title: i.title ?? 't' })
    }
    if (a[0] === 'issue' && a[1] === 'list') {
      return j(Object.entries(opts.issues).filter(([, i]) => i.open !== false).map(([n, i]) => ({ number: Number(n), body: i.body ?? body() })))
    }
    if (a[0] === 'issue' && a[1] === 'comment') return ''
    if (a[0] === 'pr' && a[1] === 'list') return j(opts.prs ?? [])
    return undefined
  })
}

describe('runFinalize', () => {
  it('未納管（target repo 的 software-factory 沒有 catalog-info.yaml）→ 什麼都不做', () => {
    const f = world({ onboarded: false, issues: { 1: {} } })
    expect(runFinalize(f.gh, 'o/r', 1, false)).toMatchObject({ onboarded: false, deleted: [], notified: [] })
    expect(f.calls).toHaveLength(1)
  })

  it('完成：刪落選分支、通知宣告它為前置的下游 Issue；已通知過的不重複', () => {
    const f = world({
      issues: { 1: {}, 2: { body: body('#1') }, 3: { body: body('#1'), comments: [prereqDoneMarker(1)] }, 4: { body: body() } },
      prs: [pr(10, 'factory/1-a-01-test', 'MERGED'), pr(11, 'factory/1-b-01-test', 'CLOSED')],
      branches: ['factory/1-a-01-test', 'factory/1-b-01-test'],
    })
    const r = runFinalize(f.gh, 'o/r', 1, false)
    expect(r).toMatchObject({ onboarded: true, state: 'complete', winner: 'a', deleted: ['factory/1-b-01-test'], notified: [2] })
    expect(writes(f)).toEqual(['DELETE repos/o/r/git/refs/heads/factory/1-b-01-test', 'comment 2'])
    const comment = f.calls.find((a) => a[1] === 'comment')!
    expect(comment.at(-1)).toContain(prereqDoneMarker(1))
    expect(comment.at(-1)).not.toContain('stage/done')
  })

  it('人工覆寫完成 → 不刪分支（勝者不明），通知註明是人工標記', () => {
    const f = world({ issues: { 1: { labels: [STAGE_DONE_LABEL] }, 2: { body: body('#1') } }, branches: ['factory/1-b-01-test'] })
    const r = runFinalize(f.gh, 'o/r', 1, false)
    expect(r.deleted).toEqual([])
    expect(f.calls.find((a) => a[1] === 'comment')!.at(-1)).toContain('人工標記 `stage/done`')
  })

  it('mixed：只在本 Issue 請人裁決一次；不刪分支、不通知下游', () => {
    const prs = [pr(1, 'factory/1-a-01-test', 'MERGED'), pr(2, 'factory/1-b-02-impl', 'MERGED')]
    const first = world({ issues: { 1: {}, 2: { body: body('#1') } }, prs })
    expect(runFinalize(first.gh, 'o/r', 1, false)).toMatchObject({ state: 'mixed', askedForOverride: true })
    expect(writes(first)).toEqual(['comment 1'])
    const again = world({ issues: { 1: { comments: [STAGE_MIXED_MARKER] } }, prs })
    expect(runFinalize(again.gh, 'o/r', 1, false).askedForOverride).toBe(false)
    expect(writes(again)).toEqual([])
  })

  it('進行中或尚未開始 → 不做任何事（只合併了其中一層也會收到 webhook）', () => {
    const f = world({ issues: { 1: {}, 2: { body: body('#1') } }, prs: [pr(1, 'factory/1-a-01-test', 'MERGED'), pr(2, 'factory/1-a-02-impl', 'OPEN')] })
    expect(runFinalize(f.gh, 'o/r', 1, false).state).toBe('in-progress')
    expect(writes(f)).toEqual([])
  })

  it('--dry-run：計算結果相同，但沒有任何寫入', () => {
    const opts = {
      issues: { 1: {}, 2: { body: body('#1') } },
      prs: [pr(10, 'factory/1-a-01-test', 'MERGED')],
      branches: ['factory/1-b-01-test'],
    }
    const f = world(opts)
    expect(runFinalize(f.gh, 'o/r', 1, true)).toMatchObject({ deleted: ['factory/1-b-01-test'], notified: [2] })
    expect(writes(f)).toEqual([])
    const mixed = world({ issues: { 1: {} }, prs: [pr(1, 'factory/1-a-01-test', 'MERGED'), pr(2, 'factory/1-b-01-test', 'MERGED')] })
    expect(runFinalize(mixed.gh, 'o/r', 1, true).askedForOverride).toBe(true)
    expect(writes(mixed)).toEqual([])
  })

  it('Issue 不存在 → CliError', () => {
    expect(() => runFinalize(world({ issues: {} }).gh, 'o/r', 1, false)).toThrow(CliError)
  })
})

describe('main', () => {
  it('prereqs：讀本 Issue 的前置，逐一以即時狀態判定；指向自己的不查詢', () => {
    const f = world({
      issues: { 5: { body: body('#1, #5'), title: '[factory] x (#5)' }, 1: {} },
      prs: [pr(1, 'factory/1-a-01-test', 'OPEN')],
    })
    const r = main(['prereqs', '--repo', 'o/r', '--issue', '5'], f.gh)
    expect(r).toMatchObject({ blocked: true })
    expect(f.calls.filter((a) => a[1] === 'view' && a[2] === '5' && a.at(-1) === 'labels')).toHaveLength(0)
  })

  it('finalize --dry-run 經由 main 執行', () => {
    const f = world({ issues: { 1: {} } })
    expect(main(['finalize', '--repo', 'o/r', '--issue', '1', '--dry-run'], f.gh)).toMatchObject({ state: 'not-started' })
  })

  it('參數檢查', () => {
    const gh: GhRunner = () => ''
    expect(() => main(['prereqs', '--repo', 'o/r'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--issue', '1'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--repo', 'bad', '--issue', '1'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--repo', 'o/..', '--issue', '1'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--repo', 'o/r', '--issue', '0'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--repo', 'o/r', '--issue', 'x'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--repo'], gh)).toThrow(CliError)
    expect(() => main(['prereqs', '--repo', 'o/r', '--issue', '1', '--wat', 'x'], gh)).toThrow(CliError)
    expect(() => main(['nope', '--repo', 'o/r', '--issue', '1'], gh)).toThrow(CliError)
  })
})
