import { describe, expect, it } from 'vitest'
import {
  findPbtEditRequests,
  languageOfDir,
  languageOfFile,
  normalizeTarget,
  reviewPbtAuditIntake,
  type PbtAuditIntakeContext,
} from './intake.js'

/** 假的目標 repo：檔案清單即全部事實。 */
function repo(files: string[]): PbtAuditIntakeContext {
  return {
    pathKind: (rel) =>
      files.includes(rel) ? 'file' : files.some((f) => f.startsWith(`${rel}/`)) ? 'dir' : undefined,
    listFiles: (dir) => files.filter((f) => f.startsWith(`${dir}/`)),
  }
}
const NO_CHECKOUT: PbtAuditIntakeContext = { pathKind: undefined, listFiles: undefined }

describe('reviewPbtAuditIntake：範圍', () => {
  it('未宣告目標 → error', () => {
    const r = reviewPbtAuditIntake([], NO_CHECKOUT)
    expect(r.errors[0]).toContain('目標模組 / 檔案')
  })
  it('宣告多個 → error，要求拆單', () => {
    const r = reviewPbtAuditIntake(['src/a.ts', 'src/b.ts'], repo(['src/a.ts', 'src/b.ts']))
    expect(r.errors[0]).toContain('拆成多張工單')
    expect(r.errors[0]).toContain('2 個')
  })
  it.each(['/etc/passwd', '../outside/x.ts', 'C:/x.ts', './', ''])('非 repo 內相對路徑 %s → error', (p) => {
    expect(reviewPbtAuditIntake([p], repo(['src/a.ts'])).errors[0]).toContain('相對路徑')
  })
  it.each(['test/jest/Tick.test.ts', 'test/jest', 'src/__tests__', 'pkg/a_pbt_test.go'])('測試檔或測試目錄 %s → error', (p) => {
    expect(reviewPbtAuditIntake([p], repo([p, `${p}/x.ts`])).errors[0]).toContain('產品程式碼')
  })
  it('不存在於目標 repo → error', () => {
    expect(reviewPbtAuditIntake(['src/missing.ts'], repo(['src/a.ts'])).errors[0]).toContain('不存在')
  })
})

describe('reviewPbtAuditIntake：語言', () => {
  it('TS 檔案 → typescript，無錯誤', () => {
    const r = reviewPbtAuditIntake(['./src/options/TickSizeCalculator.ts'], repo(['src/options/TickSizeCalculator.ts']))
    expect(r).toEqual({ target: 'src/options/TickSizeCalculator.ts', language: 'typescript', errors: [], deferred: [] })
  })
  it('目錄 → 取非測試原始檔的多數語言（測試檔、node_modules 不計）', () => {
    const r = reviewPbtAuditIntake(
      ['pkg/price/'],
      repo([
        'pkg/price/a.go',
        'pkg/price/b.go',
        'pkg/price/a_test.go',
        'pkg/price/gen.ts',
        'pkg/price/node_modules/x/y.ts',
        'pkg/price/node_modules/x/z.ts',
        'pkg/price/README.md',
      ]),
    )
    expect(r).toMatchObject({ target: 'pkg/price', language: 'go', errors: [] })
  })
  it('Python 檔案 → error，明說交還人類', () => {
    const r = reviewPbtAuditIntake(['app/price.py'], repo(['app/price.py']))
    expect(r.errors[0]).toContain('Python')
    expect(r.errors[0]).toContain('交還人類')
  })
  it('沒有 checkout：有副檔名的檔案先判語言，存在性延後', () => {
    const r = reviewPbtAuditIntake(['src/Order.kt'], NO_CHECKOUT)
    expect(r.errors[0]).toContain('Kotlin')
    expect(r.deferred[0]).toContain('存在性')
    const ok = reviewPbtAuditIntake(['src/a.rs'], NO_CHECKOUT)
    expect(ok).toMatchObject({ language: 'rust', errors: [] })
  })
  it('沒有 checkout：目錄的存在性與語言都延後', () => {
    const r = reviewPbtAuditIntake(['src/pricing'], NO_CHECKOUT)
    expect(r).toMatchObject({ target: 'src/pricing', errors: [] })
    expect(r.language).toBeUndefined()
    expect(r.deferred[0]).toContain('存在性與語言')
  })
})

describe('languageOfFile／languageOfDir', () => {
  it('未知副檔名 → 無法判定', () => {
    expect(languageOfFile('Makefile').error).toContain('無法由副檔名判定')
  })
  it('目錄內沒有 Hegel 語言 → error', () => {
    expect(languageOfDir('docs', ['docs/a.md', 'docs/b.py']).error).toContain('沒有 Hegel 支援語言')
  })
  it('同票 → error，要求縮小範圍', () => {
    const r = languageOfDir('mix', ['mix/a.go', 'mix/b.ts'])
    expect(r.error).toContain('檔案數相同')
  })
  it('normalizeTarget', () => {
    expect(normalizeTarget(' ./src\\a\\ ')).toBe('src/a')
  })
})

/*
 * 非 audit 類型要求變更 PBT 檔（ADR-019 §2）：派工前就攔下，不必等 crosscheck。
 * 回歸（philipz/fubon-tradingbot#654，run 37422161781）：agent-fix-bug 的 PRD 要求在
 * 兩支 *.pbt.test.ts 加回 property，agent 照做、crosscheck 判 pbt-outside-audit，
 * 11 分鐘的產出全部交還人類。
 */
describe('findPbtEditRequests', () => {
  it('回歸 #654：AC 要求在 PBT 檔加回 property → 列出該檔', () => {
    const prd = 'AC-2（01-test）在 TickSizeCalculator.pbt.test.ts 加回下列 property（沿用檔內 gridCents）：'
    expect(findPbtEditRequests(prd)).toEqual(['TickSizeCalculator.pbt.test.ts'])
  })
  it('回歸 #654：範圍列出要改的測試檔 → 只列 PBT 檔、不列一般測試檔', () => {
    const prd =
      '- 測試：test/jest/TickSizeCalculator.test.ts、test/jest/TickSizeCalculator.pbt.test.ts；' +
      'test/jest/TradingCostCalculator.pbt.test.ts 只加回 #646 候選發現 3。'
    expect(findPbtEditRequests(prd)).toEqual([
      'test/jest/TickSizeCalculator.pbt.test.ts',
      'test/jest/TradingCostCalculator.pbt.test.ts',
    ])
  })
  it('回歸 #659：「不碰」與「維持綠燈」提到 PBT 檔（含 glob）→ 不列', () => {
    const prd = [
      '- 不碰：任何 *.pbt.test.ts（ADR-019 §2：只有 agent-pbt-audit 可以變更 PBT 檔）',
      'AC-3（02-impl）依 D1–D3 修改；既有測試（含所有 *.pbt.test.ts）全部維持綠燈。',
    ].join('\n')
    expect(findPbtEditRequests(prd)).toEqual([])
  })
  it('具體 PBT 路徑但在否定語境 → 不列', () => {
    expect(findPbtEditRequests('- 不碰：test/jest/A.pbt.test.ts')).toEqual([])
    expect(findPbtEditRequests('Do not modify test/jest/A.pbt.test.ts')).toEqual([])
  })
  it('只是提及、沒有變更動詞 → 不列', () => {
    expect(findPbtEditRequests('參考 test/jest/A.pbt.test.ts 的 generator 寫法')).toEqual([])
  })
  it('code fence 內的內容不判讀（property 程式碼不是指示）', () => {
    const prd = ['下列 property 供參考：', '```ts', '// 新增到 test/jest/A.pbt.test.ts', '```'].join('\n')
    expect(findPbtEditRequests(prd)).toEqual([])
  })
  it('其他語言的 PBT 命名同樣適用、同一檔只列一次', () => {
    expect(findPbtEditRequests('新增 pkg/price_pbt_test.go；並修改 pkg/price_pbt_test.go 的 generator')).toEqual([
      'pkg/price_pbt_test.go',
    ])
    expect(findPbtEditRequests('Add properties to test/a.pbt.test.ts.')).toEqual(['test/a.pbt.test.ts'])
  })
  it('同一檔先後以完整路徑與檔名出現 → 只列完整路徑（回歸 #654 實際內文）', () => {
    const prd = [
      '- 測試：test/jest/Tick.pbt.test.ts 加回 property',
      'AC-2（01-test）在 Tick.pbt.test.ts 加回下列 property',
      'AC-3（01-test）在 Other.pbt.test.ts 加回',
    ].join('\n')
    expect(findPbtEditRequests(prd)).toEqual(['test/jest/Tick.pbt.test.ts', 'Other.pbt.test.ts'])
  })
})
