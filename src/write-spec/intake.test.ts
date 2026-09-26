/**
 * write-spec 開單欄位檢查測試（ADR-018 §4、§5）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifySpecSource,
  isValidSpecName,
  loadQuintSpecAnnotated,
  reviewSpecIntake,
  type SpecIntakeContext,
} from './intake.js'

const KNOWN: SpecIntakeContext = {
  riskHits: 0,
  quintSpecAnnotated: true,
  fileExists: () => true,
}

describe('isValidSpecName', () => {
  it('kebab-case 小寫英數 → 合法', () => {
    expect(isValidSpecName('redlock')).toBe(true)
    expect(isValidSpecName('redlock-quorum-2')).toBe(true)
  })
  it('大寫、底線、空白、斜線、首尾連字號、連續連字號 → 不合法', () => {
    for (const bad of ['Redlock', 'red_lock', 'red lock', 'a/b', '-a', 'a-', 'a--b', '']) {
      expect(isValidSpecName(bad), bad).toBe(false)
    }
  })
  it('超過 64 字元 → 不合法（會成為目錄名）', () => {
    expect(isValidSpecName('a'.repeat(64))).toBe(true)
    expect(isValidSpecName('a'.repeat(65))).toBe(false)
  })
})

describe('classifySpecSource', () => {
  it('`issue`（不分大小寫）→ issue 快照', () => {
    expect(classifySpecSource('issue')).toEqual({ kind: 'issue' })
    expect(classifySpecSource('Issue')).toEqual({ kind: 'issue' })
  })
  it('GitHub permalink（路徑含 40 位 commit SHA）→ 固定版本 URL', () => {
    const url =
      'https://github.com/o/r/blob/0123456789abcdef0123456789abcdef01234567/docs/spec.md'
    expect(classifySpecSource(url)).toEqual({ kind: 'url' })
  })
  it('路徑含版號段（v1.2.3 或 1.2）→ 固定版本 URL', () => {
    expect(classifySpecSource('https://example.com/spec/v1.2.3/index.html')).toEqual({ kind: 'url' })
    expect(classifySpecSource('https://example.com/docs/2.0/lock')).toEqual({ kind: 'url' })
  })
  it('浮動 URL（latest、無版本）→ 錯誤，並提示先存檔進 repo', () => {
    const r = classifySpecSource(
      'https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/',
    )
    expect(r.kind).toBe('url')
    expect(r.error).toMatch(/固定版本/)
  })
  it('http（非 https）→ 錯誤', () => {
    expect(classifySpecSource('http://example.com/v1.0/spec').error).toMatch(/https/)
  })
  it('其他 scheme 或無法解析的 URL → 錯誤', () => {
    expect(classifySpecSource('ftp://example.com/v1.0/spec').error).toBeDefined()
    expect(classifySpecSource('https://').error).toBeDefined()
  })
  it('repo 內相對路徑 → path', () => {
    expect(classifySpecSource('docs/specs/redlock.md')).toEqual({ kind: 'path' })
  })
  it('絕對路徑或含 `..` → 錯誤（不得指向 repo 外）', () => {
    expect(classifySpecSource('/etc/passwd').error).toBeDefined()
    expect(classifySpecSource('docs/../../secret.md').error).toBeDefined()
    expect(classifySpecSource('C:\\spec.md').error).toBeDefined()
  })
})

describe('reviewSpecIntake：必填', () => {
  it('兩欄位齊全且合法 → 無錯誤', () => {
    const r = reviewSpecIntake('redlock', 'docs/specs/redlock.md', KNOWN)
    expect(r.errors).toEqual([])
    expect(r.deferred).toEqual([])
    expect(r.sourceKind).toBe('path')
  })
  it('缺規格名稱／規格來源 → 各自一條錯誤（缺漏即不派工）', () => {
    const r = reviewSpecIntake(undefined, undefined, KNOWN)
    expect(r.errors).toHaveLength(2)
    expect(r.errors.join()).toMatch(/規格名稱/)
    expect(r.errors.join()).toMatch(/規格來源/)
  })
  it('規格名稱格式錯誤 → 錯誤', () => {
    expect(reviewSpecIntake('Red Lock', 'issue', KNOWN).errors.join()).toMatch(/kebab-case/)
  })
  it('規格來源格式錯誤 → 錯誤', () => {
    expect(reviewSpecIntake('redlock', '/abs/path.md', KNOWN).errors).toHaveLength(1)
  })
})

describe('reviewSpecIntake：repo 內路徑存在性（零網路）', () => {
  it('路徑不存在於 trunk → 錯誤', () => {
    const r = reviewSpecIntake('redlock', 'docs/missing.md', { ...KNOWN, fileExists: () => false })
    expect(r.errors.join()).toMatch(/不存在/)
  })
  it('無法檢查（未提供 fileExists）→ 延後到 dispatch，不當成錯誤', () => {
    const r = reviewSpecIntake('redlock', 'docs/a.md', { ...KNOWN, fileExists: undefined })
    expect(r.errors).toEqual([])
    expect(r.deferred.join()).toMatch(/存在性/)
  })
  it('來源是 issue 或 URL 時不查檔案', () => {
    let called = false
    const ctx = {
      ...KNOWN,
      fileExists: () => {
        called = true
        return false
      },
    }
    reviewSpecIntake('redlock', 'issue', ctx)
    reviewSpecIntake(
      'redlock',
      'https://github.com/o/r/blob/0123456789abcdef0123456789abcdef01234567/a.md',
      ctx,
    )
    expect(called).toBe(false)
  })
})

describe('reviewSpecIntake：使用門檻（H 規則 或 quint-spec 標註）', () => {
  it('命中 H 規則 → 通過（即使沒有 quint-spec 標註）', () => {
    const r = reviewSpecIntake('redlock', 'issue', { ...KNOWN, riskHits: 1, quintSpecAnnotated: false })
    expect(r.errors).toEqual([])
  })
  it('有 quint-spec 標註 → 通過（即使沒命中 H 規則）', () => {
    const r = reviewSpecIntake('redlock', 'issue', { ...KNOWN, riskHits: 0, quintSpecAnnotated: true })
    expect(r.errors).toEqual([])
  })
  it('兩者皆否 → 錯誤（非高風險模組不得使用 write-spec）', () => {
    const r = reviewSpecIntake('redlock', 'issue', { ...KNOWN, riskHits: 0, quintSpecAnnotated: false })
    expect(r.errors.join()).toMatch(/高風險/)
  })
  it('沒命中 H 規則且標註未知 → 延後，不當成錯誤', () => {
    const r = reviewSpecIntake('redlock', 'issue', { ...KNOWN, riskHits: 0, quintSpecAnnotated: undefined })
    expect(r.errors).toEqual([])
    expect(r.deferred.join()).toMatch(/門檻/)
  })
  it('H 規則未知且沒有標註 → 延後', () => {
    const r = reviewSpecIntake('redlock', 'issue', {
      ...KNOWN,
      riskHits: undefined,
      quintSpecAnnotated: false,
    })
    expect(r.errors).toEqual([])
    expect(r.deferred.join()).toMatch(/門檻/)
  })
})

describe('loadQuintSpecAnnotated', () => {
  const write = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'))
    const p = join(dir, 'catalog-info.yaml')
    writeFileSync(p, content)
    return p
  }
  it('有非空的 factory.io/quint-spec → true', () => {
    const p = write('metadata:\n  annotations:\n    factory.io/quint-spec: specs/\n')
    expect(loadQuintSpecAnnotated(p)).toBe(true)
  })
  it('沒有標註、空字串、或沒有 metadata → false', () => {
    expect(loadQuintSpecAnnotated(write('metadata:\n  annotations:\n    a: b\n'))).toBe(false)
    expect(
      loadQuintSpecAnnotated(write('metadata:\n  annotations:\n    factory.io/quint-spec: ""\n')),
    ).toBe(false)
    expect(loadQuintSpecAnnotated(write('kind: Component\n'))).toBe(false)
  })
  it('檔案不存在或不是合法 YAML → false（fail-closed：無法確認就不算標註）', () => {
    expect(loadQuintSpecAnnotated('/nonexistent/catalog-info.yaml')).toBe(false)
    expect(loadQuintSpecAnnotated(write('metadata: [unclosed\n'))).toBe(false)
  })
})
