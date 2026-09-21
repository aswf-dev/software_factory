import { describe, expect, it } from 'vitest'
import {
  countAssertionDelta,
  countAssertions,
  isTestPath,
  stripComments,
} from './count.js'

describe('isTestPath', () => {
  it.each([
    'test/foo.ts',
    'tests/foo.ts',
    'src/__tests__/foo.ts',
    'src/a.test.ts',
    'src/a.spec.tsx',
    'src/a.test.mjs',
    'pkg/test_thing.py',
    'pkg/thing_test.py',
    'pkg/thing_test.go',
    'pkg/thing_test.rb',
    'spec/thing_spec.rb',
    'src/FooTest.java',
    'src/FooTests.cs',
    'src/FooTest.swift',
  ])('%s → 是測試檔', (p) => {
    expect(isTestPath(p)).toBe(true)
  })

  it.each([
    'src/a.ts',
    'docs/testing.md',
    'src/latest/a.ts', // 含 "test" 但不是路徑段起點——錨定沒有這一條就會誤認
    'src/contest/a.ts',
    'src/testify.ts',
  ])('%s → 不是測試檔', (p) => {
    expect(isTestPath(p)).toBe(false)
  })
})

describe('stripComments', () => {
  it('剝除 // 之後的內容', () => {
    expect(stripComments('const a = 1 // assert something')).toBe('const a = 1 ')
  })

  it('剝除 # 之後的內容', () => {
    expect(stripComments('x = 1  # assert something')).toBe('x = 1  ')
  })

  it('兩種標記同時出現 → 取較前面的那個', () => {
    expect(stripComments('a # b // c')).toBe('a ')
    expect(stripComments('a // b # c')).toBe('a ')
  })

  it('block comment 的中間行與起始行整行捨棄', () => {
    expect(stripComments('   * assert 這是說明文字')).toBe('')
    expect(stripComments('  /* assert 這是說明文字')).toBe('')
  })

  it('沒有註解標記 → 原樣回傳', () => {
    expect(stripComments('expect(a).toBe(1)')).toBe('expect(a).toBe(1)')
  })
})

describe('countAssertions', () => {
  it.each([
    ['expect(a).toBe(1)', 1],
    ['expect (a).toBe(1)', 1],
    ['assert x == 1', 1],
    ['assert_eq!(a, b);', 1],
    ['assert_ne!(a, b);', 1],
    ['XCTAssertEqual(a, b)', 1],
    ['t.Errorf("boom %v", err)', 1],
    ['t.Fatal(err)', 1],
  ])('%s → %i 條', (line, n) => {
    expect(countAssertions(line)).toBe(n)
  })

  it('一行多條全部計入', () => {
    expect(countAssertions('expect(a).toBe(1); expect(b).toBe(2)')).toBe(2)
  })

  it('整行註解不計入（刪掉一行提到 assert 的註解不是刪掉斷言）', () => {
    expect(countAssertions('// assert that expect(x) works')).toBe(0)
    expect(countAssertions(' * assert_eq!(a, b) 舉例')).toBe(0)
  })

  it('空行與純空白 → 0', () => {
    expect(countAssertions('')).toBe(0)
    expect(countAssertions('// only a comment')).toBe(0)
  })

  it('刻意不收的兩類：require.* 與 should（避免非斷言用途的雜訊）', () => {
    expect(countAssertions("const x = require.resolve('y')")).toBe(0)
    expect(countAssertions('result.should.be.ok')).toBe(0)
  })
})

/** 組一段 unified diff（`--unified=0` 的形狀）。 */
function diffOf(path: string, lines: string[], oldPath = path): string {
  return [
    `diff --git a/${oldPath} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${oldPath}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ...lines,
  ].join('\n')
}

describe('countAssertionDelta', () => {
  it('測試檔加了斷言 → delta 為正', () => {
    const d = countAssertionDelta(diffOf('src/a.test.ts', ['+  expect(a).toBe(1)', '+  expect(b).toBe(2)']))
    expect(d).toEqual({ added: 2, removed: 0, delta: 2 })
  })

  it('測試檔刪了斷言 → delta 為負（SR6 的判準）', () => {
    const d = countAssertionDelta(diffOf('src/a.test.ts', ['-  expect(a).toBe(1)', '+  // TODO']))
    expect(d).toEqual({ added: 0, removed: 1, delta: -1 })
  })

  it('非測試檔的 expect( 不計入', () => {
    const d = countAssertionDelta(diffOf('src/a.ts', ['-  expect(a).toBe(1)']))
    expect(d).toEqual({ added: 0, removed: 0, delta: 0 })
  })

  it('刪除整個測試檔仍計入減項（+++ /dev/null 時退回舊路徑）', () => {
    const text = [
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      'deleted file mode 100644',
      '--- a/src/a.test.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-  expect(a).toBe(1)',
      '-  expect(b).toBe(2)',
    ].join('\n')
    expect(countAssertionDelta(text).delta).toBe(-2)
  })

  it('新增整個測試檔（--- /dev/null）計入加項', () => {
    const text = [
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/a.test.ts',
      '@@ -0,0 +1,1 @@',
      '+  expect(a).toBe(1)',
    ].join('\n')
    expect(countAssertionDelta(text).delta).toBe(1)
  })

  it('hunk 內長得像標頭的內容行不被當成標頭', () => {
    // 刪掉一行 SQL 註解 `-- expect(...)` 在 diff 裡長成 `--- expect(...)`。
    // 若無條件解析成 `---` 標頭，這一行不但不計數，還會把當前檔案改掉。
    const text = [
      'diff --git a/test/x_test.rb b/test/x_test.rb',
      '--- a/test/x_test.rb',
      '+++ b/test/x_test.rb',
      '@@ -1,2 +1,1 @@',
      '--- expect(a).toBe(1)',
      '+++ expect(b).toBe(2)',
    ].join('\n')
    expect(countAssertionDelta(text)).toEqual({ added: 1, removed: 1, delta: 0 })
  })

  it('多檔 diff：diff --git 重置檔案狀態', () => {
    const text = [
      diffOf('src/a.test.ts', ['+  expect(a).toBe(1)']),
      diffOf('src/b.ts', ['-  expect(b).toBe(2)']),
    ].join('\n')
    // 第二個檔案不是測試檔；若 diff --git 沒有重置 inTestFile，它會被誤計為 -1
    expect(countAssertionDelta(text)).toEqual({ added: 1, removed: 0, delta: 1 })
  })

  it('沒有前綴的路徑（--no-prefix）也認得', () => {
    const text = [
      'diff --git src/a.test.ts src/a.test.ts',
      '--- src/a.test.ts',
      '+++ src/a.test.ts',
      '@@ -1 +1 @@',
      '-  assert x == 1',
    ].join('\n')
    expect(countAssertionDelta(text).delta).toBe(-1)
  })

  it('測試檔內既非加行也非減行的行被忽略（脈絡行、"\\ No newline"、空行）', () => {
    const text = [
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      '--- a/src/a.test.ts',
      '+++ b/src/a.test.ts',
      '@@ -1,3 +1,3 @@',
      '   expect(context).toBe(1)', // 脈絡行：兩側都存在，不是變更
      '+  expect(a).toBe(1)',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(countAssertionDelta(text)).toEqual({ added: 1, removed: 0, delta: 1 })
  })

  it('空輸入 → 全 0（無分支時的情形）', () => {
    expect(countAssertionDelta('')).toEqual({ added: 0, removed: 0, delta: 0 })
  })

  it('純搬移（同內容一刪一加）淨值為 0，不會誤報', () => {
    const text = [
      diffOf('test/old_test.go', ['-  t.Fatal(err)'], 'test/old_test.go'),
      diffOf('test/new_test.go', ['+  t.Fatal(err)'], 'test/new_test.go'),
    ].join('\n')
    expect(countAssertionDelta(text).delta).toBe(0)
  })
})
