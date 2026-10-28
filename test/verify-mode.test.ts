/**
 * 驗證模式判定（ADR-029 §5、§6 修訂 ADR-013）。
 *
 * 這支 CLI 是 base_branch guard 的唯一實作：非驗證類仍不得為 main；驗證類
 * 改以目標 repo 的預設分支為準（過渡期容許 software-factory），並豁免
 * catalog／risk-paths／factory-stage prereqs 三項要求。判定錯誤的後果是
 * 「驗證類跑不動」或「非驗證類碰了 main」——兩者都不會有第二次訊號，故以
 * 單元測試釘住全部六個欄位。
 */
import { describe, expect, it } from 'vitest'
import {
  decideVerifyMode,
  main,
  parseArgs,
  VERIFY_LEGACY_BASE_BRANCH,
} from '../src/cli/factory-verify-mode.js'
import { CliError } from '../src/cli/run-cli.js'

/** 既有的一般類型（ADR-013 不變）。 */
const NON_VERIFY = ['agent-add-tests', 'agent-fix-bug', 'agent-write-spec', 'agent-pbt-audit'] as const

/** 四個驗證階段（ADR-029 §5；順序即流程順序，見 verify-task-types.ts）。 */
const VERIFY = ['agent-verify-grill', 'agent-verify-quint', 'agent-verify-lean', 'agent-verify-tests'] as const

describe('decideVerifyMode：非驗證 task（ADR-013 原規則不變）', () => {
  for (const taskType of NON_VERIFY) {
    it(`${taskType} ＋ software-factory → 允許，catalog／risk-paths／stage prereqs 仍必需`, () => {
      expect(decideVerifyMode({ taskType, baseBranch: 'software-factory', defaultBranch: 'main' })).toEqual({
        verify: false,
        baseBranchAllowed: true,
        requiresCatalog: true,
        requiresRiskPaths: true,
        requiresStagePrereqs: true,
        error: null,
      })
    })

    it(`${taskType} ＋ main → 擋下並回可讀 error（main 絕不觸碰）`, () => {
      const d = decideVerifyMode({ taskType, baseBranch: 'main', defaultBranch: 'main' })
      expect(d.verify).toBe(false)
      expect(d.baseBranchAllowed).toBe(false)
      expect(d.requiresCatalog).toBe(true)
      expect(d.error).toContain('main')
      expect(d.error).toContain('ADR-013')
    })
  }

  it('預設分支不是 main 時，非驗證類仍不得用 main（defaultBranch 不影響規則）', () => {
    const d = decideVerifyMode({ taskType: 'agent-add-tests', baseBranch: 'main', defaultBranch: 'develop' })
    expect(d.baseBranchAllowed).toBe(false)
    expect(d.error).not.toBeNull()
  })
})

describe('decideVerifyMode：未知 task type（預設安全＝非驗證規則）', () => {
  it('未知名稱 → verify=false 且三項要求為 true、允許非 main 分支', () => {
    expect(decideVerifyMode({ taskType: 'agent-unknown', baseBranch: 'software-factory', defaultBranch: 'main' })).toEqual({
      verify: false,
      baseBranchAllowed: true,
      requiresCatalog: true,
      requiresRiskPaths: true,
      requiresStagePrereqs: true,
      error: null,
    })
  })

  it('未知名稱 ＋ main → 以非驗證規則擋下（不可因拼錯而繞過 guard）', () => {
    const d = decideVerifyMode({ taskType: 'agent-unknown', baseBranch: 'main', defaultBranch: 'main' })
    expect(d.verify).toBe(false)
    expect(d.baseBranchAllowed).toBe(false)
    expect(d.error).toContain('main')
  })
})

describe('decideVerifyMode：驗證 task（ADR-029 §6 guard 豁免）', () => {
  for (const taskType of VERIFY) {
    it(`${taskType} ＋ 目標 repo 預設分支 → 允許，三項要求全為 false`, () => {
      expect(decideVerifyMode({ taskType, baseBranch: 'main', defaultBranch: 'main' })).toEqual({
        verify: true,
        baseBranchAllowed: true,
        requiresCatalog: false,
        requiresRiskPaths: false,
        requiresStagePrereqs: false,
        error: null,
      })
    })

    it(`${taskType} ＋ 預設分支不是 main（例如 develop）→ 以 defaultBranch 為準`, () => {
      const d = decideVerifyMode({ taskType, baseBranch: 'develop', defaultBranch: 'develop' })
      expect(d.baseBranchAllowed).toBe(true)
      expect(d.error).toBeNull()
    })

    it(`${taskType} ＋ 過渡期相容值 software-factory → 允許`, () => {
      const d = decideVerifyMode({ taskType, baseBranch: VERIFY_LEGACY_BASE_BRANCH, defaultBranch: 'main' })
      expect(d.verify).toBe(true)
      expect(d.baseBranchAllowed).toBe(true)
      expect(d.error).toBeNull()
    })

    it(`${taskType} ＋ 其他分支 → 擋下並回 error（列出允許值）`, () => {
      const d = decideVerifyMode({ taskType, baseBranch: 'feature/x', defaultBranch: 'main' })
      expect(d.verify).toBe(true)
      expect(d.baseBranchAllowed).toBe(false)
      expect(d.error).toContain(taskType)
      expect(d.error).toContain('main')
      expect(d.error).toContain(VERIFY_LEGACY_BASE_BRANCH)
      // 驗證類即使被擋下，仍不回頭要求 catalog／risk-paths／stage prereqs
      expect(d.requiresCatalog).toBe(false)
      expect(d.requiresRiskPaths).toBe(false)
      expect(d.requiresStagePrereqs).toBe(false)
    })
  }
})

describe('parseArgs', () => {
  it('三個旗標皆必填，解析為決定函式的輸入', () => {
    expect(parseArgs(['--task-type', 'agent-verify-lean', '--base-branch', 'main', '--default-branch', 'main'])).toEqual({
      taskType: 'agent-verify-lean',
      baseBranch: 'main',
      defaultBranch: 'main',
    })
  })

  it('旗標順序不影響結果', () => {
    expect(
      parseArgs(['--default-branch', 'develop', '--task-type', 'agent-add-tests', '--base-branch', 'software-factory']),
    ).toEqual({ taskType: 'agent-add-tests', baseBranch: 'software-factory', defaultBranch: 'develop' })
  })

  it('缺旗標 → CliError（不得靜默套用預設值：預設值會讓 guard 判錯分支）', () => {
    expect(() => parseArgs(['--task-type', 'agent-add-tests', '--base-branch', 'software-factory'])).toThrow(CliError)
    expect(() => parseArgs(['--base-branch', 'software-factory', '--default-branch', 'main'])).toThrow(/task-type/)
    expect(() => parseArgs(['--task-type', 'agent-add-tests', '--default-branch', 'main'])).toThrow(/base-branch/)
    expect(() => parseArgs(['--task-type', 'agent-add-tests', '--base-branch', 'x'])).toThrow(/default-branch/)
  })

  it('空字串與缺值 → CliError', () => {
    expect(() => parseArgs(['--task-type', '', '--base-branch', 'x', '--default-branch', 'y'])).toThrow(/task-type/)
    expect(() => parseArgs(['--task-type', 'agent-add-tests', '--base-branch', '--default-branch', 'y'])).toThrow(
      /base-branch/,
    )
    // 旗標在 argv 結尾、完全沒有值（value === undefined）也要擋下
    expect(() => parseArgs(['--task-type', 'agent-add-tests', '--base-branch', 'x', '--default-branch'])).toThrow(
      /default-branch/,
    )
  })

  it('未知參數 → CliError（不吞掉打錯的旗標）', () => {
    expect(() =>
      parseArgs(['--task-type', 'agent-add-tests', '--base-branch', 'x', '--default-branch', 'y', '--skip-guard']),
    ).toThrow(/unknown argument/)
  })
})

describe('main', () => {
  it('把 CLI 參數接到 decideVerifyMode（workflow 讀 stdout 的 JSON）', () => {
    expect(main(['--task-type', 'agent-verify-tests', '--base-branch', 'main', '--default-branch', 'main'])).toEqual({
      verify: true,
      baseBranchAllowed: true,
      requiresCatalog: false,
      requiresRiskPaths: false,
      requiresStagePrereqs: false,
      error: null,
    })
  })
})
