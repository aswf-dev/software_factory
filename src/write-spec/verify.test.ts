/**
 * write-spec 驗證清單與結果判定（ADR-018 §7、§8、§12）。
 * Quint 輸出格式取自 0.32.0 實測（run／verify 的 [ok]／[violation]、witness 行）。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateByInvariant,
  checkInvariantSources,
  extractInstanceConstants,
  extractValNames,
  judgeEvidence,
  parseQuintOutput,
  parseVerifyConfig,
  type CheckResult,
} from './verify.js'

const INVARIANTS = [
  'module invariants {',
  '  const N: int',
  '  var votesFor: int',
  '  // source: spec §3',
  '  // 「經過時間必須小於有效期」',
  '  val INV_settles = votesFor < N',
  '  // source: spec §4',
  '  val INV_bounded = votesFor <= N',
  '  val WIT_tie = votesFor * 2 == N',
  '}',
].join('\n')

const INSTANCES = [
  'module odd { import model(N = 3).* from "./model" }',
  'module even {',
  '  import model(N = 2, CLIENTS = Set(1, 2)).* from "./model"',
  '}',
].join('\n')

// 情境 witness 由模型階段定義在 model.qnt（Q34）
const MODEL = '  val WIT_allVotesIn = votesFor + votesAgainst == N'

const VALID = `
instances:
  - module: even
    constants:
      N: { value: "2", domain_justification: "src/index.ts 未限制節點數" }
      CLIENTS: { value: "Set(1, 2)", domain_justification: "程式未限制" }
checks:
  - { instance: even, invariant: INV_settles, mode: run, max_steps: 4, timeout_seconds: 60, witnesses: [WIT_allVotesIn] }
  - { instance: even, invariant: INV_bounded, mode: verify, max_steps: 4, timeout_seconds: 60, witnesses: [WIT_allVotesIn] }
`

describe('extractValNames', () => {
  it('依前綴取 val 名稱', () => {
    expect(extractValNames(INVARIANTS, 'INV_')).toEqual(['INV_settles', 'INV_bounded'])
    expect(extractValNames(INVARIANTS, 'WIT_')).toEqual(['WIT_tie'])
  })
})

describe('checkInvariantSources（不變量階段）', () => {
  it('每個 INV_* 上方的註解區塊都有 `// source:` → 無錯誤', () => {
    expect(checkInvariantSources(INVARIANTS)).toEqual([])
  })
  it('缺 source 註解的 INV_* → 逐條列出', () => {
    const text = 'module m {\n  val INV_a = true\n  // 只是說明\n  val INV_b = true\n}'
    const errs = checkInvariantSources(text)
    expect(errs).toHaveLength(2)
    expect(errs.join()).toContain('INV_a')
    expect(errs.join()).toContain('INV_b')
  })
  it('一個 INV_* 都沒有 → 錯誤（不變量階段必須產出不變量）', () => {
    expect(checkInvariantSources('module m {}')).toEqual(['`invariants.qnt` 沒有任何 `val INV_*`'])
  })
})

describe('extractInstanceConstants', () => {
  it('取每個 instance 模組 import model(...) 的常數名稱', () => {
    expect(extractInstanceConstants(INSTANCES)).toEqual({ odd: ['N'], even: ['N', 'CLIENTS'] })
  })
  it('沒有參數化 import 的模組 → 空清單；括號未配對時取到結尾', () => {
    expect(extractInstanceConstants('module plain { import model.* from "./model" }')).toEqual({ plain: [] })
    expect(extractInstanceConstants('module broken { import model(N = f(1)')).toEqual({ broken: ['N'] })
    expect(extractInstanceConstants('module trailing { import model(N = 1, ).* }')).toEqual({ trailing: ['N'] })
  })
})

describe('parseVerifyConfig', () => {
  const ctx = { invariantsText: INVARIANTS, modelText: MODEL, instancesText: INSTANCES }
  it('合法清單 → 無錯誤，套用預設值', () => {
    const r = parseVerifyConfig(VALID, ctx)
    expect(r.errors).toEqual([])
    expect(r.config?.checks[0]!.max_samples).toBe(10000)
  })
  it('YAML 語法錯誤或 schema 不符 → 錯誤', () => {
    expect(parseVerifyConfig('checks: [unclosed', ctx).errors[0]).toMatch(/YAML/)
    expect(parseVerifyConfig('instances: []\nchecks: []\n', ctx).errors.join()).toMatch(/schema/)
    expect(parseVerifyConfig('42', ctx).errors.join()).toContain('(root)')
  })
  it('不允許宣告預期結果（未知欄位一律拒絕）', () => {
    const withExpect = VALID.replace('witnesses: [WIT_allVotesIn] }\n  - {', 'witnesses: [WIT_allVotesIn], expect: holds }\n  - {')
    expect(parseVerifyConfig(withExpect, ctx).errors.join()).toMatch(/schema/)
  })
  it('引用未宣告的實例、不存在的不變量或 witness → 錯誤', () => {
    const bad = VALID.replace('instance: even, invariant: INV_settles', 'instance: nope, invariant: INV_missing').replace(
      'witnesses: [WIT_allVotesIn] }\n  - {',
      'witnesses: [WIT_nope] }\n  - {',
    )
    const errs = parseVerifyConfig(bad, ctx).errors.join('\n')
    expect(errs).toContain('nope')
    expect(errs).toContain('INV_missing')
    expect(errs).toContain('WIT_nope')
  })
  it('有不變量沒被任何檢查涵蓋 → 錯誤', () => {
    const oneCheck = VALID.split('\n').filter((l) => !l.includes('INV_bounded')).join('\n')
    expect(parseVerifyConfig(oneCheck, ctx).errors.join()).toMatch(/INV_bounded.*沒有任何檢查/)
  })
  it('實例常數缺 domain_justification、或 instances.qnt 沒有該模組 → 錯誤（Q21）', () => {
    const missing = VALID.replace('      CLIENTS: { value: "Set(1, 2)", domain_justification: "程式未限制" }\n', '')
    expect(parseVerifyConfig(missing, ctx).errors.join()).toMatch(/CLIENTS.*domain_justification/)
    const ghost = VALID.replace('  - module: even', '  - module: ghost').replaceAll('instance: even', 'instance: ghost')
    expect(parseVerifyConfig(ghost, ctx).errors.join()).toMatch(/ghost.*instances\.qnt/)
  })
  it('witness 必須定義在 model.qnt：引用 invariants.qnt 的 WIT_* → 錯誤並說明原因（Q34）', () => {
    const errs = parseVerifyConfig(VALID.replaceAll('WIT_allVotesIn', 'WIT_tie'), ctx).errors.join('\n')
    expect(errs).toMatch(/WIT_tie.*invariants\.qnt.*model\.qnt/)
    expect(errs).toContain('必然不可達')
  })
  it('model.qnt 沒有 witness 時，錯誤訊息指向 model.qnt', () => {
    const errs = parseVerifyConfig(VALID, { ...ctx, modelText: '' }).errors.join('\n')
    expect(errs).toMatch(/WIT_allVotesIn.*不存在於 model\.qnt/)
  })
  it('實例名稱重複、或逾時總和超過上限 → 錯誤', () => {
    const dup = VALID.replace(
      'checks:',
      '  - module: even\n    constants:\n      N: { value: "2", domain_justification: "x" }\n      CLIENTS: { value: "1", domain_justification: "x" }\nchecks:',
    )
    expect(parseVerifyConfig(dup, ctx).errors.join()).toMatch(/重複/)
    const slow = VALID.replaceAll('timeout_seconds: 60', 'timeout_seconds: 1000')
    expect(parseVerifyConfig(slow, ctx).errors.join()).toMatch(/上限/)
  })
})

describe('parseQuintOutput', () => {
  it('[ok] + witness 行 → holds 與 witness 次數', () => {
    const out = '[ok] No violation found (32ms).\nWitnesses:\nWIT_tie was witnessed in 0 trace(s) out of 200 explored (0.00%)\nWIT_x was witnessed in 7 trace(s) out of 200 explored (3.50%)\n'
    expect(parseQuintOutput(0, out, false)).toEqual({ status: 'holds', witnesses: { WIT_tie: 0, WIT_x: 7 } })
  })
  it('[violation]（run 或 verify）→ violated', () => {
    expect(parseQuintOutput(1, '[violation] Found an issue (19ms).\nerror: Invariant violated\n', false).status).toBe(
      'violated',
    )
  })
  it('逾時 → timeout', () => {
    expect(parseQuintOutput(null, '', true).status).toBe('timeout')
  })
  it('其他（typecheck 錯誤、名稱找不到）→ error，保留輸出尾段', () => {
    const r = parseQuintOutput(1, "error: [QNT404] Name 'INV_x' not found\nerror: Argument error\n", false)
    expect(r.status).toBe('error')
    expect(r.detail).toContain('QNT404')
  })
})

describe('aggregateByInvariant 與 judgeEvidence', () => {
  const res = (invariant: string, r: Partial<CheckResult>): CheckResult => ({
    instance: 'even',
    invariant,
    mode: 'run',
    status: 'holds',
    witnesses: {},
    ...r,
  })
  it('任一實例違反 → violated；全部成立且有 witness 可達 → holds', () => {
    const agg = aggregateByInvariant([
      res('INV_a', { instance: 'odd', witnesses: { W: 0 } }),
      res('INV_a', { status: 'violated', trace: 'specs/x/traces/even.INV_a.itf.json' }),
      res('INV_b', { witnesses: { W: 3 } }),
    ])
    expect(agg).toEqual([
      { invariant: 'INV_a', status: 'violated', traces: ['specs/x/traces/even.INV_a.itf.json'] },
      { invariant: 'INV_b', status: 'holds', traces: [] },
    ])
  })
  it('全部成立但沒有任何 witness 可達 → vacuous（假綠燈嫌疑）', () => {
    expect(aggregateByInvariant([res('INV_a', { witnesses: { W: 0 } })])[0]!.status).toBe('vacuous')
  })
  it('沒有違反、有錯誤 → error；只剩逾時 → timeout', () => {
    expect(aggregateByInvariant([res('INV_a', { status: 'error', detail: 'x' })])[0]!.status).toBe('error')
    expect(aggregateByInvariant([res('INV_a', { status: 'timeout' })])[0]!.status).toBe('timeout')
  })
  it('judgeEvidence：錯誤與假綠燈擋下；違反與逾時只記錄；違反是發現不是失敗', () => {
    const j = judgeEvidence([
      { invariant: 'INV_ok', status: 'holds', traces: [] },
      { invariant: 'INV_bug', status: 'violated', traces: ['t.itf.json'] },
      { invariant: 'INV_slow', status: 'timeout', traces: [] },
      { invariant: 'INV_hollow', status: 'vacuous', traces: [] },
      { invariant: 'INV_broken', status: 'error', traces: [] },
    ])
    expect(j.mismatches.map((m) => m.kind)).toEqual(['write-spec-vacuous', 'write-spec-check-error'])
    expect(j.advisories.map((a) => a.kind)).toEqual(['write-spec-candidate-finding', 'write-spec-timeout'])
    expect(j.advisories[0]!.detail).toContain('未回放')
  })
  it('全部成立 → 無 mismatch、無 advisory', () => {
    expect(judgeEvidence([{ invariant: 'INV_ok', status: 'holds', traces: [] }])).toEqual({
      mismatches: [],
      advisories: [],
    })
  })
})
