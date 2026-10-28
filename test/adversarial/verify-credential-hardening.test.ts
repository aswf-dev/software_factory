/**
 * N2（third fix wave）：agent 不得從 runner 暫存讀到 write App token。
 *
 * `actions/checkout` 預設 `persist-credentials: true`，會把 token 寫進
 * `$RUNNER_TEMP/git-credentials-*.config`，再以 `includeIf` 引入；後續
 * 「Configure agent git auth」只清 includeIf 與改 remote URL，那個檔案仍留在
 * agent sandbox 可讀的 `$RUNNER_TEMP`。修法：
 *
 *   1. target repo checkout 關閉 persist-credentials；
 *   2. 在 agent 之前、**所有任務類型**都刪掉 `$RUNNER_TEMP/git-credentials-*`；
 *   3. 之後才以 gh-token 設定 authenticated remote URL（非驗證 push 仍可用）。
 *
 * 這些是安全性配置：少了任何一條都不會有功能症狀，只有測試會抓到。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'

interface Step {
  name?: string
  if?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

function steps(): Step[] {
  const wf = load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as {
    jobs: { run: { steps: Step[] } }
  }
  return wf.jobs.run.steps
}

function indexByName(name: string): number {
  return steps().findIndex((s) => s.name === name)
}

function stepByName(name: string): Step {
  const step = steps().find((s) => s.name === name)
  expect(step, `workflow 缺少步驟：${name}`).toBeDefined()
  return step as Step
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('N2：checkout 憑證不得留在 agent 可讀的 RUNNER_TEMP', () => {
  it('target repo checkout 設定 persist-credentials: false', () => {
    const target = stepByName('Checkout target repo')
    expect(target.uses).toMatch(/^actions\/checkout@/)
    expect(String(target.with?.['persist-credentials'])).toBe('false')
  })

  it('每一個使用 write App token 的 checkout 都關閉 persist-credentials', () => {
    const checkouts = steps().filter((s) => s.uses?.startsWith('actions/checkout@') === true)
    const writeToken = checkouts.filter((s) => String(s.with?.token ?? '').includes('steps.app-token.outputs.token'))
    // guard：接線若改名／改用法，這個測試不能默默變成空集合
    expect(writeToken.length).toBeGreaterThan(0)
    for (const checkout of writeToken) {
      expect(String(checkout.with?.['persist-credentials']), checkout.name).toBe('false')
    }
  })

  it('清理步驟在 agent 之前、對所有任務類型執行（無 if 條件）', () => {
    const cleanup = stepByName('Remove checkout credential files')
    expect(cleanup.if, '清理不得被 verify／task type 條件跳過').toBeUndefined()
    expect(cleanup.run).toContain('git-credentials-')
    expect(cleanup.run).toContain('RUNNER_TEMP')
    expect(indexByName('Remove checkout credential files')).toBeLessThan(indexByName('Run factory agent'))
  })

  it('清理步驟真的刪除 $RUNNER_TEMP/git-credentials-*（其餘檔案不動）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-credential-cleanup-'))
    dirs.push(dir)
    const credential = join(dir, 'git-credentials-1234.config')
    const credentialNoExt = join(dir, 'git-credentials-abcd')
    const keep = join(dir, 'keep.txt')
    writeFileSync(credential, 'https://x-access-token:SECRET@github.com\n')
    writeFileSync(credentialNoExt, 'https://x-access-token:SECRET@github.com\n')
    writeFileSync(keep, 'keep\n')

    const run = spawnSync('bash', ['-e', '-c', stepByName('Remove checkout credential files').run as string], {
      env: { ...process.env, RUNNER_TEMP: dir },
      encoding: 'utf8',
    })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(credential)).toBe(false)
    expect(existsSync(credentialNoExt)).toBe(false)
    expect(existsSync(keep)).toBe(true)
  })

  it('清理之後才以 gh-token 設定 remote URL（非驗證 push 仍可用）', () => {
    const cleanupIndex = indexByName('Remove checkout credential files')
    const authIndex = indexByName('Configure agent git auth (target repo)')
    const agentIndex = indexByName('Run factory agent')
    expect(cleanupIndex).toBeGreaterThanOrEqual(0)
    expect(authIndex).toBeGreaterThan(cleanupIndex)
    expect(authIndex).toBeLessThan(agentIndex)

    const auth = stepByName('Configure agent git auth (target repo)')
    expect(auth.run).toContain('git remote set-url origin')
    expect(auth.run).toContain('x-access-token:')
    expect(auth.run).toContain('.factory/run/gh-token')
  })
})
