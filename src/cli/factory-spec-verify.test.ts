/**
 * factory-spec-verify 測試（src/cli/** 100% branch 閘門）。fake quint 依參數回傳
 * 0.32.0 實測的輸出格式，並像真實 quint 一樣在 --out-itf 指定處寫出檔案。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, parseArgs, renderSummary, type QuintRunner } from './factory-spec-verify.js'
import { CliError } from './run-cli.js'

const OK = (w: Record<string, number>): string =>
  '[ok] No violation found (5ms).\nWitnesses:\n' +
  Object.entries(w).map(([k, n]) => `${k} was witnessed in ${n} trace(s) out of 100 explored`).join('\n') + '\n'
const VIOLATION = '[violation] Found an issue (5ms).\nerror: Invariant violated\n'

const INVARIANTS = [
  'module invariants {',
  '  const N: int',
  '  var v: int',
  '  // source: spec §3',
  '  val INV_a = v < N',
  '  // source: spec §4',
  '  val INV_b = v <= N',
  '  val WIT_w = v == N',
  '}',
].join('\n')

function makeSpec(files: Record<string, string>): string {
  const target = mkdtempSync(join(tmpdir(), 'spec-verify-'))
  const dir = join(target, 'specs/redlock')
  mkdirSync(dir, { recursive: true })
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c)
  return target
}

const MODEL_FILES = (verify: string): Record<string, string> => ({
  'invariants.qnt': INVARIANTS,
  'model.qnt': 'module model { import invariants.* from "./invariants"\n export invariants.* }',
  'instances.qnt': 'module odd { import model(N = 3).* from "./model" }\nmodule even { import model(N = 2).* from "./model" }',
  'verify.yml': verify,
})

const VERIFY = `
instances:
  - { module: odd, constants: { N: { value: "3", domain_justification: "程式未限制" } } }
  - { module: even, constants: { N: { value: "2", domain_justification: "程式未限制" } } }
checks:
  - { instance: odd, invariant: INV_a, max_steps: 4, timeout_seconds: 60, witnesses: [WIT_w] }
  - { instance: even, invariant: INV_a, max_steps: 4, timeout_seconds: 60, witnesses: [WIT_w] }
  - { instance: even, invariant: INV_b, mode: verify, max_steps: 4, timeout_seconds: 60, witnesses: [WIT_w] }
`

/** 依 (子指令, instance, invariant) 回傳腳本輸出；run/verify 帶 --out-itf 時寫出檔案。 */
function fakeQuint(script: (cmd: string, main: string, inv: string) => { exitCode?: number | null; output?: string; timedOut?: boolean }, calls: string[][] = []): QuintRunner {
  return (args, { cwd }) => {
    calls.push(args)
    const get = (flag: string): string => args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ''
    const out = get('--out-itf')
    if (out !== '') writeFileSync(join(cwd, out), '{"states":[]}')
    const r = script(args[0] as string, get('--main'), get('--invariant'))
    return { exitCode: r.exitCode ?? 0, output: r.output ?? '', timedOut: r.timedOut ?? false }
  }
}

describe('parseArgs', () => {
  it('完整參數；--quint 轉成絕對路徑', () => {
    const a = parseArgs(['--phase', 'model', '--spec-name', 'redlock', '--target', 't', '--quint', 'q', '--summary', 's.md'])
    expect(a).toMatchObject({ phase: 'model', specName: 'redlock', target: 't', summaryPath: 's.md' })
    expect(a.quintBin.endsWith('/q')).toBe(true)
  })
  it('預設 target 與 quint 路徑', () => {
    const a = parseArgs(['--phase', 'invariants', '--spec-name', 'redlock'])
    expect(a.target).toBe('target')
    expect(a.quintBin.endsWith('node_modules/.bin/quint')).toBe(true)
  })
  it('缺或錯的 phase、spec-name，未知參數、缺值 → CliError', () => {
    expect(() => parseArgs(['--spec-name', 'redlock'])).toThrow(/\(missing\)/)
    expect(() => parseArgs(['--phase', 'draft', '--spec-name', 'redlock'])).toThrow(CliError)
    expect(() => parseArgs(['--phase', 'model'])).toThrow(/spec-name/)
    expect(() => parseArgs(['--phase', 'model', '--spec-name', 'Bad'])).toThrow(/spec-name/)
    expect(() => parseArgs(['--phase', 'model', '--spec-name', 'redlock', '--x'])).toThrow(/unknown/)
    expect(() => parseArgs(['--phase'])).toThrow(/requires a value/)
  })
})

describe('main：不變量階段', () => {
  const run = (target: string, q: QuintRunner) => main(['--phase', 'invariants', '--spec-name', 'redlock', '--target', target], q)
  it('typecheck 通過、source 註解齊全 → ok', () => {
    expect(run(makeSpec({ 'invariants.qnt': INVARIANTS }), fakeQuint(() => ({}))).ok).toBe(true)
  })
  it('缺 invariants.qnt → 不合規', () => {
    const r = run(makeSpec({}), fakeQuint(() => ({})))
    expect(r.mismatches.map((m) => m.kind)).toEqual(['write-spec-missing-file'])
  })
  it('typecheck 失敗或逾時、缺 source 註解 → 不合規', () => {
    const bad = run(makeSpec({ 'invariants.qnt': 'module m {\n  val INV_x = y\n}' }), fakeQuint(() => ({ exitCode: 1, output: "error: [QNT404] Name 'y' not found\n" })))
    expect(bad.mismatches.map((m) => m.kind)).toEqual(['write-spec-typecheck', 'write-spec-source-comment'])
    expect(bad.mismatches[0]!.detail).toContain('QNT404')
    const slow = run(makeSpec({ 'invariants.qnt': INVARIANTS }), fakeQuint(() => ({ exitCode: null, timedOut: true })))
    expect(slow.mismatches[0]!.detail).toContain('逾時')
  })
})

describe('main：模型階段', () => {
  const run = (target: string, q: QuintRunner, extra: string[] = []) =>
    main(['--phase', 'model', '--spec-name', 'redlock', '--target', target, ...extra], q, 'run-1')

  it('奇數實例成立（witness 0）＋偶數實例違反 → INV_a 為違反、保留反例；verify 成立後另跑 witness', () => {
    const target = makeSpec(MODEL_FILES(VERIFY))
    mkdirSync(join(target, 'specs/redlock/traces'), { recursive: true })
    writeFileSync(join(target, 'specs/redlock/traces/stale.itf.json'), 'old')
    const calls: string[][] = []
    const r = run(
      target,
      fakeQuint((cmd, m, inv) => {
        if (cmd === 'typecheck') return {}
        if (inv === 'INV_a' && m === 'even') return { exitCode: 1, output: VIOLATION }
        if (cmd === 'verify') return { output: '[ok] No violation found (5ms).\n' }
        if (inv === '') return { output: OK({ WIT_w: 4 }) } // verify 之後的 witness 量測
        return { output: OK({ WIT_w: 0 }) }
      }, calls),
    )
    expect(r.ok).toBe(true)
    expect(r.invariants).toEqual([
      { invariant: 'INV_a', status: 'violated', traces: ['specs/redlock/traces/even.INV_a.itf.json'] },
      { invariant: 'INV_b', status: 'holds', traces: [] },
    ])
    expect(r.advisories.map((a) => a.kind)).toEqual(['write-spec-candidate-finding'])
    const traces = readdirSync(join(target, 'specs/redlock/traces'))
    expect(traces).toEqual(['even.INV_a.itf.json']) // 舊檔清掉、成立的暫存 ITF 刪掉
    expect(calls.some((c) => c[0] === 'run' && c.includes('--witnesses') && !c.some((a) => a.startsWith('--invariant=')))).toBe(true)
  })

  it('全部成立但 witness 皆不可達 → 假綠燈，不合規；--summary 寫出摘要', () => {
    const target = makeSpec(MODEL_FILES(VERIFY))
    const summary = join(target, 'summary.md')
    const r = run(target, fakeQuint((cmd) => (cmd === 'verify' ? { output: '[ok]\n' } : { output: OK({ WIT_w: 0 }) })), ['--summary', summary])
    expect(r.ok).toBe(false)
    expect(r.mismatches.map((m) => m.kind)).toEqual(['write-spec-vacuous', 'write-spec-vacuous'])
    const md = readFileSync(summary, 'utf8')
    expect(md).toContain('run: run-1')
    expect(md).toContain('假綠燈嫌疑')
  })

  it('違反但 quint 沒寫出 ITF → 不記錄反例路徑', () => {
    const target = makeSpec(MODEL_FILES(VERIFY))
    const q: QuintRunner = (args) =>
      args[0] === 'typecheck' ? { exitCode: 0, output: '', timedOut: false } : { exitCode: 1, output: VIOLATION, timedOut: false }
    const r = run(target, q)
    expect(r.invariants?.[0]).toEqual({ invariant: 'INV_a', status: 'violated', traces: [] })
  })

  it('缺檔案、typecheck 失敗、verify.yml 不合法 → 不合規且不執行檢查', () => {
    const missing = run(makeSpec({ 'invariants.qnt': INVARIANTS }), fakeQuint(() => ({})))
    expect(missing.mismatches.map((m) => m.detail)).toEqual(['缺 `model.qnt`', '缺 `instances.qnt`', '缺 `verify.yml`'])

    const calls: string[][] = []
    const tc = run(makeSpec(MODEL_FILES(VERIFY)), fakeQuint(() => ({ exitCode: 1, output: 'error: x' }), calls))
    expect(tc.mismatches.map((m) => m.kind)).toEqual(['write-spec-typecheck'])
    expect(calls).toHaveLength(1)

    const cfg = run(makeSpec(MODEL_FILES('checks: []\n')), fakeQuint(() => ({})))
    expect(cfg.mismatches.map((m) => m.kind)).toEqual(['write-spec-verify-config'])
  })
})

describe('renderSummary', () => {
  it('無彙總結果時只列 mismatch 與 advisory', () => {
    const md = renderSummary(
      { phase: 'invariants', ok: false, mismatches: [{ kind: 'k', detail: '缺東西' }], advisories: [{ kind: 'a', detail: '提示' }] },
      'r',
    )
    expect(md).toContain('證據不完整')
    expect(md).toContain('- ❌ 缺東西')
    expect(md).toContain('- 💡 提示')
    expect(md).not.toContain('| 不變量 |')
  })
  it('違反的不變量列出反例路徑（多個以 <br> 分隔）', () => {
    const md = renderSummary(
      {
        phase: 'model',
        ok: true,
        mismatches: [],
        advisories: [],
        invariants: [{ invariant: 'INV_a', status: 'violated', traces: ['t/a.itf.json', 't/b.itf.json'] }],
      },
      'r',
    )
    expect(md).toContain('| `INV_a` | 🔴 違反（候選發現，未回放） | `t/a.itf.json`<br>`t/b.itf.json` |')
  })
  it('ok → 證據完整', () => {
    expect(renderSummary({ phase: 'model', ok: true, mismatches: [], advisories: [], invariants: [] }, 'r')).toContain('證據完整')
  })
})

it('traces/ 裡非 ITF 的檔案保留（只清 CI 產生的 *.itf.json）', () => {
  const target = makeSpec(MODEL_FILES(VERIFY))
  mkdirSync(join(target, 'specs/redlock/traces'), { recursive: true })
  writeFileSync(join(target, 'specs/redlock/traces/README.md'), '說明')
  main(['--phase', 'model', '--spec-name', 'redlock', '--target', target], fakeQuint((cmd) => (cmd === 'verify' ? { output: '[ok]\n' } : { output: OK({ WIT_w: 1 }) })))
  expect(readdirSync(join(target, 'specs/redlock/traces'))).toEqual(['README.md'])
})

it('未注入 runner → 以真實 quint typecheck（repo 內的 @informalsystems/quint，不需下載）', () => {
  const quint = ['--quint', join(import.meta.dirname, '../../node_modules/.bin/quint')]
  const ok = main(['--phase', 'invariants', '--spec-name', 'redlock', '--target', makeSpec({ 'invariants.qnt': INVARIANTS }), ...quint])
  expect(ok.mismatches).toEqual([])
  const bad = main(['--phase', 'invariants', '--spec-name', 'redlock', '--target', makeSpec({ 'invariants.qnt': 'module m {\n  // source: x\n  val INV_a = nope\n}' }), ...quint])
  expect(bad.mismatches.map((m) => m.kind)).toEqual(['write-spec-typecheck'])
  expect(bad.mismatches[0]!.detail).toContain('QNT404')
}, 60_000)

it('traces 目錄不存在時會建立', () => {
  const target = makeSpec(MODEL_FILES(VERIFY))
  main(['--phase', 'model', '--spec-name', 'redlock', '--target', target], fakeQuint((cmd) => (cmd === 'verify' ? { output: '[ok]\n' } : { output: OK({ WIT_w: 1 }) })))
  expect(existsSync(join(target, 'specs/redlock/traces'))).toBe(true)
})
