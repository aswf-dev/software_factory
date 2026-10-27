/**
 * 依序模式（ADR-022）的 workflow 接線。CLI 本身由 src/cli/factory-stage.test.ts 覆蓋；
 * 這裡鎖 step 的位置與條件，並以 stub gh／node 實際執行前置檢查的 shell。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { STAGE_DONE_LABEL } from '../../src/cli/factory-stage.js'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '../..')

interface Step {
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
  uses?: string
  with?: Record<string, string>
}
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; required?: boolean; default?: unknown }> } }
  concurrency?: { group?: string }
  permissions?: Record<string, string>
  jobs: Record<string, { steps: Step[] }>
}
const workflow = (f: string): Workflow => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  return load(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as Workflow
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function exec(script: string, node: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-step-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\necho "$*" >> "$STUB_DIR/gh.log"\n')
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\n${node}\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  chmodSync(join(bin, 'node'), 0o755)
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, STUB_DIR: dir, ...env },
  })
  let gh = ''
  try {
    gh = readFileSync(join(dir, 'gh.log'), 'utf8')
  } catch {
    gh = ''
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, gh }
}

describe('派工時的前置檢查（factory-run.yml）', () => {
  const steps = () => workflow('factory-run.yml').jobs['run']!.steps
  const step = (): Step => steps().find((s) => s.name === 'Check prerequisites (ADR-022)')!

  it('在格式檢查之後、計分與 agent 之前（花 LLM 成本之前）', () => {
    const names = steps().map((s) => s.name)
    const i = names.indexOf('Check prerequisites (ADR-022)')
    expect(i).toBeGreaterThan(names.indexOf('Check issue format (central enforcement)'))
    expect(i).toBeLessThan(names.indexOf('Initial score'))
    expect(i).toBeLessThan(names.indexOf('Run factory agent'))
    // ADR-029 §6：驗證類不檢查 prereqs；非驗證類（requires_stage_prereqs=true）照跑。
    expect(step().if).toBe("steps.verifymode.outputs.requires_stage_prereqs == 'true'")
  })

  const env = { GH_REPO: 'o/r', ISSUE: '5', GH_TOKEN: 'x' }
  const blocked = `echo '{"blocked":true,"comment":"## 🧭 前置"}'`

  it('前置未完成 → 變體 a 留言、兩個變體都停派；不貼任何標籤（不是 agent 的失敗）', () => {
    const a = exec(step().run!, blocked, { ...env, VARIANT: 'a' })
    expect(a.status).not.toBe(0)
    expect(a.gh).toContain('issue comment 5 --body-file .factory/prereqs.md')
    expect(a.gh).not.toContain('--add-label')
    const b = exec(step().run!, blocked, { ...env, VARIANT: 'b' })
    expect(b.status).not.toBe(0)
    expect(b.gh).toBe('')
  })

  it('前置完成或未宣告 → 通過，不留言', () => {
    const r = exec(step().run!, `echo '{"blocked":false}'`, { ...env, VARIANT: 'a' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.gh).toBe('')
  })

  it('查詢失敗 → fail-closed 停派', () => {
    const r = exec(step().run!, 'exit 1', { ...env, VARIANT: 'a' })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('前置工作項檢查失敗')
  })

  it('格式卡只由變體 a 留言，但兩個變體都仍會因不合規而紅燈', () => {
    const format = steps().find((s) => s.name === 'Check issue format (central enforcement)')!
    expect(format.env?.VARIANT).toBe('${{ matrix.variant }}')
    expect(format.run).toContain('if [ "$VARIANT" = "a" ]; then')
    const commentAt = format.run!.indexOf('gh issue comment')
    const guardAt = format.run!.indexOf('if [ "$VARIANT" = "a" ]; then')
    expect(guardAt).toBeLessThan(commentAt)
    // 停派判定不得被包進變體判斷
    expect(format.run!.indexOf('格式不合規')).toBeGreaterThan(commentAt)
  })

  it('沒有提供略過檢查的 dispatch input（ADR-018 §12 先例）', () => {
    const inputs = Object.keys(workflow('factory-run.yml').on.workflow_dispatch.inputs)
    expect(inputs.filter((k) => /prereq|skip|force/i.test(k))).toEqual([])
  })

  it(`${STAGE_DONE_LABEL} 標籤由 workflow 預先建立（人工覆寫用）`, () => {
    const bootstrap = steps().find((s) => (s.run ?? '').includes('gh label create'))!.run!
    expect(bootstrap).toContain(`gh label create "${STAGE_DONE_LABEL}"`)
  })
})

describe('factory-stage-finalize.yml', () => {
  const wf = () => workflow('factory-stage-finalize.yml')
  const steps = () => wf().jobs['finalize']!.steps

  it('workflow_dispatch：repo 與 Issue 必填；遞送 ID 只作稽核；可 dry run；與 factory-run 共用 concurrency group', () => {
    const inputs = wf().on.workflow_dispatch.inputs
    expect(inputs['repo']).toMatchObject({ required: true, type: 'string' })
    expect(inputs['issue_number']).toMatchObject({ required: true, type: 'number' })
    expect(inputs['delivery_id']).toMatchObject({ required: false })
    expect(inputs['dry_run']).toMatchObject({ type: 'boolean', default: false })
    expect(wf().concurrency?.group).toBe(workflow('factory-run.yml').concurrency?.group)
    expect(wf().permissions).toEqual({ contents: 'read' })
  })

  it('App token 只發給單一目標 repo，權限最小：contents write（刪分支）、issues write（留言）、PR read', () => {
    const mint = steps().find((s) => s.uses?.startsWith('actions/create-github-app-token'))!
    expect(mint.with?.['repositories']).toBe('${{ steps.target.outputs.name }}')
    expect(mint.with?.['permission-contents']).toBe('write')
    expect(mint.with?.['permission-issues']).toBe('write')
    expect(mint.with?.['permission-pull-requests']).toBe('read')
    // 必須明列為 read：遺漏時 token 會繼承 App 的全部權限（含 actions:write）
    expect(mint.with?.['permission-actions']).toBe('read')
  })

  it('repo 格式不符 → 在發 token 之前就失敗', () => {
    const resolve = steps().find((s) => s.name === 'Resolve target owner/name')!.run!
    for (const bad of ['no-slash', 'o/..', 'o/r/x', 'o r/x']) {
      const r = exec(resolve, 'exit 0', { TARGET_REPO: bad, GITHUB_OUTPUT: '/dev/null' })
      expect(r.status, bad).not.toBe(0)
    }
    expect(exec(resolve, 'exit 0', { TARGET_REPO: 'aswf-dev/software_factory', GITHUB_OUTPUT: '/dev/null' }).status).toBe(0)
  })

  it('所有判斷交給 factory-stage finalize（本 workflow 不自己判斷）；dry run 傳 --dry-run；結果寫入 job summary', () => {
    const run = steps().find((s) => s.name === 'Finalize stage')!.run!
    expect(run).toContain('node dist/cli/factory-stage.js finalize --repo "$REPO" --issue "$ISSUE" $FLAGS')
    expect(run).toContain('FLAGS="--dry-run"')
    expect(run).toContain('$GITHUB_STEP_SUMMARY')
    expect(run).not.toMatch(/gh (issue|api|pr) /)
  })
})
