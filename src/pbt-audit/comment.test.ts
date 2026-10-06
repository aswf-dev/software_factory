import { describe, expect, it } from 'vitest'
import { buildPbtAuditComment, countProperties, fence, FIELD_MAX, type PbtMeasured } from './comment.js'
import { parsePbtAudit } from './report.js'

const FINDING = {
  property: 'roundToTick 對合法價格是恆等',
  source: 'generic/idempotent',
  draws: 'var draw_1 = 1000;',
  seed: 37303534685,
  hegelVersion: '0.4.7',
  reproTest: "test('F2', () => { expect(roundToTick(1000)).toBe(1000) })",
  propertyToRestore: "test('idem', () => hegel.test((tc) => { /* ... */ }))",
}
const MEASURED: PbtMeasured = {
  agentWallClockMs: 754_000,
  pbtFiles: ['test/jest/Tick.pbt.test.ts'],
  propertyCounts: { 'test/jest/Tick.pbt.test.ts': 7 },
}

describe('parsePbtAudit', () => {
  it('缺席或 null → absent', () => {
    expect(parsePbtAudit(undefined)).toEqual({ status: 'absent' })
    expect(parsePbtAudit(null)).toEqual({ status: 'absent' })
  })
  it('格式不符 → invalid 並指出欄位', () => {
    const r = parsePbtAudit({ passed: -1, findings: [{ property: 'p' }] })
    expect(r.status).toBe('invalid')
    expect(r.status === 'invalid' && r.detail).toContain('passed')
  })
  it('非物件 → invalid，路徑顯示 (root)', () => {
    const r = parsePbtAudit('oops')
    expect(r.status === 'invalid' && r.detail).toContain('(root)')
  })
})

describe('countProperties', () => {
  it('TS：hegel.test 與 hegel.testAsync', () => {
    expect(countProperties('a.pbt.test.ts', "test('a', () => hegel.test(f))\ntest('b', () => hegel.testAsync (g))")).toBe(2)
  })
  it('Java：@HegelTest；Rust：#[hegel::test]', () => {
    expect(countProperties('src/test/java/APbtTest.java', '@HegelTest\nvoid a(){}\n@HegelTest void b(){}')).toBe(2)
    expect(countProperties('tests/a_pbt.rs', '#[hegel::test]\nfn a(tc: TestCase) {}')).toBe(1)
  })
  it('Go／C++／OCaml／未知 → undefined（寧可未計數）', () => {
    expect(countProperties('a_pbt_test.go', 'hegel.Run')).toBeUndefined()
    expect(countProperties('README', 'x')).toBeUndefined()
  })
})

describe('fence', () => {
  it('內容含 ``` → 用更長的 fence', () => {
    expect(fence('a ``` b')).toBe('````\na ``` b\n````')
  })
  it('一般內容 → 三個反引號，可帶語言', () => {
    expect(fence('x', 'ts')).toBe('```ts\nx\n```')
  })
  it('超長 → 截斷並指向 artifact', () => {
    const out = fence('y'.repeat(FIELD_MAX + 10))
    expect(out).toContain('已截斷')
    expect(out.length).toBeLessThan(FIELD_MAX + 100)
  })
})

describe('buildPbtAuditComment', () => {
  it('內嵌 run id（終態守衛判定依據）', () => {
    expect(buildPbtAuditComment(undefined, MEASURED, '123')).toContain('（run: 123）')
  })
  it('機制實測與 agent 自報分段，自報標示未經驗證', () => {
    const c = buildPbtAuditComment({ seeds: [1, 2], testCasesPerSeed: 5000, properties: 8, passed: 7, failed: 1, timeouts: 0, findings: [FINDING] }, MEASURED, '1')
    expect(c).toContain('### 機制實測')
    expect(c).toContain('agent 牆鐘：12 分 34 秒')
    expect(c).toContain('property 數：7')
    expect(c).toContain('`test/jest/Tick.pbt.test.ts`：7 個 property')
    expect(c).toContain('### agent 自報（未經驗證）')
    expect(c).toContain('seeds：2 個；每 seed 案例數：5000')
    expect(c).toContain('通過 7、失敗 1、逾時 0')
  })
  it('候選發現：依據、seed、版本、draws、紅燈測試、要加回的 property 都在，標「未回放」並指向 agent-fix-bug', () => {
    const c = buildPbtAuditComment({ findings: [FINDING] }, MEASURED, '1')
    expect(c).toContain('候選發現（未回放）：1 條')
    expect(c).toContain('候選發現 1（未回放）：roundToTick 對合法價格是恆等')
    expect(c).toContain('`generic/idempotent`')
    expect(c).toContain('HEGEL_SEED=37303534685')
    expect(c).toContain('Hegel `0.4.7`')
    expect(c).toContain('var draw_1 = 1000;')
    expect(c).toContain("expect(roundToTick(1000)).toBe(1000)")
    expect(c).toContain('修正後要加回的 property')
    expect(c).toContain('agent-fix-bug')
  })
  // 回歸（philipz/fubon-tradingbot#654）：舊留言與操作手冊叫人把要加回的 property 放進
  // fix-bug 工單，但 fix-bug 不得變更 PBT 檔（crosscheck pbt-outside-audit）——沒有合法執行者。
  it('指明加回 property 的合法路徑：不放進 fix-bug 工單，修正合併後另開 agent-pbt-audit', () => {
    const c = buildPbtAuditComment({ findings: [FINDING] }, MEASURED, '1')
    expect(c).toContain('不要放進 `agent-fix-bug` 工單')
    expect(c).toContain('修正合併後另開 `agent-pbt-audit`')
    expect(c).toContain('docs/30 §7')
  })
  it('沒有 propertyToRestore（或空白）→ 不輸出該段', () => {
    const { propertyToRestore: _, ...noRestore } = FINDING
    expect(buildPbtAuditComment({ findings: [noRestore] }, MEASURED, '1')).not.toContain('修正後要加回')
    expect(buildPbtAuditComment({ findings: [{ ...FINDING, propertyToRestore: '  ' }] }, MEASURED, '1')).not.toContain('修正後要加回')
  })
  it('單行欄位的換行與反引號被中和（不破壞 markdown）', () => {
    const c = buildPbtAuditComment({ findings: [{ ...FINDING, property: 'a\n## 偽標題 `x`' }] }, MEASURED, '1')
    expect(c).toContain("候選發現 1（未回放）：a ## 偽標題 'x'")
  })
  it('沒有 findings → 「無。」；欄位未回報 → 「未回報」', () => {
    const c = buildPbtAuditComment({}, MEASURED, '1')
    expect(c).toContain('候選發現（未回放）：0 條')
    expect(c).toContain('無。')
    expect(c).toContain('seeds：未回報；每 seed 案例數：未回報')
  })
  it('pbtAudit 缺席 → 明說沒有自報數據', () => {
    expect(buildPbtAuditComment(undefined, MEASURED, '1')).toContain('沒有 `pbtAudit` 欄位')
  })
  it('pbtAudit 格式不符 → 不採用，指向 artifact', () => {
    const c = buildPbtAuditComment({ findings: 'x' }, MEASURED, '1')
    expect(c).toContain('格式不符，未採用')
    expect(c).toContain('artifact')
  })
  it('牆鐘量不到、未計數語言、沒有 PBT 檔', () => {
    const c = buildPbtAuditComment(undefined, { agentWallClockMs: undefined, pbtFiles: ['a_pbt_test.go'], propertyCounts: { 'a_pbt_test.go': undefined } }, '1')
    expect(c).toContain('agent 牆鐘：量不到')
    expect(c).toContain('property 數：部分語言未計數')
    expect(c).toContain('`a_pbt_test.go`：未計數')
    const none = buildPbtAuditComment(undefined, { agentWallClockMs: 42_000, pbtFiles: [], propertyCounts: {} }, '1')
    expect(none).toContain('agent 牆鐘：42 秒')
    expect(none).toContain('新增或修改的 PBT 檔：0 個')
    expect(none).toContain('property 數：0')
  })
})
