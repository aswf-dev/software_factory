/**
 * factory-crosscheck 單元測試（src/cli/** 100% branch 閘門）。
 *
 * 涵蓋：git 輸出解析（for-each-ref / diff --name-only / --shortstat / --porcelain）、
 * report 與實際 diff 的雙向比較、參數解析、以及 main 的編排（fake git runner）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  collectActualDiff,
  collectReportedPaths,
  compareReportToActual,
  isFactoryInternal,
  main,
  normalizePath,
  parseArgs,
  parseDiffNameOnly,
  parseForEachRefOutput,
  parseShortStat,
  parseStatusPorcelain,
  type CrosscheckActual,
  type GitRunner,
} from './factory-crosscheck.js'
/** fake git runner：依命令回傳腳本值；未預期的呼叫會 throw（抓到接線錯誤）。 */
function fakeGit(script: {
  branches?: string
  diffNameOnly?: (branch: string) => string
  shortStat?: (branch: string) => string
  status?: string
}): GitRunner {
  return (args, cwd) => {
    const cmd = args[0]
    if (cmd === 'for-each-ref') return script.branches ?? ''
    if (cmd === 'diff') {
      const flag = args[1]
      const branch = (args[2] ?? '').split('...')[1] ?? ''
      return flag === '--name-only'
        ? (script.diffNameOnly?.(branch) ?? '')
        : (script.shortStat?.(branch) ?? '')
    }
    if (cmd === 'status') return script.status ?? ''
    throw new Error(`unexpected git call: ${args.join(' ')} (cwd=${cwd})`)
  }
}

function makeReport(partial: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issueNumber: 12,
    invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
    changedPaths: ['src/a.ts'],
    changedLines: 30,
    requirements: [{ id: 'R1', status: 'passed' }],
    ...partial,
  })
}

describe('git 輸出解析', () => {
  it('parseForEachRefOutput：切行、trim、去空行', () => {
    expect(parseForEachRefOutput('factory/12-01-test\n factory/12-02-impl \n\n')).toEqual([
      'factory/12-01-test',
      'factory/12-02-impl',
    ])
    expect(parseForEachRefOutput('')).toEqual([])
  })

  it('parseDiffNameOnly：切行、去空行', () => {
    expect(parseDiffNameOnly('src/a.ts\nsrc/b.ts\n\n')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parseDiffNameOnly('')).toEqual([])
  })

  it('parseShortStat：完整、只有 insertions、只有 deletions、空', () => {
    expect(parseShortStat(' 2 files changed, 30 insertions(+), 5 deletions(-)')).toEqual({
      added: 30,
      deleted: 5,
    })
    expect(parseShortStat(' 1 file changed, 10 insertions(+)')).toEqual({ added: 10, deleted: 0 })
    expect(parseShortStat(' 1 file changed, 2 deletions(-)')).toEqual({ added: 0, deleted: 2 })
    expect(parseShortStat(' 1 file changed')).toEqual({ added: 0, deleted: 0 })
    expect(parseShortStat('')).toEqual({ added: 0, deleted: 0 })
  })

  it('parseStatusPorcelain：取最後欄位、跳過空行', () => {
    expect(parseStatusPorcelain(' M src/a.ts\n?? new.txt\n R  old.txt -> new2.txt\n\n')).toEqual([
      'src/a.ts',
      'new.txt',
      'new2.txt',
    ])
    expect(parseStatusPorcelain('')).toEqual([])
  })
})

describe('路徑處理', () => {
  it('normalizePath 去空白與開頭 ./', () => {
    expect(normalizePath('  ./src/a.ts ')).toBe('src/a.ts')
    expect(normalizePath('src/b.ts')).toBe('src/b.ts')
  })

  it('isFactoryInternal 只認 .factory/ 前綴', () => {
    expect(isFactoryInternal('.factory/run/report.json')).toBe(true)
    expect(isFactoryInternal('src/a.ts')).toBe(false)
  })

  it('collectReportedPaths：undefined→[]、排除 .factory/、去空白路徑', () => {
    expect(collectReportedPaths(undefined)).toEqual([])
    expect(
      collectReportedPaths(['src/a.ts', './.factory/run/report.json', '  ', 'src/b.ts']),
    ).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('compareReportToActual', () => {
  const emptyActual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: [] }

  it('完全一致 → 無 mismatch', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 20,
      deleted: 10,
      uncommitted: [],
    }
    expect(
      compareReportToActual(
        {
          changedPaths: ['src/a.ts'],
          changedLines: 30,
          requirements: [{ id: 'R1', status: 'passed' }],
        },
        actual,
      ),
    ).toEqual([])
  })

  it('analyze-only + 純 docs 報告 → 無 analyze-code-change', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['docs/research/12-impact.md'],
      added: 40,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual(
      { changedPaths: ['docs/research/12-impact.md'], changedLines: 40, requirements: [{ id: 'R1', status: 'passed' }] },
      actual,
      true,
    )
    expect(m.some((x) => x.kind === 'analyze-code-change')).toBe(false)
  })

  it('analyze-only + src/ 變更 → analyze-code-change（僅分析不實作）', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts', 'docs/research/12-impact.md'],
      added: 20,
      deleted: 5,
      uncommitted: [],
    }
    const m = compareReportToActual({ changedPaths: ['src/a.ts', 'docs/research/12-impact.md'], changedLines: 25 }, actual, true)
    expect(m.some((x) => x.kind === 'analyze-code-change')).toBe(true)
  })

  it('非 analyze-only（預設）→ 不做 docs 限制', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 20,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual({ changedPaths: ['src/a.ts'], changedLines: 20 }, actual, false)
    expect(m.some((x) => x.kind === 'analyze-code-change')).toBe(false)
  })

  it('宣稱變更但無分支、無 diff、無未提交 → no-trace（假完成）', () => {
    const m = compareReportToActual({ changedPaths: ['src/a.ts'], changedLines: 30 }, emptyActual)
    expect(m.some((x) => x.kind === 'no-trace')).toBe(true)
  })

  it('有分支但 diff 為空 → 不觸發 no-trace，改觸發 reported-not-in-diff', () => {
    const actual: CrosscheckActual = { branches: ['factory/12-01-test'], paths: [], added: 0, deleted: 0, uncommitted: [] }
    const m = compareReportToActual({ changedPaths: ['src/a.ts'], changedLines: 30 }, actual)
    expect(m.some((x) => x.kind === 'no-trace')).toBe(false)
    expect(m.some((x) => x.kind === 'reported-not-in-diff')).toBe(true)
  })

  it('diff 有檔案但 report 未回報 → unreported-changes', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 5,
      deleted: 1,
      uncommitted: [],
    }
    const m = compareReportToActual({ changedLines: 6 }, actual)
    expect(m.some((x) => x.kind === 'unreported-changes')).toBe(true)
  })

  it('雙向差異都抓：回報了不存在的檔 + 漏報存在的檔', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts', 'src/hidden.ts'],
      added: 10,
      deleted: 2,
      uncommitted: [],
    }
    const m = compareReportToActual({ changedPaths: ['src/a.ts', 'src/ghost.ts'], changedLines: 12 }, actual)
    expect(m.some((x) => x.kind === 'reported-not-in-diff')).toBe(true)
    expect(m.some((x) => x.kind === 'diff-not-reported')).toBe(true)
  })

  it('diff 非空但 changedLines 缺席 → lines-missing', () => {
    const actual: CrosscheckActual = { branches: ['factory/12-01-test'], paths: ['src/a.ts'], added: 5, deleted: 0, uncommitted: [] }
    expect(
      compareReportToActual({ changedPaths: ['src/a.ts'] }, actual).some((x) => x.kind === 'lines-missing'),
    ).toBe(true)
  })

  it('diff 非空但 changedLines = 0 → lines-missing', () => {
    const actual: CrosscheckActual = { branches: ['factory/12-01-test'], paths: ['src/a.ts'], added: 5, deleted: 0, uncommitted: [] }
    expect(
      compareReportToActual({ changedPaths: ['src/a.ts'], changedLines: 0 }, actual).some(
        (x) => x.kind === 'lines-missing',
      ),
    ).toBe(true)
  })

  it('diff 為空但宣稱有行數 → lines-without-diff；changedLines 缺席或 0 時不誤報', () => {
    const m = compareReportToActual({ changedPaths: [], changedLines: 40 }, emptyActual)
    expect(m.some((x) => x.kind === 'lines-without-diff')).toBe(true)
    // changedLines 缺席 → 條件短路，不觸發 lines-without-diff
    expect(compareReportToActual({ changedPaths: [] }, emptyActual).some((x) => x.kind === 'lines-without-diff')).toBe(false)
    // changedLines = 0 → `> 0` 為 false，不觸發
    expect(compareReportToActual({ changedPaths: [], changedLines: 0 }, emptyActual).some((x) => x.kind === 'lines-without-diff')).toBe(false)
  })

  it('宣稱變更但工作樹有未提交變更 → 不觸發 no-trace，改觸發 uncommitted-changes', () => {
    // 第一個 no-trace 條件的第四個 conjunct（uncommitted.length === 0）在此為 false
    const actual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: ['src/dirty.ts'] }
    const m = compareReportToActual({ changedPaths: ['src/dirty.ts'], changedLines: 5 }, actual)
    expect(m.some((x) => x.kind === 'no-trace')).toBe(false)
    expect(m.some((x) => x.kind === 'uncommitted-changes')).toBe(true)
  })

  it('工作樹有未提交變更 → uncommitted-changes（未宣稱變更時也抓）', () => {
    const actual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: ['src/dirty.ts'] }
    const m = compareReportToActual({ changedPaths: [], changedLines: 0 }, actual)
    expect(m.some((x) => x.kind === 'uncommitted-changes')).toBe(true)
  })

  it('.factory/** 在兩側都被排除，不造成誤報', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['.factory/run/report.json'],
      added: 0,
      deleted: 0,
      uncommitted: [],
    }
    // report 只含 .factory 內部檔 → 排除後視為未宣稱變更；actual 也被排除 → 一致
    expect(compareReportToActual({ changedPaths: ['.factory/run/report.json'], changedLines: 0 }, actual)).toEqual([])
  })
})

describe('compareReportToActual — requirements 驗證（G8）', () => {
  // G8（docs/18 §4、docs/20 B1）：report 的 requirements[{id,status}] 是「驗收條件→
  // 測試/實作→status」的證據槽。crosscheck 必須對「有實質變更卻未回報 requirements」與
  // 「條目 id/status 不完備」fail-loud——這份欄位是 agent 自報，隻字未報等同靜默缺漏。

  it('有實質變更但 requirements 缺席 → requirements-missing', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 5,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual(
      { changedPaths: ['src/a.ts'], changedLines: 5, requirements: undefined },
      actual,
    )
    expect(m.some((x) => x.kind === 'requirements-missing')).toBe(true)
  })

  it('有實質變更但 requirements 為空陣列 → requirements-missing', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 5,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual(
      { changedPaths: ['src/a.ts'], changedLines: 5, requirements: [] },
      actual,
    )
    expect(m.some((x) => x.kind === 'requirements-missing')).toBe(true)
  })

  it('條目缺少 id → requirements-incomplete', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 5,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual(
      {
        changedPaths: ['src/a.ts'],
        changedLines: 5,
        requirements: [{ id: '', status: 'passed' }],
      },
      actual,
    )
    expect(m.some((x) => x.kind === 'requirements-incomplete')).toBe(true)
  })

  it('條目缺少 status → requirements-incomplete', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 5,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual(
      {
        changedPaths: ['src/a.ts'],
        changedLines: 5,
        requirements: [{ id: 'R1', status: '' as 'passed' }],
      },
      actual,
    )
    expect(m.some((x) => x.kind === 'requirements-incomplete')).toBe(true)
  })

  it('requirements 齊全 → 不觸發 requirements-missing / requirements-incomplete', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 5,
      deleted: 0,
      uncommitted: [],
    }
    const m = compareReportToActual(
      {
        changedPaths: ['src/a.ts'],
        changedLines: 5,
        requirements: [
          { id: 'R1', status: 'passed' },
          { id: 'R2', status: 'failed' },
          { id: 'R3', status: 'skipped' },
        ],
      },
      actual,
    )
    expect(m.filter((x) => x.kind === 'requirements-missing' || x.kind === 'requirements-incomplete')).toEqual([])
  })

  it('無變更（diff 為空）時 requirements 缺席 → 不誤報 requirements-missing', () => {
    const actual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: [] }
    const m = compareReportToActual({ changedPaths: [], changedLines: 0, requirements: undefined }, actual)
    expect(m.some((x) => x.kind === 'requirements-missing')).toBe(false)
  })
})

describe('collectActualDiff', () => {
  it('無分支 → 空事實；有分支 → union 去重、行數累加、未提交解析', () => {
    const git = fakeGit({
      branches: 'factory/12-01-test\nfactory/12-02-impl\n',
      diffNameOnly: (b) => (b === 'factory/12-01-test' ? 'src/a.ts\nsrc/b.ts\n' : 'src/b.ts\nsrc/c.ts\n'),
      shortStat: (b) => (b === 'factory/12-01-test' ? ' 2 files changed, 10 insertions(+), 3 deletions(-)' : ' 1 file changed, 4 insertions(+)'),
      status: ' M src/dirty.ts\n',
    })
    const actual = collectActualDiff(git, { issueNumber: 12, base: 'software-factory', target: 'target' })
    expect(actual.branches).toEqual(['factory/12-01-test', 'factory/12-02-impl'])
    expect(actual.paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(actual.added).toBe(14)
    expect(actual.deleted).toBe(3)
    expect(actual.uncommitted).toEqual(['src/dirty.ts'])
  })

  it('不存在的分支 → 空清單', () => {
    const actual = collectActualDiff(fakeGit({}), { issueNumber: 99, base: 'b', target: 't' })
    expect(actual.branches).toEqual([])
    expect(actual.paths).toEqual([])
    expect(actual.added).toBe(0)
    expect(actual.deleted).toBe(0)
  })
})

describe('parseArgs', () => {
  it('預設值：base=software-factory、target=target、analyzeOnly=false', () => {
    expect(parseArgs(['12', 'report.json'])).toEqual({
      issueNumber: 12,
      reportPath: 'report.json',
      paths: { base: 'software-factory', target: 'target' },
      analyzeOnly: false,
    })
  })

  it('--base / --target 覆寫', () => {
    expect(parseArgs(['12', 'r.json', '--base', 'main', '--target', 't2'])).toEqual({
      issueNumber: 12,
      reportPath: 'r.json',
      paths: { base: 'main', target: 't2' },
      analyzeOnly: false,
    })
  })

  it('--analyze-only 旗標', () => {
    expect(parseArgs(['12', 'r.json', '--analyze-only']).analyzeOnly).toBe(true)
  })

  it('參數錯誤 → CliError', () => {
    expect(() => parseArgs([])).toThrow(CliError)
    expect(() => parseArgs(['abc', 'r.json'])).toThrow(CliError)
    expect(() => parseArgs(['12'])).toThrow(CliError)
    expect(() => parseArgs(['12', 'r.json', '--base'])).toThrow(CliError)
    expect(() => parseArgs(['12', 'r.json', '--base', '--target'])).toThrow(CliError)
    expect(() => parseArgs(['12', 'r.json', '--target'])).toThrow(CliError)
    expect(() => parseArgs(['12', 'r.json', '--bogus'])).toThrow(CliError)
  })
})

describe('main（fake git runner）', () => {
  let dir: string
  let reportPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-crosscheck-'))
    reportPath = join(dir, 'report.json')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('report 與 git 一致 → ok=true', () => {
    writeFileSync(reportPath, makeReport())
    const out = main(['12', reportPath, '--target', 'target'], fakeGit({ branches: 'factory/12-01-test\n', diffNameOnly: () => 'src/a.ts\n', shortStat: () => ' 1 file changed, 30 insertions(+)' }))
    expect(out.ok).toBe(true)
    expect(out.issueNumber).toBe(12)
    expect(out.mismatches).toEqual([])
    expect(out.actual.paths).toEqual(['src/a.ts'])
  })

  it('report 宣稱變更但 git 無任何痕跡 → ok=false 且含 no-trace', () => {
    writeFileSync(reportPath, makeReport())
    const out = main(['12', reportPath, '--target', 'target'], fakeGit({}))
    expect(out.ok).toBe(false)
    expect(out.mismatches.some((m) => m.kind === 'no-trace')).toBe(true)
  })

  it('report 不存在 → 拋錯（CLI 邊界由 formatCliError 轉成 file not found 單行）', () => {
    expect(() => main(['12', join(dir, 'missing.json')], fakeGit({}))).toThrow(/ENOENT|no such file/)
  })

  it('report 是無效 JSON → CliError', () => {
    writeFileSync(reportPath, '{not json')
    expect(() => main(['12', reportPath], fakeGit({}))).toThrow()
  })

  it('report 缺必填欄位 → CliError', () => {
    writeFileSync(reportPath, JSON.stringify({ invocation: {} }))
    expect(() => main(['12', reportPath], fakeGit({}))).toThrow(CliError)
  })

  it('report 根層級型別錯（非物件）→ CliError 且錯誤路徑為 (root)', () => {
    writeFileSync(reportPath, JSON.stringify('not-an-object'))
    expect(() => main(['12', reportPath], fakeGit({}))).toThrow(/\(root\)/)
  })

  it('fake git 收到 target cwd（編排正確性）', () => {
    let sawCwd: string | undefined
    writeFileSync(reportPath, makeReport())
    const git: GitRunner = (args, cwd) => {
      sawCwd = cwd
      return ''
    }
    main(['12', reportPath, '--target', 'target'], git)
    expect(sawCwd).toBe('target')
  })
})
