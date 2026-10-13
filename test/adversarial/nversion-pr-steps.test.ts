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
function execStep(script: string, opts: { gh: string; node: string; files?: Record<string, string> | undefined; env: Record<string, string> }) {
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

/* ── ADR-021：開關、draft 狀態、單一終態寫入者、G1／G2、選勝者 ─────────────── */

interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown; options?: string[]; required?: boolean }> } }
  concurrency?: { group?: string }
  jobs: Record<string, { strategy?: { matrix?: { variant?: unknown } }; steps: (Step & { id?: string; uses?: string })[] }>
}
function workflow(file: string): Workflow {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  return load(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as Workflow
}

/** 通用 stub 執行：gh 依 `cases`（bash case 主體）回應，且每次呼叫都依序記到 calls.log。 */
function execLogged(script: string, opts: { cases: string; files?: Record<string, string>; env: Record<string, string>; node?: string }) {
  const r = execStep(script, {
    gh: `echo "$*" >> "$STUB_DIR/calls.log"\ncase "$1 $2" in\n${opts.cases}\n  *) : ;;\nesac`,
    node: opts.node ?? 'exit 0',
    files: opts.files,
    env: opts.env,
  })
  const dir = dirs[dirs.length - 1] as string
  let calls: string[] = []
  try {
    calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter((l) => l !== '')
  } catch {
    calls = []
  }
  const file = (f: string): string => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }
  return { ...r, calls, file }
}

describe('nversion 開關（ADR-021）', () => {
  it('dispatch input：布林、預設 true（Backstage／aswf.dev／標籤觸發都不傳 → 一律開啟）', () => {
    const input = workflow('factory-run.yml').on.workflow_dispatch.inputs['nversion']
    expect(input).toMatchObject({ type: 'boolean', default: true, required: false })
  })

  it('關閉時：不改寫成 dual 模型鏈、不告訴 agent「另一個變體正在處理」、仍告知分支前綴', () => {
    const steps = jobs().run.steps
    const model = steps.find((s) => s.name === 'Select model tier')!.run!
    expect(model).toMatch(/if \[ "\$\{\{ inputs\.nversion \}\}" = "true" \]; then[\s\S]*\.dual as \$d[\s\S]*else/)
    const agent = steps.find((s) => s.name === 'Run factory agent')!.run!
    expect(agent).toContain('if [ "${{ inputs.nversion }}" != "true" ]; then')
    expect(agent).toContain('【單一變體執行】')
    expect(agent).toContain('${VARIANT_PREFIX}')
  })

  it('把 nversion 寫給 agent（skill 依此決定 draft），並寫 variant', () => {
    const w = readFileSync(join(ROOT, WORKFLOW), 'utf8')
    expect(w).toContain(`printf '%s' "\${{ inputs.nversion }}" > target/.factory/run/nversion`)
  })

  it('compare：B 的 artifact、比對卡片、互指區塊只在 N-version 時執行', () => {
    const c = workflow('factory-run.yml').jobs['compare']!.steps
    expect(c.find((s) => s.name === 'Download Variant B artifact')!.if).toBe('inputs.nversion')
    expect(c.find((s) => s.name === 'Generate comparison report and post comment')!.if).toBe('always() && inputs.nversion')
    expect(c.find((s) => s.name === 'Link N-version sibling PRs')!.if).toBe('always() && inputs.nversion')
  })
})

describe('dry_run 的模型路由可被驗證（2026-10-13 沙箱 #10）', () => {
  it('stub agent 收到本變體的 model.json；比對卡片收到字面 true／false 的 --dry-run', () => {
    const w = readFileSync(join(ROOT, WORKFLOW), 'utf8')
    expect(jobs().run.steps.find((s) => s.name === 'Run factory agent')!.run).toContain('--model-json "$GITHUB_WORKSPACE/.factory/model.json"')
    // model.json 必須在 agent 之前產出（Select model tier 已依變體改寫 chain）
    const names = jobs().run.steps.map((s) => s.name)
    expect(names.indexOf('Select model tier')).toBeLessThan(names.indexOf('Run factory agent'))
    expect(w).toContain(`--dry-run "\${{ inputs.dry_run && 'true' || 'false' }}"`)
  })
})

describe('PR draft 狀態由機制統一設定（ADR-021，D 方案的機制層）', () => {
  const step = (): Step => jobs().run.steps.find((x) => x.name === 'Normalize PR draft state')!

  it('位於 agent 之後、用量量測之前；agent 失敗也跑；不擋 run', () => {
    const names = jobs().run.steps.map((s) => s.name)
    const i = names.indexOf('Normalize PR draft state')
    expect(i).toBeGreaterThan(names.indexOf('Run factory agent'))
    expect(i).toBeLessThan(names.indexOf('Measure usage & cost'))
    expect(step().if).toContain('always()')
    expect(step()['continue-on-error']).toBe(true)
  })

  const list = JSON.stringify([
    { number: 1, headRefName: 'factory/721-a-01-test', isDraft: false },
    { number: 2, headRefName: 'factory/721-a-02-impl', isDraft: true },
    { number: 3, headRefName: 'factory/721-b-01-test', isDraft: false },
    { number: 4, headRefName: 'factory/7210-a-01-test', isDraft: false },
  ])

  it('N-version：只把本變體前綴、還不是 draft 的 PR 轉成 draft', () => {
    const r = execLogged(step().run ?? '', {
      cases: `  "pr list") echo '${list}' ;;`,
      env: { GH_REPO: 'o/r', ISSUE: '721', VARIANT: 'a', NVERSION: 'true', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.filter((c) => c.startsWith('pr ready'))).toEqual(['pr ready 1 --repo o/r --undo'])
    expect(r.file('.factory/draft-state.txt')).toBe('')
  })

  it('N-version：轉 draft 失敗（例如方案不支援）→ 記入 draft-state.txt、不擋 run', () => {
    const r = execLogged(step().run ?? '', {
      cases: `  "pr list") echo '${list}' ;;\n  "pr ready") exit 1 ;;`,
      env: { GH_REPO: 'o/r', ISSUE: '721', VARIANT: 'a', NVERSION: 'true', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.file('.factory/draft-state.txt')).toBe('unsupported 1\n')
  })

  it('單一變體：只把 draft 轉成正式 PR', () => {
    const r = execLogged(step().run ?? '', {
      cases: `  "pr list") echo '${list}' ;;`,
      env: { GH_REPO: 'o/r', ISSUE: '721', VARIANT: 'a', NVERSION: 'false', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.filter((c) => c.startsWith('pr ready'))).toEqual(['pr ready 2 --repo o/r'])
  })
})

describe('compare job 是 Issue 終態的唯一寫入者（ADR-021）', () => {
  const steps = () => workflow('factory-run.yml').jobs['compare']!.steps
  const terminal = (): Step => steps().find((s) => s.name === 'Write terminal state')!
  const guard = (): Step => steps().find((s) => s.name === 'Ensure terminal state (guard)')!

  it('終態寫入排在比對卡片之前；卡片失敗不擋（continue-on-error）；G1 是最後一步', () => {
    const names = steps().map((s) => s.name)
    expect(names.indexOf('Write terminal state')).toBeLessThan(names.indexOf('Generate comparison report and post comment'))
    expect(steps().find((s) => s.name === 'Generate comparison report and post comment')!['continue-on-error']).toBe(true)
    expect(names.at(-1)).toBe('Ensure terminal state (guard)')
    expect(guard().if).toBe("always() && steps.terminal.outcome != 'success'")
  })

  it('先貼標籤、後留言（留言帶終態標記；標籤失敗時不得留下標記）', () => {
    const r = execLogged(terminal().run ?? '', {
      cases: '',
      node: `echo '{"write":true,"labels":["oversight/review"],"comment":"<!-- factory:terminal run=5 -->\\nX"}'`,
      env: { GH_REPO: 'o/r', ISSUE: '721', NVERSION: 'true', RUN_ID: '5', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls).toEqual(['issue edit 721 --repo o/r --add-label oversight/review', 'issue comment 721 --repo o/r --body-file terminal.md'])
  })

  it('標籤失敗 → step 失敗且沒有留言（讓 G1 接手）', () => {
    const r = execLogged(terminal().run ?? '', {
      cases: '  "issue edit") exit 1 ;;',
      node: `echo '{"write":true,"labels":["needs-human"],"comment":"c"}'`,
      env: { GH_REPO: 'o/r', ISSUE: '721', NVERSION: 'true', RUN_ID: '5', GH_TOKEN: 'x' },
    })
    expect(r.status).not.toBe(0)
    expect(r.calls.some((c) => c.startsWith('issue comment'))).toBe(false)
  })

  it('所有變體都沒啟動 agent → 不寫任何東西', () => {
    const r = execLogged(terminal().run ?? '', {
      cases: '',
      node: `echo '{"write":false,"labels":[]}'`,
      env: { GH_REPO: 'o/r', ISSUE: '721', NVERSION: 'true', RUN_ID: '5', GH_TOKEN: 'x' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls).toEqual([])
  })

  it('N-version 時讀兩個變體目錄，關閉時只讀 a', () => {
    for (const [nv, expected] of [['true', '--variant-dir b=artifacts/b'], ['false', '']] as const) {
      const r = execLogged(terminal().run ?? '', {
        cases: '',
        node: `echo "$*" >> "$STUB_DIR/node.log"; echo '{"write":false,"labels":[]}'`,
        env: { GH_REPO: 'o/r', ISSUE: '721', NVERSION: nv, RUN_ID: '5', GH_TOKEN: 'x' },
      })
      expect(r.nodeCalls).toContain(`--run-id 5 --nversion ${nv} --variant-dir a=artifacts/a`)
      if (expected === '') expect(r.nodeCalls).not.toContain('artifacts/b')
      else expect(r.nodeCalls).toContain(expected)
    }
  })

  const guardEnv = { GH_REPO: 'o/r', ISSUE: '721', NVERSION: 'true', RUN_ID: '5', GH_TOKEN: 'x' }

  it('G1：Issue 已有本 run 的終態標記 → 閒置（含 run id 但沒有標記的留言不算）', () => {
    const idle = execLogged(guard().run ?? '', {
      cases: `  "issue view") echo 'x <!-- factory:terminal run=5 --> y' ;;`,
      env: guardEnv,
    })
    expect(idle.calls.some((c) => c.startsWith('issue edit'))).toBe(false)
    const fires = execLogged(guard().run ?? '', {
      cases: `  "issue view") echo '規格流程（run: 5）' ;;`,
      files: {},
      env: guardEnv,
    })
    expect(fires.calls.some((c) => c.includes('--add-label needs-human'))).toBe(true)
  })

  it('G1：所有變體的 agent 都沒啟動 → 閒置（前置閘門已有訊號）', () => {
    const r = execLogged(
      `mkdir -p artifacts/a/.factory artifacts/b/.factory
echo '{"agent":"skipped"}' > artifacts/a/.factory/steps.json
echo '{"agent":"skipped"}' > artifacts/b/.factory/steps.json
${guard().run ?? ''}`,
      { cases: `  "issue view") echo '' ;;`, env: guardEnv },
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.some((c) => c.startsWith('issue edit'))).toBe(false)
  })

  it('G1：補貼時先貼標籤、後留言，且留言帶標記（讓 G2 閒置）', () => {
    const r = execLogged(guard().run ?? '', { cases: `  "issue view") echo '' ;;`, env: guardEnv })
    expect(r.status, r.stderr).toBe(0)
    const edit = r.calls.findIndex((c) => c.startsWith('issue edit'))
    const comment = r.calls.findIndex((c) => c.startsWith('issue comment'))
    expect(edit).toBeGreaterThanOrEqual(0)
    expect(comment).toBeGreaterThan(edit)
    expect(r.file('.factory/guard-comment.txt')).toContain('<!-- factory:terminal run=5 -->')
  })
})

describe('G2（factory-run-cleanup）只認終態標記（ADR-021）', () => {
  it('判斷「已有終態」用專屬標記，不用裸 run id；補貼的留言也帶標記', () => {
    const run = workflow('factory-run-cleanup.yml').jobs['cleanup']!.steps.find((s) => s.name === 'Post needs-human if no terminal comment')!.run!
    expect(run).toContain('MARKER="<!-- factory:terminal run=${RUN_ID} -->"')
    expect(run).toContain('grep -qF "$MARKER"')
    expect(run).not.toContain('grep -qF "$RUN_ID"')
    expect(run.indexOf('--add-label needs-human')).toBeLessThan(run.indexOf('gh issue comment'))
  })
})

describe('選勝者 workflow（factory-nversion-pick，ADR-021）', () => {
  const wf = () => workflow('factory-nversion-pick.yml')
  const step = (): Step => wf().jobs['pick']!.steps.find((s) => s.name === 'Promote winner and close loser drafts')!
  const env = { GH_REPO: 'o/r', ISSUE: '721', WINNER: 'a', ACTOR: 'philipz', RUN_ID: '9', GH_TOKEN: 'x' }

  it('workflow_dispatch：Issue 編號必填、勝出變體只能是 a／b；與 factory-run 共用 concurrency group', () => {
    const inputs = wf().on.workflow_dispatch.inputs
    expect(inputs['issue_number']).toMatchObject({ required: true, type: 'number' })
    expect(inputs['variant']).toMatchObject({ required: true, type: 'choice', options: ['a', 'b'] })
    expect(wf().concurrency?.group).toBe(workflow('factory-run.yml').concurrency?.group)
  })

  it('勝者的 draft 由底層往上轉正式；落選方關閉但**不刪分支**；在 Issue 留紀錄', () => {
    const open = (v: string) =>
      JSON.stringify(
        v === 'a'
          ? [
              { number: 12, headRefName: 'factory/721-a-02-impl', isDraft: true },
              { number: 11, headRefName: 'factory/721-a-01-test', isDraft: true },
              { number: 99, headRefName: 'factory/7210-a-01-test', isDraft: true },
            ]
          : [{ number: 21, headRefName: 'factory/721-b-01-test', isDraft: true }],
      )
    const r = execLogged(step().run ?? '', {
      cases: `  "pr list") case "$*" in *721-a-*) echo '${open('a')}' ;; *) echo '${open('b')}' ;; esac ;;`,
      env,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.filter((c) => c.startsWith('pr ready'))).toEqual(['pr ready 11 --repo o/r', 'pr ready 12 --repo o/r'])
    const closes = r.calls.filter((c) => c.startsWith('pr close'))
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatch(/^pr close 21 --repo o\/r --comment /)
    expect(closes[0]).not.toContain('--delete-branch')
    const comment = r.calls.find((c) => c.startsWith('issue comment'))!
    expect(comment).toContain('#11、#12')
    expect(comment).toContain('#21')
    expect(comment).toContain('@philipz')
  })

  it('勝者沒有 open PR → 失敗，不關閉任何東西', () => {
    const r = execLogged(step().run ?? '', { cases: `  "pr list") echo '[]' ;;`, env })
    expect(r.status).not.toBe(0)
    expect(r.calls.some((c) => c.startsWith('pr close'))).toBe(false)
  })

  it('勝者的 PR 若不是 draft（例如 repo 不支援 draft）→ 不呼叫 pr ready，照常關閉落選方', () => {
    const r = execLogged(step().run ?? '', {
      cases: `  "pr list") case "$*" in *721-a-*) echo '[{"number":11,"headRefName":"factory/721-a-01-test","isDraft":false}]' ;; *) echo '[]' ;; esac ;;`,
      env,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.some((c) => c.startsWith('pr ready'))).toBe(false)
    expect(r.calls.find((c) => c.startsWith('issue comment'))).toContain('沒有開著的 PR')
  })

  it('取代舊的 factory-nversion-cleanup.yml（那支只對機制 repo 有效，從未部署到目標 repo）', () => {
    expect(readdirSync(join(ROOT, '.github/workflows'))).not.toContain('factory-nversion-cleanup.yml')
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
