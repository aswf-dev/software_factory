/**
 * factory-run 的 Lean 工具鏈與工具鏈快取（ADR-029 §7；plan Task 5＋review fix I1/R8、M1–M3）。
 *
 * - 只在 `agent-verify-lean` 安裝：其他驗證階段與一般 task 不該付出安裝時間，也不該
 *   讓 agent 在不需要時拿到 `lean`／`lake`；
 * - 版本固定 `leanprover/lean4:v4.35.0`，只用 core——workflow 任何地方都不得出現
 *   那個大型數學函式庫的名字（安裝它要數 GB、數十分鐘，且 ADR-029 §7 明文排除）；
 * - elan 本體以「固定版本＋SHA-256」下載，不從 master 或 latest 執行遠端 shell；
 *   快取命中時沒經過 SHA-256，改驗 elan 自報版本，不符即 fail closed（M2）；
 * - 快取**只有** `~/.elan`，key 固定、沒有 restore-keys；`target/` 底下一律不快取
 *   （使用者 specs 的編譯產物不得跨 run／跨 repo 共享）。restore 在安裝前、save 在
 *   安裝與版本檢查後、**agent 之前**——agent 跑完後的 `~/.elan` 不寫回快取（I1/R8）；
 * - 目標 repo 的 `specs/lean/lean-toolchain` 若存在必須釘在同一版本（M3）；
 * - Quint 快取在驗證模式不得於 agent 之後存檔（M1）；
 * - 兩個 `actions/cache/save` 都是 best-effort（I6）：條件以 `success()` 開頭、
 *   `continue-on-error: true`，Lean 另要求安裝步驟成功且 `~/.elan/bin/lean` 存在——
 *   安裝失敗或只裝了一半不得存檔，存檔失敗也不得讓 run 變紅。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

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
  'continue-on-error'?: boolean
  with?: { path?: string; key?: string; 'restore-keys'?: string }
}

const raw = readFileSync(join(ROOT, WORKFLOW), 'utf8')
type Wf = { jobs: Record<string, { steps: Step[] }> }
const steps = (): Step[] => (load(raw) as Wf).jobs['run']!.steps
const allSteps = (): Step[] => Object.values((load(raw) as Wf).jobs).flatMap((j) => j.steps)
const idx = (name: string): number => steps().findIndex((s) => s.name === name)
const idxId = (id: string): number => steps().findIndex((s) => s.id === id)
const step = (name: string): Step => {
  const s = steps()[idx(name)]
  expect(s, `workflow 缺少步驟：${name}`).toBeDefined()
  return s as Step
}
const pathsOf = (s: Step): string[] =>
  (s.with?.path ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)

const RESTORE = 'Restore Lean toolchain cache (elan)'
const INSTALL = 'Install Lean toolchain (elan)'
const INSTALL_ID = 'leaninstall'
const CHECK = 'Check Lean toolchain complete (verify only)'
const SAVE = 'Save Lean toolchain cache (elan)'
const PIN = 'Check target lean-toolchain pin'
const LEAN_KEY = 'lean-elan-${{ runner.os }}-leanprover/lean4:v4.35.0'

/** 以最小求值器解讀 step 的 `if:`（只支援本 workflow 用到的形狀），證明失敗時真的不存檔。 */
interface EvalContext {
  success: boolean
  steps: Record<string, Record<string, string>>
}

function evalCondition(expr: string, ctx: EvalContext): boolean {
  return expr.split(' && ').every((atom) => {
    const text = atom.trim()
    if (text === 'success()') return ctx.success
    const m = text.match(/^steps\.([\w-]+)\.(outputs\.[\w-]+|outcome) (==|!=) '(.*)'$/)
    if (m === null) throw new Error(`unsupported condition atom: ${text}`)
    const id = m[1] as string
    const field = m[2] as string
    const expected = m[4] as string
    return m[3] === '==' ? ctx.steps[id]?.[field] === expected : ctx.steps[id]?.[field] !== expected
  })
}

/** 一個「全部成功、cache miss」的 Lean save 情境；個別測試再覆寫成失敗。 */
const leanSaveContext = (): EvalContext => ({
  success: true,
  steps: {
    verifymode: { 'outputs.verify': 'true' },
    tasktype: { 'outputs.value': 'agent-verify-lean' },
    leancache: { 'outputs.cache-hit': 'false' },
    leaninstall: { outcome: 'success' },
    leancheck: { outcome: 'success' },
  },
})

/** 既有 actions/cache 的 major（test.yml／quint-verify.yml 仍用合併版 actions/cache）。 */
const cacheMajor = (): string => {
  const m = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8').match(/actions\/cache@(v\d+)/)
  expect(m, 'test.yml 應使用 actions/cache@vN').not.toBeNull()
  return m![1]!
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** 以 bash 實際執行 step 的 run script（`${{ }}` 不得出現；env 由呼叫端給）。 */
function exec(run: string, env: Record<string, string>, setup: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lean-step-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'bin'))
  setup(dir)
  expect(run).not.toMatch(/\$\{\{/)
  const r = spawnSync('bash', ['-e', '-c', run], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir, ...env },
  })
  return { status: r.status, log: `${r.stdout}${r.stderr}`, dir }
}

const stub = (path: string, body: string) => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('Lean 工具鏈步驟：只在驗證模式的 agent-verify-lean', () => {
  it('restore／install／pin check 以 verify ∧ agent-verify-lean 閘控；save 另加 miss 與安裝成功', () => {
    expect(step(RESTORE).if).toBe(GATE)
    expect(step(INSTALL).if).toBe(GATE)
    expect(step(PIN).if).toBe(GATE)
    const save = step(SAVE)
    expect(save.if?.startsWith('success() && '), 'success() 必須是第一個條件').toBe(true)
    expect(save.if).toContain(GATE)
    expect(save.if).toContain("steps.leancache.outputs.cache-hit != 'true'")
    expect(save.if).toContain(`steps.${INSTALL_ID}.outcome == 'success'`)
    expect(save.if).toContain('steps.leancheck.outcome == \'success\'')
  })

  it('順序：guard 與 target checkout 之後；restore → install → check → save 相鄰，全在 agent 之前', () => {
    const guard = idxId('verifymode')
    const checkout = idx('Checkout target repo')
    const agent = idxId('agent')
    expect(step(RESTORE).id).toBe('leancache')
    expect(step(INSTALL).id).toBe(INSTALL_ID)
    expect(step(CHECK).id).toBe('leancheck')
    expect(idx(RESTORE)).toBeGreaterThan(guard)
    expect(idx(RESTORE)).toBeGreaterThan(checkout)
    expect(idx(INSTALL)).toBe(idx(RESTORE) + 1)
    expect(idx(CHECK)).toBe(idx(INSTALL) + 1)
    expect(idx(SAVE)).toBe(idx(CHECK) + 1)
    expect(idx(SAVE)).toBeLessThan(agent)
    expect(idx(PIN)).toBeGreaterThan(checkout)
    expect(idx(PIN)).toBeLessThan(agent)
  })

  it('除了 restore／install／check／save，workflow 沒有其他地方安裝、呼叫或快取 elan', () => {
    const others = steps().filter((s) => ![RESTORE, INSTALL, CHECK, SAVE].includes(s.name ?? ''))
    for (const s of others) {
      expect(`${s.run ?? ''}${s.with?.path ?? ''}`, s.name).not.toMatch(/elan/i)
    }
    // 新增的 check 只讀取既有安裝，不下載、不執行 elan-init、不碰快取。
    const checkRun = step(CHECK).run ?? ''
    expect(checkRun).not.toMatch(/curl|elan-init|actions\/cache/)
  })
})

describe('Lean 版本與來源', () => {
  it('toolchain 固定 leanprover/lean4:v4.35.0（env 單一來源）', () => {
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
})

describe('快取命中：沒經過 SHA-256 → 驗 elan 自報版本，不符 fail closed（M2）', () => {
  it('install 以 env 取得 restore 的 cache-hit（run 內不內嵌 ${{ }}）', () => {
    expect(step(INSTALL).env?.['CACHE_HIT']).toBe('${{ steps.leancache.outputs.cache-hit }}')
    expect(step(INSTALL).run ?? '').not.toMatch(/\$\{\{/)
  })

  /** 在暫存 HOME 放一個假的已還原 ~/.elan；curl 被呼叫即記錄（命中時不該下載）。 */
  const runHit = (reported: string | null, hit = 'true') => {
    const s = step(INSTALL)
    return exec(s.run ?? '', { ...(s.env ?? {}), CACHE_HIT: hit, GITHUB_PATH: '/dev/null' }, (dir) => {
      const bin = join(dir, '.elan/bin')
      mkdirSync(bin, { recursive: true })
      if (reported !== null) {
        stub(join(bin, 'elan'), `[ "$1" = "--version" ] && { echo "${reported}"; exit 0; }\nexit 0`)
      }
      stub(join(bin, 'lean'), 'echo "Lean (version 4.35.0, x86_64-unknown-linux-gnu, Release)"')
      stub(join(dir, 'bin/curl'), `echo curl >> "${dir}/curl-called"; exit 1`)
    })
  }

  it('自報版本＝ELAN_VERSION → 通過，不下載', () => {
    const v = (step(INSTALL).env?.['ELAN_VERSION'] ?? '').replace(/^v/, '')
    const r = runHit(`elan ${v} (bb75b50d2 2025-06-11)`)
    expect(r.status, r.log).toBe(0)
    expect(() => statSync(join(r.dir, 'curl-called'))).toThrow()
  })

  for (const reported of ['elan 4.1.0 (deadbeef 2024-01-01)', 'elan 4.2.40 (deadbeef 2026-01-01)', '']) {
    it(`自報版本不符（${JSON.stringify(reported)}）→ ::error:: 並非零結束`, () => {
      const r = runHit(reported)
      expect(r.status).not.toBe(0)
      expect(r.log).toContain('::error::')
    })
  }

  it('命中但 ~/.elan/bin/elan 不存在 → fail closed（不默默改走下載）', () => {
    const r = runHit(null)
    expect(r.status).not.toBe(0)
    expect(r.log).toContain('::error::')
    expect(() => statSync(join(r.dir, 'curl-called'))).toThrow()
  })
})

describe('Lean 快取：只有 ~/.elan，key 固定、沒有 restore-keys，agent 前存檔（I1/R8）', () => {
  it('restore／save 使用與既有 actions/cache 同 major 的 restore／save 子 action', () => {
    expect(step(RESTORE).uses).toBe(`actions/cache/restore@${cacheMajor()}`)
    expect(step(SAVE).uses).toBe(`actions/cache/save@${cacheMajor()}`)
  })

  it('路徑只有 ~/.elan；key 逐字固定；沒有 restore-keys', () => {
    for (const s of [step(RESTORE), step(SAVE)]) {
      expect(pathsOf(s), s.name).toEqual(['~/.elan'])
      expect(s.with?.key, s.name).toBe(LEAN_KEY)
      expect(s.with && 'restore-keys' in s.with, s.name).toBe(false)
    }
  })

  it('快取 key 的 toolchain 字串與安裝步驟的 LEAN_TOOLCHAIN 一致', () => {
    expect(step(RESTORE).with?.key).toContain(step(INSTALL).env?.['LEAN_TOOLCHAIN'])
  })

  it('workflow 任何 job 都不用合併版 actions/cache（它的 post-job save 會在 agent 之後執行）', () => {
    for (const s of allSteps()) expect(s.uses ?? '', s.name).not.toMatch(/^actions\/cache@/)
  })

  it('任何快取步驟的路徑都不在 target/ 底下', () => {
    const cacheSteps = allSteps().filter((s) => (s.uses ?? '').startsWith('actions/cache'))
    expect(cacheSteps.length).toBeGreaterThan(0)
    for (const s of cacheSteps) {
      for (const p of pathsOf(s)) expect(p, s.name).not.toMatch(/^(\.\/)?target(\/|$)|\$\{\{\s*github\.workspace\s*\}\}\/target/)
    }
  })
})

describe('目標 repo 的 lean-toolchain 必須釘在 v4.35.0（M3）', () => {
  it('期望值以 env 給，與安裝步驟的 LEAN_TOOLCHAIN 相同', () => {
    expect(step(PIN).env?.['EXPECTED_TOOLCHAIN']).toBe(LEAN_TOOLCHAIN)
  })

  const runPin = (content: string | null) => {
    const s = step(PIN)
    return exec(s.run ?? '', s.env ?? {}, (dir) => {
      if (content === null) return
      mkdirSync(join(dir, 'target/specs/lean'), { recursive: true })
      writeFileSync(join(dir, 'target/specs/lean/lean-toolchain'), content)
    })
  }

  it('檔案不存在 → 通過（agent 會依 skill 範本建立）', () => {
    const r = runPin(null)
    expect(r.status, r.log).toBe(0)
  })

  for (const ok of [`${LEAN_TOOLCHAIN}\n`, LEAN_TOOLCHAIN, `  ${LEAN_TOOLCHAIN}  \n\n`]) {
    it(`前後空白修剪後相等 → 通過（${JSON.stringify(ok)}）`, () => {
      const r = runPin(ok)
      expect(r.status, r.log).toBe(0)
    })
  }

  for (const bad of ['leanprover/lean4:v4.36.0\n', 'leanprover/lean4:stable\n', `${LEAN_TOOLCHAIN}-rc1\n`, '']) {
    it(`不符 → ::error:: 並非零結束（${JSON.stringify(bad)}）`, () => {
      const r = runPin(bad)
      expect(r.status).not.toBe(0)
      expect(r.log).toContain('::error::')
    })
  }
})

describe('Quint 快取：驗證模式不在 agent 之後存檔（M1）', () => {
  const QRESTORE = 'Restore Quint toolchain'
  const QSAVE = 'Save Quint toolchain'

  it('restore 無條件、在 build 之前，path／key／restore-keys 與原本相同', () => {
    const s = step(QRESTORE)
    expect(s.id).toBe('quintcache')
    expect(s.uses).toBe(`actions/cache/restore@${cacheMajor()}`)
    expect(s.if).toBeUndefined()
    expect(pathsOf(s)).toEqual(['~/.quint'])
    expect(s.with?.key).toBe("quint-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}")
    expect((s.with?.['restore-keys'] ?? '').trim()).toBe('quint-${{ runner.os }}-')
    expect(idx(QRESTORE)).toBeLessThan(idx('Install and build'))
  })

  it('save：同 path／key，只在「確定非驗證模式」且非精確命中時執行（success() 開頭、無 always／||）', () => {
    const s = step(QSAVE)
    expect(s.uses).toBe(`actions/cache/save@${cacheMajor()}`)
    expect(pathsOf(s)).toEqual(['~/.quint'])
    expect(s.with?.key).toBe(step(QRESTORE).with?.key)
    // == 'false' 而非 != 'true'：guard 沒產出（空字串）時也不存
    expect(s.if).toBe(
      "success() && steps.verifymode.outputs.verify == 'false' && steps.quintcache.outputs.cache-hit != 'true'",
    )
  })

  it('非驗證模式仍在 agent 與 write-spec 集中驗證（~/.quint 的實際寫入者）之後存檔', () => {
    expect(idx(QSAVE)).toBeGreaterThan(idxId('agent'))
    expect(idx(QSAVE)).toBeGreaterThan(idxId('specverify'))
  })

  it('agent 之後的每個 cache save 步驟都排除驗證模式', () => {
    const agent = idxId('agent')
    const saves = steps()
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i > agent && (s.uses ?? '').startsWith('actions/cache/save'))
    for (const { s } of saves) {
      expect(s.if ?? '', s.name).toContain("steps.verifymode.outputs.verify == 'false'")
      expect(s.if ?? '', s.name).not.toMatch(/\|\||always\(\)|failure\(\)/)
    }
  })
})

describe('I6：快取存檔是 best-effort，且不得從失敗／部分安裝存檔', () => {
  const LEAN_SAVE = (): Step => step(SAVE)
  const QUINT_SAVE = (): Step => step('Save Quint toolchain')

  it('兩個 save 都以 success() 為第一個條件，並帶 continue-on-error: true', () => {
    for (const s of [LEAN_SAVE(), QUINT_SAVE()]) {
      expect(s.if?.startsWith('success() && '), `${s.name}: success() 必須是第一個條件`).toBe(true)
      expect(s['continue-on-error'], `${s.name}: cache save 不得讓 run 失敗`).toBe(true)
      expect(s.if ?? '', s.name).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|\|\|/)
    }
  })

  it('Lean save 要求安裝步驟成功；安裝失敗 → 條件為 false（不存檔）', () => {
    const expr = LEAN_SAVE().if ?? ''
    expect(expr).toContain(`steps.${INSTALL_ID}.outcome == 'success'`)
    const ctx = leanSaveContext()
    ctx.steps[INSTALL_ID] = { outcome: 'failure' }
    expect(evalCondition(expr, ctx)).toBe(false)
  })

  it('Lean save 要求完整性檢查成功；檢查失敗 → 條件為 false（不存部分 elan）', () => {
    const expr = LEAN_SAVE().if ?? ''
    expect(expr).toContain("steps.leancheck.outcome == 'success'")
    const ctx = leanSaveContext()
    ctx.steps.leancheck = { outcome: 'failure' }
    expect(evalCondition(expr, ctx)).toBe(false)
  })

  it('Lean save 在其他前置不成立時也不執行（cache hit／非驗證／前面步驟失敗）', () => {
    const expr = LEAN_SAVE().if ?? ''
    const hit = leanSaveContext()
    hit.steps.leancache = { 'outputs.cache-hit': 'true' }
    expect(evalCondition(expr, hit)).toBe(false)

    const nonVerify = leanSaveContext()
    nonVerify.steps.verifymode = { 'outputs.verify': 'false' }
    expect(evalCondition(expr, nonVerify)).toBe(false)

    const earlierFailure = leanSaveContext()
    earlierFailure.success = false
    expect(evalCondition(expr, earlierFailure)).toBe(false)

    // happy path：全部成立才存
    expect(evalCondition(expr, leanSaveContext())).toBe(true)
  })

  it('完整性檢查步驟只檢查 ~/.elan/bin/lean：部分安裝 → 非零；完整 → 零（失敗只跳過存檔）', () => {
    const s = step(CHECK)
    expect(s['continue-on-error'], '檢查失敗只跳過 save，不得讓 run 失敗').toBe(true)
    expect(s.if ?? '').toContain(`steps.${INSTALL_ID}.outcome == 'success'`)
    expect(s.run ?? '').toContain('$HOME/.elan/bin/lean')

    const partial = exec(s.run ?? '', {}, (dir) => {
      mkdirSync(join(dir, '.elan/bin'), { recursive: true })
      stub(join(dir, '.elan/bin/elan'), 'echo "elan 4.2.4"')
    })
    expect(partial.status, partial.log).not.toBe(0)

    const complete = exec(s.run ?? '', {}, (dir) => {
      mkdirSync(join(dir, '.elan/bin'), { recursive: true })
      stub(join(dir, '.elan/bin/lean'), 'echo "Lean (version 4.35.0, x86_64-unknown-linux-gnu, Release)"')
    })
    expect(complete.status, complete.log).toBe(0)
  })

  it('Quint save 驗證失敗條件：success() 為 false 或非確定非驗證 → 不存檔', () => {
    const expr = QUINT_SAVE().if ?? ''
    const base: EvalContext = {
      success: true,
      steps: {
        verifymode: { 'outputs.verify': 'false' },
        quintcache: { 'outputs.cache-hit': 'false' },
      },
    }
    expect(evalCondition(expr, base)).toBe(true)

    const failed = { ...base, success: false }
    expect(evalCondition(expr, failed)).toBe(false)

    const verify = { ...base, steps: { ...base.steps, verifymode: { 'outputs.verify': 'true' } } }
    expect(evalCondition(expr, verify)).toBe(false)

    const empty = { ...base, steps: { ...base.steps, verifymode: { 'outputs.verify': '' } } }
    expect(evalCondition(expr, empty)).toBe(false)
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
