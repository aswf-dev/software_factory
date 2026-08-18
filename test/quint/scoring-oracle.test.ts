/**
 * 神諭 harness（docs/superpowers/plans Phase 1 Task 18）。
 *
 * 以 Quint 模型為 oracle：quint run 產生 ITF traces，逐一與 TS 實作比對。
 * 若模型與實作不一致，代表「程式碼偏離規格書」——CI 紅燈。
 *
 * ITF 結構（quint 0.32.0 實測）：states 為扁平物件，整數編碼為
 * {"#bigint": "..."}，布林為純 true/false。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { score, tierForTotal } from '../../src/scoring/score.js'

const ROOT = join(import.meta.dirname, '../..')
const SPEC = join(ROOT, 'specs/scoring/score.qnt')

interface ItfState {
  bc?: { '#bigint'?: string } | number
  rp?: { '#bigint'?: string } | number
  cx?: { '#bigint'?: string } | number
  total?: { '#bigint'?: string } | number
  tier?: { '#bigint'?: string } | number
  auto?: boolean
}
interface ItfFile {
  states: ItfState[]
}

/** 解碼 ITF 的整數（{"#bigint": "3"}）與原生數值。 */
function num(v: { '#bigint'?: string } | number | undefined): number {
  if (typeof v === 'number') return v
  if (v && typeof v['#bigint'] === 'string') return Number(v['#bigint'])
  return NaN
}

/** 軸值 0..2 → catalog annotation 字串（business-criticality 軸）。 */
function axisCriticality(v: number): 'tactical' | 'operational' | 'strategic' {
  return (['tactical', 'operational', 'strategic'] as const)[v] ?? 'strategic'
}

/** 軸值 0..2 → catalog annotation 字串（risk/complexity 軸，合法值為 low/medium/high）。 */
function axisLevel(v: number): 'low' | 'medium' | 'high' {
  return (['low', 'medium', 'high'] as const)[v] ?? 'high'
}

/** 模型 tier 整數 0/1/2 → TS 的 OversightTier 字串。 */
const MODEL_TIERS = ['on-loop', 'review', 'in-loop'] as const

let traceDir: string
let states: ItfState[]

beforeAll(
  () => {
    traceDir = mkdtempSync(join(tmpdir(), 'quint-oracle-'))
    // 固定 seed + 單一長 trace：step 每步以 nondet s ∈ 0..26 選輸入 → 400 步覆蓋多種組合。
    // rust backend 首次執行需編譯，CI 冷啟動可能 >10s，故 hook 上限設 120s。
    execFileSync(
      'npx',
      [
        'quint', 'run', '--seed', '0', '--max-samples', '1', '--max-steps', '400',
        '--out-itf', join(traceDir, 'trace.itf.json'),
        SPEC,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    )
    const trace = JSON.parse(readFileSync(join(traceDir, 'trace.itf.json'), 'utf8')) as ItfFile
    // 跳過 init state（bc=rp=cx=0, total=0）
    states = trace.states.slice(1)
  },
  120_000,
)

afterAll(() => {
  rmSync(traceDir, { recursive: true, force: true })
})

describe('Quint 神諭：TS 實作與規格模型一致', () => {
  it('模型產出足夠多的 states（覆蓋多種輸入組合）', () => {
    expect(states.length).toBeGreaterThan(50)
    const distinct = new Set(states.map((s) => `${num(s.bc)},${num(s.rp)},${num(s.cx)}`))
    // nondet s 均勻取樣 0..26 → 300 samples 應覆蓋絕大多數組合
    expect(distinct.size).toBeGreaterThanOrEqual(20)
  })

  it('模型輸出的 total 與 TS totalScore 一致', () => {
    for (const s of states) {
      expect(num(s.total), `bc=${num(s.bc)} rp=${num(s.rp)} cx=${num(s.cx)}`).toBe(
        num(s.bc) + num(s.rp) + num(s.cx),
      )
    }
  })

  it('模型輸出的 tier 與 TS tierForTotal 一致', () => {
    for (const s of states) {
      const modelTier = MODEL_TIERS[num(s.tier)] ?? 'in-loop'
      expect(tierForTotal(num(s.total)), `total=${num(s.total)}`).toBe(modelTier)
    }
  })

  it('模型輸出的 automerge 與 TS score().automergeAllowed 一致（無硬規則情境）', () => {
    for (const s of states) {
      const ts = score({
        annotations: {
          businessCriticality: axisCriticality(num(s.bc)),
          riskProfile: axisLevel(num(s.rp)),
          complexity: axisLevel(num(s.cx)),
        },
        changedLines: 10,
      })
      expect(ts.automergeAllowed, `bc=${num(s.bc)} rp=${num(s.rp)} cx=${num(s.cx)}`).toBe(s.auto)
    }
  })
})
