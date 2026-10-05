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
  adviseAssertionDelta,
  collectActualDiff,
  collectReportedPaths,
  compareReportToActual,
  compareRequirementIds,
  detectUnreportedTrigger,
  isFactoryInternal,
  main,
  normalizePath,
  parseArgs,
  parseDiffNameOnly,
  parseForEachRefOutput,
  parseShortStat,
  parseStatusPorcelain,
  collectDeletedPaths,
  type CrosscheckActual,
  type GitRunner,
} from './factory-crosscheck.js'
/** fake git runner：依命令回傳腳本值；未預期的呼叫會 throw（抓到接線錯誤）。 */
function fakeGit(script: {
  branches?: string
  diffNameOnly?: (branch: string) => string
  shortStat?: (branch: string) => string
  unifiedDiff?: (branch: string) => string
  status?: string
  /** `git diff --name-only --no-renames --diff-filter=D`（pbt-audit 的刪除偵測）。 */
  deletedNameOnly?: (branch: string) => string
  /** `git show <branch>:<path>`；回傳 undefined 代表該分支沒有此檔（真實 git 會非零結束）。 */
  show?: (ref: string) => string | undefined
}): GitRunner {
  return (args, cwd) => {
    const cmd = args[0]
    if (cmd === 'for-each-ref') return script.branches ?? ''
    if (cmd === 'diff' && args.includes('--diff-filter=D')) {
      // 刪除偵測必須關掉 rename 偵測，否則「改名成 PBT 檔」能藏住刪除
      if (!args.includes('--no-renames')) throw new Error('deleted-path diff must pass --no-renames')
      const branch = (args[args.length - 1] ?? '').split('...')[1] ?? ''
      return script.deletedNameOnly?.(branch) ?? ''
    }
    if (cmd === 'diff') {
      const flag = args[1]
      const branch = (args[2] ?? '').split('...')[1] ?? ''
      // 逐一列舉而非 else 兜底：兜底會讓「用錯旗標」的接線錯誤靜靜拿到另一個
      // 命令的輸出（--unified=0 曾因此收到 --shortstat 的字串仍然通過）。
      if (flag === '--name-only') return script.diffNameOnly?.(branch) ?? ''
      if (flag === '--shortstat') return script.shortStat?.(branch) ?? ''
      if (flag === '--unified=0') return script.unifiedDiff?.(branch) ?? ''
      throw new Error(`unexpected git diff flag: ${flag}`)
    }
    if (cmd === 'status') return script.status ?? ''
    if (cmd === 'show' && script.show !== undefined) {
      const content = script.show(args[1] ?? '')
      if (content === undefined) throw new Error(`fatal: path does not exist in '${args[1]}'`)
      return content
    }
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
  const emptyActual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: [], assertionDelta: 0 }

  it('完全一致 → 無 mismatch', () => {
    const actual: CrosscheckActual = {
      branches: ['factory/12-01-test'],
      paths: ['src/a.ts'],
      added: 20,
      deleted: 10,
      uncommitted: [],
      assertionDelta: 0,
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
      assertionDelta: 0,
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
      assertionDelta: 0,
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
      assertionDelta: 0,
    }
    const m = compareReportToActual({ changedPaths: ['src/a.ts'], changedLines: 20 }, actual, false)
    expect(m.some((x) => x.kind === 'analyze-code-change')).toBe(false)
  })

  // --- propose-skill-only（E6／ADR-016 §3 閘門 1：安全樞紐）---

  /** 建一個 propose-skill 情境的 actual（分支＋指定路徑）。 */
  function proposeActual(paths: string[]): CrosscheckActual {
    return { branches: ['factory/12-01-propose'], paths, added: 30, deleted: 0, uncommitted: [], assertionDelta: 0 }
  }

  it('propose-skill-only + 純 proposals/skills 變更 → 無 propose-skill-scope', () => {
    const paths = ['proposals/skills/monorepo-test-path/SKILL.md']
    const m = compareReportToActual(
      { changedPaths: paths, changedLines: 30, requirements: [{ id: 'R1', status: 'passed' }] },
      proposeActual(paths),
      false,
      true,
    )
    expect(m.some((x) => x.kind === 'propose-skill-scope')).toBe(false)
  })

  it('propose-skill-only + docs 併同變更 → 允許（可附說明文件）', () => {
    const paths = ['proposals/skills/x-y/SKILL.md', 'docs/25-skill-authoring-loop.md']
    const m = compareReportToActual(
      { changedPaths: paths, changedLines: 30, requirements: [{ id: 'R1', status: 'passed' }] },
      proposeActual(paths),
      false,
      true,
    )
    expect(m.some((x) => x.kind === 'propose-skill-scope')).toBe(false)
  })

  /**
   * 這是整個 ADR-016 的安全樞紐：若 agent 能寫進 .dsh/skills/，它就能自訂
   * 自己的行為準則並自我放行——docs/05 §1.1 的核心不變量當場失效。
   */
  it('propose-skill-only + .dsh/skills 變更 → propose-skill-scope（絕不可繞道生效）', () => {
    const paths = ['.dsh/skills/evil/SKILL.md']
    const m = compareReportToActual({ changedPaths: paths, changedLines: 30 }, proposeActual(paths), false, true)
    expect(m.some((x) => x.kind === 'propose-skill-scope')).toBe(true)
  })

  it('propose-skill-only + src/ 或 .github/ 變更 → propose-skill-scope', () => {
    for (const bad of ['src/cli/x.ts', '.github/workflows/factory-run.yml', 'catalog-info.yaml']) {
      const m = compareReportToActual(
        { changedPaths: [bad], changedLines: 10 },
        proposeActual([bad]),
        false,
        true,
      )
      expect(m.some((x) => x.kind === 'propose-skill-scope'), `${bad} 應被擋`).toBe(true)
    }
  })

  it('非 propose-skill-only（預設）→ 不做 proposals 限制', () => {
    const paths = ['src/a.ts']
    const m = compareReportToActual({ changedPaths: paths, changedLines: 20 }, proposeActual(paths))
    expect(m.some((x) => x.kind === 'propose-skill-scope')).toBe(false)
  })

  // --- onboard-only（納管分析：安全樞紐，賭注高於 ADR-016）---

  /** 建一個 onboard 情境的 actual（分支＋指定路徑）。 */
  function onboardActual(paths: string[]): CrosscheckActual {
    return { branches: ['factory/12-01-onboard'], paths, added: 40, deleted: 0, uncommitted: [], assertionDelta: 0 }
  }

  it('onboard-only + 純 proposals/onboarding 變更 → 無 onboard-scope', () => {
    const paths = ['proposals/onboarding/catalog-info.yaml', 'proposals/onboarding/risk-paths.yml']
    const m = compareReportToActual(
      { changedPaths: paths, changedLines: 40, requirements: [{ id: 'R1', status: 'passed' }] },
      onboardActual(paths),
      false,
      false,
      true,
    )
    expect(m.some((x) => x.kind === 'onboard-scope')).toBe(false)
  })

  it('onboard-only + docs 併同變更 → 允許（可附納管說明）', () => {
    const paths = ['proposals/onboarding/catalog-info.yaml', 'docs/16-rescore-multirepo.md']
    const m = compareReportToActual(
      { changedPaths: paths, changedLines: 40, requirements: [{ id: 'R1', status: 'passed' }] },
      onboardActual(paths),
      false,
      false,
      true,
    )
    expect(m.some((x) => x.kind === 'onboard-scope')).toBe(false)
  })

  /**
   * 納管情境的安全樞紐。這兩個路徑正是 agent 要分析並提出建議的**對象**，
   * 而納管當下**尚無任何人審過該 repo 的風險評級**——agent 若能直接寫入正位，
   * 等於自己宣告自己的監督等級，docs/05 §1.1 的核心不變量當場失效。
   *
   * 「有人類審 PR」不足以補償：審查者面對一份填好的 YAML，預設反應是按 merge，
   * 真正需要動腦的三軸裁定會被包裝成一個看起來已完成的東西
   * （docs/16 §5.3 的 factory-scoreboard 事故正是這個模式）。
   */
  it('onboard-only + 寫入 guardrail 正位 → onboard-scope（絕不可直接落檔）', () => {
    for (const bad of [
      'catalog-info.yaml',
      '.github/factory/risk-paths.yml',
      '.github/workflows/factory-run.yml',
      'CODEOWNERS',
      '.dsh/skills/evil/SKILL.md',
      'src/cli/factory-score.ts',
    ]) {
      const m = compareReportToActual(
        { changedPaths: [bad], changedLines: 10 },
        onboardActual([bad]),
        false,
        false,
        true,
      )
      expect(m.some((x) => x.kind === 'onboard-scope'), `${bad} 應被擋`).toBe(true)
    }
  })

  /**
   * proposals/skills/ 與 proposals/onboarding/ 是兩個不同型別的提案通道，
   * 不可互穿——否則 onboard 工作項可藉此產出技能提案，型別契約失效。
   */
  it('onboard-only + proposals/skills 變更 → onboard-scope（通道不可互穿）', () => {
    const paths = ['proposals/skills/x/SKILL.md']
    const m = compareReportToActual(
      { changedPaths: paths, changedLines: 10 },
      onboardActual(paths),
      false,
      false,
      true,
    )
    expect(m.some((x) => x.kind === 'onboard-scope')).toBe(true)
  })

  it('非 onboard-only（預設）→ 不做 onboarding 限制', () => {
    const paths = ['src/a.ts']
    const m = compareReportToActual({ changedPaths: paths, changedLines: 20 }, onboardActual(paths))
    expect(m.some((x) => x.kind === 'onboard-scope')).toBe(false)
  })

  it('宣稱變更但無分支、無 diff、無未提交 → no-trace（假完成）', () => {
    const m = compareReportToActual({ changedPaths: ['src/a.ts'], changedLines: 30 }, emptyActual)
    expect(m.some((x) => x.kind === 'no-trace')).toBe(true)
  })

  it('有分支但 diff 為空 → 不觸發 no-trace，改觸發 reported-not-in-diff', () => {
    const actual: CrosscheckActual = { branches: ['factory/12-01-test'], paths: [], added: 0, deleted: 0, uncommitted: [], assertionDelta: 0 }
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
      assertionDelta: 0,
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
      assertionDelta: 0,
    }
    const m = compareReportToActual({ changedPaths: ['src/a.ts', 'src/ghost.ts'], changedLines: 12 }, actual)
    expect(m.some((x) => x.kind === 'reported-not-in-diff')).toBe(true)
    expect(m.some((x) => x.kind === 'diff-not-reported')).toBe(true)
  })

  it('diff 非空但 changedLines 缺席 → lines-missing', () => {
    const actual: CrosscheckActual = { branches: ['factory/12-01-test'], paths: ['src/a.ts'], added: 5, deleted: 0, uncommitted: [], assertionDelta: 0 }
    expect(
      compareReportToActual({ changedPaths: ['src/a.ts'] }, actual).some((x) => x.kind === 'lines-missing'),
    ).toBe(true)
  })

  it('diff 非空但 changedLines = 0 → lines-missing', () => {
    const actual: CrosscheckActual = { branches: ['factory/12-01-test'], paths: ['src/a.ts'], added: 5, deleted: 0, uncommitted: [], assertionDelta: 0 }
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
    const actual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: ['src/dirty.ts'], assertionDelta: 0 }
    const m = compareReportToActual({ changedPaths: ['src/dirty.ts'], changedLines: 5 }, actual)
    expect(m.some((x) => x.kind === 'no-trace')).toBe(false)
    expect(m.some((x) => x.kind === 'uncommitted-changes')).toBe(true)
  })

  it('工作樹有未提交變更 → uncommitted-changes（未宣稱變更時也抓）', () => {
    const actual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: ['src/dirty.ts'], assertionDelta: 0 }
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
      assertionDelta: 0,
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
      assertionDelta: 0,
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
      assertionDelta: 0,
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
      assertionDelta: 0,
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
      assertionDelta: 0,
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
      assertionDelta: 0,
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
    const actual: CrosscheckActual = { branches: [], paths: [], added: 0, deleted: 0, uncommitted: [], assertionDelta: 0 }
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
    expect(actual.assertionDelta).toBe(0)
  })

  it('assertionDelta 取各分支最小值，不是總和', () => {
    // stacked PR：02-impl 相對 base 已包含 01-test 的變更。相加會把 01 的 +2
    // 與 02 的 -1 合成 +1，把真正的淨減少藏起來；取最小值才看得見。
    const git = fakeGit({
      branches: 'factory/12-01-test\nfactory/12-02-impl\n',
      diffNameOnly: () => 'src/a.test.ts\n',
      shortStat: () => ' 1 file changed, 1 insertion(+)',
      unifiedDiff: (b) =>
        [
          'diff --git a/src/a.test.ts b/src/a.test.ts',
          '--- a/src/a.test.ts',
          '+++ b/src/a.test.ts',
          '@@ -1 +1 @@',
          b === 'factory/12-01-test'
            ? '+  expect(a).toBe(1)\n+  expect(b).toBe(2)'
            : '+  expect(a).toBe(1)\n-  expect(c).toBe(3)\n-  expect(d).toBe(4)',
        ].join('\n'),
    })
    const actual = collectActualDiff(git, { issueNumber: 12, base: 'software-factory', target: 'target' })
    expect(actual.assertionDelta).toBe(-1)
  })
})

describe('assertionDelta 反向鎖（SR6 的輸入不再只有自報）', () => {
  const withDelta = (measured: number): CrosscheckActual => ({
    branches: ['factory/12-01-test'],
    paths: ['src/a.test.ts'],
    added: 5,
    deleted: 5,
    uncommitted: [],
    assertionDelta: measured,
  })
  const kinds = (ms: { kind: string }[]): string[] => ms.map((m) => m.kind)

  it('實算淨減少、report 未回報 → mismatch（漏填等於 SR6 從未存在）', () => {
    const out = compareReportToActual({ changedPaths: ['src/a.test.ts'] }, withDelta(-2))
    expect(kinds(out)).toContain('assertion-delta-understated')
    expect(out.find((m) => m.kind === 'assertion-delta-understated')?.detail).toMatch(/未回報/)
  })

  it('實算淨減少、report 回報 0 → mismatch（這是唯一能繞過 SR6 的路徑）', () => {
    const out = compareReportToActual(
      { changedPaths: ['src/a.test.ts'], assertionDelta: 0 },
      withDelta(-3),
    )
    expect(kinds(out)).toContain('assertion-delta-understated')
  })

  it('實算淨減少、report 也回報負數 → 無 mismatch（誠實回報，交給 SR6）', () => {
    const out = compareReportToActual(
      { changedPaths: ['src/a.test.ts'], assertionDelta: -1 },
      withDelta(-3),
    )
    expect(kinds(out)).not.toContain('assertion-delta-understated')
  })

  it('實算非負 → 無 mismatch，且數值差異不發話（避免假陽性）', () => {
    const out = compareReportToActual(
      { changedPaths: ['src/a.test.ts'], assertionDelta: 7 },
      withDelta(2),
    )
    expect(kinds(out)).not.toContain('assertion-delta-understated')
  })
})

describe('adviseAssertionDelta（安全方向，不擋 run）', () => {
  it('自報淨減少、實算非負 → advisory', () => {
    const out = adviseAssertionDelta(-2, 0)
    expect(out.map((a) => a.kind)).toEqual(['assertion-delta-overstated'])
  })

  it('實算為負 → 不重複發話（危險方向由 mismatch 處理）', () => {
    expect(adviseAssertionDelta(-2, -5)).toEqual([])
  })

  it('自報未填或非負 → 不發話', () => {
    expect(adviseAssertionDelta(undefined, 3)).toEqual([])
    expect(adviseAssertionDelta(0, 3)).toEqual([])
  })
})

describe('compareRequirementIds（REQ id 錨定，advisory）', () => {
  it('id 全部對應錨點且涵蓋完整 → 無 advisory', () => {
    const out = compareRequirementIds(
      [
        { id: 'REQ-1', status: 'passed' },
        { id: 'REQ-2', status: 'skipped' },
      ],
      ['REQ-1', 'REQ-2'],
    )
    expect(out).toEqual([])
  })

  /** 這正是 G8 目前漏掉的語意缺口：id 存在但不指向任何驗收條件。 */
  it('回報未知 id → requirements-unknown-id', () => {
    const out = compareRequirementIds([{ id: 'req-1', status: 'passed' }], ['REQ-1'])
    expect(out.map((m) => m.kind)).toContain('requirements-unknown-id')
  })

  it('錨點未被涵蓋 → requirements-uncovered', () => {
    const out = compareRequirementIds([{ id: 'REQ-1', status: 'passed' }], ['REQ-1', 'REQ-2'])
    expect(out.map((m) => m.kind)).toContain('requirements-uncovered')
    expect(out.find((m) => m.kind === 'requirements-uncovered')?.detail).toContain('REQ-2')
  })

  it('同時有未知 id 與未涵蓋 → 兩則都回報', () => {
    const out = compareRequirementIds([{ id: 'BOGUS', status: 'passed' }], ['REQ-1'])
    expect(out.map((m) => m.kind).sort()).toEqual(['requirements-uncovered', 'requirements-unknown-id'])
  })

  /**
   * 沒有錨點就沒有基準——對舊 Issue（未經新版 issue-check）不該指控。
   */
  it('錨點為空 → 完全不發話（無基準不指控，避免假陽性）', () => {
    expect(compareRequirementIds([{ id: 'anything', status: 'passed' }], [])).toEqual([])
  })

  it('report 未回報 requirements → 不發話（該情況由 G8 fail-loud 處理）', () => {
    expect(compareRequirementIds(undefined, ['REQ-1'])).toEqual([])
    expect(compareRequirementIds([], ['REQ-1'])).toEqual([])
  })
})

describe('parseArgs', () => {
  it('預設值：base=software-factory、target=target、三個僅產出模式皆 false', () => {
    expect(parseArgs(['12', 'report.json'])).toEqual({
      issueNumber: 12,
      reportPath: 'report.json',
      paths: { base: 'software-factory', target: 'target' },
      analyzeOnly: false,
      proposeSkillOnly: false,
      onboardOnly: false,
      pbtAuditOnly: false,
      requirementAnchors: [],
    })
  })

  it('--base / --target 覆寫', () => {
    expect(parseArgs(['12', 'r.json', '--base', 'main', '--target', 't2'])).toEqual({
      issueNumber: 12,
      reportPath: 'r.json',
      paths: { base: 'main', target: 't2' },
      analyzeOnly: false,
      proposeSkillOnly: false,
      onboardOnly: false,
      pbtAuditOnly: false,
      requirementAnchors: [],
    })
  })

  it('--propose-skill-only → proposeSkillOnly=true（E6）', () => {
    expect(parseArgs(['12', 'r.json', '--propose-skill-only']).proposeSkillOnly).toBe(true)
  })

  it('--onboard-only → onboardOnly=true（納管）', () => {
    expect(parseArgs(['12', 'r.json', '--onboard-only']).onboardOnly).toBe(true)
  })

  /**
   * 三個「僅產出」模式的允許清單互不相同，同時指定會讓實際生效的規則變得含糊。
   * 沿用既有立場：寧可紅燈，也不要讓寬鬆的那一套悄悄成為實際規則。
   */
  it('--onboard-only 與其他僅產出模式併用 → CliError（規則不可含糊）', () => {
    expect(() => parseArgs(['12', 'r.json', '--onboard-only', '--analyze-only'])).toThrow()
    expect(() => parseArgs(['12', 'r.json', '--onboard-only', '--propose-skill-only'])).toThrow()
  })

  it('--requirement-anchors 解析為 id 清單（去空白、濾空項）', () => {
    expect(parseArgs(['12', 'r.json', '--requirement-anchors', 'REQ-1, REQ-2 ,,REQ-3']).requirementAnchors).toEqual([
      'REQ-1',
      'REQ-2',
      'REQ-3',
    ])
  })

  it('--requirement-anchors 缺值 → CliError', () => {
    expect(() => parseArgs(['12', 'r.json', '--requirement-anchors'])).toThrow(/comma-separated/)
  })

  it('同時指定 --analyze-only 與 --propose-skill-only → CliError（允許清單不同，語意含糊）', () => {
    expect(() => parseArgs(['12', 'r.json', '--analyze-only', '--propose-skill-only'])).toThrow(
      /不可同時指定/,
    )
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

  /**
   * REQ 錨定第一階段是 advisory：即使 id 完全對不上，**ok 仍為 true、不擋 run**。
   * 這條釘死「advisory 不得升級為 gate」的設計決策——若有人把 advisories 併進
   * mismatches，本測試立刻變紅。
   */
  it('REQ id 對不上錨點 → advisories 有內容但 ok 仍為 true（不擋 run）', () => {
    writeFileSync(reportPath, makeReport())
    const git = fakeGit({
      branches: 'factory/12-01-test\n',
      diffNameOnly: () => 'src/a.ts\n',
      shortStat: () => ' 1 file changed, 30 insertions(+)',
    })
    const out = main(['12', reportPath, '--target', 'target', '--requirement-anchors', 'REQ-1,REQ-2'], git)
    expect(out.ok).toBe(true)
    expect(out.mismatches).toEqual([])
    expect(out.advisories.map((a) => a.kind).sort()).toEqual([
      'requirements-uncovered',
      'requirements-unknown-id',
    ])
  })

  it('未傳 --requirement-anchors → advisories 為空（向後相容）', () => {
    writeFileSync(reportPath, makeReport())
    const out = main(
      ['12', reportPath, '--target', 'target'],
      fakeGit({
        branches: 'factory/12-01-test\n',
        diffNameOnly: () => 'src/a.ts\n',
        shortStat: () => ' 1 file changed, 30 insertions(+)',
      }),
    )
    expect(out.advisories).toEqual([])
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

/**
 * 「該回報卻沒回報技能缺口」advisory（docs/25 §2.1）。
 *
 * 動機（2026-09-17 盤點）：`skillGap` 缺席有兩種含義——「確實沒有」與「遇到了
 * 但沒回報」——而資料上完全相同。實證：run 35098422118 以 crosscheck
 * `requirements-missing` 收場卻無 skillGap；run 34586354343 needs-human、
 * 零產出、亦無 skillGap。本組測試釘住 advisory 的觸發與**不觸發**邊界。
 */
describe('未回報技能缺口 advisory', () => {
  let dir: string
  let reportPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crosscheck-gap-'))
    reportPath = join(dir, 'report.json')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const GAP = { category: 'ci-sandbox-vitest-run', needed: 'x' }
  const cleanGit = fakeGit({
    branches: 'factory/12-01-test\n',
    diffNameOnly: () => 'src/a.ts\n',
    shortStat: () => ' 1 file changed, 30 insertions(+)',
  })
  /** 零產出：無分支、無 diff。 */
  const emptyGit = fakeGit({ branches: '' })
  const run = (report: string, git: GitRunner): ReturnType<typeof main> => {
    writeFileSync(reportPath, report)
    return main(['12', reportPath, '--target', 'target'], git)
  }
  const kinds = (out: ReturnType<typeof main>): string[] => out.advisories.map((a) => a.kind)

  it('一致且有產出、無缺口回報 → 不發話（乾淨 run 不該被打擾）', () => {
    const out = run(makeReport(), cleanGit)
    expect(out.ok).toBe(true)
    expect(kinds(out)).not.toContain('skill-gap-unreported')
  })

  it('crosscheck mismatch 且未回報 → 發 advisory（judge 在此情境不會執行）', () => {
    const out = run(makeReport({ changedPaths: ['src/ghost.ts'] }), cleanGit)
    expect(out.ok).toBe(false)
    expect(kinds(out)).toContain('skill-gap-unreported')
  })

  it('零產出且未回報 → 發 advisory（停手的代理訊號）', () => {
    const out = run(makeReport({ changedPaths: [], changedLines: 0 }), emptyGit)
    expect(out.ok).toBe(true)
    expect(kinds(out)).toContain('skill-gap-unreported')
  })

  it('零產出但已回報缺口 → 不發話（agent 已盡責）', () => {
    const out = run(makeReport({ changedPaths: [], changedLines: 0, skillGap: GAP }), emptyGit)
    expect(kinds(out)).not.toContain('skill-gap-unreported')
  })

  /**
   * `skillGap: null` 與缺席同義（ReportSchema 的 nullish transform）。若這裡把
   * null 當成「已回報」，claude-sonnet-5 那種明寫 null 的 run（34456925126）
   * 就會靜默豁免，advisory 形同虛設。
   */
  it('skillGap 為 null → 仍視為未回報', () => {
    const out = run(makeReport({ changedPaths: [], changedLines: 0, skillGap: null }), emptyGit)
    expect(kinds(out)).toContain('skill-gap-unreported')
  })

  /** advisory 絕不影響 ok：零產出情境下 ok 必須維持 true。 */
  it('advisory 不改變 ok（第一階段觀察期，不擋 run）', () => {
    const out = run(makeReport({ changedPaths: [], changedLines: 0 }), emptyGit)
    expect(out.advisories.length).toBeGreaterThan(0)
    expect(out.ok).toBe(true)
    expect(out.mismatches).toEqual([])
  })
})

describe('detectUnreportedTrigger（觸發優先序）', () => {
  const actual = (paths: string[]): CrosscheckActual => ({
    branches: [],
    paths,
    added: 0,
    deleted: 0,
    uncommitted: [],
    assertionDelta: 0,
  })

  it('有 mismatch → crosscheck-mismatch 優先於零產出', () => {
    expect(
      detectUnreportedTrigger({ changedPaths: [] }, actual([]), [{ kind: 'k', detail: 'd' }]),
    ).toBe('crosscheck-mismatch')
  })

  it('無 mismatch 且雙方皆無變更 → no-output', () => {
    expect(detectUnreportedTrigger({ changedPaths: [] }, actual([]), [])).toBe('no-output')
  })

  it('report 宣告無變更但實際有 diff → 不觸發（那是 mismatch 的職責）', () => {
    expect(detectUnreportedTrigger({ changedPaths: [] }, actual(['src/a.ts']), [])).toBeNull()
  })

  it('report 有變更 → 不觸發', () => {
    expect(detectUnreportedTrigger({ changedPaths: ['src/a.ts'] }, actual([]), [])).toBeNull()
  })

  /** .factory/ 內部檔不算產出——否則每次 run 都因為 run 目錄而不被視為零產出。 */
  it('實際 diff 只有 .factory/ 內部檔 → 仍視為零產出', () => {
    expect(detectUnreportedTrigger({ changedPaths: [] }, actual(['.factory/run/report.json']), [])).toBe('no-output')
  })
})

/* ── agent-write-spec 模式（ADR-018 §9 護欄①、§12）──────────────────────── */

describe('parseArgs：write-spec 旗標', () => {
  const base = ['12', 'r.json']
  it('完整的不變量階段旗標 → 解析出 writeSpec', () => {
    const a = parseArgs([
      ...base,
      '--write-spec-phase', 'invariants',
      '--spec-name', 'redlock',
      '--source-snapshot', 's.md',
      '--pr-bodies', 'p.json',
    ])
    expect(a.writeSpec).toEqual({
      phase: 'invariants',
      specName: 'redlock',
      sourceSnapshotPath: 's.md',
      prBodiesPath: 'p.json',
    })
  })
  it('模型階段不需要 --source-snapshot', () => {
    const a = parseArgs([...base, '--write-spec-phase', 'model', '--spec-name', 'redlock', '--pr-bodies', 'p.json'])
    expect(a.writeSpec?.sourceSnapshotPath).toBeUndefined()
  })
  it('未指定階段 → writeSpec 為 undefined', () => {
    expect(parseArgs(base).writeSpec).toBeUndefined()
  })
  it('階段值不合法 → CliError', () => {
    expect(() => parseArgs([...base, '--write-spec-phase', 'draft', '--spec-name', 'a', '--pr-bodies', 'p'])).toThrow(CliError)
  })
  it('缺 --spec-name、--pr-bodies，或不變量階段缺 --source-snapshot → CliError（接線漏傳必須紅燈）', () => {
    expect(() => parseArgs([...base, '--write-spec-phase', 'model', '--pr-bodies', 'p'])).toThrow(/--spec-name/)
    expect(() => parseArgs([...base, '--write-spec-phase', 'model', '--spec-name', 'a'])).toThrow(/--pr-bodies/)
    expect(() =>
      parseArgs([...base, '--write-spec-phase', 'invariants', '--spec-name', 'a', '--pr-bodies', 'p']),
    ).toThrow(/--source-snapshot/)
  })
  it('規格名稱不合法 → CliError', () => {
    expect(() =>
      parseArgs([...base, '--write-spec-phase', 'model', '--spec-name', '../x', '--pr-bodies', 'p']),
    ).toThrow(CliError)
  })
  it('旗標缺值 → CliError', () => {
    for (const flag of ['--write-spec-phase', '--spec-name', '--source-snapshot', '--pr-bodies']) {
      expect(() => parseArgs([...base, flag]), flag).toThrow(CliError)
    }
  })
  it('與其他僅產出模式互斥', () => {
    expect(() =>
      parseArgs([...base, '--analyze-only', '--write-spec-phase', 'model', '--spec-name', 'a', '--pr-bodies', 'p']),
    ).toThrow(/不可同時指定/)
  })
})

describe('main：write-spec 模式', () => {
  let dir: string
  let reportPath: string
  let snapshotPath: string
  let bodiesPath: string
  const SNAPSHOT = '# Redlock 規格\n\n第 3 步：經過時間必須小於有效期。\n'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-crosscheck-spec-'))
    reportPath = join(dir, 'report.json')
    snapshotPath = join(dir, 'source.md')
    bodiesPath = join(dir, 'pr-bodies.json')
    writeFileSync(snapshotPath, SNAPSHOT)
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const OPEN_QS = { openQuestions: ['時鐘漂移上限未定'] }
  const SECTION = '\n\n## 未決事項\n\n- 時鐘漂移上限未定'
  const invariantsRun = (opts: { paths: string[]; bodies: string[]; source?: string | undefined; report?: Record<string, unknown> }) => {
    writeFileSync(reportPath, makeReport({ changedPaths: opts.paths, changedLines: 20, ...(opts.report ?? OPEN_QS) }))
    writeFileSync(bodiesPath, JSON.stringify(opts.bodies))
    return main(
      [
        '12', reportPath, '--target', 'target',
        '--write-spec-phase', 'invariants', '--spec-name', 'redlock',
        '--source-snapshot', snapshotPath, '--pr-bodies', bodiesPath,
      ],
      fakeGit({
        branches: 'factory/12-01-spec\n',
        diffNameOnly: () => opts.paths.join('\n'),
        shortStat: () => ' 2 files changed, 20 insertions(+)',
        show: (ref) => (ref === 'factory/12-01-spec:specs/redlock/source.md' ? opts.source : undefined),
      }),
    )
  }
  const OK_PATHS = ['specs/redlock/invariants.qnt', 'specs/redlock/source.md']

  it('範圍、快照、Refs 都正確 → ok', () => {
    const out = invariantsRun({ paths: OK_PATHS, bodies: ['Refs #12' + SECTION], source: SNAPSHOT })
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })
  it('不變量 PR 寫 Closes #12 → mismatch', () => {
    const out = invariantsRun({ paths: OK_PATHS, bodies: ['Closes #12' + SECTION], source: SNAPSHOT })
    expect(out.mismatches.map((m) => m.kind)).toContain('write-spec-closes-in-invariants')
    expect(out.ok).toBe(false)
  })
  it('越界寫了 model.qnt → write-spec-scope', () => {
    const out = invariantsRun({
      paths: [...OK_PATHS, 'specs/redlock/model.qnt'],
      bodies: ['Refs #12' + SECTION],
      source: SNAPSHOT,
    })
    expect(out.mismatches.map((m) => m.kind)).toContain('write-spec-scope')
  })
  it('source.md 被改寫 → write-spec-source-tampered', () => {
    const out = invariantsRun({ paths: OK_PATHS, bodies: ['Refs #12' + SECTION], source: SNAPSHOT + '（agent 加註）\n' })
    expect(out.mismatches.map((m) => m.kind)).toContain('write-spec-source-tampered')
  })
  it('分支上沒有 source.md → write-spec-source-missing', () => {
    const out = invariantsRun({ paths: ['specs/redlock/invariants.qnt'], bodies: ['Refs #12' + SECTION], source: undefined })
    expect(out.mismatches.map((m) => m.kind)).toContain('write-spec-source-missing')
  })
  it('模型階段：沒寫 Closes → 只有 advisory，不擋 run', () => {
    const paths = ['specs/redlock/model.qnt', 'specs/redlock/verify.yml']
    writeFileSync(reportPath, makeReport({ changedPaths: paths, changedLines: 20, ...OPEN_QS }))
    writeFileSync(bodiesPath, JSON.stringify(['Refs #12' + SECTION]))
    const out = main(
      ['12', reportPath, '--target', 'target', '--write-spec-phase', 'model', '--spec-name', 'redlock', '--pr-bodies', bodiesPath],
      fakeGit({
        branches: 'factory/12-01-model\n',
        diffNameOnly: () => paths.join('\n'),
        shortStat: () => ' 2 files changed, 20 insertions(+)',
      }),
    )
    expect(out.ok).toBe(true)
    expect(out.advisories.map((a) => a.kind)).toContain('write-spec-model-no-closes')
  })
  it('缺未決事項（report 與 PR 章節）→ 兩條 mismatch（ADR-018 護欄④）', () => {
    const out = invariantsRun({ paths: OK_PATHS, bodies: ['Refs #12'], source: SNAPSHOT, report: {} })
    expect(out.mismatches.map((m) => m.kind)).toEqual([
      'write-spec-open-questions-missing',
      'write-spec-open-questions-section',
    ])
    expect(out.ok).toBe(false)
  })
  it('空陣列而非 { none } → 明確的 mismatch，而不是 report 格式錯誤', () => {
    const out = invariantsRun({ paths: OK_PATHS, bodies: ['Refs #12' + SECTION], source: SNAPSHOT, report: { openQuestions: [] } })
    expect(out.mismatches.map((m) => m.kind)).toEqual(['write-spec-open-questions-missing'])
  })
  it('--pr-bodies 不是字串陣列 → CliError', () => {
    writeFileSync(reportPath, makeReport())
    writeFileSync(bodiesPath, JSON.stringify({ body: 'Refs #12' }))
    expect(() =>
      main(
        ['12', reportPath, '--target', 'target', '--write-spec-phase', 'model', '--spec-name', 'redlock', '--pr-bodies', bodiesPath],
        fakeGit({}),
      ),
    ).toThrow(CliError)
  })
})

describe('main：pbt-audit 範圍（ADR-019 §2、§5、R6）', () => {
  let dir: string
  let reportPath: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-crosscheck-pbt-'))
    reportPath = join(dir, 'report.json')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const PBT = 'test/jest/Tick.pbt.test.ts'
  const run = (flags: string[], changed: string[], deleted = ''): ReturnType<typeof main> => {
    writeFileSync(reportPath, makeReport({ changedPaths: changed }))
    return main(
      ['12', reportPath, ...flags],
      fakeGit({
        branches: 'factory/12-01-audit\n',
        diffNameOnly: () => changed.join('\n'),
        shortStat: () => ' 1 file changed, 30 insertions(+)',
        deletedNameOnly: () => deleted,
      }),
    )
  }

  it('--pbt-audit-only 與其他模式互斥', () => {
    expect(parseArgs(['12', 'r.json', '--pbt-audit-only']).pbtAuditOnly).toBe(true)
    expect(() => parseArgs(['12', 'r.json', '--pbt-audit-only', '--analyze-only'])).toThrow(/不可同時指定/)
  })
  it('audit 只新增 PBT 檔 → ok', () => {
    expect(run(['--pbt-audit-only'], [PBT]).ok).toBe(true)
  })
  it('audit 碰產品程式碼 → pbt-audit-scope', () => {
    const out = run(['--pbt-audit-only'], [PBT, 'src/Tick.ts'])
    expect(out.ok).toBe(false)
    expect(out.mismatches.map((m) => m.kind)).toContain('pbt-audit-scope')
  })
  it('audit 刪檔（含「改名成 PBT 檔」藏起來的刪除）→ pbt-audit-deletion', () => {
    const out = run(['--pbt-audit-only'], [PBT], 'src/Tick.ts\n.factory/run/x\n')
    expect(out.mismatches.map((m) => m.kind)).toContain('pbt-audit-deletion')
    expect(out.mismatches.find((m) => m.kind === 'pbt-audit-deletion')?.detail).not.toContain('.factory/')
  })
  it('非 audit 類型產出 PBT 檔 → pbt-outside-audit；不產出 → 無此 mismatch', () => {
    expect(run([], ['src/a.ts', PBT]).mismatches.map((m) => m.kind)).toContain('pbt-outside-audit')
    expect(run([], ['src/a.ts']).mismatches.map((m) => m.kind)).not.toContain('pbt-outside-audit')
  })
  it('collectDeletedPaths：多分支去重並正規化', () => {
    const git = fakeGit({ deletedNameOnly: (b) => (b === 'b1' ? './x.ts\ny.ts\n' : 'x.ts\n') })
    expect(collectDeletedPaths(git, { base: 'main', target: 't', branches: ['b1', 'b2'] })).toEqual(['x.ts', 'y.ts'])
  })
})
