/**
 * N-version PR 識別的 workflow 接線（fubon-tradingbot#721：#722/#723 標題不一致、
 * 單開一個 PR 看不到另一個）。CLI 本身由 src/cli/factory-nversion-pr.test.ts 覆蓋；
 * 這裡鎖 step 的位置／條件，並以 stub gh/node 實際執行 shell，驗證「只動本變體前綴的
 * open PR」與「互指參數正確」——search 的 head: 是模糊比對，前綴過濾漏掉就會改到
 * 另一變體或別張工單（7210 vs 721）的 PR。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'

interface Step {
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
}

function jobs(): { run: { steps: Step[] }; compare: { steps: Step[] } } {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  return (load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as { jobs: { run: { steps: Step[] }; compare: { steps: Step[] } } }).jobs
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 建 stub bin（gh/node），在 tmp cwd 執行 step script；回傳 stub 記錄的呼叫。 */
function execStep(script: string, opts: { gh: string; node: string; files?: Record<string, string>; env: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), 'nversion-step-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const [name, body] of [['gh', opts.gh], ['node', opts.node]] as const) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  for (const [f, content] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, f), content)
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, STUB_DIR: dir, GITHUB_WORKSPACE: dir, ...opts.env },
  })
  const read = (f: string): string => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }
  return { status: r.status, stderr: r.stderr, edits: read('edits.log'), nodeCalls: read('node.log') }
}

describe('標題正規化 step（run job）', () => {
  const step = (): Step => {
    const s = jobs().run.steps.find((x) => x.name === 'Normalize N-version PR titles')
    if (s === undefined) throw new Error('missing step')
    return s
  }

  it('位於 agent 之後、用量量測之前；agent 失敗/逾時也跑；不擋 run', () => {
    const names = jobs().run.steps.map((s) => s.name)
    const i = names.indexOf('Normalize N-version PR titles')
    expect(i).toBeGreaterThan(names.indexOf('Run factory agent'))
    expect(i).toBeLessThan(names.indexOf('Measure usage & cost'))
    expect(step().if).toContain('always()')
    expect(step().if).toContain("steps.agent.outcome != 'skipped'")
    expect(step().if).toContain('inputs.dry_run != true')
    expect(step()['continue-on-error']).toBe(true)
    expect(step().env?.GH_TOKEN).toContain('steps.app-token.outputs.token')
  })

  it('只改本變體前綴的 open PR（排除另一變體與 7210 這類前綴碰撞），並把分支與工單標題交給 CLI', () => {
    const prList = JSON.stringify([
      { number: 722, headRefName: 'factory/721-a-01-docs' },
      { number: 723, headRefName: 'factory/721-b-01-docs' },
      { number: 900, headRefName: 'factory/7210-a-01-docs' },
      { number: 724, headRefName: 'factory/721-a-02-impl' },
    ])
    const r = execStep(step().run ?? '', {
      gh: `case "$1 $2" in
  "issue view") echo '[factory] 盤點落差' ;;
  "pr list") echo '${prList}' ;;
  "pr edit") echo "$*" >> "$STUB_DIR/edits.log" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac`,
      node: `echo "$*" >> "$STUB_DIR/node.log"; echo '{"title":"T"}'`,
      env: { GH_REPO: 'o/r', ISSUE: '721', VARIANT: 'a', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    const edited = r.edits.trim().split('\n').map((l) => l.split(' ')[2])
    expect(edited).toEqual(['722', '724'])
    expect(r.nodeCalls).toContain('--branch factory/721-a-01-docs')
    expect(r.nodeCalls).toContain('--branch factory/721-a-02-impl')
    expect(r.nodeCalls).toContain('--issue-title [factory] 盤點落差')
    expect(r.nodeCalls).toContain('--variant a')
  })
})

describe('互指區塊 step（compare job）', () => {
  const step = (): Step => {
    const s = jobs().compare.steps.find((x) => x.name === 'Link N-version sibling PRs')
    if (s === undefined) throw new Error('missing step')
    return s
  }

  it('位於比對卡片之後、always()、不擋 job', () => {
    const names = jobs().compare.steps.map((s) => s.name)
    expect(names.indexOf('Link N-version sibling PRs')).toBeGreaterThan(
      names.indexOf('Generate comparison report and post comment'),
    )
    expect(step().if).toContain('always()')
    expect(step()['continue-on-error']).toBe(true)
  })

  it('每個 open PR 拿到另一變體的 open PR 清單；closed 與前綴碰撞者不算', () => {
    const prA = JSON.stringify([
      { number: 722, headRefName: 'factory/721-a-01-docs', state: 'OPEN' },
      { number: 719, headRefName: 'factory/721-a-01-docs', state: 'CLOSED' },
      { number: 901, headRefName: 'factory/7210-a-01-docs', state: 'OPEN' },
    ])
    const prB = JSON.stringify([{ number: 723, headRefName: 'factory/721-b-01-docs', state: 'OPEN' }])
    const r = execStep(step().run ?? '', {
      gh: `case "$1 $2" in
  "pr view") echo "body of $3" ;;
  "pr edit") echo "$*" >> "$STUB_DIR/edits.log" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac`,
      node: `echo "$*" >> "$STUB_DIR/node.log"; echo '{"body":"NEW"}'`,
      files: { 'pr-a.json': prA, 'pr-b.json': prB },
      env: { GH_REPO: 'o/r', ISSUE: '721', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    const edited = r.edits.trim().split('\n').map((l) => l.split(' ')[2])
    expect(edited).toEqual(['722', '723'])
    const calls = r.nodeCalls.trim().split('\n')
    expect(calls[0]).toContain('--variant a --sibling-prs 723')
    expect(calls[1]).toContain('--variant b --sibling-prs 722')
  })

  it('另一變體沒有 open PR → 傳空字串（CLI 寫「未產生 PR」）', () => {
    const r = execStep(step().run ?? '', {
      gh: `case "$1 $2" in
  "pr view") echo "body" ;;
  "pr edit") echo "$*" >> "$STUB_DIR/edits.log" ;;
esac`,
      node: `printf '%s|' "$@" >> "$STUB_DIR/node.log"; echo >> "$STUB_DIR/node.log"; echo '{"body":"NEW"}'`,
      files: { 'pr-a.json': JSON.stringify([{ number: 722, headRefName: 'factory/721-a-01-docs', state: 'OPEN' }]), 'pr-b.json': '[]' },
      env: { GH_REPO: 'o/r', ISSUE: '721', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.nodeCalls).toContain('--sibling-prs||')
    expect(r.edits.trim().split('\n')).toHaveLength(1)
  })
})

describe('shell 變數緊接非 ASCII 字元必須加大括號（全部 workflow）', () => {
  // bash 會把緊接在後的多位元組字元的位元組當成變數名的一部分：`$PR（` 變成讀取
  // 名為 `PR\xef…` 的變數——set -u 下直接 unbound variable，否則靜默印出空字串。
  // 本 PR 的互指 step 首版就踩到（stub 執行測試抓出）；factory-run.yml 既有 6 行、
  // factory-run-cleanup.yml 2 行同病（如「要求 $REQUESTED，實際」印成「要求 ，實際」）。
  it.each(readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')))('%s', (file) => {
    const offenders = readFileSync(join(ROOT, '.github/workflows', file), 'utf8')
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith('#'))
      .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`)
    expect(offenders).toEqual([])
  })
})
