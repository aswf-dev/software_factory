/**
 * factory-crosscheck 單元測試（src/cli/** 100% branch 閘門）。
 *
 * 涵蓋：git 輸出解析（for-each-ref / diff --name-only / --shortstat / --porcelain）、
 * report 與實際 diff 的雙向比較、參數解析、以及 main 的編排（fake git runner）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  adviseAssertionDelta,
  categorizeMismatch,
  checkVerifyScope,
  crosscheckHeadline,
  collectActualDiff,
  collectReportedPaths,
  collectVerifyDiff,
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
  parseUntrackedPaths,
  collectDeletedPaths,
  checkVariantIsolation,
  parseRemoteBranches,
  REUSE_DOWNGRADED_KINDS,
  validateReuseClaim,
  variantPrefix,
  VERIFY_ALLOWED_GLOBS,
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
  it('預設值：base=software-factory、target=target、四個僅產出模式皆 false', () => {
    expect(parseArgs(['12', 'report.json'])).toEqual({
      issueNumber: 12,
      reportPath: 'report.json',
      paths: { base: 'software-factory', target: 'target' },
      analyzeOnly: false,
      proposeSkillOnly: false,
      onboardOnly: false,
      pbtAuditOnly: false,
      verifyOnly: false,
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
      verifyOnly: false,
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
  it('回歸 #654：報告誠實列出 PBT 檔、只有範圍違規 → 類別 scope、標題不說「不一致」', () => {
    const out = run([], ['src/Tick.ts', PBT])
    expect(out.ok).toBe(false)
    expect(out.mismatches).toEqual([expect.objectContaining({ kind: 'pbt-outside-audit', category: 'scope' })])
    expect(out.headline).toBe('變更超出任務類型允許的範圍')
  })
  it('沒有 mismatch → 標題為空字串', () => {
    expect(run([], ['src/Tick.ts']).headline).toBe('')
  })
  it('collectDeletedPaths：多分支去重並正規化', () => {
    const git = fakeGit({ deletedNameOnly: (b) => (b === 'b1' ? './x.ts\ny.ts\n' : 'x.ts\n') })
    expect(collectDeletedPaths(git, { base: 'main', target: 't', branches: ['b1', 'b2'] })).toEqual(['x.ts', 'y.ts'])
  })
})

describe('categorizeMismatch／crosscheckHeadline：政策違規與報告不一致分開標示', () => {
  it.each([
    'pbt-outside-audit',
    'pbt-audit-scope',
    'pbt-audit-deletion',
    'analyze-code-change',
    'propose-skill-scope',
    'onboard-scope',
    'write-spec-scope',
    'verify-neutralised-path',
  ])('%s → scope（變更超出任務類型允許的範圍）', (kind) => {
    expect(categorizeMismatch(kind)).toBe('scope')
  })
  it.each(['unreported-changes', 'reported-not-in-diff', 'lines-missing', 'write-spec-source-tampered', 'some-future-kind'])(
    '%s → consistency（含未知類型：維持舊標題，不誤稱為範圍違規）',
    (kind) => {
      expect(categorizeMismatch(kind)).toBe('consistency')
    },
  )
  it.each(['variant-branch-prefix', 'variant-foreign-reuse'])('%s → isolation（N-version 變體隔離）', (kind) => {
    expect(categorizeMismatch(kind)).toBe('isolation')
  })
  it('標題依類別組合', () => {
    const m = (kind: string) => ({ kind, detail: 'x' })
    expect(crosscheckHeadline([])).toBe('')
    expect(crosscheckHeadline([m('pbt-outside-audit')])).toBe('變更超出任務類型允許的範圍')
    expect(crosscheckHeadline([m('unreported-changes')])).toBe('report 與實際變更不一致')
    expect(crosscheckHeadline([m('pbt-outside-audit'), m('unreported-changes')])).toBe(
      '變更超出任務類型允許的範圍，且 report 與實際變更不一致',
    )
    expect(crosscheckHeadline([m('variant-foreign-reuse')])).toBe('N-version 變體隔離失敗')
    expect(crosscheckHeadline([m('variant-branch-prefix'), m('unreported-changes')])).toBe(
      'N-version 變體隔離失敗，且 report 與實際變更不一致',
    )
  })
})

/**
 * N-version 變體隔離（fubon-tradingbot#713，run 38066416086）：兩變體平行處理同一張
 * Issue。變體 B 開了沒有變體前綴的 `factory/713-01-analysis`；變體 A 寫完報告、要推
 * 分支時看到它，依「既有交付不重複開 PR」把自己的成果刪掉——judge 仍判 ready-for-review。
 */
describe('checkVariantIsolation', () => {
  const base = { issueNumber: 713, variant: 'a' as const, localBranches: [], remoteBranches: [], reportedPaths: [] }

  it('variantPrefix 是 factory/<issue>-<variant>-', () => {
    expect(variantPrefix(713, 'b')).toBe('factory/713-b-')
  })

  it('本變體前綴的分支 → 無 mismatch', () => {
    expect(
      checkVariantIsolation({ ...base, localBranches: ['factory/713-a-01-docs'], reportedPaths: ['docs/r.md'] }),
    ).toEqual([])
  })

  it('本地分支缺變體前綴（#713 變體 B 的 factory/713-01-analysis）→ variant-branch-prefix', () => {
    const out = checkVariantIsolation({
      ...base,
      variant: 'b',
      localBranches: ['factory/713-01-analysis', 'factory/713-b-01-docs'],
      reportedPaths: ['docs/r.md'],
    })
    expect(out.map((m) => m.kind)).toEqual(['variant-branch-prefix'])
    expect(out[0]?.detail).toContain('factory/713-01-analysis')
    expect(out[0]?.detail).not.toContain('factory/713-b-01-docs')
    expect(out[0]?.detail).toContain('factory/713-b-')
  })

  it('無自己的交付、遠端只有另一變體的分支（#713 變體 A）→ variant-foreign-reuse', () => {
    const out = checkVariantIsolation({
      ...base,
      remoteBranches: ['factory/713-01-analysis', 'factory/713-b-01-docs', 'factory/7130-a-01-x', 'main'],
    })
    expect(out.map((m) => m.kind)).toEqual(['variant-foreign-reuse'])
    expect(out[0]?.detail).toContain('factory/713-01-analysis')
    expect(out[0]?.detail).toContain('factory/713-b-01-docs')
    // 其他 Issue 與非 factory 分支不列入（7130 不是 713 的分支）
    expect(out[0]?.detail).not.toContain('7130')
    expect(out[0]?.detail).not.toContain('main')
  })

  it('遠端有本變體前綴的分支（本變體的重跑）→ 沿用既有交付合法', () => {
    expect(
      checkVariantIsolation({ ...base, remoteBranches: ['factory/713-a-01-docs', 'factory/713-b-01-docs'] }),
    ).toEqual([])
  })

  it('slash 命名（factory/<issue>/…）一樣算本 Issue 的分支', () => {
    const out = checkVariantIsolation({ ...base, remoteBranches: ['factory/713/01-docs'] })
    expect(out.map((m) => m.kind)).toEqual(['variant-foreign-reuse'])
  })

  it('無自己的交付、遠端也沒有其他分支（停手規則）→ 不歸咎於隔離', () => {
    expect(checkVariantIsolation(base)).toEqual([])
  })

  it('report 有變更就不是沿用（由其他檢查負責一致性）', () => {
    expect(
      checkVariantIsolation({ ...base, remoteBranches: ['factory/713-b-01-docs'], reportedPaths: ['docs/r.md'] }),
    ).toEqual([])
  })

  it('本地有本變體分支就不是沿用', () => {
    expect(
      checkVariantIsolation({
        ...base,
        localBranches: ['factory/713-a-01-docs'],
        remoteBranches: ['factory/713-b-01-docs'],
      }),
    ).toEqual([])
  })
})

describe('parseRemoteBranches', () => {
  it('一行一個分支名，忽略空行與前後空白', () => {
    expect(parseRemoteBranches('factory/1-a-01-test\n\n  main  \n')).toEqual(['factory/1-a-01-test', 'main'])
  })
})

describe('parseArgs：N-version 旗標', () => {
  it('--variant 與 --remote-branches 一起解析', () => {
    const r = parseArgs(['12', 'r.json', '--variant', 'b', '--remote-branches', 'rb.txt'])
    expect(r.variant).toEqual({ id: 'b', remoteBranchesPath: 'rb.txt' })
  })
  it('未指定 --variant → undefined（非 N-version 呼叫維持舊行為）', () => {
    expect(parseArgs(['12', 'r.json']).variant).toBeUndefined()
  })
  it('--variant 值不合法 → CliError', () => {
    expect(() => parseArgs(['12', 'r.json', '--variant', 'c', '--remote-branches', 'x'])).toThrow(/--variant must be a or b/)
  })
  it('--variant 缺 --remote-branches → CliError（接線漏傳時寧可紅燈）', () => {
    expect(() => parseArgs(['12', 'r.json', '--variant', 'a'])).toThrow(/--variant requires --remote-branches/)
  })
  it('--remote-branches 沒有 --variant → CliError', () => {
    expect(() => parseArgs(['12', 'r.json', '--remote-branches', 'x'])).toThrow(/--remote-branches requires --variant/)
  })
  it('旗標缺值 → CliError', () => {
    expect(() => parseArgs(['12', 'r.json', '--variant'])).toThrow(/--variant requires a value/)
    expect(() => parseArgs(['12', 'r.json', '--variant', 'a', '--remote-branches'])).toThrow(
      /--remote-branches requires a value/,
    )
  })
})

describe('main：N-version 變體隔離', () => {
  let dir: string
  let reportPath: string
  let remotePath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-crosscheck-variant-'))
    reportPath = join(dir, 'report.json')
    remotePath = join(dir, 'remote-branches.txt')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('重現 #713 變體 A：changedPaths=[]、遠端只有 B 的分支 → ok=false 且標題為隔離失敗', () => {
    writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0 }))
    writeFileSync(remotePath, 'factory/12-01-analysis\n')
    const out = main(['12', reportPath, '--variant', 'a', '--remote-branches', remotePath], fakeGit({}))
    expect(out.ok).toBe(false)
    expect(out.mismatches.map((m) => m.kind)).toEqual(['variant-foreign-reuse'])
    expect(out.mismatches[0]?.category).toBe('isolation')
    expect(out.headline).toBe('N-version 變體隔離失敗')
  })

  it('變體自己的前綴分支與 report 一致 → ok=true', () => {
    writeFileSync(reportPath, makeReport())
    writeFileSync(remotePath, 'factory/12-b-01-test\n')
    const out = main(
      ['12', reportPath, '--variant', 'a', '--remote-branches', remotePath],
      fakeGit({
        branches: 'factory/12-a-01-test\n',
        diffNameOnly: () => 'src/a.ts\n',
        shortStat: () => ' 1 file changed, 30 insertions(+)',
      }),
    )
    expect(out.ok).toBe(true)
  })
})

describe('沿用既有交付的合法路徑（reusedExistingPr；fubon-tradingbot#717 run 38106446065 假紅教訓）', () => {
  const base = { issueNumber: 12, reportedPaths: [] as string[], localBranches: ['factory/12-a-01-docs'], remoteBranches: ['factory/12-a-01-docs'] as string[] | undefined, variant: 'a' as const }

  it('降級集合恰為三種路徑/行數不一致（其餘 kinds 不得被沿用掩蓋）', () => {
    expect([...REUSE_DOWNGRADED_KINDS].sort()).toEqual(['diff-not-reported', 'lines-missing', 'unreported-changes'])
  })

  it('N-version：本變體分支本地＋遠端都在 → valid', () => {
    expect(validateReuseClaim(base)).toEqual({ valid: true, branch: 'factory/12-a-01-docs' })
  })
  it('changedPaths 非空 → 與沿用矛盾', () => {
    const r = validateReuseClaim({ ...base, reportedPaths: ['docs/r.md'] })
    expect(r.valid).toBe(false)
    expect(!r.valid && r.reason).toContain('相互矛盾')
  })
  it('遠端與本地都無本變體前綴分支 → 既有交付不存在', () => {
    const r = validateReuseClaim({ ...base, localBranches: ['factory/12-b-01-docs'], remoteBranches: ['factory/12-b-01-docs'] })
    expect(r.valid).toBe(false)
    expect(!r.valid && r.reason).toContain('factory/12-a-')
    expect(!r.valid && r.reason).toContain('遠端與本地都找不到')
  })
  it('乾淨沿用（run 38109497975 教訓）：agent 未 checkout，遠端清單就是權威證據', () => {
    expect(validateReuseClaim({ ...base, localBranches: [] })).toEqual({ valid: true, branch: 'factory/12-a-01-docs' })
  })
  it('分支不在遠端清單 → 本次新做的不能冒充既有交付', () => {
    const r = validateReuseClaim({ ...base, remoteBranches: [] })
    expect(r.valid).toBe(false)
    expect(!r.valid && r.reason).toContain('不在遠端清單')
  })
  it('非 N-version：無遠端清單時只驗本地，dash 與 slash 格式都認得', () => {
    expect(validateReuseClaim({ issueNumber: 12, reportedPaths: [], localBranches: ['factory/12-01-docs'], remoteBranches: undefined, variant: undefined })).toEqual({ valid: true, branch: 'factory/12-01-docs' })
    expect(validateReuseClaim({ issueNumber: 12, reportedPaths: [], localBranches: ['factory/12/01-docs'], remoteBranches: undefined, variant: undefined })).toEqual({ valid: true, branch: 'factory/12/01-docs' })
    const r = validateReuseClaim({ issueNumber: 12, reportedPaths: [], localBranches: ['feature/x'], remoteBranches: undefined, variant: undefined })
    expect(r.valid).toBe(false)
  })

  describe('main 整合', () => {
    let dir: string
    let reportPath: string
    let rbPath: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'crosscheck-reuse-'))
      reportPath = join(dir, 'report.json')
      rbPath = join(dir, 'remote-branches.txt')
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    const reuseGit = (extra: { status?: string } = {}) =>
      fakeGit({
        branches: 'factory/12-a-01-docs\n',
        diffNameOnly: () => 'docs/r.md\n',
        shortStat: () => ' 1 file changed, 710 insertions(+)',
        ...extra,
      })

    it('#717 場景重現：合法沿用 → ok=true，三種假紅降級為 advisory', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0, reusedExistingPr: 719 }))
      writeFileSync(rbPath, 'factory/12-a-01-docs\n')
      const out = main(['12', reportPath, '--target', 'target', '--variant', 'a', '--remote-branches', rbPath], reuseGit())
      expect(out.ok).toBe(true)
      expect(out.mismatches).toEqual([])
      const adv = out.advisories.find((a) => a.kind === 'reuse-of-existing-pr')
      expect(adv?.detail).toContain('#719')
      expect(adv?.detail).toContain('factory/12-a-01-docs')
      expect(adv?.detail).toContain('710')
    })

    it('乾淨沿用重現（run 38109497975）：未 checkout、無本地分支、無 diff → ok=true＋advisory', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0, reusedExistingPr: 719 }))
      writeFileSync(rbPath, 'factory/12-a-01-docs\n')
      const out = main(['12', reportPath, '--target', 'target', '--variant', 'a', '--remote-branches', rbPath], fakeGit({}))
      expect(out.ok).toBe(true)
      expect(out.mismatches).toEqual([])
      const adv = out.advisories.find((a) => a.kind === 'reuse-of-existing-pr')
      expect(adv?.detail).toContain('#719')
      expect(adv?.detail).toContain('factory/12-a-01-docs')
    })

    it('宣稱沿用但 changedPaths 非空 → reuse-claim-unverified（consistency、fail-loud）', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: ['docs/r.md'], changedLines: 710, reusedExistingPr: 719 }))
      writeFileSync(rbPath, 'factory/12-a-01-docs\n')
      const out = main(['12', reportPath, '--target', 'target', '--variant', 'a', '--remote-branches', rbPath], reuseGit())
      expect(out.ok).toBe(false)
      expect(out.mismatches.map((m) => m.kind)).toEqual(['reuse-claim-unverified'])
      expect(out.mismatches[0]?.category).toBe('consistency')
      expect(out.headline).toContain('report 與實際變更不一致')
    })

    it('宣稱沿用但分支未推送 → reuse-claim-unverified', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0, reusedExistingPr: 719 }))
      writeFileSync(rbPath, '')
      const out = main(['12', reportPath, '--target', 'target', '--variant', 'a', '--remote-branches', rbPath], reuseGit())
      expect(out.ok).toBe(false)
      // 驗證不成立 → 不降級：三種被沿用掩蓋的不一致與 unverified 全部留在紅燈裡
      expect(out.mismatches.map((m) => m.kind).sort()).toEqual([
        'diff-not-reported',
        'lines-missing',
        'reuse-claim-unverified',
        'unreported-changes',
      ])
    })

    it('合法沿用不掩蓋本次新問題：uncommitted-changes 依舊紅', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0, reusedExistingPr: 719 }))
      writeFileSync(rbPath, 'factory/12-a-01-docs\n')
      const out = main(['12', reportPath, '--target', 'target', '--variant', 'a', '--remote-branches', rbPath], reuseGit({ status: ' M docs/dirty.md\n' }))
      expect(out.ok).toBe(false)
      expect(out.mismatches.map((m) => m.kind)).toContain('uncommitted-changes')
      expect(out.advisories.some((a) => a.kind === 'reuse-of-existing-pr')).toBe(true)
    })

    it('非 N-version 沿用：無 --variant 也走同一條機械驗證', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0, reusedExistingPr: 595 }))
      const out = main(['12', reportPath, '--target', 'target'], fakeGit({
        branches: 'factory/12-01-docs\n',
        diffNameOnly: () => 'docs/r.md\n',
        shortStat: () => ' 1 file changed, 20 insertions(+)',
      }))
      expect(out.ok).toBe(true)
      expect(out.advisories.some((a) => a.kind === 'reuse-of-existing-pr')).toBe(true)
    })

    it('reusedExistingPr 非正整數 → schema 拒收（CliError）', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: [], reusedExistingPr: 0 }))
      expect(() => main(['12', reportPath, '--target', 'target'], fakeGit({}))).toThrow(CliError)
    })
  })
})

/**
 * 驗證模式（ADR-029 §5、§6）：agent 不建分支、不 push、不開 PR，所以 crosscheck
 * 不能再找 `factory/<issue>-*` 分支——事實來源改成「工作區（含本地 commit）相對
 * base 的 diff」，並套用 specs／測試檔白名單。R2 裁決：本地 commit 允許，未提交
 * 變更也不再是 mismatch（兩者都以同一份 diff 呈現）。
 */
describe('驗證模式的 crosscheck（--verify-only，ADR-029 §5、§6）', () => {
  /** 只認得驗證模式四種 git 呼叫的 fake；呼叫到分支相關命令即 throw。 */
  function verifyGit(
    script: {
      diffNameOnly?: string
      shortStat?: string
      unifiedDiff?: string
      status?: string
      /** `git ls-files --others --exclude-per-directory=.gitignore …`：未追蹤檔清單。 */
      otherFiles?: string
    },
    calls: string[][] = [],
  ): GitRunner {
    return (args) => {
      calls.push(args)
      if (args[0] === 'diff') {
        // R24：verify 事實必須關掉 rename 偵測。預設 -M 對 100% 改名只列新路徑，
        // 被刪掉的產品檔就從 verify-scope 白名單逃出去。
        if (!args.includes('--no-renames')) throw new Error('verify diff must pass --no-renames')
        if (args[1] === '--name-only') return script.diffNameOnly ?? ''
        if (args[1] === '--shortstat') return script.shortStat ?? ''
        if (args[1] === '--unified=0') return script.unifiedDiff ?? ''
        throw new Error(`unexpected git diff flag: ${args[1]}`)
      }
      if (args[0] === 'status') return script.status ?? ''
      if (args[0] === 'ls-files') return script.otherFiles ?? ''
      throw new Error(`驗證模式不該呼叫：git ${args.join(' ')}`)
    }
  }

  describe('checkVerifyScope', () => {
    it('白名單：specs/** 與五種測試檔命名皆允許', () => {
      const allowed = [
        'specs/quint/model.qnt',
        'specs/lean/Specs/Proofs.lean',
        'specs/lean/lean-toolchain',
        'src/util/format.test.ts',
        'service/foo_test.go',
        'pkg/tests/integration.py',
        'pkg/test/unit.js',
      ]
      for (const p of allowed) expect(checkVerifyScope([p]), p).toEqual([])
    })

    it('dot segments 在 specs/** 內合法：lean skill 的 .gitignore 與 .lake/ 不得被判越界', () => {
      const allowed = [
        'specs/lean/.gitignore',
        'specs/lean/.lake/build/x.olean',
        'specs/.hidden/model.qnt',
      ]
      for (const p of allowed) expect(checkVerifyScope([p]), p).toEqual([])
    })

    it('隱藏路徑仍受白名單限制：specs 外的 dot 路徑一律拒絕', () => {
      const outside = ['.github/foo', '.github/workflows/x.yml', '.gitignore']
      const findings = checkVerifyScope(outside)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.kind).toBe('verify-scope')
      for (const p of outside) expect(findings[0]?.detail).toContain(p)
    })

    it('C1：`.github` 下符合測試命名慣例的路徑仍一律拒絕（dot segment 只在 specs/** 內放寬）', () => {
      // 這些路徑全部符合「測試檔」glob 的字面形狀。dot:true 套用到所有 glob 時，
      // 它們會通過白名單——等於讓驗證 agent 改寫 CI 設定/工作流程（C1）。
      const outside = [
        '.github/workflows/evil.test.yml',
        '.github/tests/x.ts',
        '.github/test/x.ts',
        '.github/factory/foo_test.go',
      ]
      const findings = checkVerifyScope(outside)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.kind).toBe('verify-scope')
      for (const p of outside) expect(findings[0]?.detail).toContain(p)
    })

    it('C1：specs 外的 dot segment 一律拒絕，即使路徑符合測試 glob', () => {
      const outside = ['src/.hidden/x.test.ts', 'tests/.cache/y_test.go', 'pkg/.config/test/z.ts']
      const findings = checkVerifyScope(outside)
      expect(findings).toHaveLength(1)
      for (const p of outside) expect(findings[0]?.detail).toContain(p)
    })

    it('C1：specs 樹內的 dot segment 仍是合規產出（lean skill 的 .gitignore）', () => {
      for (const p of ['specs/lean/.gitignore', 'specs/lean/.lake/build/x.olean', 'specs/.hidden/model.qnt']) {
        expect(checkVerifyScope([p]), p).toEqual([])
      }
    })

    it('越界：產品程式碼、設定、依賴、文件、CI 設定一律拒絕並列出路徑', () => {
      const outside = ['src/util/format.ts', 'package.json', 'package-lock.json', '.github/workflows/test.yml', 'docs/x.md', 'catalog-info.yaml']
      const findings = checkVerifyScope(outside)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.kind).toBe('verify-scope')
      for (const p of outside) expect(findings[0]?.detail).toContain(p)
      expect(findings[0]?.detail).toContain('specs/**')
    })

    it('空清單 → 無 finding（沒有變更就沒有越界）', () => {
      expect(checkVerifyScope([])).toEqual([])
    })

    it('白名單常數即 ADR-029 修訂版列出的五個 glob（改動要經 ADR）', () => {
      expect([...VERIFY_ALLOWED_GLOBS]).toEqual([
        'specs/**',
        '**/*.test.*',
        '**/*_test.go',
        '**/tests/**',
        '**/test/**',
      ])
    })

    it('歸類為 scope：越界要改規則／改工單，不是查 agent 的回報', () => {
      expect(categorizeMismatch('verify-scope')).toBe('scope')
    })
  })

  describe('parseUntrackedPaths', () => {
    it('只取 `??` 的未追蹤檔，正規化 ./，忽略已修改／已暫存', () => {
      expect(parseUntrackedPaths(' M src/a.ts\n?? specs/quint/model.qnt\nA  specs/lean/A.lean\n?? ./test/x.test.ts\n\n')).toEqual([
        'specs/quint/model.qnt',
        'test/x.test.ts',
      ])
      expect(parseUntrackedPaths('')).toEqual([])
      // 正規化後為空的路徑（`?? ./`）不進清單，避免下游拿空字串去比對
      expect(parseUntrackedPaths('?? ./\n')).toEqual([])
    })
    it('解開 git C-style 引號：空白、引號、控制字元與非 ASCII 路徑不得被截斷或連引號回報', () => {
      expect(
        parseUntrackedPaths(
          '?? "specs/a b.qnt"\n?? "specs/quote\\"x.qnt"\n?? "specs/tab\\there.qnt"\n?? "specs/caf\\303\\251.qnt"\n',
        ),
      ).toEqual(['specs/a b.qnt', 'specs/quote"x.qnt', 'specs/tab\there.qnt', 'specs/café.qnt'])
      // 不完整的引號（沒有收尾）維持原樣，不誤吞路徑
      expect(parseUntrackedPaths('?? "specs/unterminated.qnt\n')).toEqual(['"specs/unterminated.qnt'])
      // 未知跳脫（git 目前不會產生）保留反斜線，不靜默吞掉字元
      expect(parseUntrackedPaths('?? "specs/odd\\;name.qnt"\n')).toEqual(['specs/odd\\;name.qnt'])
    })
  })

  describe('collectVerifyDiff', () => {
    it('以 `git diff <base>`（不是 base...branch）取事實；untracked 一併算交付', () => {
      const calls: string[][] = []
      const actual = collectVerifyDiff(
        verifyGit(
          {
            diffNameOnly: 'specs/quint/model.qnt\ntest/x.test.ts\n',
            shortStat: ' 2 files changed, 12 insertions(+), 3 deletions(-)',
            unifiedDiff: [
              'diff --git a/test/x.test.ts b/test/x.test.ts',
              '--- a/test/x.test.ts',
              '+++ b/test/x.test.ts',
              '@@ -1,0 +1,1 @@',
              '+expect(a).toBe(1)',
              '',
            ].join('\n'),
            status: '?? specs/lean/Specs/Proofs.lean\n M test/x.test.ts\n',
          },
          calls,
        ),
        { base: 'main', target: 'target' },
      )
      expect(calls).toContainEqual(['diff', '--name-only', '--no-renames', 'main'])
      expect(calls).toContainEqual(['diff', '--shortstat', '--no-renames', 'main'])
      expect(calls).toContainEqual(['diff', '--unified=0', '--no-renames', 'main'])
      expect(actual.branches).toEqual([])
      expect(actual.paths).toEqual(['specs/quint/model.qnt', 'test/x.test.ts', 'specs/lean/Specs/Proofs.lean'])
      expect(actual.added).toBe(12)
      expect(actual.deleted).toBe(3)
      expect(actual.uncommitted).toEqual(['specs/lean/Specs/Proofs.lean', 'test/x.test.ts'])
      expect(actual.assertionDelta).toBe(1)
    })

    it('收集時帶 --untracked-files=all：整個新目錄逐檔列出，不收成 ?? specs/', () => {
      const calls: string[][] = []
      const actual = collectVerifyDiff(
        verifyGit(
          {
            status:
              '?? specs/quint/model.qnt\n?? specs/quint/aux.qnt\n?? specs/lean/.gitignore\n',
          },
          calls,
        ),
        { base: 'main', target: 'target' },
      )
      expect(calls).toContainEqual(['status', '--porcelain', '--untracked-files=all'])
      expect(actual.paths).toEqual([
        'specs/quint/model.qnt',
        'specs/quint/aux.qnt',
        'specs/lean/.gitignore',
      ])
    })

    it('git 仍回目錄項（如巢狀 repo）→ 以 ls-files 逐目錄展開', () => {
      const calls: string[][] = []
      const actual = collectVerifyDiff(
        verifyGit(
          {
            status: '?? specs/newdir/\n',
            otherFiles: 'specs/newdir/a.qnt\nspecs/newdir/b.qnt\n',
          },
          calls,
        ),
        { base: 'main', target: 'target' },
      )
      expect(calls).toContainEqual([
        'ls-files',
        '--others',
        '--exclude-per-directory=.gitignore',
        '--',
        'specs/newdir',
      ])
      expect(actual.paths).toEqual(['specs/newdir/a.qnt', 'specs/newdir/b.qnt'])
    })

    it('目錄展開為空 → 保留目錄項，不靜默丟掉變更', () => {
      const actual = collectVerifyDiff(
        verifyGit({ status: '?? specs/empty/\n', otherFiles: '' }),
        { base: 'main', target: 'target' },
      )
      expect(actual.paths).toEqual(['specs/empty/'])
    })

    it('沒有變更 → 全空', () => {
      expect(collectVerifyDiff(verifyGit({}), { base: 'main', target: 'target' })).toEqual({
        branches: [],
        paths: [],
        added: 0,
        deleted: 0,
        uncommitted: [],
        assertionDelta: 0,
      })
    })

    it('untracked 與 diff 的重複路徑只算一次（不讓白名單／報告比對看到兩份）', () => {
      const actual = collectVerifyDiff(
        verifyGit({ diffNameOnly: 'specs/x.qnt\n', status: '?? specs/x.qnt\n' }),
        { base: 'main', target: 'target' },
      )
      expect(actual.paths).toEqual(['specs/x.qnt'])
    })
  })

  describe('--verify-only 的 main 編排', () => {
    let dir: string
    let reportPath: string
    /** 還原 fixture 的獨立根目錄：各測試互不汙染，afterAll 一次清掉。 */
    const restoredRoots: string[] = []

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'crosscheck-verify-'))
      reportPath = join(dir, 'report.json')
    })
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
      for (const root of restoredRoots) rmSync(root, { recursive: true, force: true })
    })

    /** manifest 記錄的是還原位元組的 sha256（hex、小寫），crosscheck 以磁碟重算比對。 */
    const sha256 = (bytes: string | Uint8Array): string =>
      createHash('sha256').update(bytes).digest('hex')

    /**
     * 建立「`factory-verify-input` 已還原」的狀態：檔案寫進獨立 `target/`，manifest
     * 依還原端格式記錄每個檔案的實際 sha256（依 path 排序）。
     */
    function restoredFixture(files: Record<string, string>): { target: string; manifest: string } {
      const root = mkdtempSync(join(tmpdir(), 'crosscheck-restored-'))
      restoredRoots.push(root)
      const target = join(root, 'target')
      const entries = Object.entries(files)
        .map(([path, content]) => {
          const abs = join(target, path)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, content)
          return { path, sha256: sha256(content) }
        })
        .sort((a, b) => (a.path < b.path ? -1 : 1))
      const manifest = join(root, 'restored.json')
      writeFileSync(manifest, JSON.stringify({ restored: entries }))
      return { target, manifest }
    }

    it('白名單內變更 → ok=true；未提交變更不再是 mismatch（R2）', () => {
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', 'target', '--verify-only'],
        verifyGit({
          diffNameOnly: 'specs/quint/model.qnt\n',
          shortStat: ' 1 file changed, 5 insertions(+)',
          status: ' M specs/quint/model.qnt\n',
        }),
      )
      expect(out.ok).toBe(true)
      expect(out.mismatches).toEqual([])
    })

    it('agent 未 commit 的新檔（untracked）也算交付，不誤判 no-trace', () => {
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 10, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', 'target', '--verify-only'],
        verifyGit({ status: '?? specs/quint/model.qnt\n' }),
      )
      expect(out.ok).toBe(true)
      expect(out.actual.paths).toEqual(['specs/quint/model.qnt'])
    })

    it('整棵未追蹤的新目錄：兩個檔案逐檔列出並與 report 的 changedPaths 對上（--untracked-files=all）', () => {
      const repo = mkdtempSync(join(tmpdir(), 'crosscheck-verify-repo-'))
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo })
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'base'],
          { cwd: repo },
        )
        mkdirSync(join(repo, 'specs', 'quint'), { recursive: true })
        writeFileSync(join(repo, 'specs', 'quint', 'model.qnt'), 'module Model {}\n')
        writeFileSync(join(repo, 'specs', 'quint', 'aux.qnt'), 'module Aux {}\n')
        writeFileSync(
          reportPath,
          makeReport({
            changedPaths: ['specs/quint/model.qnt', 'specs/quint/aux.qnt'],
            changedLines: 2,
            requirements: undefined,
          }),
        )
        const out = main(['12', reportPath, '--target', repo, '--base', 'HEAD', '--verify-only'])
        expect(out.actual.paths).toEqual(['specs/quint/aux.qnt', 'specs/quint/model.qnt'])
        expect(out.mismatches).toEqual([])
        expect(out.ok).toBe(true)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })

    it('越界變更 → verify-scope（scope、fail-loud），不是 consistency', () => {
      writeFileSync(reportPath, makeReport({ changedPaths: ['src/a.ts'], changedLines: 30 }))
      const out = main(
        ['12', reportPath, '--target', 'target', '--verify-only'],
        verifyGit({ diffNameOnly: 'src/a.ts\n', shortStat: ' 1 file changed, 30 insertions(+)' }),
      )
      expect(out.ok).toBe(false)
      expect(out.mismatches.map((m) => m.kind)).toEqual(['verify-scope'])
      expect(out.mismatches[0]?.category).toBe('scope')
      expect(out.headline).toContain('變更超出任務類型允許的範圍')
    })

    it('requirements 不是驗證階段的必要欄位（G8 只適用開發型工單）', () => {
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', 'target', '--verify-only'],
        verifyGit({ diffNameOnly: 'specs/quint/model.qnt\n', shortStat: ' 1 file changed, 5 insertions(+)\n' }),
      )
      expect(out.ok).toBe(true)
      expect(out.mismatches.some((m) => m.kind.startsWith('requirements-'))).toBe(false)
    })

    it('--restored-manifest：未動的還原輸入（tracked 與 untracked）不算 agent 交付，扣除後與 report 一致', () => {
      const { target, manifest } = restoredFixture({
        'specs/quint/RULES.md': '# RULES\n',
        'specs/quint/TRIAGE.md': '# TRIAGE\n',
      })
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', manifest],
        verifyGit({
          diffNameOnly: 'specs/quint/RULES.md\nspecs/quint/model.qnt\n',
          shortStat: ' 2 files changed, 8 insertions(+)',
          status: '?? specs/quint/TRIAGE.md\n?? specs/quint/model.qnt\n',
        }),
      )
      expect(out.actual.paths).toEqual(['specs/quint/model.qnt'])
      expect(out.actual.uncommitted).toEqual(['specs/quint/model.qnt'])
      expect(out.mismatches).toEqual([])
      expect(out.ok).toBe(true)
    })

    it('--restored-manifest：還原端白名單內的測試檔也可扣除（manifest 與還原端同一套路徑規則）', () => {
      const { target, manifest } = restoredFixture({ 'test/unit.test.ts': 'it("x", () => {})\n' })
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', manifest],
        verifyGit({
          diffNameOnly: 'test/unit.test.ts\nspecs/quint/model.qnt\n',
          shortStat: ' 2 files changed, 6 insertions(+)',
          status: ' M test/unit.test.ts\n',
        }),
      )
      expect(out.actual.paths).toEqual(['specs/quint/model.qnt'])
      expect(out.actual.uncommitted).toEqual([])
      expect(out.ok).toBe(true)
    })

    it('--restored-manifest：空的 restored 清單 → 不扣除任何路徑（與沒帶旗標相同）', () => {
      const manifestPath = join(dir, 'restored-empty.json')
      writeFileSync(manifestPath, JSON.stringify({ restored: [] }))
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', 'target', '--verify-only', '--restored-manifest', manifestPath],
        verifyGit({
          diffNameOnly: 'specs/quint/model.qnt\n',
          shortStat: ' 1 file changed, 5 insertions(+)',
          status: '?? specs/quint/model.qnt\n',
        }),
      )
      expect(out.actual.paths).toEqual(['specs/quint/model.qnt'])
      expect(out.ok).toBe(true)
    })

    it('--restored-manifest：agent 改動還原輸入 → restored-input-modified（hard），且不從 diff 扣除', () => {
      const { target, manifest } = restoredFixture({
        'specs/quint/RULES.md': '# RULES\n',
        'specs/quint/TRIAGE.md': '# TRIAGE\n',
      })
      // agent 改掉上一階段確認過的 RULES.md（唯讀輸入）
      writeFileSync(join(target, 'specs/quint/RULES.md'), '# RULES\n\n- 放寬：餘額可為負\n')
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 2, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', manifest],
        verifyGit({
          diffNameOnly: 'specs/quint/RULES.md\nspecs/quint/model.qnt\n',
          shortStat: ' 2 files changed, 3 insertions(+)',
          status: ' M specs/quint/RULES.md\n?? specs/quint/model.qnt\n',
        }),
      )
      expect(out.ok).toBe(false)
      expect(out.mismatches.map((m) => m.kind)).toEqual(['diff-not-reported', 'restored-input-modified'])
      const modified = out.mismatches[1]
      expect(modified?.detail).toContain('specs/quint/RULES.md')
      expect(modified?.detail).toMatch(/修改/)
      expect(modified?.category).toBe('consistency')
      // 被改的還原輸入仍算 agent 的變更（雙重訊號：diff-not-reported ＋ restored-input-modified）
      const unreported = out.mismatches[0]
      expect(unreported?.detail).toContain('specs/quint/RULES.md')
      expect(unreported?.detail).not.toContain('specs/quint/TRIAGE.md')
      expect(out.actual.paths).toEqual(['specs/quint/RULES.md', 'specs/quint/model.qnt'])
      expect(out.actual.uncommitted).toEqual(['specs/quint/RULES.md', 'specs/quint/model.qnt'])
    })

    it('--verify-phase 缺值即 fail loud（不靜默忽略旗標）', () => {
      expect(() => main(['12', reportPath, '--verify-only', '--verify-phase'], fakeGit({}))).toThrow(/--verify-phase/)
      expect(() =>
        main(['12', reportPath, '--verify-only', '--verify-phase', '--target', '.'], fakeGit({})),
      ).toThrow(/--verify-phase/)
    })

    it('--verify-phase proofs：specs/lean 以外的還原輸入仍唯讀', () => {
      const { target, manifest } = restoredFixture({ 'specs/quint/RULES.md': '# RULES\n' })
      writeFileSync(join(target, 'specs/quint/RULES.md'), '# RULES\n\n- 放寬\n')
      writeFileSync(reportPath, makeReport({ changedPaths: ['specs/quint/RULES.md'], changedLines: 1 }))
      const out = main(
        ['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', manifest, '--verify-phase', 'proofs'],
        verifyGit({
          diffNameOnly: 'specs/quint/RULES.md\n',
          shortStat: ' 1 file changed, 1 insertion(+)',
          status: ' M specs/quint/RULES.md\n',
        }),
      )
      expect(out.mismatches.map((m) => m.kind)).toContain('restored-input-modified')
    })

    it('--verify-phase proofs：specs/lean/** 的還原輸入可以改寫，RULES.md 仍唯讀', () => {
      // 2026-10-29 真實 run 40809048823：Lean proofs 階段的工作就是改寫 statements 階段
      // 還原回來的 Specs/Proofs.lean（把 sorry 補成證明），卻被「還原輸入唯讀」判成
      // hard mismatch。proofs 階段因此允許 specs/lean/** 被改寫——但 RULES.md 是 G3
      // 簽核過的規則轉錄，兩個階段都必須唯讀。
      const restored = {
        'specs/lean/Specs/Proofs.lean': 'theorem t : True := sorry\n',
        'specs/lean/RULES.md': '# RULES\n',
      }
      const { target: proofsTarget, manifest: proofsManifest } = restoredFixture(restored)
      writeFileSync(join(proofsTarget, 'specs/lean/Specs/Proofs.lean'), 'theorem t : True := trivial\n')
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/lean/Specs/Proofs.lean'], changedLines: 1, requirements: undefined }),
      )
      const proofs = main(
        [
          '12', reportPath, '--target', proofsTarget, '--verify-only',
          '--restored-manifest', proofsManifest, '--verify-phase', 'proofs',
        ],
        verifyGit({
          diffNameOnly: 'specs/lean/Specs/Proofs.lean\n',
          shortStat: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
          status: ' M specs/lean/Specs/Proofs.lean\n',
        }),
      )
      expect(proofs.mismatches.map((m) => m.kind)).toEqual([])
      expect(proofs.ok).toBe(true)

      // RULES.md 在 proofs 階段仍然唯讀。
      const { target: rulesTarget, manifest: rulesManifest } = restoredFixture(restored)
      writeFileSync(join(rulesTarget, 'specs/lean/Specs/Proofs.lean'), 'theorem t : True := trivial\n')
      writeFileSync(join(rulesTarget, 'specs/lean/RULES.md'), '# RULES\n\n- 放寬\n')
      const rules = main(
        [
          '12', reportPath, '--target', rulesTarget, '--verify-only',
          '--restored-manifest', rulesManifest, '--verify-phase', 'proofs',
        ],
        verifyGit({
          diffNameOnly: 'specs/lean/RULES.md\nspecs/lean/Specs/Proofs.lean\n',
          shortStat: ' 2 files changed, 2 insertions(+), 1 deletion(-)',
          status: ' M specs/lean/RULES.md\n M specs/lean/Specs/Proofs.lean\n',
        }),
      )
      expect(rules.mismatches.map((m) => m.kind)).toContain('restored-input-modified')
      expect(rules.mismatches[0]?.detail).toContain('specs/lean/RULES.md')
    })

    it('--verify-phase proofs：G3-SIGNOFF.md 是服務端寫入的簽核證據，改寫即 restored-input-modified', () => {
      // 2026-10-31 獨立審查：agent 原本從「有 proofs 派工」推斷 G3 已簽核。現在 Worker 把
      // 簽核者與時間寫進 specs/lean/G3-SIGNOFF.md；proofs 階段雖可改寫 specs/lean/**，
      // 這個檔改了就等於偽造簽核，必須跟 RULES.md 一樣唯讀。
      const { target, manifest } = restoredFixture({
        'specs/lean/Specs/Proofs.lean': 'theorem t : True := sorry\n',
        'specs/lean/G3-SIGNOFF.md': '# G3\n- 簽核者（actor）：philipz\n',
      })
      writeFileSync(join(target, 'specs/lean/Specs/Proofs.lean'), 'theorem t : True := trivial\n')
      writeFileSync(join(target, 'specs/lean/G3-SIGNOFF.md'), '# G3\n- 簽核者（actor）：someone-else\n')
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/lean/Specs/Proofs.lean'], changedLines: 1, requirements: undefined }),
      )
      const result = main(
        [
          '12', reportPath, '--target', target, '--verify-only',
          '--restored-manifest', manifest, '--verify-phase', 'proofs',
        ],
        verifyGit({
          diffNameOnly: 'specs/lean/G3-SIGNOFF.md\nspecs/lean/Specs/Proofs.lean\n',
          shortStat: ' 2 files changed, 2 insertions(+), 2 deletions(-)',
          status: ' M specs/lean/G3-SIGNOFF.md\n M specs/lean/Specs/Proofs.lean\n',
        }),
      )
      expect(result.mismatches.map((m) => m.kind)).toContain('restored-input-modified')
      expect(result.mismatches.find((m) => m.kind === 'restored-input-modified')?.detail).toContain(
        'specs/lean/G3-SIGNOFF.md',
      )
    })

    it('--restored-manifest：agent 刪除還原輸入 → restored-input-modified（hard）', () => {
      const { target, manifest } = restoredFixture({
        'specs/quint/RULES.md': '# RULES\n',
        'specs/quint/TRIAGE.md': '# TRIAGE\n',
      })
      rmSync(join(target, 'specs/quint/TRIAGE.md'))
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 1, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', manifest],
        verifyGit({
          diffNameOnly: 'specs/quint/TRIAGE.md\nspecs/quint/model.qnt\n',
          shortStat: ' 2 files changed, 2 insertions(+), 3 deletions(-)',
          status: ' D specs/quint/TRIAGE.md\n?? specs/quint/model.qnt\n',
        }),
      )
      expect(out.ok).toBe(false)
      const modified = out.mismatches.find((m) => m.kind === 'restored-input-modified')
      expect(modified?.detail).toContain('specs/quint/TRIAGE.md')
      expect(modified?.detail).toMatch(/不存在|無法讀取/)
      // 未動的 RULES.md 照常扣除；被刪的那個留在 diff 裡
      expect(out.actual.paths).toEqual(['specs/quint/TRIAGE.md', 'specs/quint/model.qnt'])
    })

    it('--restored-manifest：manifest 的 sha256 不被信任——一律以磁碟重算，偽造雜湊 → mismatch', () => {
      const { target } = restoredFixture({ 'specs/quint/RULES.md': '# RULES\n' })
      writeFileSync(join(target, 'specs/quint/RULES.md'), '# tampered\n')
      const forged = join(dir, 'restored-forged.json')
      writeFileSync(
        forged,
        JSON.stringify({
          restored: [{ path: 'specs/quint/RULES.md', sha256: sha256('# forged claim\n') }],
        }),
      )
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 1, requirements: undefined }),
      )
      const out = main(
        ['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', forged],
        verifyGit({
          diffNameOnly: 'specs/quint/RULES.md\nspecs/quint/model.qnt\n',
          shortStat: ' 2 files changed, 2 insertions(+)',
        }),
      )
      expect(out.ok).toBe(false)
      expect(out.mismatches.map((m) => m.kind)).toContain('restored-input-modified')
      expect(out.mismatches.find((m) => m.kind === 'restored-input-modified')?.detail).toContain(
        'specs/quint/RULES.md',
      )
      // 沒有扣除：manifest 的數值不是「這個檔案沒被動」的證據
      expect(out.actual.paths).toEqual(['specs/quint/RULES.md', 'specs/quint/model.qnt'])
    })

    it('--restored-manifest：重複路徑 → CliError', () => {
      const entry = { path: 'specs/quint/RULES.md', sha256: sha256('# RULES\n') }
      const manifestPath = join(dir, 'restored-dup.json')
      // 兩筆同路徑（雜湊相同或不同都一樣）：扣除結果取決於處理順序，拒絕
      writeFileSync(manifestPath, JSON.stringify({ restored: [entry, { ...entry, sha256: sha256('other') }] }))
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      expect(() =>
        main(
          ['12', reportPath, '--target', 'target', '--verify-only', '--restored-manifest', manifestPath],
          verifyGit({}),
        ),
      ).toThrow(/重複路徑/)
    })

    it('--restored-manifest：舊版 {restored:[string]} 形狀被明確拒絕（不自動升級）', () => {
      const manifestPath = join(dir, 'restored-legacy.json')
      writeFileSync(manifestPath, JSON.stringify({ restored: ['specs/quint/RULES.md'] }))
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const run = (): unknown =>
        main(
          ['12', reportPath, '--target', 'target', '--verify-only', '--restored-manifest', manifestPath],
          verifyGit({}),
        )
      expect(run).toThrow(CliError)
      expect(run).toThrow(/舊版/)
      expect(run).toThrow(/sha256/)
      expect(run).toThrow(/restored-manifest/)
    })

    it('--restored-manifest：PBT 測試檔與 .lake/build 不得列為還原輸入（不得遮蔽 pbt-outside-audit／建置產物）', () => {
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const manifestPath = join(dir, 'restored-scope.json')
      const run = (payload: unknown): unknown => {
        writeFileSync(manifestPath, JSON.stringify(payload))
        return main(
          ['12', reportPath, '--target', 'target', '--verify-only', '--restored-manifest', manifestPath],
          verifyGit({}),
        )
      }
      for (const p of [
        'test/ledger.pbt.test.ts',
        'specs/quint/ledger.pbt.test.ts',
        'src/ledger.pbt.test.ts',
        'specs/lean/.lake/build/Ledger.olean',
        'specs/quint/.lake/build/trace.itf.json',
        'specs/lean/.lake/build/sub/x.olean',
      ]) {
        expect(() => run({ restored: [{ path: p, sha256: sha256('x') }] }), p).toThrow(/還原白名單/)
      }
      // 對照：普通測試檔與 specs 檔（非 PBT、非 .lake/build）仍是合法的還原輸入
      const { target, manifest } = restoredFixture({
        'test/ledger.test.ts': 'it("x", () => {})\n',
        'specs/quint/model.qnt': 'module M {}\n',
      })
      expect(() =>
        main(['12', reportPath, '--target', target, '--verify-only', '--restored-manifest', manifest], verifyGit({})),
      ).not.toThrow()
    })

    it('--restored-manifest：檔案不存在、非 JSON、形狀錯或含白名單外路徑 → hard error（不靜默忽略）', () => {
      writeFileSync(
        reportPath,
        makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 5, requirements: undefined }),
      )
      const path = join(dir, 'restored-bad.json')
      const run = (): ReturnType<typeof main> =>
        main(['12', reportPath, '--target', 'target', '--verify-only', '--restored-manifest', path], verifyGit({}))
      const good = { path: 'specs/quint/RULES.md', sha256: sha256('# RULES\n') }

      expect(() =>
        main(['12', reportPath, '--target', 'target', '--verify-only', '--restored-manifest', join(dir, 'nope.json')], verifyGit({})),
      ).toThrow(/restored-manifest/)
      for (const bad of [
        'not json',
        'null',
        '42',
        '"x"',
        '[]',
        '{}',
        '{"restored":"specs/quint/RULES.md"}',
        '{"restored":{}}',
        JSON.stringify({ restored: [null] }),
        JSON.stringify({ restored: [42] }),
        JSON.stringify({ restored: [['specs/quint/RULES.md']] }),
        JSON.stringify({ restored: [{ path: 'specs/quint/RULES.md' }] }),
        JSON.stringify({ restored: [{ sha256: good.sha256 }] }),
        JSON.stringify({ restored: [{ path: 42, sha256: good.sha256 }] }),
        JSON.stringify({ restored: [{ path: 'specs/quint/RULES.md', sha256: 42 }] }),
        JSON.stringify({ restored: [{ path: 'specs/quint/RULES.md', sha256: 'abc' }] }),
        JSON.stringify({ restored: [{ path: 'specs/quint/RULES.md', sha256: good.sha256.toUpperCase() }] }),
        JSON.stringify({ restored: [{ path: 'src/app.ts', sha256: good.sha256 }] }),
        // C1：`.github` segment 一律拒絕，連 specs 樹內也一樣（機制資產）
        JSON.stringify({ restored: [{ path: 'specs/.github/workflows/x.yml', sha256: good.sha256 }] }),
        JSON.stringify({ restored: [{ path: '../escape.md', sha256: good.sha256 }] }),
        JSON.stringify({ restored: [{ path: '/etc/passwd', sha256: good.sha256 }] }),
      ]) {
        writeFileSync(path, bad)
        expect(() => run(), bad).toThrow(/restored-manifest/)
      }
      // 路徑字串本身不合還原端規則：空、反斜線、NUL、空／. segment、.git
      for (const p of ['', 'specs\\x', 'specs/a\0b', 'specs//x', 'specs/./x', 'specs/.git/x']) {
        const payload = JSON.stringify({ restored: [{ path: p, sha256: good.sha256 }] })
        writeFileSync(path, payload)
        expect(() => run(), payload).toThrow(/restored-manifest/)
      }
    })

    it('R13 整合：還原的 RULES.md／TRIAGE.md 不算未回報變更；不帶旗標時重現 diff-not-reported 假紅', () => {
      const repo = mkdtempSync(join(tmpdir(), 'crosscheck-verify-restored-'))
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo })
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'base'],
          { cwd: repo },
        )
        mkdirSync(join(repo, 'specs', 'quint'), { recursive: true })
        // factory-verify-input 還原的階段輸入（未追蹤檔）
        writeFileSync(join(repo, 'specs', 'quint', 'RULES.md'), '# RULES\n')
        writeFileSync(join(repo, 'specs', 'quint', 'TRIAGE.md'), '# TRIAGE\n')
        // agent 的交付
        writeFileSync(join(repo, 'specs', 'quint', 'model.qnt'), 'module Model {}\n')
        const manifest = join(dir, 'restored-integration.json')
        writeFileSync(
          manifest,
          JSON.stringify({
            restored: [
              { path: 'specs/quint/RULES.md', sha256: sha256('# RULES\n') },
              { path: 'specs/quint/TRIAGE.md', sha256: sha256('# TRIAGE\n') },
            ],
          }),
        )
        writeFileSync(
          reportPath,
          makeReport({ changedPaths: ['specs/quint/model.qnt'], changedLines: 1, requirements: undefined }),
        )

        const withFlag = main([
          '12',
          reportPath,
          '--target',
          repo,
          '--base',
          'HEAD',
          '--verify-only',
          '--restored-manifest',
          manifest,
        ])
        expect(withFlag.ok).toBe(true)
        expect(withFlag.actual.paths).toEqual(['specs/quint/model.qnt'])

        const withoutFlag = main(['12', reportPath, '--target', repo, '--base', 'HEAD', '--verify-only'])
        expect(withoutFlag.ok).toBe(false)
        const mismatch = withoutFlag.mismatches.find((m) => m.kind === 'diff-not-reported')
        expect(mismatch).toBeDefined()
        expect(mismatch?.detail).toContain('specs/quint/RULES.md')
        expect(mismatch?.detail).toContain('specs/quint/TRIAGE.md')
        expect(mismatch?.detail).not.toContain('model.qnt')

        // 唯讀規則（R15）：agent 改動還原輸入後，同一份 manifest 不再扣除它
        writeFileSync(join(repo, 'specs/quint/RULES.md'), '# RULES（被 agent 改寫）\n')
        const tampered = main([
          '12',
          reportPath,
          '--target',
          repo,
          '--base',
          'HEAD',
          '--verify-only',
          '--restored-manifest',
          manifest,
        ])
        expect(tampered.ok).toBe(false)
        expect(tampered.mismatches.map((m) => m.kind)).toContain('restored-input-modified')
        expect(
          tampered.mismatches.find((m) => m.kind === 'restored-input-modified')?.detail,
        ).toContain('specs/quint/RULES.md')
        // 未動的 TRIAGE.md 仍被扣除
        expect(tampered.actual.paths).toEqual(['specs/quint/RULES.md', 'specs/quint/model.qnt'])
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })

    it('--verify-only 與其他僅產出模式／--variant 併用 → CliError（兩套規則不可同時生效）', () => {
      expect(() => parseArgs(['12', 'r.json', '--verify-only', '--analyze-only'])).toThrow(/不可同時指定/)
      expect(() => parseArgs(['12', 'r.json', '--verify-only', '--write-spec-phase', 'invariants'])).toThrow(
        /不可同時指定/,
      )
      expect(() => parseArgs(['12', 'r.json', '--verify-only', '--variant', 'a', '--remote-branches', 'rb.txt'])).toThrow(
        /--variant/,
      )
      // 只給 --remote-branches（沒有 --variant）也一樣：驗證模式沒有分支事實來源
      expect(() => parseArgs(['12', 'r.json', '--verify-only', '--remote-branches', 'rb.txt'])).toThrow(/--variant/)
    })

    it('--restored-manifest：需有值、且只適用於 --verify-only', () => {
      expect(
        parseArgs(['12', 'r.json', '--verify-only', '--restored-manifest', '.factory/verify-restored.json'])
          .restoredManifestPath,
      ).toBe('.factory/verify-restored.json')
      expect(parseArgs(['12', 'r.json', '--verify-only']).restoredManifestPath).toBeUndefined()
      expect(() => parseArgs(['12', 'r.json', '--restored-manifest', 'm.json'])).toThrow(/--verify-only/)
      expect(() => parseArgs(['12', 'r.json', '--verify-only', '--restored-manifest'])).toThrow(/requires a path/)
      expect(() => parseArgs(['12', 'r.json', '--verify-only', '--restored-manifest', '--base', 'main'])).toThrow(
        /requires a path/,
      )
    })
  })
})

/**
 * C2（final whole-branch review）：驗證模式的 diff 基準必須是「agent 啟動前」的
 * 不可變 commit。
 *
 * `git diff <base>` 的 `<base>` 是本地分支名；驗證 agent 依 R2 可以本地 commit，
 * commit 一前進 `<base>`（agent 就在該分支上），diff 立刻變空：
 *   - 合規 agent 的交付消失 → no-trace／reported-not-in-diff 假紅；
 *   - 越界 agent 的變更消失 → 白名單完全繞過（假綠）。
 * 修法（R19）：workflow 在 agent 之前把 HEAD 寫到 target 外的 `.factory/base-sha`，
 * 兩個 CLI 以 `--base-sha <40-hex>` 使用該 commit，忽略分支名。
 */
describe('驗證模式的不可變 diff 基準（--base-sha，R19／C2）', () => {
  const repos: string[] = []
  let reportPath: string

  const gitIn = (repo: string, ...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const commit = (repo: string, message: string): void => {
    gitIn(repo, 'add', '-A')
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
  }
  const write = (repo: string, rel: string, content: string): void => {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const newRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'crosscheck-base-sha-'))
    repos.push(repo)
    gitIn(repo, 'init', '-q', '-b', 'main')
    write(repo, 'README.md', '# fixture\n')
    commit(repo, 'base')
    return repo
  }
  const report = (partial: Record<string, unknown>): string => {
    writeFileSync(reportPath, makeReport({ requirements: undefined, ...partial }))
    return reportPath
  }

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-base-sha-report-'))
    repos.push(dir)
    reportPath = join(dir, 'report.json')
  })
  afterAll(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
  })

  it('--base-sha 看到 agent 在 base 分支上的 commit；不傳時重現空 diff（假紅）', () => {
    const repo = newRepo()
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    write(repo, 'test/x.test.ts', 'it("x", () => {})\n')
    commit(repo, 'agent commit on base branch')

    const withSha = main([
      '12',
      report({ changedPaths: ['specs/quint/model.qnt', 'test/x.test.ts'], changedLines: 2 }),
      '--target',
      repo,
      // 分支名刻意不存在：--base-sha 存在時必須忽略分支名（R19）
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ])
    expect(withSha.actual.paths.sort()).toEqual(['specs/quint/model.qnt', 'test/x.test.ts'])
    expect(withSha.mismatches).toEqual([])
    expect(withSha.ok).toBe(true)

    const withoutSha = main([
      '12',
      report({ changedPaths: ['specs/quint/model.qnt', 'test/x.test.ts'], changedLines: 2 }),
      '--target',
      repo,
      '--base',
      'HEAD',
      '--verify-only',
    ])
    expect(withoutSha.actual.paths).toEqual([])
    expect(withoutSha.ok).toBe(false)
    expect(withoutSha.mismatches.map((m) => m.kind)).toContain('no-trace')
  })

  it('--base-sha 讓已 commit 的越界變更現形 → verify-scope（不傳時被 commit 藏住）', () => {
    const repo = newRepo()
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'src/app.ts', 'export const answer = 42\n')
    commit(repo, 'agent commit: out-of-scope source change')
    const reportPathForScope = report({ changedPaths: ['src/app.ts'], changedLines: 1 })

    const withSha = main([
      '12',
      reportPathForScope,
      '--target',
      repo,
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ])
    expect(withSha.ok).toBe(false)
    expect(withSha.mismatches.map((m) => m.kind)).toContain('verify-scope')
    expect(withSha.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain('src/app.ts')

    const withoutSha = main(['12', reportPathForScope, '--target', repo, '--base', 'HEAD', '--verify-only'])
    expect(withoutSha.actual.paths).toEqual([])
    expect(withoutSha.mismatches.map((m) => m.kind)).toContain('no-trace')
  })

  it('R24：`git mv` 後 commit——被刪的 src/app.ts 仍在 git 事實裡並被判越界（rename 偵測不得只列新路徑）', () => {
    const repo = newRepo()
    write(repo, 'src/app.ts', 'export const answer = 42\n')
    commit(repo, 'base source file')
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    // 100% 改名：git 預設 rename 偵測顯示成單一 R100，`--name-only` 只列新路徑。
    mkdirSync(join(repo, 'test'), { recursive: true })
    gitIn(repo, 'mv', 'src/app.ts', 'test/app.test.ts')
    commit(repo, 'agent rename')

    const out = main([
      '12',
      report({ changedPaths: ['test/app.test.ts'], changedLines: 1 }),
      '--target',
      repo,
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ])

    // 新測試檔是 agent 的交付，必須留在事實裡（report 比對與 bundle 都靠它）；
    // 被改名的產品檔則必須以刪除現形，否則 verify-scope 白名單被繞過。
    expect(out.actual.paths).toEqual(['src/app.ts', 'test/app.test.ts'])
    expect(out.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain('src/app.ts')
    expect(out.ok).toBe(false)
  })

  it('R24 containment：沒有改名的 repo，事實與白名單結果不變（--no-renames 不改變一般 diff）', () => {
    const repo = newRepo()
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    write(repo, 'test/existing.test.ts', 'it("x", () => {})\n')
    commit(repo, 'base fixtures')
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'specs/quint/model.qnt', 'module Model {}\nmodule Aux {}\n')
    write(repo, 'test/new.test.ts', 'it("y", () => {})\n')
    commit(repo, 'agent changes')

    const out = main([
      '12',
      report({ changedPaths: ['specs/quint/model.qnt', 'test/new.test.ts'], changedLines: 2 }),
      '--target',
      repo,
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ])

    expect(out.actual).toEqual({
      branches: [],
      paths: ['specs/quint/model.qnt', 'test/new.test.ts'],
      added: 2,
      deleted: 0,
      uncommitted: [],
      assertionDelta: 0,
    })
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('--base-sha 需為 40-hex、只適用於 --verify-only、且必須解析得到 commit', () => {
    const sha = 'a'.repeat(40)
    expect(parseArgs(['12', 'r.json', '--verify-only', '--base-sha', sha]).baseSha).toBe(sha)
    expect(parseArgs(['12', 'r.json', '--verify-only']).baseSha).toBeUndefined()
    expect(() => parseArgs(['12', 'r.json', '--base-sha', sha])).toThrow(/--verify-only/)
    expect(() => parseArgs(['12', 'r.json', '--verify-only', '--base-sha'])).toThrow(/--base-sha/)
    expect(() => parseArgs(['12', 'r.json', '--verify-only', '--base-sha', 'abc123'])).toThrow(/40-hex/)
    expect(() => parseArgs(['12', 'r.json', '--verify-only', '--base-sha', 'g'.repeat(40)])).toThrow(/40-hex/)
    // 合法形狀但不存在於 repo：main 必須 fail-loud，不得默默退回分支名
    const repo = newRepo()
    writeFileSync(reportPath, makeReport({ changedPaths: [], changedLines: 0, requirements: undefined }))
    expect(() =>
      main(['12', reportPath, '--target', repo, '--verify-only', '--base-sha', 'f'.repeat(40)]),
    ).toThrow(/base-sha/)
  })
})

/**
 * N1（third fix wave）：`--base-sha` 不得被 `git replace` 改寫。
 *
 * `git diff` 預設會套用 `refs/replace/*`：agent 在 target/ 內執行
 * `git replace <base-sha> <fake-commit>` 之後，crosscheck 看到的是「fake 基準 vs
 * HEAD」的 diff——真正的越界變更（例如 src/app.ts）可以整批消失，白名單形同被繞過。
 * 修法：兩個 CLI 的**所有** git 子行程都經同一個 helper，helper 強制
 * `GIT_NO_REPLACE_OBJECTS=1`（並以 /dev/null 隔離 global／system config）。
 */
describe('N1：git replace refs 不得改寫 --base-sha 的事實', () => {
  const repos: string[] = []
  let reportPath: string

  const gitIn = (repo: string, ...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const commit = (repo: string, message: string): void => {
    gitIn(repo, 'add', '-A')
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
  }
  const write = (repo: string, rel: string, content: string): void => {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const newRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'crosscheck-replace-'))
    repos.push(repo)
    gitIn(repo, 'init', '-q', '-b', 'main')
    write(repo, 'README.md', '# fixture\n')
    commit(repo, 'base')
    return repo
  }
  const report = (partial: Record<string, unknown>): string => {
    writeFileSync(reportPath, makeReport({ requirements: undefined, ...partial }))
    return reportPath
  }

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-replace-report-'))
    repos.push(dir)
    reportPath = join(dir, 'report.json')
  })
  afterAll(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
  })

  it('fake base tree（含 src/app.ts、缺 agent 測試檔）→ 真實變更仍現形，src 越界照樣被擋', () => {
    const repo = newRepo()
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    write(repo, 'src/app.ts', 'export const answer = 42\n')
    write(repo, 'test/agent.test.ts', 'it("agent", () => {})\n')
    commit(repo, 'agent changes')
    // fake base = 真實 HEAD 的樹再拿掉 agent 的測試檔。套用 replace 後，diff 只剩
    // 測試檔——src/app.ts 看起來「本來就有」，正是繞過白名單的攻擊。
    gitIn(repo, 'checkout', '-q', '-b', 'fake-base', 'HEAD')
    rmSync(join(repo, 'test/agent.test.ts'))
    commit(repo, 'fake base tree')
    const fake = gitIn(repo, 'rev-parse', 'HEAD').trim()
    gitIn(repo, 'checkout', '-q', 'main')
    gitIn(repo, 'replace', preAgent, fake)

    const out = main([
      '12',
      report({
        changedPaths: ['specs/quint/model.qnt', 'src/app.ts', 'test/agent.test.ts'],
        changedLines: 3,
      }),
      '--target',
      repo,
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ])

    expect(out.actual.paths.sort()).toEqual(['specs/quint/model.qnt', 'src/app.ts', 'test/agent.test.ts'])
    expect(out.mismatches.map((m) => m.kind)).toContain('verify-scope')
    expect(out.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain('src/app.ts')
  })

  it('git replace <base> HEAD → diff 不得變空（否則已 commit 的合規交付被判 no-trace）', () => {
    const repo = newRepo()
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    write(repo, 'test/agent.test.ts', 'it("agent", () => {})\n')
    commit(repo, 'agent commit on base branch')
    gitIn(repo, 'replace', preAgent, 'HEAD')

    const out = main([
      '12',
      report({ changedPaths: ['specs/quint/model.qnt', 'test/agent.test.ts'], changedLines: 2 }),
      '--target',
      repo,
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ])

    expect(out.actual.paths.sort()).toEqual(['specs/quint/model.qnt', 'test/agent.test.ts'])
    expect(out.mismatches.map((m) => m.kind)).not.toContain('no-trace')
  })

  it('global core.pager／diff.external 不得改變輸出（temp HOME）', () => {
    const repo = newRepo()
    const preAgent = gitIn(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'test/agent.test.ts', 'it("agent", () => {})\nexpect(1).toBe(1)\n')
    commit(repo, 'agent test')
    const argv = [
      '12',
      report({ changedPaths: ['test/agent.test.ts'], changedLines: 2 }),
      '--target',
      repo,
      '--base',
      'does-not-exist',
      '--verify-only',
      '--base-sha',
      preAgent,
    ]
    const clean = main(argv)

    const home = mkdtempSync(join(tmpdir(), 'crosscheck-hostile-home-'))
    repos.push(home)
    writeFileSync(
      join(home, '.gitconfig'),
      '[core]\n\tpager = /bin/false\n[diff]\n\texternal = /bin/false\n',
    )
    const savedHome = process.env.HOME
    process.env.HOME = home
    try {
      const hostile = main(argv)
      expect(hostile.actual).toEqual(clean.actual)
      expect(hostile).toEqual(clean)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })
})

/**
 * N4（fourth fix wave）：repo-local 的 git 檔案面不得改變驗證事實。
 *
 * N1 只關掉 global／system config、pager 與 external diff。agent 在 target/ 內有
 * shell，因此還能寫 `.git/config`、`.git/info/attributes`、`.git/info/exclude` 與
 * 工作區 `.gitattributes`，而 crosscheck 在 agent **之後**才跑（它的步驟握有 WRITE
 * App token）：任何一個 repo-local 設定只要能在事實收集時執行程式碼，就等於把 token
 * 交給 agent。五個實證攻擊（各自一個測試）：
 *
 *   1. `diff.<driver>.textconv`＋`.git/info/attributes` → `git diff --unified=0` 執行
 *      agent 的 script（`--no-ext-diff` 擋不到 textconv）。
 *   2. `core.fsmonitor` → `git status` 執行 agent 的 script。
 *   3. `core.worktree=/tmp/fake` → diff 比對假的樹，真實越界變更消失（白名單被繞過）。
 *   4. `.git/info/exclude`（或 global ignore）＝`*` → 未追蹤交付從 status／ls-files 消失。
 *   5. `.gitattributes` 的 `* -diff` → diff 說「Binary files differ」，
 *      assertion 淨減被算成 0（`assertion-delta-understated` 被繞過）。
 *
 * 最後一個測試是 containment：沒有敵意設定的正常 repo，事實輸出必須與硬化前相同。
 */
describe('N4：repo-local git config／attributes／exclude 不得改變驗證事實', () => {
  const repos: string[] = []
  let reportPath: string

  const gitIn = (repo: string, ...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const commit = (repo: string, message: string): void => {
    gitIn(repo, 'add', '-A')
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
  }
  const write = (root: string, rel: string, content: string): void => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const newRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'crosscheck-repo-config-'))
    repos.push(repo)
    gitIn(repo, 'init', '-q', '-b', 'main')
    write(repo, 'README.md', '# fixture\n')
    commit(repo, 'base')
    return repo
  }
  const head = (repo: string): string => gitIn(repo, 'rev-parse', 'HEAD').trim()
  const report = (partial: Record<string, unknown>): string => {
    writeFileSync(reportPath, makeReport({ requirements: undefined, ...partial }))
    return reportPath
  }
  /** 敵意 script：先寫 marker（證明它真的被執行），再跑 body。 */
  const hostileScript = (name: string, body: string): { path: string; marker: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-hostile-script-'))
    repos.push(dir)
    const path = join(dir, `${name}.sh`)
    const marker = join(dir, `${name}.marker`)
    writeFileSync(path, `#!/bin/sh\nprintf ran > '${marker}'\n${body}\n`)
    chmodSync(path, 0o755)
    return { path, marker }
  }
  const verifyArgs = (
    repo: string,
    baseSha: string,
    changedPaths: string[],
    changedLines: number,
    extra: Record<string, unknown> = {},
  ): string[] => [
    '12',
    report({ changedPaths, changedLines, ...extra }),
    '--target',
    repo,
    // 分支名刻意不存在：--base-sha 存在時必須忽略它（R19）
    '--base',
    'does-not-exist',
    '--verify-only',
    '--base-sha',
    baseSha,
  ]

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-config-report-'))
    repos.push(dir)
    reportPath = join(dir, 'report.json')
  })
  afterAll(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
  })

  it('diff.<driver>.textconv＋.git/info/attributes：agent 的 script 不得被 diff 執行', () => {
    const repo = newRepo()
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    commit(repo, 'base model')
    const preAgent = head(repo)
    const evil = hostileScript('textconv', "printf 'converted\\n'")
    write(repo, '.git/info/attributes', 'specs/quint/model.qnt diff=evil\n')
    gitIn(repo, 'config', 'diff.evil.textconv', evil.path)
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n// agent tweak\n')

    const out = main(verifyArgs(repo, preAgent, ['specs/quint/model.qnt'], 1))

    // 攻擊成立時 marker 會被建立：script 在 crosscheck 的 diff 期間執行過（可讀 GH_TOKEN）。
    expect(existsSync(evil.marker)).toBe(false)
    expect(out.actual.paths).toContain('specs/quint/model.qnt')
  })

  it('core.fsmonitor：agent 的 script 不得被 git status 執行', () => {
    const repo = newRepo()
    const preAgent = head(repo)
    const evil = hostileScript('fsmonitor', 'exit 0')
    gitIn(repo, 'config', 'core.fsmonitor', evil.path)
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')

    const out = main(verifyArgs(repo, preAgent, ['specs/quint/model.qnt'], 1))

    expect(existsSync(evil.marker)).toBe(false)
    expect(out.actual.paths).toContain('specs/quint/model.qnt')
  })

  it('core.worktree=/tmp/fake：diff 不得改看假工作樹而藏住 src/app.ts', () => {
    const repo = newRepo()
    write(repo, 'src/app.ts', 'export const answer = 1\n')
    commit(repo, 'base app')
    const preAgent = head(repo)
    // 假工作樹保有 base 版的 src/app.ts：core.worktree 生效時 diff 會是空的。
    const fake = mkdtempSync(join(tmpdir(), 'crosscheck-fake-worktree-'))
    repos.push(fake)
    write(fake, 'src/app.ts', 'export const answer = 1\n')
    gitIn(repo, 'config', 'core.worktree', fake)
    write(repo, 'src/app.ts', 'export const answer = 2\n')

    const out = main(verifyArgs(repo, preAgent, ['src/app.ts'], 1))

    expect(out.actual.paths).toContain('src/app.ts')
    expect(out.mismatches.map((m) => m.kind)).toContain('verify-scope')
    expect(out.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain('src/app.ts')
  })

  it('.git/info/exclude＝*：未追蹤的 specs/quint/model.qnt 仍必須現形', () => {
    const repo = newRepo()
    const preAgent = head(repo)
    write(repo, '.git/info/exclude', '*\n')
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')

    const out = main(verifyArgs(repo, preAgent, ['specs/quint/model.qnt'], 1))

    expect(out.actual.paths).toEqual(['specs/quint/model.qnt'])
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('$XDG_CONFIG_HOME/git/ignore（global ignore 預設路徑）＝*：未追蹤交付仍必須現形', () => {
    const repo = newRepo()
    const preAgent = head(repo)
    const xdg = mkdtempSync(join(tmpdir(), 'crosscheck-hostile-xdg-'))
    repos.push(xdg)
    write(xdg, 'git/ignore', '*\n')
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    const savedXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = xdg
    try {
      const out = main(verifyArgs(repo, preAgent, ['specs/quint/model.qnt'], 1))
      expect(out.actual.paths).toEqual(['specs/quint/model.qnt'])
      expect(out.mismatches).toEqual([])
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
    }
  })

  it('.gitattributes 的 `* -diff`：assertion 淨減仍必須被實算（不得變成 Binary files）', () => {
    const repo = newRepo()
    write(repo, 'test/x.test.ts', 'expect(1).toBe(1)\nexpect(2).toBe(2)\nexpect(3).toBe(3)\n')
    write(repo, '.gitattributes', '* -diff\n')
    commit(repo, 'base with -diff attributes')
    const preAgent = head(repo)
    write(repo, 'test/x.test.ts', 'expect(1).toBe(1)\n')

    const out = main(verifyArgs(repo, preAgent, ['test/x.test.ts'], 2, { assertionDelta: 0 }))

    // 真實 delta 是 -2（3 條斷言 → 1 條）；0 是「Binary files differ」的假象。
    expect(out.actual.assertionDelta).toBeLessThan(0)
    expect(out.mismatches.map((m) => m.kind)).toContain('assertion-delta-understated')
  })

  it('containment：沒有敵意設定的正常 repo，事實輸出與硬化前相同', () => {
    const repo = newRepo()
    const preAgent = head(repo)
    write(repo, 'specs/quint/model.qnt', 'module Model {}\n')
    write(repo, 'test/agent.test.ts', 'expect(1).toBe(1)\nexpect(2).toBe(2)\n')
    commit(repo, 'agent commit')
    write(repo, 'specs/quint/untracked.qnt', 'module Untracked {}\n')

    const out = main(
      verifyArgs(
        repo,
        preAgent,
        ['specs/quint/model.qnt', 'specs/quint/untracked.qnt', 'test/agent.test.ts'],
        3,
      ),
    )

    expect(out.actual.paths.sort()).toEqual([
      'specs/quint/model.qnt',
      'specs/quint/untracked.qnt',
      'test/agent.test.ts',
    ])
    expect(out.actual.added).toBe(3)
    expect(out.actual.deleted).toBe(0)
    expect(out.actual.assertionDelta).toBe(2)
    expect(out.actual.uncommitted).toEqual(['specs/quint/untracked.qnt'])
    expect(out.actual.branches).toEqual([])
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })
})

/**
 * R25（wave 6）：verify 模式的 crosscheck 改吃 `factory-verify-facts` 產出的
 * facts JSON，**不再對 agent 工作樹跑任何 git 命令**。target 的 clean filter／
 * index flags／ignore 檔因此沒有執行或說謊的機會。
 */
describe('驗證模式的 facts JSON（--facts，R25）', () => {
  const dirs: string[] = []
  const sha = 'a'.repeat(40)

  const factsFile = (partial: Record<string, unknown> = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-facts-'))
    dirs.push(dir)
    const path = join(dir, 'verify-facts.json')
    writeFileSync(
      path,
      JSON.stringify({
        baseSha: sha,
        changed: [],
        linesAdded: 0,
        linesDeleted: 0,
        assertionDelta: 0,
        ...partial,
      }),
    )
    return path
  }

  const reportFile = (partial: Record<string, unknown> = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-facts-report-'))
    dirs.push(dir)
    const path = join(dir, 'report.json')
    writeFileSync(path, makeReport({ requirements: undefined, ...partial }))
    return path
  }

  const neverGit: GitRunner = () => {
    throw new Error('帶 --facts 時不得呼叫 git（R25）')
  }

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('parseArgs：--facts 需有值、只適用於 --verify-only、且必須搭配 --base-sha', () => {
    const facts = 'facts.json'
    expect(parseArgs(['12', 'r.json', '--verify-only', '--base-sha', sha, '--facts', facts]).factsPath).toBe(facts)
    expect(parseArgs(['12', 'r.json', '--verify-only']).factsPath).toBeUndefined()
    expect(() => parseArgs(['12', 'r.json', '--facts', facts])).toThrow(/--verify-only/)
    expect(() => parseArgs(['12', 'r.json', '--verify-only', '--facts', facts])).toThrow(/--base-sha/)
    expect(() => parseArgs(['12', 'r.json', '--verify-only', '--base-sha', sha, '--facts'])).toThrow(/requires/)
    expect(() =>
      parseArgs(['12', 'r.json', '--verify-only', '--base-sha', sha, '--facts', '--base', 'main']),
    ).toThrow(/requires/)
  })

  it('main 只消費 facts，不呼叫 git；實際值＝facts 的 changed／行數／斷言', () => {
    const facts = factsFile({
      changed: [
        { path: 'test/new.test.ts', status: 'A' },
        { path: 'specs/quint/model.qnt', status: 'M' },
      ],
      linesAdded: 7,
      linesDeleted: 2,
      assertionDelta: 3,
    })
    const out = main(
      ['12', reportFile({ changedPaths: ['test/new.test.ts', 'specs/quint/model.qnt'], changedLines: 9 }), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
      neverGit,
    )
    expect(out.actual).toEqual({
      branches: [],
      paths: ['test/new.test.ts', 'specs/quint/model.qnt'],
      added: 7,
      deleted: 2,
      uncommitted: [],
      assertionDelta: 3,
    })
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('status D 的越界刪除仍在事實裡（verify-scope 不得被吃掉）', () => {
    const facts = factsFile({ changed: [{ path: 'src/app.ts', status: 'D' }], linesDeleted: 3 })
    const out = main(
      ['12', reportFile({ changedPaths: ['src/app.ts'], changedLines: 3 }), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
      neverGit,
    )
    expect(out.actual.paths).toEqual(['src/app.ts'])
    expect(out.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain('src/app.ts')
    expect(out.ok).toBe(false)
  })

  it('防禦性過濾 neutralised 路徑的「刪除」（舊 facts 的 tracked .dsh 刪除不得 red）', () => {
    const facts = factsFile({
      changed: [
        { path: '.dsh/skills/x/SKILL.md', status: 'D' },
        { path: '.agents/skills/x/SKILL.md', status: 'D' },
        { path: 'AGENTS.md', status: 'D' },
        { path: 'AGENTS.local.md', status: 'D' },
        { path: 'nested/CLAUDE.local.md', status: 'D' },
        { path: 'test/new.test.ts', status: 'A' },
      ],
      linesAdded: 1,
    })
    const out = main(
      ['12', reportFile({ changedPaths: ['test/new.test.ts'], changedLines: 1 }), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
      neverGit,
    )
    expect(out.actual.paths).toEqual(['test/new.test.ts'])
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('R26 (d)：neutralised 路徑的「新增」不是刪除——保留並判 verify-scope（不得靜默吞掉）', () => {
    const facts = factsFile({
      changed: [{ path: '.dsh/skills/selfauth/SKILL.md', status: 'A' }],
      linesAdded: 2,
    })
    const out = main(
      ['12', reportFile({ changedPaths: ['.dsh/skills/selfauth/SKILL.md'], changedLines: 2 }), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
      neverGit,
    )
    expect(out.actual.paths).toEqual(['.dsh/skills/selfauth/SKILL.md'])
    expect(out.ok).toBe(false)
    expect(out.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain(
      '.dsh/skills/selfauth/SKILL.md',
    )
  })

  it('R26 (d)：neutralised 路徑落在 specs 白名單內也不得放行（verify-neutralised-path）', () => {
    const facts = factsFile({
      changed: [{ path: 'specs/lean/AGENTS.md', status: 'A' }],
      linesAdded: 1,
    })
    const out = main(
      ['12', reportFile({ changedPaths: ['specs/lean/AGENTS.md'], changedLines: 1 }), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
      neverGit,
    )
    const finding = out.mismatches.find((m) => m.kind === 'verify-neutralised-path')
    expect(finding?.category).toBe('scope')
    expect(finding?.detail).toContain('specs/lean/AGENTS.md')
    expect(out.ok).toBe(false)
  })

  it('R26 (d) 對照組：specs 內的正常新增仍是白名單允許（不誤紅）', () => {
    const facts = factsFile({
      changed: [{ path: 'specs/lean/Spec.lean', status: 'A' }],
      linesAdded: 1,
    })
    const out = main(
      ['12', reportFile({ changedPaths: ['specs/lean/Spec.lean'], changedLines: 1 }), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
      neverGit,
    )
    expect(out.mismatches).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('--base-sha 與 facts.baseSha 不一致 → CliError（不得默認其中一個）', () => {
    const facts = factsFile({ baseSha: 'b'.repeat(40) })
    expect(() =>
      main(
        ['12', reportFile(), '--target', 'target', '--verify-only', '--base-sha', sha, '--facts', facts],
        neverGit,
      ),
    ).toThrow(/base-sha.*facts/i)
  })
})
