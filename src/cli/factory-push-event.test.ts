import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from './run-cli.js'
import { buildEvent, deriveEventId, main, parseArgs, pushEvent, splitRepo } from './factory-push-event.js'

let tmp: string
let ws: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-push-event-'))
})

beforeEach(() => {
  ws = join(tmp, `ws-${Math.random().toString(36).slice(2)}`)
  mkdirSync(ws, { recursive: true })
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const writeJson = (rel: string, value: unknown): string => {
  const p = join(ws, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(value, null, 2))
  return p
}

const baseArgv = (extra: string[] = []): string[] => [
  '--repo',
  'philipz/software_factory',
  '--issue',
  '228',
  '--run-id',
  '33891806331',
  '--task-type',
  'agent-fix-bug',
  ...extra,
]

const usageBlock = {
  source: 'dsh-session-log',
  totals: {
    inputTokens: 145412,
    outputTokens: 57721,
    cacheReadTokens: 3775488,
    cacheWriteTokens: 0,
    reasoningTokens: 42079,
    totalTokens: 3978621,
    costUsd: 0.037,
    unpricedModels: [],
    cacheReadUnpriced: false,
  },
  routes: [],
  pricingRef: 'config/dsh/pricing.yaml',
  measuredAt: '2026-10-14T08:37:38Z',
  sessionCount: 1,
}

const fixedNow = (): Date => new Date('2026-10-14T08:37:38Z')

describe('parseArgs', () => {
  it('parses required flags', () => {
    const args = parseArgs(baseArgv())
    expect(args).toMatchObject({
      repo: 'philipz/software_factory',
      issueNumber: 228,
      runId: 33891806331,
      taskType: 'agent-fix-bug',
    })
  })

  it('rejects a missing --repo', () => {
    expect(() => parseArgs(['--issue', '1', '--task-type', 't'])).toThrow(CliError)
  })

  it('rejects a missing --issue', () => {
    expect(() => parseArgs(['--repo', 'a/b', '--task-type', 't'])).toThrow(CliError)
  })

  it('rejects a non-numeric --issue', () => {
    expect(() => parseArgs(['--repo', 'a/b', '--issue', 'abc', '--task-type', 't'])).toThrow(CliError)
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(baseArgv(['--wat']))).toThrow(CliError)
  })

  it('rejects positional arguments', () => {
    expect(() => parseArgs(baseArgv(['stray']))).toThrow(CliError)
  })

  it('degrades an invalid --run-id to null instead of aborting', () => {
    // The event still has value without a run link; losing it entirely would be worse.
    expect(parseArgs(['--repo', 'a/b', '--issue', '1', '--task-type', 't', '--run-id', 'nope']).runId).toBeNull()
  })

  it('treats an empty --run-id as null', () => {
    // `github.run_id` interpolates to an empty string in some contexts.
    expect(parseArgs(['--repo', 'a/b', '--issue', '1', '--task-type', 't', '--run-id', '']).runId).toBeNull()
  })

  it('rejects a negative --issue', () => {
    expect(() => parseArgs(['--repo', 'a/b', '--issue', '-1', '--task-type', 't'])).toThrow(CliError)
  })

  it('rejects a flag used without its value', () => {
    expect(() => parseArgs(['--repo', '--issue'])).toThrow(CliError)
  })

  it('rejects a missing --task-type', () => {
    expect(() => parseArgs(['--repo', 'a/b', '--issue', '1'])).toThrow(CliError)
  })
})

describe('splitRepo', () => {
  it('splits owner and repo', () => {
    expect(splitRepo('philipz/software_factory')).toEqual({ owner: 'philipz', repo: 'software_factory' })
  })

  it('falls back to a placeholder owner when there is no slash', () => {
    expect(splitRepo('software_factory')).toEqual({ owner: 'unknown', repo: 'software_factory' })
  })
})

describe('deriveEventId — docs/26 §3 idempotency', () => {
  it('is stable for the same run and issue', () => {
    expect(deriveEventId(1, 228)).toBe(deriveEventId(1, 228))
  })

  it('differs across issues and across runs', () => {
    expect(deriveEventId(1, 228)).not.toBe(deriveEventId(1, 229))
    expect(deriveEventId(1, 228)).not.toBe(deriveEventId(2, 228))
  })

  it('matches the receiver algorithm: sha256(run:issue) truncated to 32 chars', () => {
    // Pinned so the two repos cannot silently drift apart; a mismatch here
    // would break dedupe and double-count every retried run.
    expect(deriveEventId(33891806331, 228)).toBe('d428b5cb1f9a79f690a66cc8cfc1911f')
  })

  it('keeps distinct issues distinct when run_id is null', () => {
    expect(deriveEventId(null, 228)).not.toBe(deriveEventId(null, 229))
  })
})

describe('buildEvent — 純資料搬運（docs/26 §2.3）', () => {
  it('assembles a complete event from all four artifacts', () => {
    const report = writeJson('report.json', { usage: usageBlock, skillGap: { category: 'monorepo-test-path', needed: 'x' } })
    const judge = writeJson('judge.json', {
      result: { outcome: 'needs-human', stopDecision: { mustStop: true, violations: [{ rule: 'SR4-unclear-acceptance', reason: 'r' }] } },
    })
    const crosscheck = writeJson('crosscheck.json', { mismatches: [{ kind: 'unreported-changes', detail: 'src/secret.ts' }] })
    const model = writeJson('model.json', { tier: 'high' })

    const event = buildEvent(
      parseArgs(baseArgv(['--report', report, '--judge', judge, '--crosscheck', crosscheck, '--model', model])),
      fixedNow,
    )

    expect(event).toMatchObject({
      schema_version: 2,
      owner: 'philipz',
      repo: 'software_factory',
      issue_number: 228,
      run_id: 33891806331,
      task_type: 'agent-fix-bug',
      model_tier: 'high',
      outcome: 'needs-human',
      stop_reason: 'SR4-unclear-acceptance',
      crosscheck_mismatches: ['unreported-changes'],
    })
    expect(event.usage).toEqual(usageBlock)
    expect(event.skill_gap).toEqual({ category: 'monorepo-test-path', needed: 'x' })
  })

  it('never forwards crosscheck detail — only kind (docs/26 §6 privacy)', () => {
    // detail carries file paths and issue content and must not leave the repo.
    const crosscheck = writeJson('crosscheck.json', {
      mismatches: [{ kind: 'unreported-changes', detail: 'src/internal/secret-path.ts' }],
    })
    const event = buildEvent(parseArgs(baseArgv(['--crosscheck', crosscheck])), fixedNow)

    expect(event.crosscheck_mismatches).toEqual(['unreported-changes'])
    expect(JSON.stringify(event)).not.toContain('secret-path')
  })

  it('tolerates every artifact being absent (docs/26 §1.2)', () => {
    // judge.json/crosscheck.json legitimately do not exist for some terminal
    // states; the CLI must fill null rather than abort.
    const event = buildEvent(parseArgs(baseArgv()), fixedNow)

    expect(event).toMatchObject({
      usage: null,
      outcome: null,
      skill_gap: null,
      stop_reason: null,
      crosscheck_mismatches: [],
      model_tier: null,
      skills_digest: null,
    })
  })

  it('tolerates malformed JSON without throwing', () => {
    const p = join(ws, 'broken.json')
    writeFileSync(p, '{not json')
    const event = buildEvent(parseArgs(baseArgv(['--report', p, '--judge', p])), fixedNow)
    expect(event.usage).toBeNull()
    expect(event.outcome).toBeNull()
  })

  it('passes unavailableReason through so the dashboard shows 無資料 not $0', () => {
    // docs/26 §1.1 constraint 2 — dropping this field would let a failed
    // measurement render as a real $0.
    const report = writeJson('report.json', {
      usage: { ...usageBlock, unavailableReason: 'session log missing' },
    })
    const event = buildEvent(parseArgs(baseArgv(['--report', report])), fixedNow)
    expect((event.usage as Record<string, unknown>)['unavailableReason']).toBe('session log missing')
  })

  it('does not recompute cost — usage is forwarded verbatim', () => {
    // The push side must stay a faithful copy; a second cost calculation could
    // disagree with the Issue comment.
    const report = writeJson('report.json', { usage: usageBlock })
    const event = buildEvent(parseArgs(baseArgv(['--report', report])), fixedNow)
    expect(event.usage).toEqual(usageBlock)
  })

  it('returns null stop_reason when the run did not stop', () => {
    const judge = writeJson('judge.json', {
      result: { outcome: 'ready-for-review', stopDecision: { mustStop: false, violations: [] } },
    })
    const event = buildEvent(parseArgs(baseArgv(['--judge', judge])), fixedNow)
    expect(event.stop_reason).toBeNull()
    expect(event.outcome).toBe('ready-for-review')
  })

  it('handles a null stopDecision', () => {
    const judge = writeJson('judge.json', { result: { outcome: 'ready-to-automerge', stopDecision: null } })
    expect(buildEvent(parseArgs(baseArgv(['--judge', judge])), fixedNow).stop_reason).toBeNull()
  })

  it('drops mismatch entries that carry no kind', () => {
    const crosscheck = writeJson('crosscheck.json', { mismatches: [{ detail: 'x' }, { kind: 'no-trace' }] })
    expect(buildEvent(parseArgs(baseArgv(['--crosscheck', crosscheck])), fixedNow).crosscheck_mismatches).toEqual(['no-trace'])
  })

  it('ignores a JSON file whose root is not an object', () => {
    // A top-level array or scalar is not a valid artifact; treat it as absent
    // rather than reading fields off it.
    const arr = writeJson('arr.json', [1, 2, 3])
    const scalar = writeJson('scalar.json', 'nope')
    const event = buildEvent(parseArgs(baseArgv(['--report', arr, '--judge', scalar])), fixedNow)

    expect(event.usage).toBeNull()
    expect(event.outcome).toBeNull()
  })

  it('ignores violations entries that are not objects', () => {
    const judge = writeJson('judge.json', {
      result: { outcome: 'needs-human', stopDecision: { violations: ['SR4', null, { rule: 'SR6-weakened-tests' }] } },
    })
    expect(buildEvent(parseArgs(baseArgv(['--judge', judge])), fixedNow).stop_reason).toBe('SR6-weakened-tests')
  })

  it('returns null stop_reason when violations is not an array', () => {
    const judge = writeJson('judge.json', { result: { stopDecision: { violations: 'SR4' } } })
    expect(buildEvent(parseArgs(baseArgv(['--judge', judge])), fixedNow).stop_reason).toBeNull()
  })

  it('returns null stop_reason when no violation carries a string rule', () => {
    const judge = writeJson('judge.json', { result: { stopDecision: { violations: [{ reason: 'x' }] } } })
    expect(buildEvent(parseArgs(baseArgv(['--judge', judge])), fixedNow).stop_reason).toBeNull()
  })

  it('ignores a non-array mismatches field', () => {
    const crosscheck = writeJson('crosscheck.json', { mismatches: 'unreported-changes' })
    expect(buildEvent(parseArgs(baseArgv(['--crosscheck', crosscheck])), fixedNow).crosscheck_mismatches).toEqual([])
  })

  it('skills_digest 來自 --skills-digest 旗標；空字串與缺席同義', () => {
    expect(
      buildEvent(parseArgs(baseArgv(['--skills-digest', 'sha256:abc'])), fixedNow).skills_digest,
    ).toBe('sha256:abc')
    expect(buildEvent(parseArgs(baseArgv(['--skills-digest', ''])), fixedNow).skills_digest).toBeNull()
    expect(buildEvent(parseArgs(baseArgv([])), fixedNow).skills_digest).toBeNull()
  })

  it('report.json 的 skillsDigest **不被採用**（受測者不得填寫自己的量測值）', () => {
    // 這個欄位的全部用途是判斷「某個 skill 放行後 gap 是否消失」（docs/25 §5 第 4 步）。
    // report.json 由 agent 自己寫；能被 agent 填寫的量測值沒有意義。
    const forged = writeJson('forged.json', { skillsDigest: 'sha256:agent-claims-this' })
    expect(buildEvent(parseArgs(baseArgv(['--report', forged])), fixedNow).skills_digest).toBeNull()
    expect(
      buildEvent(
        parseArgs(baseArgv(['--report', forged, '--skills-digest', 'sha256:ci-measured'])),
        fixedNow,
      ).skills_digest,
    ).toBe('sha256:ci-measured')
  })

  it('ignores a non-string model tier', () => {
    const model = writeJson('model.json', { tier: 7 })
    expect(buildEvent(parseArgs(baseArgv(['--model', model])), fixedNow).model_tier).toBeNull()
  })

  it('ignores a non-string outcome', () => {
    const judge = writeJson('judge.json', { result: { outcome: 42 } })
    expect(buildEvent(parseArgs(baseArgv(['--judge', judge])), fixedNow).outcome).toBeNull()
  })

  it('uses the real clock when no clock is injected', () => {
    // Exercises the default `now` parameter: every other test injects a fixed
    // clock, which would otherwise leave the production default unrun.
    const before = Date.now()
    const event = buildEvent(parseArgs(baseArgv()))
    const at = Date.parse(event.occurred_at)

    expect(Number.isNaN(at)).toBe(false)
    expect(at).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('pushEvent — 收集面永不影響執行面', () => {
  const event = buildEvent(parseArgs(baseArgv()), fixedNow)

  it('posts to /api/v1/events with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const outcome = await pushEvent(event, 'https://scoreboard.example', 'tok', fetchMock as unknown as typeof fetch)

    expect(outcome.pushed).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://scoreboard.example/api/v1/events')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
  })

  it('strips a trailing slash from the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await pushEvent(event, 'https://scoreboard.example/', 'tok', fetchMock as unknown as typeof fetch)
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://scoreboard.example/api/v1/events')
  })

  it('reports, rather than throws, when the network fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const outcome = await pushEvent(event, 'https://scoreboard.example', 'tok', fetchMock as unknown as typeof fetch)

    expect(outcome.pushed).toBe(false)
    expect(outcome.skippedReason).toContain('ECONNREFUSED')
  })

  it('reports a non-2xx response without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const outcome = await pushEvent(event, 'https://scoreboard.example', 'tok', fetchMock as unknown as typeof fetch)

    expect(outcome.pushed).toBe(false)
    expect(outcome.status).toBe(500)
  })

  it('skips silently when the URL is unset', async () => {
    const fetchMock = vi.fn()
    const outcome = await pushEvent(event, undefined, 'tok', fetchMock as unknown as typeof fetch)

    expect(outcome.pushed).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips silently when the token is unset', async () => {
    // Must not attempt an unauthenticated POST.
    const fetchMock = vi.fn()
    const outcome = await pushEvent(event, 'https://scoreboard.example', '', fetchMock as unknown as typeof fetch)

    expect(outcome.pushed).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('main', () => {
  it('assembles and pushes using env configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const outcome = await main(
      baseArgv(),
      { SCOREBOARD_URL: 'https://sb.example', SCOREBOARD_TOKEN: 'tok' },
      fetchMock as unknown as typeof fetch,
      fixedNow,
    )

    expect(outcome.pushed).toBe(true)
    expect(outcome.event.issue_number).toBe(228)
  })

  it('builds the event but sends nothing in --dry-run', async () => {
    const fetchMock = vi.fn()
    const outcome = await main(
      baseArgv(['--dry-run']),
      { SCOREBOARD_URL: 'https://sb.example', SCOREBOARD_TOKEN: 'tok' },
      fetchMock as unknown as typeof fetch,
      fixedNow,
    )

    expect(outcome.pushed).toBe(false)
    expect(outcome.skippedReason).toBe('dry-run')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome.event.schema_version).toBe(2)
  })

  it('does not push when env is empty', async () => {
    const fetchMock = vi.fn()
    const outcome = await main(baseArgv(), {}, fetchMock as unknown as typeof fetch, fixedNow)
    expect(outcome.pushed).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to process.env and the real clock when not injected', async () => {
    // Covers main()'s default parameters. SCOREBOARD_URL is unset in the test
    // environment, so this must skip without any network call.
    const prevUrl = process.env['SCOREBOARD_URL']
    const prevToken = process.env['SCOREBOARD_TOKEN']
    delete process.env['SCOREBOARD_URL']
    delete process.env['SCOREBOARD_TOKEN']
    try {
      const outcome = await main(baseArgv())
      expect(outcome.pushed).toBe(false)
      expect(outcome.skippedReason).toContain('SCOREBOARD_URL')
    } finally {
      if (prevUrl !== undefined) process.env['SCOREBOARD_URL'] = prevUrl
      if (prevToken !== undefined) process.env['SCOREBOARD_TOKEN'] = prevToken
    }
  })

  it('uses the real fetch default when a backend is configured but unreachable', async () => {
    // Covers the `fetchImpl = fetch` default. Pointed at a closed port so the
    // network path runs and fails fast, without contacting anything real.
    const outcome = await main(
      baseArgv(),
      { SCOREBOARD_URL: 'http://127.0.0.1:1', SCOREBOARD_TOKEN: 'tok' },
      undefined as unknown as typeof fetch,
    )
    expect(outcome.pushed).toBe(false)
    expect(outcome.skippedReason).toContain('網路錯誤')
  })
})

describe('requirements 訊號（REQ 錨定 → extra 槽）', () => {
  it('failed 條目 → extra.requirements_failed 只含 id（不含條文，隱私）', () => {
    const report = writeJson('r-failed.json', {
      requirements: [
        { id: 'REQ-1', status: 'passed' },
        { id: 'REQ-2', status: 'failed' },
        { id: 'REQ-3', status: 'failed' },
      ],
    })
    const e = buildEvent(parseArgs([...baseArgv(), '--report', report]))
    expect(e.extra['requirements_failed']).toEqual(['REQ-2', 'REQ-3'])
    expect(e.extra['requirements_total']).toBe(3)
  })

  it('全部 passed → 不產生 requirements_failed 欄位（不製造空欄位噪音）', () => {
    const report = writeJson('r-pass.json', { requirements: [{ id: 'REQ-1', status: 'passed' }] })
    const e = buildEvent(parseArgs([...baseArgv(), '--report', report]))
    expect(e.extra['requirements_failed']).toBeUndefined()
    expect(e.extra['requirements_total']).toBe(1)
  })

  it('crosscheck 有 advisories → extra.requirement_advisories 帶 kind', () => {
    const report = writeJson('r-adv.json', { requirements: [{ id: 'X', status: 'passed' }] })
    const cc = writeJson('cc-adv.json', {
      mismatches: [],
      advisories: [{ kind: 'requirements-unknown-id', detail: '不應外流的細節' }],
    })
    const e = buildEvent(parseArgs([...baseArgv(), '--report', report, '--crosscheck', cc]))
    expect(e.extra['requirement_advisories']).toEqual(['requirements-unknown-id'])
    // detail 含 Issue 內容，絕不外送（docs/26 §1.1 約束 3）
    expect(JSON.stringify(e)).not.toContain('不應外流的細節')
  })

  it('無 report／無 crosscheck → extra 為空物件（向後相容）', () => {
    const e = buildEvent(parseArgs(baseArgv()))
    expect(e.extra).toEqual({})
  })
})

/**
 * 「該回報卻沒回報技能缺口」→ extra.skill_gap_unreported（docs/25 §2.1）。
 *
 * 訊號可能來自 crosscheck（mismatch／零產出）或 judge（needs-human）。以單一
 * 布林送出而非兩個陣列：同一次 run 兩邊可能各發一條，布林由構造上就不重複。
 */
describe('未回報技能缺口訊號（→ extra 槽）', () => {
  const ADV = [{ kind: 'skill-gap-unreported', detail: '不應外流的細節' }]

  it('crosscheck 發出 → extra.skill_gap_unreported = true', () => {
    const cc = writeJson('cc-gap.json', { mismatches: [], advisories: ADV })
    const e = buildEvent(parseArgs([...baseArgv(), '--crosscheck', cc]))
    expect(e.extra['skill_gap_unreported']).toBe(true)
    expect(JSON.stringify(e)).not.toContain('不應外流的細節')
  })

  it('judge 發出 → extra.skill_gap_unreported = true', () => {
    const judge = writeJson('j-gap.json', {
      result: { outcome: 'needs-human', labels: [], summary: '' },
      advisories: ADV,
    })
    const e = buildEvent(parseArgs([...baseArgv(), '--judge', judge]))
    expect(e.extra['skill_gap_unreported']).toBe(true)
  })

  it('兩邊同時發出 → 仍是單一 true（不重複計數）', () => {
    const cc = writeJson('cc-both.json', { mismatches: [], advisories: ADV })
    const judge = writeJson('j-both.json', {
      result: { outcome: 'needs-human', labels: [], summary: '' },
      advisories: ADV,
    })
    const e = buildEvent(parseArgs([...baseArgv(), '--crosscheck', cc, '--judge', judge]))
    expect(e.extra['skill_gap_unreported']).toBe(true)
  })

  it('只有其他 kind 的 advisory → 不設此欄位（不製造 false 噪音）', () => {
    const cc = writeJson('cc-other.json', {
      mismatches: [],
      advisories: [{ kind: 'requirements-uncovered', detail: 'x' }],
    })
    const e = buildEvent(parseArgs([...baseArgv(), '--crosscheck', cc]))
    expect(e.extra['skill_gap_unreported']).toBeUndefined()
    expect(e.extra['requirement_advisories']).toEqual(['requirements-uncovered'])
  })

  it('缺檔／無 advisories → 不設此欄位', () => {
    expect(buildEvent(parseArgs(baseArgv())).extra['skill_gap_unreported']).toBeUndefined()
  })
})

// 2026-10-03：機制 repo 由 philipz/software_factory 遷至 aswf-dev/software_factory
// （全新 repo，非 transfer）。事件的 `repo` 是 Issue 所在的目標 repo，run 卻在
// 機制 repo 執行；看板原以單一 FACTORY_RUNNER_REPO 拼 run 連結，遷移後新 run
// （37104864848）因此 404。由 CI 以 --run-repo 帶入 github.repository，事件自述
// run 的所在地。放 extra 而非頂層：接收端 zod 會剝除未知頂層欄位，extra 原樣保存。
describe('run_repo（--run-repo → extra.run_repo，factory-scoreboard#19）', () => {
  it('--run-repo 寫入 extra.run_repo', () => {
    const e = buildEvent(parseArgs(baseArgv(['--run-repo', 'aswf-dev/software_factory'])), fixedNow)
    expect(e.extra['run_repo']).toBe('aswf-dev/software_factory')
  })

  it('缺席 → 不設此欄位（看板退回 FACTORY_RUNNER_REPO）', () => {
    expect(buildEvent(parseArgs(baseArgv()), fixedNow).extra['run_repo']).toBeUndefined()
  })

  it.each(['', 'no-slash', 'a/b/c', 'evil.com/../x', ' aswf-dev/software_factory'])(
    '非 owner/name 格式 %j → 不設此欄位（不送會被看板拒用的值）',
    (bad) => {
      expect(buildEvent(parseArgs(baseArgv(['--run-repo', bad])), fixedNow).extra['run_repo']).toBeUndefined()
    },
  )

  it('與 requirements 訊號並存於 extra，互不覆蓋', () => {
    const report = writeJson('r-run-repo.json', { requirements: [{ id: 'REQ-1', status: 'failed' }] })
    const e = buildEvent(
      parseArgs(baseArgv(['--report', report, '--run-repo', 'aswf-dev/software_factory'])),
      fixedNow,
    )
    expect(e.extra['run_repo']).toBe('aswf-dev/software_factory')
    expect(e.extra['requirements_failed']).toEqual(['REQ-1'])
  })
})
