/**
 * factory-run 的 Lean 工具鏈（ADR-029 §7；plan Task 5）。
 *
 * - 只在 `agent-verify-lean` 安裝：其他驗證階段與一般 task 不該付出安裝時間，也不該
 *   讓 agent 在不需要時拿到 `lean`／`lake`；
 * - 版本固定 `leanprover/lean4:v4.35.0`，只用 core——workflow 任何地方都不得出現
 *   那個大型數學函式庫的名字（安裝它要數 GB、數十分鐘，且 ADR-029 §7 明文排除）；
 * - elan 本體以「固定版本＋SHA-256」下載，不從 master 或 latest 執行遠端 shell；
 * - 快取 `~/.elan` 與 `target/specs/lean/.lake/packages`。**刻意不快取
 *   `.lake/build`**：core-only 時 packages 是空的、build 是使用者 specs 的編譯
 *   產物（olean 帶定理名與敘述）。快取 key 對所有目標 repo 相同，快取 build 會把
 *   A repo 的編譯產物還原到 B repo 的 runner；而公開 repo 的 Actions cache 對
 *   同 repo 的其他 workflow（含 fork PR 讀 base 分支的快取）可讀。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'
const LEAN_TOOLCHAIN = 'leanprover/lean4:v4.35.0'
const GATE = "steps.verifymode.outputs.verify == 'true' && steps.tasktype.outputs.value == 'agent-verify-lean'"

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: { path?: string; key?: string; 'restore-keys'?: string }
}

const raw = readFileSync(join(ROOT, WORKFLOW), 'utf8')
const steps = (): Step[] => (load(raw) as { jobs: { run: { steps: Step[] } } }).jobs.run.steps
const idx = (name: string): number => steps().findIndex((s) => s.name === name)
const step = (name: string): Step => {
  const s = steps()[idx(name)]
  expect(s, `workflow 缺少步驟：${name}`).toBeDefined()
  return s as Step
}

const CACHE = 'Cache Lean toolchain (elan)'
const INSTALL = 'Install Lean toolchain (elan)'

describe('Lean 工具鏈步驟：只在驗證模式的 agent-verify-lean', () => {
  it('快取與安裝兩步都以 verify ∧ agent-verify-lean 閘控（不含其他條件可放寬的 ||）', () => {
    expect(step(CACHE).if).toBe(GATE)
    expect(step(INSTALL).if).toBe(GATE)
  })

  it('順序：guard（verifymode）與 target checkout 之後、agent 之前；快取在安裝之前', () => {
    const guard = steps().findIndex((s) => s.id === 'verifymode')
    const checkout = idx('Checkout target repo')
    const agent = steps().findIndex((s) => s.id === 'agent')
    expect(idx(CACHE)).toBeGreaterThan(guard)
    expect(idx(CACHE)).toBeGreaterThan(checkout)
    expect(idx(INSTALL)).toBe(idx(CACHE) + 1)
    expect(idx(INSTALL)).toBeLessThan(agent)
  })

  it('除了這兩步，workflow 沒有其他地方安裝或呼叫 elan', () => {
    const others = steps().filter((s) => s.name !== CACHE && s.name !== INSTALL)
    for (const s of others) {
      expect(`${s.run ?? ''}${s.with?.path ?? ''}`, s.name).not.toMatch(/elan/i)
    }
  })
})

describe('Lean 版本與來源', () => {
  it('toolchain 固定 leanprover/lean4:v4.35.0（env 單一來源，安裝與快取 key 都讀它）', () => {
    expect(step(INSTALL).env?.['LEAN_TOOLCHAIN']).toBe(LEAN_TOOLCHAIN)
    const run = step(INSTALL).run ?? ''
    expect(run).toContain('--default-toolchain "$LEAN_TOOLCHAIN"')
    expect(run).toContain('elan" toolchain install "$LEAN_TOOLCHAIN"')
    expect(run).toContain('elan" default "$LEAN_TOOLCHAIN"')
    // 版本實際生效：lean --version 必須是 4.35.0，否則 fail-loud
    expect(run).toMatch(/lean" --version[^\n]*\|[^\n]*grep -F "version 4\.35\.0"/)
  })

  it('workflow 全文不出現那個數學函式庫的名字（core only，ADR-029 §7）', () => {
    expect(raw).not.toMatch(/mathlib/i)
  })

  it('elan 以固定版本的 release asset 下載並驗 SHA-256；不從 master／latest 執行遠端 shell', () => {
    const s = step(INSTALL)
    expect(s.env?.['ELAN_VERSION']).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(s.env?.['ELAN_SHA256']).toMatch(/^[0-9a-f]{64}$/)
    const run = s.run ?? ''
    expect(run).toContain(
      'https://github.com/leanprover/elan/releases/download/${ELAN_VERSION}/elan-x86_64-unknown-linux-gnu.tar.gz',
    )
    expect(run).toMatch(/sha256sum -c/)
    // 驗證在執行之前
    expect(run.indexOf('sha256sum -c')).toBeLessThan(run.indexOf('elan-init" -y'))
    expect(raw).not.toMatch(/elan\/master|elan-init\.sh|releases\/latest|\|\s*sh\b/)
  })

  it('非互動安裝、不改 shell rc；~/.elan/bin 經 $GITHUB_PATH 交給後續步驟（agent）', () => {
    const run = step(INSTALL).run ?? ''
    expect(run).toMatch(/elan-init" -y --no-modify-path/)
    expect(run).toContain('echo "$HOME/.elan/bin" >> "$GITHUB_PATH"')
    expect(run).toContain('set -euo pipefail')
  })

  it('已從快取還原 elan 時不重新下載（仍以 toolchain install 確保版本存在）', () => {
    const run = step(INSTALL).run ?? ''
    expect(run).toMatch(/if \[ ! -x "\$HOME\/\.elan\/bin\/elan" \]; then/)
  })
})

describe('Lean 快取', () => {
  const s = () => step(CACHE)
  const paths = () =>
    (s().with?.path ?? '')
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)

  it('actions/cache，路徑為 ~/.elan 與 target/specs/lean/.lake/packages', () => {
    expect(s().uses).toMatch(/^actions\/cache@v\d+$/)
    expect(paths()).toEqual(['~/.elan', 'target/specs/lean/.lake/packages'])
  })

  it('不快取 .lake/build 或整個 .lake（使用者 specs 的編譯產物不得跨 run／跨 repo 共享）', () => {
    for (const p of paths()) {
      expect(p).not.toMatch(/\.lake\/?$/)
      expect(p).not.toMatch(/build/)
    }
  })

  it('key＝toolchain＋lake-manifest.json 的 hash；fallback 只到 toolchain', () => {
    expect(s().with?.key).toBe(
      "lean-${{ runner.os }}-leanprover/lean4:v4.35.0-${{ hashFiles('target/specs/lean/lake-manifest.json') }}",
    )
    expect((s().with?.['restore-keys'] ?? '').trim()).toBe('lean-${{ runner.os }}-leanprover/lean4:v4.35.0-')
  })

  it('快取 key 的 toolchain 字串與安裝步驟的 LEAN_TOOLCHAIN 一致', () => {
    expect(s().with?.key).toContain(step(INSTALL).env?.['LEAN_TOOLCHAIN'])
  })
})

describe('vendored verify-lean.sh 可執行（Task 4 minor）', () => {
  const SCRIPT = '.dsh/skills/lean-formal-verification/scripts/verify-lean.sh'

  it('工作樹的檔案有 executable mode bit', () => {
    expect(statSync(join(ROOT, SCRIPT)).mode & 0o111).not.toBe(0)
  })

  it('git index 記錄為 100755（CI checkout 取的是 index 的 mode，不是本機檔案）', () => {
    const out = execFileSync('git', ['ls-files', '--stage', '--', SCRIPT], { cwd: ROOT, encoding: 'utf8' })
    expect(out).toMatch(/^100755 /)
  })
})
