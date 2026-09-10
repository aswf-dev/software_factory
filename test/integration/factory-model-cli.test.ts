/**
 * factory-model CLI 的實機（子行程）整合測試。
 *
 * 驗證單元測試無法觸及的 entrypoint 行為：CLI 被真的當成程式執行時，是否輸出
 * JSON、退出碼是否正確、以及透過 symlink 執行是否仍然運作（isMainModule 迴歸，
 * 與 factory-score-cli 同款）。最關鍵的是「絕不靜默成功」：設定/輸入錯誤必須
 * exit 1，否則 CI 的模型路由會被當成通過（docs/ADR/011）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cliPath = join(repoRoot, 'dist/cli/factory-model.js')

let tmp: string
let tiersPath: string
let providersPath: string

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(script: string, args: string[] = []): RunResult {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: repoRoot })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function fixture(name: string, content: string): string {
  const p = join(tmp, name)
  writeFileSync(p, content)
  return p
}

function issueJson(requirement: string): string {
  return JSON.stringify({
    body: ['### 任務類型', '', 'agent-fix-bug', '', '### 需求描述（PRD）', '', requirement, ''].join('\n'),
  })
}

function scoreJson(total: number): string {
  return JSON.stringify({ annotations: {}, stack: {}, score: { total, tier: 'review' } })
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' })
  tmp = mkdtempSync(join(tmpdir(), 'factory-model-cli-'))
  tiersPath = join(repoRoot, 'config/dsh/model-tiers.yaml')
  providersPath = join(repoRoot, 'config/dsh/settings.providers.yaml')
}, 120_000)

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('factory-model 實機執行', () => {
  it('簡單需求 → exit 0、tier=low、chain 為 qwen3.8-flash → deepseek-v4.1-flash', () => {
    const issue = fixture('low.json', issueJson('為單一工具函式補測試'))
    const { status, stdout } = runCli(cliPath, [
      '--issue',
      issue,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.tier).toBe('low')
    expect(out.complexitySource).toBe('issue-analysis')
    expect(out.chain.map((e: { model: string }) => e.model)).toEqual([
      'qwen3.8-flash',
      'deepseek-v4.1-flash',
    ])
  })

  it('高複雜度 + total=4 → critical（claude-opus-5，fable-5 已移除）', () => {
    const issue = fixture('high.json', issueJson('跨服務架構變更，含授權邏輯'))
    const score = fixture('score4.json', scoreJson(4))
    const { status, stdout } = runCli(cliPath, [
      '--issue',
      issue,
      '--score',
      score,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.tier).toBe('critical')
    expect(out.chain[0].model).toBe('claude-opus-5')
    expect(out.reason).toContain('critical')
  })

  it('無 --issue、無 catalog → fail-safe high（deepseek-v4.1-flash）', () => {
    const { status, stdout } = runCli(cliPath, ['--tiers', tiersPath, '--providers', providersPath])
    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.tier).toBe('high')
    expect(out.complexitySource).toBe('fail-safe')
    expect(out.selected.model).toBe('deepseek-v4.1-flash')
  })

  it('model-tiers 設定損壞 → exit 1、stderr 單行（絕不靜默成功）', () => {
    const bad = fixture('bad-tiers.yaml', 'tiers: 42')
    const { status, stdout, stderr } = runCli(cliPath, ['--tiers', bad, '--providers', providersPath])
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr.trim().split('\n')).toHaveLength(1)
    expect(stderr).toContain('error:')
  })

  it('透過 symlink 執行 → 仍輸出選模結果（isMainModule 迴歸）', () => {
    const link = join(tmp, 'linked-factory-model.js')
    symlinkSync(cliPath, link)
    const { status, stdout } = runCli(link, ['--tiers', tiersPath, '--providers', providersPath])
    expect(status).toBe(0)
    expect(JSON.parse(stdout).tier).toBeDefined()
  })
})
