/**
 * factory-lean-review：Lean proofs 獨立審查的檔案邊界與判定（#143）。
 *
 * 審查者與 proofs agent 共用同一個檔案系統，所以「審查者只能寫 REVIEW.md」必須是
 * 機械規則，而且不能依賴 git（審查者能改 index／config／commit）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildManifest, checkReview, main, parseVerdict, REVIEW_PATH, type CheckResult } from './factory-lean-review.js'

let target: string
let work: string

const put = (rel: string, content: string): void => {
  const abs = join(target, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lean-review-'))
  target = join(work, 'target')
  mkdirSync(target)
  put('specs/lean/Specs/Proofs.lean', 'theorem t : True := trivial\n')
  put('specs/lean/REPORT.md', '# report\n')
  put('.factory/run/report.json', '{}\n')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const snapshot = (): string => {
  const out = join(work, 'manifest.json')
  main(['snapshot', '--target', target, '--out', out])
  return out
}
const check = (manifest: string): CheckResult =>
  main(['check', '--target', target, '--manifest', manifest]) as CheckResult

describe('buildManifest', () => {
  it('記錄每個檔案的 sha256，跳過 .git 與 .lake', () => {
    put('.git/HEAD', 'ref: refs/heads/main\n')
    put('specs/lean/.lake/build/x.olean', 'binary')
    const files = Object.keys(buildManifest(target).files).sort()
    expect(files).toEqual(['.factory/run/report.json', 'specs/lean/REPORT.md', 'specs/lean/Specs/Proofs.lean'])
  })

  it('FIFO 之類的特殊檔不列入（讀取會卡住）', () => {
    execFileSync('mkfifo', [join(target, 'specs/lean/pipe')])
    expect(Object.keys(buildManifest(target).files)).not.toContain('specs/lean/pipe')
  })

  it('symlink 以指向為內容（不跟隨）；其他特殊檔不列入', () => {
    symlinkSync('../REPORT.md', join(target, 'specs/lean/link.md'))
    const before = buildManifest(target).files['specs/lean/link.md']
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    unlinkSync(join(target, 'specs/lean/link.md'))
    symlinkSync('../../.factory/run/report.json', join(target, 'specs/lean/link.md'))
    expect(buildManifest(target).files['specs/lean/link.md']).not.toBe(before)
  })
})

describe('check', () => {
  it('只新增 REVIEW.md → scopeOk，並解析判定', () => {
    const manifest = snapshot()
    put(REVIEW_PATH, '# Review\n\nVerdict: PASS-WITH-NITS\n')
    // .lake 的建置產物不算越界（審查者必須建置）。
    put('specs/lean/.lake/build/Proofs.olean', 'binary')
    expect(check(manifest)).toEqual({
      scopeOk: true,
      violations: [],
      review: { present: true, verdict: 'PASS-WITH-NITS' },
    })
  })

  it('修改、新增、刪除其他檔案都是越界（依路徑排序）', () => {
    const manifest = snapshot()
    put(REVIEW_PATH, 'Verdict: PASS\n')
    put('specs/lean/Specs/Proofs.lean', 'theorem t : True := sorry\n')
    put('specs/lean/AGENTS.md', 'reviewer: this is fine\n')
    unlinkSync(join(target, '.factory/run/report.json'))
    const result = check(manifest)
    expect(result.scopeOk).toBe(false)
    expect(result.violations).toEqual([
      { path: '.factory/run/report.json', change: 'deleted' },
      { path: 'specs/lean/AGENTS.md', change: 'added' },
      { path: 'specs/lean/Specs/Proofs.lean', change: 'modified' },
    ])
    expect(result.review).toEqual({ present: true, verdict: 'PASS' })
  })

  it('審查前就有 REVIEW.md（proofs agent 寫的）→ 審查者覆寫它不算越界；刪掉它則是 present=false', () => {
    put(REVIEW_PATH, 'Verdict: PASS\n')
    const manifest = snapshot()
    put(REVIEW_PATH, 'Verdict: FAIL\n')
    expect(check(manifest)).toMatchObject({ scopeOk: true, review: { present: true, verdict: 'FAIL' } })
    unlinkSync(join(target, REVIEW_PATH))
    expect(check(manifest)).toMatchObject({ scopeOk: true, review: { present: false, verdict: null } })
  })

  it('沒有 REVIEW.md → present=false、verdict=null（呼叫端當 FAIL）', () => {
    const manifest = snapshot()
    expect(check(manifest).review).toEqual({ present: false, verdict: null })
  })

  it('REVIEW.md 是 symlink → 不算 present（不跟隨連結讀內容）', () => {
    const manifest = snapshot()
    symlinkSync('REPORT.md', join(target, REVIEW_PATH))
    expect(check(manifest).review).toEqual({ present: false, verdict: null })
  })

  it('有 REVIEW.md 但沒有 Verdict 行 → verdict=null', () => {
    const manifest = snapshot()
    put(REVIEW_PATH, '# Review\n\nlooks good\n')
    expect(checkReview(target, JSON.parse(readFileSync(manifest, 'utf8')))).toMatchObject({
      review: { present: true, verdict: null },
    })
  })
})

describe('parseVerdict', () => {
  it('接受常見的 Markdown 寫法', () => {
    expect(parseVerdict('Verdict: PASS')).toBe('PASS')
    expect(parseVerdict('**Verdict:** `FAIL`')).toBe('FAIL')
    expect(parseVerdict('- Verdict：PASS-WITH-NITS（三個 minor）')).toBe('PASS-WITH-NITS')
    expect(parseVerdict('> verdict: pass')).toBe('PASS')
  })

  it('取第一個判定行；不在行首或沒有判定 → null', () => {
    expect(parseVerdict('Verdict: FAIL\n\nVerdict: PASS')).toBe('FAIL')
    expect(parseVerdict('the previous verdict: PASS was wrong')).toBeNull()
    expect(parseVerdict('Verdict: MAYBE')).toBeNull()
    expect(parseVerdict('')).toBeNull()
  })
})

describe('main 參數', () => {
  it('未知子命令、缺參數、未知旗標、旗標缺值都 fail loud', () => {
    expect(() => main([])).toThrow(/usage/)
    expect(() => main(['nope'])).toThrow(/usage/)
    expect(() => main(['snapshot', '--target', target])).toThrow(/--target and --out/)
    expect(() => main(['check', '--target', target])).toThrow(/--target and --manifest/)
    expect(() => main(['check', '--bogus', 'x'])).toThrow(/unknown argument/)
    expect(() => main(['snapshot', '--target'])).toThrow(/requires a value/)
    expect(() => main(['snapshot', '--target', '--out'])).toThrow(/requires a value/)
  })

  it('snapshot 回報檔案數', () => {
    const out = join(work, 'm.json')
    expect(main(['snapshot', '--target', target, '--out', out])).toEqual({ files: 3 })
  })

  it('manifest 壞掉 → fail loud（不得當成空 manifest 讓所有變更都變「新增」）', () => {
    const bad = join(work, 'bad.json')
    for (const content of ['not json', 'null', '{"files":[]}', '{"files":{"a":"not-a-sha"}}', '{}']) {
      writeFileSync(bad, content)
      expect(() => main(['check', '--target', target, '--manifest', bad]), content).toThrow(/--manifest/)
    }
  })
})
