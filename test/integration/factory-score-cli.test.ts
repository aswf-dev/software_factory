/**
 * factory-score CLI 的實機（子行程）整合測試。
 *
 * 這裡驗證單元測試無法觸及的 entrypoint 行為：CLI 被真的當成程式執行時，
 * 是否輸出 JSON、退出碼是否正確、以及透過 symlink 執行是否仍然運作。
 *
 * 最關鍵的一條是「絕不靜默成功」：計分失敗必須以非 0 結束，否則 CI 的
 * oversight gate 會把「沒算出分數」誤判為通過（docs/06 §5.1）。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cliPath = join(repoRoot, 'dist/cli/factory-score.js')

let tmp: string

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(script: string, args: string[] = []): RunResult {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: repoRoot })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

beforeAll(() => {
  // 以原始碼建置出 dist，避免測試依賴先前的 build 狀態。
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' })
  tmp = mkdtempSync(join(tmpdir(), 'factory-score-cli-'))
}, 120_000)

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('factory-score 實機執行', () => {
  it('直接執行 → 輸出本 repo 的計分 JSON 且 exit 0', () => {
    const { status, stdout } = runCli(cliPath)
    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    // 本 repo：tactical(0) + high(2) + medium(1) = 3 → review。
    expect(out.score.total).toBe(3)
    expect(out.score.tier).toBe('review')
    expect(out.score.label).toBe('oversight/review')
    // 自家 repo 永不自動合併（docs/06 §4.3）。
    expect(out.score.automergeAllowed).toBe(false)
  })

  it('透過 symlink 執行 → 仍輸出計分結果', () => {
    // 迴歸測試：舊版用 pathToFileURL(process.argv[1]) 比對，不解析 symlink，
    // 導致「無輸出且 exit 0」—— CI 會把未執行的 gate 當成通過。
    const link = join(tmp, 'linked-factory-score.js')
    symlinkSync(cliPath, link)
    const { status, stdout } = runCli(link)
    expect(status).toBe(0)
    expect(JSON.parse(stdout).score.tier).toBe('review')
  })

  it('被 import 時不輸出任何內容（供 Task 20 擴充）', async () => {
    const probe = join(tmp, 'probe.mjs')
    writeFileSync(probe, `await import(${JSON.stringify(cliPath)});\n`)
    const { status, stdout } = runCli(probe)
    expect(status).toBe(0)
    expect(stdout).toBe('')
  })

  it('缺檔 → 單行錯誤訊息且 exit 1，不吐 stack trace', () => {
    const { status, stdout, stderr } = runCli(cliPath, ['--catalog', join(tmp, 'missing.yaml')])
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr.trim()).toMatch(/^error: file not found:/)
    expect(stderr).not.toContain('at ')
  })

  it('旗標缺值 → exit 1，且不把下一個旗標吞成路徑', () => {
    const { status, stderr } = runCli(cliPath, ['--catalog', '--risk-paths', 'x.yml'])
    expect(status).toBe(1)
    expect(stderr.trim()).toBe('error: --catalog requires a path argument')
  })

  it('hard_rules 格式錯誤 → exit 1（fail-loud，不得靜默略過硬性規則）', () => {
    const badRules = join(tmp, 'bad.yml')
    writeFileSync(badRules, 'hard_rules:\n  H1: "src/auth/**"\n')
    const { status, stderr } = runCli(cliPath, ['--risk-paths', badRules])
    expect(status).toBe(1)
    expect(stderr).toContain('risk-paths')
  })
})
