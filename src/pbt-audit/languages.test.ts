import { describe, expect, it } from 'vitest'
import { extensionOf, isPbtTestPath, languageForExtension, languageSpec, PBT_LANGUAGES } from './languages.js'

describe('PBT_LANGUAGES（ADR-019 R1：Hegel 官方 6 種）', () => {
  it('恰為 TS/JS、Java、Go、Rust、C++、OCaml', () => {
    expect(PBT_LANGUAGES.map((l) => l.id)).toEqual(['typescript', 'java', 'go', 'rust', 'cpp', 'ocaml'])
  })
  it('副檔名不重疊（否則語言判定取決於表格順序）', () => {
    const all = PBT_LANGUAGES.flatMap((l) => l.extensions)
    expect(new Set(all).size).toBe(all.length)
  })
  it('只有 C++、OCaml 不做機械 preflight', () => {
    expect(PBT_LANGUAGES.filter((l) => !l.mechanicalPreflight).map((l) => l.id)).toEqual(['cpp', 'ocaml'])
  })
  it('languageSpec 依 id 取回', () => {
    expect(languageSpec('go').label).toBe('Go')
  })
})

describe('extensionOf', () => {
  it.each([
    ['src/a/Tick.ts', '.ts'],
    ['Main.JAVA', '.java'],
    ['lib/x.ml', '.ml'],
    ['Makefile', ''],
    ['.gitignore', ''],
    ['src/types.d.ts', ''],
    ['src/dir/', ''],
  ])('%s → %s', (p, ext) => {
    expect(extensionOf(p)).toBe(ext)
  })
  it('languageForExtension：未知副檔名 → undefined', () => {
    expect(languageForExtension('.py')).toBeUndefined()
    expect(languageForExtension('.mjs')?.id).toBe('typescript')
  })
})

describe('isPbtTestPath（crosscheck 白名單）', () => {
  it.each([
    'test/jest/TickSizeCalculator.pbt.test.ts',
    'TickSize.pbt.test.ts',
    'src/a/b.pbt.test.mjs',
    'core/src/test/java/dev/x/PricingPbtTest.java',
    'pkg/price/price_pbt_test.go',
    'tests/price_pbt.rs',
    'crates/core/tests/props/pbt_roundtrip.rs',
    'test/price_pbt_test.cpp',
    'lib/test/price_pbt.ml',
  ])('✓ %s', (p) => {
    expect(isPbtTestPath(p)).toBe(true)
  })
  it.each([
    'test/jest/TickSizeCalculator.test.ts',
    'src/TickSizeCalculator.ts',
    'src/pbt.ts',
    'src/main/java/dev/x/PricingPbtTest.java', // 不在 src/test 下
    'pkg/price/price_test.go',
    'src/lib.rs', // src 內的 #[cfg(test)] mod 等於改產品檔
    'src/pbt_helpers.rs',
    'package.json',
    'jest.common.config.js',
    'test/price_pbt.ml.bak',
  ])('✗ %s', (p) => {
    expect(isPbtTestPath(p)).toBe(false)
  })
})
