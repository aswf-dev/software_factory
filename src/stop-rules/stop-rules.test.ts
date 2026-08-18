import { describe, expect, it } from 'vitest'
import { buildHandoverReport, evaluateStopRules } from './stop-rules.js'
import { MAX_SYNC_ATTEMPTS, NEEDS_HUMAN_LABEL } from './types.js'

describe('SR1 — gh stack sync 連續失敗（docs/07 §4.1）', () => {
  it('零次失敗 → 不停手', () => {
    expect(evaluateStopRules({ syncFailures: 0 }).mustStop).toBe(false)
  })

  it('第一次失敗 → 允許重試，不停手', () => {
    expect(evaluateStopRules({ syncFailures: 1 }).mustStop).toBe(false)
  })

  it(`連續 ${MAX_SYNC_ATTEMPTS} 次失敗 → 停手`, () => {
    const d = evaluateStopRules({ syncFailures: MAX_SYNC_ATTEMPTS })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.rule).toBe('SR1-sync-failed')
  })

  it('未提供 syncFailures → 視同 0', () => {
    expect(evaluateStopRules({}).mustStop).toBe(false)
  })
})

describe('SR2 — 高風險領域（docs/00 §6）', () => {
  it.each(['H1', 'H2', 'H3', 'H4', 'H6', 'H7'])('觸發 %s → 停手', (rule) => {
    const d = evaluateStopRules({ triggeredHardRules: [rule] })
    expect(d.mustStop).toBe(true)
    expect(d.violations.some((v) => v.rule === 'SR2-high-risk-domain')).toBe(true)
  })

  // H5 is guardrail self-modification: SR3 reports it with a far more specific
  // reason, so SR2 stays quiet to avoid a duplicate, vaguer message.
  it('僅觸發 H5 → 由 SR3 處理，不重複回報為 SR2', () => {
    const d = evaluateStopRules({ triggeredHardRules: ['H5'] })
    expect(d.violations.some((v) => v.rule === 'SR2-high-risk-domain')).toBe(false)
  })

  it('無觸發 → 不停手', () => {
    expect(evaluateStopRules({ triggeredHardRules: [] }).mustStop).toBe(false)
  })

  it('H5 與其他硬規則並存 → 仍停手，且理由排除 H5（由 SR3 專責）', () => {
    const d = evaluateStopRules({ triggeredHardRules: ['H5', 'H3'] })
    expect(d.mustStop).toBe(true)
    const sr2 = d.violations.find((v) => v.rule === 'SR2-high-risk-domain')
    expect(sr2?.reason).toContain('H3')
    expect(sr2?.reason).not.toContain('H5')
  })
})

describe('SR3 — 不得修改 guardrail 自身（docs/05 §1.1）', () => {
  it.each([
    '.github/workflows/test.yml',
    '.github/factory/risk-paths.yml',
    'CODEOWNERS',
    'catalog-info.yaml',
    '.dsh/skills/factory-stop-rules/SKILL.md',
  ])('%s → 停手', (path) => {
    const d = evaluateStopRules({ changedPaths: [path] })
    expect(d.mustStop).toBe(true)
    expect(d.violations.some((v) => v.rule === 'SR3-guardrail-change')).toBe(true)
  })

  it('一般程式碼路徑 → 不停手', () => {
    const d = evaluateStopRules({ changedPaths: ['src/app.ts', 'README.md'] })
    expect(d.mustStop).toBe(false)
  })

  // Negative controls: a path that merely *contains* a guardrail filename must
  // NOT be treated as a guardrail hit. Matching is glob-exact, not substring —
  // guards against regressing to naive `includes()` matching (false positives).
  it.each([
    'docs/catalog-info.yaml.md',
    'src/CODEOWNERS.js',
    'README-catalog-info.yaml.txt',
    'src/.github-formatter.ts',
  ])('僅包含 guardrail 檔名/目錄的變體 %s → 不停手（精確 glob 匹配）', (path) => {
    const d = evaluateStopRules({ changedPaths: [path] })
    expect(d.violations.some((v) => v.rule === 'SR3-guardrail-change')).toBe(false)
  })

  it('報告列出全部被觸及的 guardrail 檔案', () => {
    const d = evaluateStopRules({ changedPaths: ['CODEOWNERS', 'catalog-info.yaml'] })
    expect(d.violations[0]?.reason).toContain('CODEOWNERS')
    expect(d.violations[0]?.reason).toContain('catalog-info.yaml')
  })
})

describe('SR4 — 驗收條件不明確', () => {
  it('缺少驗收條件 → 停手', () => {
    const d = evaluateStopRules({ hasAcceptanceCriteria: false })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.rule).toBe('SR4-unclear-acceptance')
  })

  it('具備驗收條件 → 不停手', () => {
    expect(evaluateStopRules({ hasAcceptanceCriteria: true }).mustStop).toBe(false)
  })

  it('未提供該欄位 → 不觸發（僅明確為 false 才停手）', () => {
    expect(evaluateStopRules({}).mustStop).toBe(false)
  })
})

describe('SR5 — 新增相依套件', () => {
  it('新增套件 → 停手', () => {
    const d = evaluateStopRules({ addedDependencies: ['left-pad'] })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.reason).toContain('left-pad')
  })

  it('未新增 → 不停手', () => {
    expect(evaluateStopRules({ addedDependencies: [] }).mustStop).toBe(false)
  })
})

describe('SR6 — 弱化測試斷言（最危險的失敗模式）', () => {
  it('斷言淨減少 → 停手', () => {
    const d = evaluateStopRules({ assertionDelta: -3 })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.rule).toBe('SR6-weakened-tests')
    expect(d.violations[0]?.reason).toContain('3')
  })

  // Boundary: any negative delta, down to -1, is a stop. Guards against a
  // mutation that tightens the threshold (e.g. `assertionDelta < -1`) which
  // would let a single weakened assertion slip through undetected.
  it('斷言恰好 -1 → 停手（負數即停，邊界含 -1）', () => {
    const d = evaluateStopRules({ assertionDelta: -1 })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.rule).toBe('SR6-weakened-tests')
  })

  it('斷言增加 → 不停手', () => {
    expect(evaluateStopRules({ assertionDelta: 5 }).mustStop).toBe(false)
  })

  it('斷言數持平 → 不停手', () => {
    expect(evaluateStopRules({ assertionDelta: 0 }).mustStop).toBe(false)
  })

  it('未提供 → 不觸發', () => {
    expect(evaluateStopRules({}).mustStop).toBe(false)
  })
})

describe('SR7 — 成本上限（docs/05 §5）', () => {
  it('超過預算 → 停手', () => {
    const d = evaluateStopRules({ tokensUsed: 150_000, tokenBudget: 100_000 })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.rule).toBe('SR7-cost-exceeded')
  })

  it('恰好等於預算 → 不停手（邊界含等於）', () => {
    expect(evaluateStopRules({ tokensUsed: 100_000, tokenBudget: 100_000 }).mustStop).toBe(false)
  })

  // Phase 1 measures without enforcing, because no baseline exists yet (docs/04 §5).
  it('未設定預算 → 不強制中止，即使用量很高', () => {
    expect(evaluateStopRules({ tokensUsed: 999_999 }).mustStop).toBe(false)
  })

  it('有預算但無用量資料 → 不觸發', () => {
    expect(evaluateStopRules({ tokenBudget: 100 }).mustStop).toBe(false)
  })
})

describe('SR8 — 逾時（docs/02 §6）', () => {
  it('逾時 → 停手', () => {
    const d = evaluateStopRules({ timedOut: true })
    expect(d.mustStop).toBe(true)
    expect(d.violations[0]?.rule).toBe('SR8-timeout')
  })

  it('未逾時 → 不停手', () => {
    expect(evaluateStopRules({ timedOut: false }).mustStop).toBe(false)
  })
})

describe('多條規則同時觸發', () => {
  it('全部列出，不只回報第一條', () => {
    const d = evaluateStopRules({
      syncFailures: 2,
      changedPaths: ['CODEOWNERS'],
      assertionDelta: -1,
      timedOut: true,
    })
    expect(d.mustStop).toBe(true)
    expect(d.violations).toHaveLength(4)
    const rules = d.violations.map((v) => v.rule)
    expect(rules).toContain('SR1-sync-failed')
    expect(rules).toContain('SR3-guardrail-change')
    expect(rules).toContain('SR6-weakened-tests')
    expect(rules).toContain('SR8-timeout')
  })
})

describe('交還報告（docs/07 §4.2）', () => {
  it('無違規 → 空字串', () => {
    expect(evaluateStopRules({}).report).toBe('')
    expect(buildHandoverReport([])).toBe('')
  })

  it('包含標籤、規則數與每條理由，讓人類能接手而非重做', () => {
    const d = evaluateStopRules({ syncFailures: 2, assertionDelta: -2 })
    expect(d.label).toBe(NEEDS_HUMAN_LABEL)
    expect(d.report).toContain('工廠執行中止')
    expect(d.report).toContain('2 條')
    expect(d.report).toContain('SR1-sync-failed')
    expect(d.report).toContain('SR6-weakened-tests')
    expect(d.report).toContain('不會自行重試')
  })
})

describe('設計不變量：無繞過機制', () => {
  // A stuck agent must not be able to argue past the rules; there is simply no
  // parameter that turns them off.
  it('空 context 不會意外觸發任何規則', () => {
    const d = evaluateStopRules({})
    expect(d.mustStop).toBe(false)
    expect(d.violations).toEqual([])
  })

  it('一旦觸發即 mustStop，無 override 參數可關閉', () => {
    const d = evaluateStopRules({ changedPaths: ['.github/workflows/x.yml'] })
    expect(d.mustStop).toBe(true)
    // The public surface exposes no override key at all.
    expect(Object.keys(d)).toEqual(['mustStop', 'violations', 'label', 'report'])
  })
})
