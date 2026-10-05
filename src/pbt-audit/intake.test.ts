import { describe, expect, it } from 'vitest'
import { languageOfDir, languageOfFile, normalizeTarget, reviewPbtAuditIntake, type PbtAuditIntakeContext } from './intake.js'

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
