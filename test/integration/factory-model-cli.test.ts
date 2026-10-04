/**
 * factory-model CLI 的實機（子行程）整合測試。
 *
 * 驗證單元測試無法觸及的 entrypoint 行為：CLI 被真的當成程式執行時，是否輸出
 * JSON、退出碼是否正確、以及透過 symlink 執行是否仍然運作（isMainModule 迴歸，
 * 與 factory-score-cli 同款）。最關鍵的是「絕不靜默成功」：設定/輸入錯誤必須
 * exit 1，否則 CI 的模型路由會被當成通過（docs/ADR/011）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // 2026-10-04 修正（CI run 37199686994 flaky 根因）：build 移到 `test:integration`
  // script 先行串行完成。原本兩個 CLI 測試檔在各自 fork 的 beforeAll 同時跑 tsc 寫
  // 同一棵 dist/，sibling fork spawn 的子行程會讀到「已建立但尚未寫入」的 0-byte
  // 編譯輸出 → ESM link 失敗（exit 1、stdout 空），且原因只出現在被丟棄的 stderr。
  // 這裡不再自行 build——dist 缺失時 fail-loud，給出可行動的訊息。
  if (!existsSync(cliPath)) {
    throw new Error(
      'dist/cli/factory-model.js 不存在：請先執行 "npm run build"，或直接跑 "npm run test:integration"（script 已內含建置）',
    )
  }
  tmp = mkdtempSync(join(tmpdir(), 'factory-model-cli-'))
  tiersPath = join(repoRoot, 'config/dsh/model-tiers.yaml')
  providersPath = join(repoRoot, 'config/dsh/settings.providers.yaml')
})

afterAll(() => {
  // beforeAll 可能提前 throw（dist 缺失），tmp 未初始化時跳過清理。
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('factory-model 實機執行', () => {
  it('簡單需求 → exit 0、tier=low、chain 為 qwen3.8-flash → deepseek-flash', () => {
    const issue = fixture('low.json', issueJson('為單一工具函式補測試'))
    const { status, stdout, stderr } = runCli(cliPath, [
      '--issue',
      issue,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    // 子行程紅燈必須自我解釋（run 37199686994 教訓：原因只出現在被丟棄的 stderr）
    expect(status, `子行程 exit 非 0；stderr:\n${stderr}`).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.tier).toBe('low')
    expect(out.complexitySource).toBe('issue-analysis')
    expect(out.chain.map((e: { model: string }) => e.model)).toEqual([
      'qwen3.8-flash',
      'deepseek-flash',
    ])
  })

  it('高複雜度 + total=4 → critical（claude-opus-5-5，未收錄前 fallback 至 claude-opus-5）', () => {
    const issue = fixture('high.json', issueJson('跨服務架構變更，含授權邏輯'))
    const score = fixture('score4.json', scoreJson(4))
    const { status, stdout, stderr } = runCli(cliPath, [
      '--issue',
      issue,
      '--score',
      score,
      '--tiers',
      tiersPath,
      '--providers',
      providersPath,
    ])
    expect(status, `子行程 exit 非 0；stderr:\n${stderr}`).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.tier).toBe('critical')
    expect(out.chain.slice(0, 2).map((e: { model: string }) => e.model)).toEqual(['claude-opus-5-5', 'claude-opus-5'])
    expect(out.reason).toContain('critical')
  })

  it('無 --issue、無 catalog → fail-safe high（deepseek-flash）', () => {
    const { status, stdout, stderr } = runCli(cliPath, ['--tiers', tiersPath, '--providers', providersPath])
    expect(status, `子行程 exit 非 0；stderr:\n${stderr}`).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.tier).toBe('high')
    expect(out.complexitySource).toBe('fail-safe')
    expect(out.selected.model).toBe('deepseek-flash')
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
    const { status, stdout, stderr } = runCli(link, ['--tiers', tiersPath, '--providers', providersPath])
    expect(status, `子行程 exit 非 0；stderr:\n${stderr}`).toBe(0)
    expect(JSON.parse(stdout).tier).toBeDefined()
  })
})
