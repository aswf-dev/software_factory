/**
 * factory-run「Cross-check report vs git diff」step 的行為測試（以 bash 實際執行）。
 *
 * 回歸 philipz/fubon-tradingbot#670（run 37601718941）：agent 的 report.json 把
 * `requirements[].status` 寫成 `met`／`deferred`，factory-crosscheck 在讀 report 時
 * 拋錯、只寫 stderr，crosscheck.json 是空檔。step 因此：
 *   1. `jq ... .factory/crosscheck.json || echo 0` 在空檔上輸出空字串（jq 讀空輸入
 *      exit 0，`|| echo 0` 不觸發），`[ "" -gt 0 ]` 印出 `integer expression expected`；
 *   2. Issue 留言只有「crosscheck 執行失敗」，原因只在沒人看得到的 crosscheck.err
 *      （沒印到 log、沒進留言、也沒進 artifact）。
 * 人只能下載 artifact、在本機重跑 crosscheck 才查到原因。
 *
 * 這類缺陷字串比對抓不到（壞掉的 shell 照樣「包含」正確的關鍵字），因此直接執行
 * step 的 run script：`node`／`gh` 以 stub 取代，`jq` 用真的。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'

type Step = { id?: string; name?: string; run?: string; with?: { path?: string } }

function steps(): Step[] {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  const wf = load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as { jobs: { run: { steps: Step[] } } }
  return wf.jobs.run.steps
}

/** crosscheck step 的 run script，`${{ }}` 以固定值代入（同 Actions 的文字替換語意）。 */
function crosscheckScript(overrides: Record<string, string> = {}): string {
  const run = steps().find((s) => s.id === 'crosscheck')?.run
  if (run === undefined) throw new Error('找不到 id: crosscheck 的 step')
  const values: Record<string, string> = {
    'steps.tasktype.outputs.value': 'agent-fix-bug',
    'steps.verifymode.outputs.verify': 'false',
    'inputs.issue_number': '670',
    'inputs.base_branch': 'software-factory',
    'github.run_id': '424242',
    'matrix.variant': 'a',
    // 非 write-spec 類型：這兩個值只出現在 write-spec 分支內，不會被讀到
    'steps.specphase.outputs.phase': '',
    'steps.specphase.outputs.spec_name': '',
    ...overrides,
  }
  return run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const v = values[expr]
    if (v === undefined) throw new Error(`測試未提供 \${{ ${expr} }} 的值`)
    return v
  })
}

interface StepResult {
  status: number | null
  log: string
  comment: string | undefined
  labels: string
  /** stub node（扮演 factory-crosscheck）收到的參數。 */
  nodeArgs: string
  /** step 寫給 crosscheck 的遠端分支清單；step 沒寫時為 undefined。 */
  remoteBranches: string | undefined
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** 執行 step：stub 的 `node` 扮演 factory-crosscheck，依參數輸出 stdout／stderr／exit code。 */
function runStep(
  crosscheck: { stdout: string; stderr: string; code: number },
  /** `git ls-remote --heads origin` 的 stub 輸出；null = ls-remote 失敗。 */
  lsRemote: string | null = '',
  /** 覆寫 `${{ }}` 的值（例如驗證模式）。 */
  overrides: Record<string, string> = {},
): StepResult {
  const dir = mkdtempSync(join(tmpdir(), 'crosscheck-step-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, '.factory'))
  mkdirSync(join(dir, 'target/.factory/run'), { recursive: true })
  writeFileSync(join(dir, 'cc.stdout'), crosscheck.stdout)
  writeFileSync(join(dir, 'cc.stderr'), crosscheck.stderr)
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  stub(
    'node',
    `echo "$*" > "$STUB_DIR/node-args.txt"; cat "$STUB_DIR/cc.stdout"; cat "$STUB_DIR/cc.stderr" >&2; exit ${crosscheck.code}`,
  )
  if (lsRemote !== null) writeFileSync(join(dir, 'ls-remote.txt'), lsRemote)
  stub(
    'git',
    [
      'if [ "$1 $2 $3 $4 $5" = "-C target ls-remote --heads origin" ]; then',
      '  [ -f "$STUB_DIR/ls-remote.txt" ] || { echo "fatal: could not read from remote" >&2; exit 128; }',
      '  cat "$STUB_DIR/ls-remote.txt"; exit 0',
      'fi',
      'echo "unexpected git call: $*" >&2; exit 99',
    ].join('\n'),
  )
  stub(
    'gh',
    [
      'case "$1 $2" in',
      '  "issue view") exit 1 ;;',
      '  "issue comment") while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$STUB_DIR/comment.md"; shift; done ;;',
      '  "issue edit") echo "$*" >> "$STUB_DIR/labels.txt" ;;',
      '  *) echo "unexpected gh call: $*" >&2; exit 99 ;;',
      'esac',
    ].join('\n'),
  )
  // GitHub Actions 的 run step 以 `bash -e {0}` 執行（見 run log 的 shell: 行）
  const r = spawnSync('bash', ['-e', '-c', crosscheckScript(overrides)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, STUB_DIR: dir, GITHUB_WORKSPACE: dir },
  })
  const commentPath = join(dir, 'comment.md')
  const labelsPath = join(dir, 'labels.txt')
  const remotePath = join(dir, '.factory/remote-branches.txt')
  const nodeArgsPath = join(dir, 'node-args.txt')
  return {
    status: r.status,
    log: `${r.stdout}${r.stderr}`,
    comment: existsSync(commentPath) ? readFileSync(commentPath, 'utf8') : undefined,
    labels: existsSync(labelsPath) ? readFileSync(labelsPath, 'utf8') : '',
    nodeArgs: existsSync(nodeArgsPath) ? readFileSync(nodeArgsPath, 'utf8') : '',
    remoteBranches: existsSync(remotePath) ? readFileSync(remotePath, 'utf8') : undefined,
  }
}

const REPORT_INVALID =
  'error: report (target/.factory/run/report.json) is invalid: requirements.0.status: Invalid option: expected one of "passed"|"failed"|"skipped"'

describe('crosscheck step：crosscheck 本身失敗（沒有 JSON）時原因必須看得到（#670 回歸）', () => {
  it('shell 不得出現 integer expression expected（空的 crosscheck.json）', () => {
    const r = runStep({ stdout: '', stderr: REPORT_INVALID, code: 1 })
    expect(r.log).not.toContain('integer expression expected')
  })

  it('stderr 的原因印到 run log', () => {
    const r = runStep({ stdout: '', stderr: REPORT_INVALID, code: 1 })
    expect(r.log).toContain('requirements.0.status: Invalid option')
  })

  it('Issue 留言帶出 stderr 的原因、以非零結束；不貼終態標籤（由 compare job 唯一寫入，ADR-021）', () => {
    const r = runStep({ stdout: '', stderr: REPORT_INVALID, code: 1 })
    expect(r.status).not.toBe(0)
    expect(r.comment).toContain('## 工廠執行中止：crosscheck 執行失敗')
    expect(r.comment).toContain('requirements.0.status: Invalid option')
    // N-version 時另一個變體可能成功；由本變體貼 needs-human 會讓 Issue 標籤變成兩邊的聯集
    expect(r.labels).toBe('')
  })

  it('stderr 過長時留言截斷（GitHub 留言上限 65536 字元）', () => {
    const r = runStep({ stdout: '', stderr: `${REPORT_INVALID}\n${'x'.repeat(100_000)}`, code: 1 })
    expect(r.comment).toBeDefined()
    expect(r.comment!.length).toBeLessThan(10_000)
    expect(r.comment).toContain('requirements.0.status: Invalid option')
  })

  it('截斷點落在多位元組字元中間時，step 仍貼出留言（不被 set -e 中止）', () => {
    const head = `${REPORT_INVALID}\n`
    // 讓第 4000 個位元組落在三位元組中文字的第一個位元組之後
    const pad = 'a'.repeat((4000 - Buffer.byteLength(head) - 1) % 3)
    const stderr = `${head}${pad}${'中'.repeat(5000)}`
    expect((4000 - Buffer.byteLength(head + pad)) % 3).toBe(1)
    const r = runStep({ stdout: '', stderr, code: 1 })
    expect(r.comment, r.log).toContain('requirements.0.status: Invalid option')
    expect(r.status).not.toBe(0)
  })
})

describe('crosscheck step：既有行為不變', () => {
  const json = (o: Record<string, unknown>) =>
    JSON.stringify({ issueNumber: 670, ok: false, mismatches: [], advisories: [], headline: '', ...o })

  it('mismatch 時留言列出明細與標題', () => {
    const r = runStep({
      stdout: json({ headline: 'report 與實際變更不一致', mismatches: [{ kind: 'no-trace', detail: '找不到變更' }] }),
      stderr: '',
      code: 1,
    })
    expect(r.status).not.toBe(0)
    expect(r.comment).toContain('## 工廠執行中止：report 與實際變更不一致')
    expect(r.comment).toContain('- no-trace：找不到變更')
  })

  it('通過時不留言、exit 0；advisory 只發 warning', () => {
    const r = runStep({
      stdout: json({ ok: true, advisories: [{ kind: 'requirements-uncovered', detail: 'x' }] }),
      stderr: '',
      code: 0,
    })
    expect(r.status).toBe(0)
    expect(r.comment).toBeUndefined()
    expect(r.log).toContain('::warning::REQ id 錨定 advisory（不擋 run）：requirements-uncovered')
    expect(r.log).not.toContain('integer expression expected')
  })
})

/** N-version 變體隔離（fubon-tradingbot#713）：遠端分支清單與 --variant 的接線。 */
describe('crosscheck step：N-version 變體隔離', () => {
  const ok = JSON.stringify({ issueNumber: 670, ok: true, mismatches: [], advisories: [], headline: '' })

  it('ls-remote 的 refs/heads/ 前綴被剝除後寫給 crosscheck，並傳入 --variant', () => {
    const r = runStep(
      { stdout: ok, stderr: '', code: 0 },
      'abc123\trefs/heads/factory/670-b-01-docs\ndef456\trefs/heads/software-factory\n',
    )
    expect(r.status, r.log).toBe(0)
    expect(r.remoteBranches).toBe('factory/670-b-01-docs\nsoftware-factory\n')
    expect(r.nodeArgs).toContain('--variant a --remote-branches .factory/remote-branches.txt')
  })

  it('ls-remote 失敗 → ::warning::、清單為空，crosscheck 照常執行（分支前綴檢查仍有效）', () => {
    const r = runStep({ stdout: ok, stderr: '', code: 0 }, null)
    expect(r.status, r.log).toBe(0)
    expect(r.log).toContain('::warning::git ls-remote 失敗')
    expect(r.remoteBranches).toBe('')
    expect(r.nodeArgs).toContain('--variant a')
  })

  it('驗證模式：帶 --verify-only、不呼叫 ls-remote、不傳 --variant（ADR-029 §5）', () => {
    const r = runStep({ stdout: ok, stderr: '', code: 0 }, '', { 'steps.verifymode.outputs.verify': 'true' })
    expect(r.status, r.log).toBe(0)
    expect(r.nodeArgs).toContain('--verify-only')
    expect(r.nodeArgs).not.toContain('--variant')
    // 驗證分支不呼叫 git ls-remote（stub 對非預期呼叫 exit 99，status 0 即證明）
    expect(r.remoteBranches).toBeUndefined()
  })
})

/**
 * factory-workflow 技能要求 agent 寫完 report 後以 jq 自檢。這條命令是 ReportSchema
 * 的手抄子集：schema 收緊而技能沒跟上，agent 會自檢通過、CI 卻判格式不合規（#670
 * 的形狀）；技能比 schema 嚴，agent 會被逼著改一份合法的 report。兩個方向都在此鎖住。
 */
describe('factory-workflow 技能的 report 自檢命令與 ReportSchema 一致', () => {
  const skill = readFileSync(join(ROOT, '.dsh/skills/factory-workflow/SKILL.md'), 'utf8')
  const block = skill.match(/```bash\njq -e '\n([\s\S]*?)\n' \.factory\/run\/report\.json\n```/)
  const filter = block?.[1]

  const jqAccepts = (report: unknown): boolean => {
    const r = spawnSync('jq', ['-e', filter!], { input: JSON.stringify(report), encoding: 'utf8' })
    return r.status === 0
  }

  const base = { issueNumber: 670, invocation: { exitCode: 0, stdout: 'done', stderr: '' } }
  const cases: [string, Record<string, unknown>][] = [
    ['最小合法 report', base],
    ['三種 status 各一', { ...base, requirements: [{ id: 'REQ-1', status: 'passed' }, { id: 'REQ-2', status: 'failed' }, { id: 'REQ-3', status: 'skipped' }] }],
    ['requirements 帶 evidence（schema 不禁止多餘欄位）', { ...base, requirements: [{ id: 'REQ-1', status: 'passed', evidence: 'exit 0' }] }],
    ['#670：status 寫 met／deferred', { ...base, requirements: [{ id: 'REQ-1', status: 'met' }, { id: 'REQ-2', status: 'deferred' }] }],
    ['status 大寫', { ...base, requirements: [{ id: 'REQ-1', status: 'PASSED' }] }],
    ['requirement 缺 id', { ...base, requirements: [{ status: 'passed' }] }],
    ['缺 issueNumber', { invocation: base.invocation }],
    ['缺 invocation', { issueNumber: 670 }],
    ['skillGap: null（與缺席同義）', { ...base, skillGap: null }],
    ['skillGap 合法', { ...base, skillGap: { category: 'monorepo-test-path', needed: '測試路徑 SOP' } }],
    ['skillGap category 非 kebab-case', { ...base, skillGap: { category: 'Monorepo Test', needed: 'x' } }],
    ['skillGap 缺 needed', { ...base, skillGap: { category: 'monorepo-test-path' } }],
  ]

  it('技能中找得到自檢命令', () => {
    expect(filter, 'SKILL.md 缺少 jq -e 自檢區塊（或格式改了，請同步本測試）').toBeDefined()
  })

  it.each(cases)('%s：jq 自檢與 ReportSchema 判定相同', async (_, report) => {
    const { ReportSchema } = await import('../../src/cli/factory-judge.js')
    expect(jqAccepts(report)).toBe(ReportSchema.safeParse(report).success)
  })
})

describe('run artifact 收錄 crosscheck 輸出', () => {
  it('crosscheck.json 與 crosscheck.err 都在上傳範圍內', () => {
    const upload = steps().find((s) => s.name === 'Upload run artifacts')
    const paths = (upload?.with?.path ?? '').split('\n').map((p) => p.trim())
    expect(paths).toContain('.factory/crosscheck.json')
    expect(paths).toContain('.factory/crosscheck.err')
  })

  it('judge.json 在上傳範圍內（compare 卡片的終態來源；fubon-tradingbot#713 沒上傳 → 全是「-」）', () => {
    const upload = steps().find((s) => s.name === 'Upload run artifacts')
    const paths = (upload?.with?.path ?? '').split('\n').map((p) => p.trim())
    expect(paths).toContain('.factory/judge.json')
  })
})

/**
 * session log 診斷（fubon-tradingbot#717）：本 repo 是 public，目標 repo 可能是 private。
 * 原始 session log 含目標 repo 的程式碼與工具輸出——只能上傳無內容的結構診斷。
 */
describe('session log 只以無內容診斷形式進 artifact', () => {
  const upload = () => {
    const s = steps().find((x) => x.name === 'Upload run artifacts')
    return (s?.with?.path ?? '').split('\n').map((p) => p.trim())
  }

  it('上傳 .factory/session-diag.json', () => {
    expect(upload()).toContain('.factory/session-diag.json')
  })

  it('原始 session log（.dsh/sessions）與 HOME 不得出現在上傳清單', () => {
    for (const p of upload().filter((x) => x !== '.factory/session-diag.json')) {
      expect(p, `上傳清單含 ${p}`).not.toMatch(/sessions|\.dsh|\$HOME|~\//)
    }
  })

  it('診斷 step 在 upload 之前、always() 執行且不擋 run', () => {
    const all = steps() as (Step & { if?: string; 'continue-on-error'?: boolean })[]
    const diag = all.findIndex((s) => s.name === 'Session integrity diagnostics (content-free)')
    const up = all.findIndex((s) => s.name === 'Upload run artifacts')
    expect(diag).toBeGreaterThan(-1)
    expect(diag).toBeLessThan(up)
    expect(all[diag]?.if).toContain('always()')
    expect(all[diag]?.['continue-on-error']).toBe(true)
  })
})

describe('compare job 接線（fubon-tradingbot#713 比對卡片全空的回歸）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  const wf = load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as { jobs: { compare: { steps: Step[] } } }
  const run = wf.jobs.compare.steps.find((s) => s.name === 'Generate comparison report and post comment')?.run ?? ''

  it('PR 以 search 的 head: 前綴查找，不用只做精確比對的 --head', () => {
    expect(run).toContain('--search "head:factory/${{ inputs.issue_number }}-${V}-"')
    expect(run).not.toMatch(/gh pr list[^\n]*--head /)
    expect(run).toContain('--pr-a pr-a.json')
    expect(run).toContain('--pr-b pr-b.json')
  })

  it('judge.json 從 artifact 根的 .factory/ 讀（不是 target/.factory/run/）', () => {
    expect(run).toContain('--judge-a "artifacts/a/.factory/judge.json"')
    expect(run).toContain('--judge-b "artifacts/b/.factory/judge.json"')
  })
})
