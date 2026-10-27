/**
 * 驗證模式不把任何內容貼到公開 Issue（ADR-029 §5；controller ruling R6）。
 *
 * 驗證類的 Issue 開在使用者的 repo，body／留言只寫範圍與階段，**不寫任何發現**。
 * factory-run 原本有十幾處 `gh issue comment`，其中幾處的內容來自目標 repo 或 agent：
 * crosscheck 中止留言（mismatch 明細＝目標 repo 的路徑、usage.md）、agent 逾時／
 * 失敗留言（handover／usage.md）、Issue 格式檢查卡（引用 Issue 條目、風險路徑）。
 *
 * 本檔把「每一處 `gh issue comment`」逐一歸類，新增一處而沒有歸類就紅燈：
 *   1. **閘控排除**：`if:` 的頂層 conjunct 之一保證驗證模式不會執行；
 *   2. **無內容狀態**：驗證模式下只貼 factory-verify-status 產生的一行
 *      （階段＋ok／needs-human／timeout＋run URL）。這一類以 bash 實際執行 step，
 *      在 target 與 .factory 內放入含「機密」字樣的路徑與 usage，斷言留言逐字等於
 *      CLI 的輸出、且不含任何機密字樣；非驗證模式的留言維持原樣。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { main as verifyStatusMain } from '../../src/cli/factory-verify-status.js'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
}

interface Workflow {
  jobs: { run: { steps: Step[] }; compare: { steps: Step[] } }
}

function workflow(): Workflow {
  return load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as Workflow
}

function stepByName(name: string): Step {
  const wf = workflow()
  const step = [...wf.jobs.run.steps, ...wf.jobs.compare.steps].find((s) => s.name === name)
  if (step === undefined) throw new Error(`workflow 缺少步驟：${name}`)
  return step
}

/** 以 paren depth 0 的 `&&` 切出頂層 conjunct；有頂層 `||` 時不能據此推論，回 null。 */
function topLevelConjuncts(expr: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && expr.startsWith('||', i)) return null
    else if (depth === 0 && expr.startsWith('&&', i)) {
      parts.push(expr.slice(start, i).trim())
      start = i + 2
      i++
    }
  }
  parts.push(expr.slice(start).trim())
  return parts
}

/**
 * 會貼 Issue 留言（`gh issue comment`，或內部會留言的 CLI）的步驟，以及它們在
 * 驗證模式下的處置。新增留言步驟時必須在此歸類（下方的完整性測試會抓到漏網者）。
 */
const EXCLUDED: Record<string, { clause: string; why: string }> = {
  'Check prerequisites (ADR-022)': {
    clause: "steps.verifymode.outputs.requires_stage_prereqs == 'true'",
    why: '驗證類 requiresStagePrereqs=false（ADR-029 §6）',
  },
  'Resolve write-spec phase (ADR-018)': {
    clause: "steps.tasktype.outputs.value == 'agent-write-spec'",
    why: '只在 write-spec',
  },
  'Apply score labels': {
    clause: "steps.verifymode.outputs.requires_catalog == 'true'",
    why: 'apply-score-labels 會貼 in-loop 閘門留言；驗證類 requiresCatalog=false',
  },
  'PBT audit preflight': { clause: "steps.tasktype.outputs.value == 'agent-pbt-audit'", why: '只在 pbt-audit' },
  'Verify write-spec artifacts (ADR-018 §7)': {
    clause: "steps.specphase.outputs.phase != ''",
    why: 'specphase 只在 write-spec 執行（下方另測），驗證模式下 phase 恆為空',
  },
  'Post PBT audit summary': { clause: "steps.tasktype.outputs.value == 'agent-pbt-audit'", why: '只在 pbt-audit' },
  'Write terminal state': { clause: "needs.run.outputs.verify != 'true'", why: '驗證類沒有 judge 終態' },
  'Generate comparison report and post comment': {
    clause: "needs.run.outputs.verify != 'true'",
    why: '驗證類沒有 PR 可比對',
  },
  'Ensure terminal state (guard)': { clause: "needs.run.outputs.verify != 'true'", why: '驗證類不寫終態' },
}

/** 驗證模式仍會執行、因此改貼無內容狀態的步驟。 */
const STATUS_STEPS = [
  'Check issue format (central enforcement)',
  'Cross-check report vs git diff',
  'Handle agent timeout/failure',
] as const

/** 內部會呼叫 `gh issue comment` 的 CLI（不經 workflow shell 的 `gh issue comment`）。 */
const COMMENTING_CLIS = ['apply-score-labels.js']

describe('每一處 Issue 留言都已歸類（新增而未歸類即紅燈）', () => {
  it('workflow 內所有留言步驟 = 閘控排除 ∪ 無內容狀態', () => {
    const wf = workflow()
    const posting = [...wf.jobs.run.steps, ...wf.jobs.compare.steps]
      .filter((s) => {
        const run = s.run ?? ''
        return run.includes('gh issue comment') || COMMENTING_CLIS.some((cli) => run.includes(cli))
      })
      .map((s) => s.name)
    expect(new Set(posting)).toEqual(new Set([...Object.keys(EXCLUDED), ...STATUS_STEPS]))
  })

  for (const [name, { clause, why }] of Object.entries(EXCLUDED)) {
    it(`${name}：if 的頂層 conjunct 含 ${clause}（${why}）`, () => {
      const conjuncts = topLevelConjuncts(stepByName(name).if ?? '')
      expect(conjuncts, `${name} 的 if 有頂層 ||，無法保證驗證模式不執行`).not.toBeNull()
      expect(conjuncts).toContain(clause)
    })
  }

  it('specphase（phase 的唯一來源）只在 write-spec 執行', () => {
    const specphase = workflow().jobs.run.steps.find((s) => s.id === 'specphase')
    expect(specphase?.if).toBe("steps.tasktype.outputs.value == 'agent-write-spec'")
  })

  for (const name of STATUS_STEPS) {
    // M4：task type 經 env 進 shell，run 內不內嵌 `${{ steps.tasktype.outputs.value }}`
    // （Actions 的 `${{ }}` 是文字替換；值一旦被 shell 解讀就是 injection 面）
    it(`${name}：task type 以 env STAGE 傳入，run 內沒有內嵌的 tasktype 運算式`, () => {
      const s = stepByName(name)
      expect(s.env?.['STAGE']).toBe('${{ steps.tasktype.outputs.value }}')
      expect(s.run ?? '').not.toMatch(/\$\{\{\s*steps\.tasktype\.outputs\.value\s*\}\}/)
      expect(s.run ?? '').toContain('--stage "$STAGE"')
    })

    it(`${name}：驗證分支呼叫 factory-verify-status，留言檔是它的輸出`, () => {
      const run = stepByName(name).run ?? ''
      expect(run).toContain('factory-verify-status.js')
      expect(run).toMatch(/jq -r \.comment > "?[^\s"]*verify-status\.md"?/)
      expect(run).toMatch(/gh issue comment [^\n]*--body-file "?[^\s"]*verify-status\.md"?/)
    })
  }
})

// ─── 行為測試：以 bash 實際執行 step（node／gh 以 stub 取代，jq 用真的） ───

const RUN_ID = '424242'
const RUN_URL = `https://github.com/aswf-dev/software_factory/actions/runs/${RUN_ID}`
/** 放進 target／.factory 的「機密」字樣：任何一個出現在留言裡都是洩漏。 */
const SECRET = 'src/payments/ledger-secret.ts'
const SECRET_USAGE = 'USAGE-SECRET-overflow-in-ledger'

function substitute(run: string, values: Record<string, string>): string {
  return run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const v = values[expr]
    if (v === undefined) throw new Error(`測試未提供 \${{ ${expr} }} 的值`)
    return v
  })
}

/** step 的 `env:`，以同樣的值代入；值含測試未提供的運算式（例如 token）時略過該變數。 */
function stepEnv(step: Step, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(step.env ?? {})) {
    try {
      out[k] = substitute(String(v), values)
    } catch {
      // 未提供的運算式：不設定
    }
  }
  return out
}

const BASE_VALUES: Record<string, string> = {
  'inputs.issue_number': '670',
  'inputs.base_branch': 'main',
  'inputs.verify_phase': 'proofs',
  'github.run_id': RUN_ID,
  'github.server_url': 'https://github.com',
  'github.repository': 'aswf-dev/software_factory',
  'matrix.variant': 'a',
  'steps.specphase.outputs.phase': '',
  'steps.specphase.outputs.spec_name': '',
  'steps.agent.outputs.inner_timeout': 'false',
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

interface Run {
  status: number | null
  log: string
  comments: string[]
  statusArgs: string[] | undefined
}

/**
 * 執行 step。stub `node`：factory-verify-status 以**真的** `main()` 的參數契約驗證——
 * stub 記下參數，測試端再以 in-process 的 main() 算出預期留言比對；其他 CLI 依
 * `NODE_<basename>` 環境變數的設定輸出 stdout 與 exit code。
 */
function runStep(
  name: string,
  overrides: Record<string, string>,
  setup: (dir: string) => void,
  cli: Record<string, { stdout: string; code: number }> = {},
  env: Record<string, string> = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'verify-comments-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, '.factory'))
  mkdirSync(join(dir, 'target/.factory/run'), { recursive: true })
  mkdirSync(join(dir, 'cli'))
  for (const [base, { stdout, code }] of Object.entries(cli)) {
    writeFileSync(join(dir, 'cli', `${base}.out`), stdout)
    writeFileSync(join(dir, 'cli', `${base}.code`), String(code))
  }
  setup(dir)
  const stub = (file: string, body: string) => {
    writeFileSync(join(bin, file), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, file), 0o755)
  }
  stub(
    'node',
    [
      'base=$(basename "$1" .js)',
      'shift',
      'if [ "$base" = "factory-verify-status" ]; then',
      '  printf "%s\\n" "$@" > "$STUB_DIR/status-args.txt"',
      // 產出與真 CLI 相同形狀的 JSON；內容由測試端以真的 main() 比對
      '  printf \'{"comment":"STATUS-FROM-CLI"}\\n\'; exit 0',
      'fi',
      'if [ -f "$STUB_DIR/cli/$base.out" ]; then cat "$STUB_DIR/cli/$base.out"; exit "$(cat "$STUB_DIR/cli/$base.code")"; fi',
      'exit 0',
    ].join('\n'),
  )
  stub(
    'gh',
    [
      'case "$1 $2" in',
      '  "issue view") exit 1 ;;',
      '  "issue comment")',
      '    n=$(ls "$STUB_DIR" | grep -c "^comment-" || true)',
      '    while [ $# -gt 0 ]; do',
      '      [ "$1" = "--body-file" ] && cp "$2" "$STUB_DIR/comment-$n.md"',
      '      [ "$1" = "--body" ] && printf "%s" "$2" > "$STUB_DIR/comment-$n.md"',
      '      shift',
      '    done ;;',
      '  *) echo "unexpected gh call: $*" >&2; exit 99 ;;',
      'esac',
    ].join('\n'),
  )
  stub('git', 'echo "unexpected git call: $*" >&2; exit 99')
  const values = { ...BASE_VALUES, ...overrides }
  const step = stepByName(name)
  const r = spawnSync('bash', ['-e', '-c', substitute(step.run ?? '', values)], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STUB_DIR: dir,
      GITHUB_WORKSPACE: dir,
      VARIANT: 'a',
      ...stepEnv(step, values),
      ...env,
    },
  })
  const comments = readdirComments(dir)
  const argsPath = join(dir, 'status-args.txt')
  return {
    status: r.status,
    log: `${r.stdout}${r.stderr}`,
    comments,
    statusArgs: existsSync(argsPath) ? readFileSync(argsPath, 'utf8').trimEnd().split('\n') : undefined,
  }
}

function readdirComments(dir: string): string[] {
  const out: string[] = []
  for (let i = 0; existsSync(join(dir, `comment-${i}.md`)); i++) out.push(readFileSync(join(dir, `comment-${i}.md`), 'utf8'))
  return out
}

/** 驗證模式的共同斷言：恰好一則留言、逐字是 CLI 輸出、參數通過真的 CLI 契約、無機密。 */
function expectContentFree(r: Run, stage: string, outcome: string): void {
  expect(r.comments, r.log).toEqual(['STATUS-FROM-CLI\n'])
  expect(r.statusArgs).toBeDefined()
  const { comment } = verifyStatusMain(r.statusArgs!)
  const phase = stage === 'agent-verify-lean' ? '（proofs）' : ''
  expect(comment).toBe(`驗證階段 ${stage}${phase}：${outcome} — ${RUN_URL}`)
  expect(comment).not.toContain(SECRET)
  expect(comment).not.toContain(SECRET_USAGE)
}

const VERIFY = (taskType: string) => ({
  'steps.verifymode.outputs.verify': 'true',
  'steps.tasktype.outputs.value': taskType,
})
const NON_VERIFY = { 'steps.verifymode.outputs.verify': 'false', 'steps.tasktype.outputs.value': 'agent-fix-bug' }

describe('Cross-check report vs git diff：驗證模式只貼無內容狀態', () => {
  const mismatch = JSON.stringify({
    issueNumber: 670,
    ok: false,
    mismatches: [{ kind: 'verify-scope', detail: `越界：${SECRET}` }],
    advisories: [],
    headline: '變更超出任務類型允許的範圍',
  })
  const seedUsage = (dir: string) => writeFileSync(join(dir, 'target/.factory/run/usage.md'), SECRET_USAGE)

  it('mismatch：needs-human 狀態，不含路徑與 usage', () => {
    const r = runStep('Cross-check report vs git diff', VERIFY('agent-verify-lean'), seedUsage, {
      'factory-crosscheck': { stdout: mismatch, code: 1 },
    })
    expect(r.status).not.toBe(0)
    expectContentFree(r, 'agent-verify-lean', 'needs-human')
  })

  it('crosscheck 沒產出 JSON：同樣只貼狀態（stderr 不進留言）', () => {
    const r = runStep('Cross-check report vs git diff', VERIFY('agent-verify-quint'), seedUsage, {
      'factory-crosscheck': { stdout: '', code: 1 },
    })
    expect(r.status).not.toBe(0)
    expectContentFree(r, 'agent-verify-quint', 'needs-human')
  })

  it('通過：不留言', () => {
    const ok = JSON.stringify({ issueNumber: 670, ok: true, mismatches: [], advisories: [], headline: '' })
    const r = runStep('Cross-check report vs git diff', VERIFY('agent-verify-quint'), seedUsage, {
      'factory-crosscheck': { stdout: ok, code: 0 },
    })
    expect(r.status, r.log).toBe(0)
    expect(r.comments).toEqual([])
  })

  it('非驗證模式：原留言（標題＋明細＋usage）不變，不呼叫 factory-verify-status', () => {
    const r = runStep(
      'Cross-check report vs git diff',
      NON_VERIFY,
      (dir) => {
        seedUsage(dir)
        writeFileSync(join(dir, '.factory/ls-remote.txt'), '')
      },
      { 'factory-crosscheck': { stdout: mismatch, code: 1 } },
    )
    expect(r.status).not.toBe(0)
    expect(r.statusArgs).toBeUndefined()
    expect(r.comments).toHaveLength(1)
    expect(r.comments[0]).toContain('## 工廠執行中止：變更超出任務類型允許的範圍')
    expect(r.comments[0]).toContain(`- verify-scope：越界：${SECRET}`)
    expect(r.comments[0]).toContain(SECRET_USAGE)
  })
})

describe('Handle agent timeout/failure：驗證模式只貼無內容狀態', () => {
  const seed = (dir: string) => writeFileSync(join(dir, 'target/.factory/run/usage.md'), SECRET_USAGE)

  it('內層逾時 → timeout，不含 usage／handover', () => {
    const r = runStep(
      'Handle agent timeout/failure',
      { ...VERIFY('agent-verify-lean'), 'steps.agent.outputs.inner_timeout': 'true' },
      seed,
    )
    expect(r.status, r.log).toBe(0)
    expectContentFree(r, 'agent-verify-lean', 'timeout')
  })

  it('其他失敗 → needs-human', () => {
    const r = runStep('Handle agent timeout/failure', VERIFY('agent-verify-tests'), seed)
    expect(r.status, r.log).toBe(0)
    expectContentFree(r, 'agent-verify-tests', 'needs-human')
  })

  it('驗證模式不寫 handover.md（含 usage 的檔案不該產生）', () => {
    let dirSeen = ''
    const r = runStep('Handle agent timeout/failure', VERIFY('agent-verify-grill'), (dir) => {
      seed(dir)
      dirSeen = dir
    })
    expect(r.status, r.log).toBe(0)
    expect(existsSync(join(dirSeen, 'target/.factory/run/handover.md'))).toBe(false)
  })

  it('非驗證模式：NOTE＋usage.md 的 handover 留言不變', () => {
    const r = runStep('Handle agent timeout/failure', NON_VERIFY, seed)
    expect(r.status, r.log).toBe(0)
    expect(r.statusArgs).toBeUndefined()
    expect(r.comments).toEqual([
      `⏱️ 變體 a 的 factory agent 未在時限內完成（逾時或失敗）。請查看 run ${RUN_ID} 的 logs；Issue 終態由 compare job 彙整後另行留言。\n${SECRET_USAGE}`,
    ])
  })

  it('非驗證模式、沒有 usage.md：只貼 NOTE', () => {
    const r = runStep('Handle agent timeout/failure', NON_VERIFY, () => {})
    expect(r.comments).toEqual([
      `⏱️ 變體 a 的 factory agent 未在時限內完成（逾時或失敗）。請查看 run ${RUN_ID} 的 logs；Issue 終態由 compare job 彙整後另行留言。`,
    ])
  })
})

describe('Check issue format (central enforcement)：驗證模式不貼格式卡', () => {
  const card = (compliant: boolean) =>
    `${compliant ? '✅ 格式合規' : '❌ 格式不合規'}\n- 「${SECRET}」（缺少驗收條件）\n📊 **複雜度分析**：high`

  it('不合規 → needs-human 狀態（格式卡含 Issue 條目，不貼），仍 exit 1 停派', () => {
    const r = runStep('Check issue format (central enforcement)', VERIFY('agent-verify-quint'), () => {}, {
      'factory-issue-check': { stdout: card(false), code: 0 },
    })
    expect(r.status).toBe(1)
    expectContentFree(r, 'agent-verify-quint', 'needs-human')
  })

  it('合規 → 不留言', () => {
    const r = runStep('Check issue format (central enforcement)', VERIFY('agent-verify-quint'), () => {}, {
      'factory-issue-check': { stdout: card(true), code: 0 },
    })
    expect(r.status, r.log).toBe(0)
    expect(r.comments).toEqual([])
  })

  it('變體 b 不留言（與一般模式相同的去重）', () => {
    const r = runStep(
      'Check issue format (central enforcement)',
      { ...VERIFY('agent-verify-quint'), 'matrix.variant': 'b' },
      () => {},
      { 'factory-issue-check': { stdout: card(false), code: 0 } },
      { VARIANT: 'b' },
    )
    expect(r.status).toBe(1)
    expect(r.comments).toEqual([])
  })

  it('非驗證模式：格式卡原樣貼出（合規與否都貼）', () => {
    for (const compliant of [true, false]) {
      const r = runStep('Check issue format (central enforcement)', NON_VERIFY, () => {}, {
        'factory-issue-check': { stdout: card(compliant), code: 0 },
      })
      expect(r.statusArgs).toBeUndefined()
      expect(r.comments).toEqual([card(compliant)])
      expect(r.status).toBe(compliant ? 0 : 1)
    }
  })
})
