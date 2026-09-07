import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadReport, main } from './factory-judge.js'
import { CliError } from './run-cli.js'

let tmp: string
/** M7 需要跑完整 main()，故備妥最小 catalog / risk-paths fixture。 */
let catalog: string
let riskPaths: string

/** 寫一個暫存 report.json 並回傳路徑；`content` 為字串時原樣寫入（用於壞格式）。 */
function report(name: string, content: unknown): string {
  const path = join(tmp, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-judge-mutation-'))
  catalog = join(tmp, 'catalog-info.yaml')
  writeFileSync(
    catalog,
    [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: demo',
      '  annotations:',
      '    factory.io/business-criticality: tactical',
      '    factory.io/risk-profile: low',
      '    factory.io/complexity: low',
      '',
    ].join('\n'),
  )
  riskPaths = join(tmp, 'risk-paths.yml')
  writeFileSync(
    riskPaths,
    ['hard_rules:', '  H1: ["src/auth/**"]', '  H5: [".github/**", ".dsh/skills/**"]', ''].join('\n'),
  )
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Mutation-strength tests for `loadReport` (docs/06 §5.1、docs/14 觀察期試跑 #45)。
 *
 * `loadReport` 用 zod 驗證 agent 自己寫出的 report.json——這份檔案是外部且
 * 不可信的輸入，任何「選填欄位型別被放寬」的變異都會讓一次壞格式的 report
 * 被寬容地讀入，進而可能把一次未真正執行的 run 判成 completed 或
 * ready-to-automerge。src/cli/** 是 CI gate，需 100% branch 覆蓋，因此這裡的
 * 挑戰不在行覆蓋（既有套件已是 100%），而在釘住 zod 對「選填欄位型別」的
 * 型別看守——行覆蓋測不出型別契約，只有型別變異測得出。
 *
 * Mutation log（以手工編輯 src/cli/factory-judge.ts 套用變異、重跑本檔變紅、
 * 再還原變綠的方式驗證）：
 *
 *  | ID | Mutation（放寬 ReportSchema / InvocationSchema 對選填欄位的型別看守）| Before | After |
 *  |----|-------------------------------------------------------------------------|--------|-------|
 *  | M1 | `changedPaths` 陣列元素 `z.string()` 放寬成 `z.string().or(z.number())` | GREEN  | RED   |
 *  | M2 | `changedLines` 由 `z.number()` 放寬成 `z.union([z.number(), z.string()])`| GREEN  | RED   |
 *  | M3 | `invocation.timedOut` 由 `z.boolean()` 放寬成 `union(…, z.string())`     | GREEN  | RED   |
 *  | M4 | `hasAcceptanceCriteria` 由 `z.boolean()` 放寬成 `union(…, z.string())`   | GREEN  | RED   |
 *
 * "Before" = 既有套件（src/cli/factory-judge.test.ts，24 則）；"After" = 加上
 * 本檔。M1–M4 在既有套件下全是全綠（存活變異）：既有測試只測「欄位缺席」與
 * 「欄位完全錯誤的型別」（如 `changedPaths: 'str'`），從未傳過「元素 / 型別
 * 含糊」的垃圾值，因此這四條選填欄位的型別契約完全未被釘住。本檔把每個欄位
 * 的型別看守錨定下來，讓這四類放寬變異在合併後無法悄悄溜進 CI。
 *
 * 驗證方式（與 parse-args-mutation.test.ts / rescore-mutation.test.ts 同）：
 * 手改 factory-judge.ts 套用變異 → `npx vitest run
 * src/cli/factory-judge-mutation.test.ts` 變紅 → 還原 → 變綠（四個變異均已
 * 實測確認，見 Issue #59 留言）。
 */

describe('M1 變異：changedPaths 陣列元素型別被放寬成 string-or-number', () => {
  /**
   * `changedPaths` 是「改了哪些檔」的路徑字串陣列。若元素型別看守放寬成
   * 也接受數字，agent 誤報 `changedPaths: [123]` 會被寬容讀入，計分時可能
   * 找不到匹配路徑而低估風險。既有套件只驗證「不是陣列」（字串）會失敗，
   * 從未驗證「陣列內元素型別」——放寬後仍全綠，此段將其釘住。
   */
  it('changedPaths 帶數字元素 → CliError，不接受型別含糊的陣列', () => {
    expect(() =>
      loadReport(
        report('m1.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          changedPaths: [123],
        }),
      ),
    ).toThrow(CliError)
  })

  it('正常字串陣列仍被接受（錨定，避免過度收緊）', () => {
    const r = loadReport(
      report('m1-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        changedPaths: ['src/a.ts'],
      }),
    )
    expect(r.changedPaths).toEqual(['src/a.ts'])
  })
})

describe('M2 變異：changedLines 型別被放寬成 number-or-string', () => {
  /**
   * `changedLines` 是變更行數（數字）。若放寬成也接受字串，agent 回報
   * `changedLines: '12'` 會被當成合法但型別錯的值，後續計分可能把字串當
   * 數字比對而失真。既有套件從未以字串傳入，放寬後全綠——此段錨定它必須
   * 是數字。
   */
  it('changedLines 帶字串 → CliError，不接受字串當行數', () => {
    expect(() =>
      loadReport(
        report('m2.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          changedLines: '12',
        }),
      ),
    ).toThrow(CliError)
  })

  it('數字行數仍被接受（錨定）', () => {
    const r = loadReport(
      report('m2-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        changedLines: 12,
      }),
    )
    expect(r.changedLines).toBe(12)
  })
})

describe('M3 變異：invocation.timedOut 型別被放寬成 boolean-or-string', () => {
  /**
   * `invocation.timedOut` 是「是否逾時」的布林旗標，直接決定 DSH 判讀是否
   * 走 needs-human 路徑（見 factory-judge.test.ts「逾時的 invocation →
   * needs-human」）。若放寬成也接受字串，agent 回報 `timedOut: 'yes'` 會被
   * 判成非逾時（缺少真正的布林 true），把一次逾時 run 誤判成別的終態——
   * 這是「未真正執行的 run 被當成 completed」的典型漏洞。既有套件只測過
   * 布林 true，此段釘住型別看守。
   */
  it('invocation.timedOut 帶字串 → CliError，不接受字串旗標', () => {
    expect(() =>
      loadReport(
        report('m3.json', {
          issueNumber: 1,
          invocation: { timedOut: 'yes' },
        }),
      ),
    ).toThrow(CliError)
  })

  it('布林 timedOut 仍被接受（錨定）', () => {
    const r = loadReport(
      report('m3-ok.json', {
        issueNumber: 1,
        invocation: { timedOut: true },
      }),
    )
    expect(r.invocation.timedOut).toBe(true)
  })
})

describe('M4 變異：hasAcceptanceCriteria 型別被放寬成 boolean-or-string', () => {
  /**
   * `hasAcceptanceCriteria: false` 是 SR4（驗收條件不明確）停手訊號（見
   * factory-judge.test.ts「hasAcceptanceCriteria: false → SR4 停手」）。若放寬
   * 成也接受字串，agent 回報 `hasAcceptanceCriteria: 'no'` 時，只有真正布林
   * false 才觸發停手，字串值會被判成「有判準」而放行不該放走的 run。既有
   * 套件只測過布林 false，此段錨定兩值必須是布林。
   */
  it('hasAcceptanceCriteria 帶字串 → CliError，不接受字串旗標', () => {
    expect(() =>
      loadReport(
        report('m4.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          hasAcceptanceCriteria: 'no',
        }),
      ),
    ).toThrow(CliError)
  })

  it('布林 hasAcceptanceCriteria 仍被接受（錨定）', () => {
    const r = loadReport(
      report('m4-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        hasAcceptanceCriteria: false,
      }),
    )
    expect(r.hasAcceptanceCriteria).toBe(false)
  })
})

describe('M5 變異：requirements 條目的 status 型別被放寬成 string', () => {
  /**
   * `requirements[{id,status}]` 是 G8 需求追蹤（docs/20 B1）的證據槽——status
   * 只能是 passed/failed/skipped 三態，crosscheck 據此驗證「每條驗收條件都有一個
   * 明確狀態」。若 status 型別看守放寬成任意字串（如 `z.string()`），agent 誤報
   * `status: 'maybe'` 會被寬容讀入，「狀態齊全」的驗證即被空洞值繞過。既有套件
   * 只測「status 缺席」與「enum 之外的值」，此段錨定 enum 必須是封閉三態。
   */
  it('requirements.status 帶 enum 之外的字串 → CliError', () => {
    expect(() =>
      loadReport(
        report('m5.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          requirements: [{ id: 'R1', status: 'maybe' }],
        }),
      ),
    ).toThrow(CliError)
  })

  it('三態 status 仍被接受（錨定，避免過度收緊）', () => {
    const r = loadReport(
      report('m5-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        requirements: [
          { id: 'R1', status: 'passed' },
          { id: 'R2', status: 'failed' },
          { id: 'R3', status: 'skipped' },
        ],
      }),
    )
    expect(r.requirements?.map((x) => x.status)).toEqual(['passed', 'failed', 'skipped'])
  })
})

/**
 * M6 變異：`skillGap.category` 的 kebab-case regex 被放寬成任意字串。
 *
 * category 是 docs/25 §2.2 的**聚類鍵**，而 §3 的提案門檻是「同 category
 * ≥3 次」。若 regex 被放寬，`MonorepoTestPath`／`monorepo_test_path`／
 * `monorepo test path` 會各自成為獨立分類——同一個缺口被拆成三份計數，
 * 永遠達不到門檻，整條技能擴增迴圈靜默失效（docs/25 §7 已列此為已知風險）。
 * 這種劣化不會讓任何行為測試變紅，只有型別/格式變異測得出。
 */
describe('M6 變異：skillGap.category 的 kebab-case 看守被放寬', () => {
  it('大駝峰 category → CliError', () => {
    expect(() =>
      loadReport(
        report('m6-camel.json', {
          issueNumber: 1,
          invocation: { exitCode: 0 },
          skillGap: { category: 'MonorepoTestPath', needed: 'x' },
        }),
      ),
    ).toThrow(CliError)
  })

  it('底線與空白 category → CliError', () => {
    for (const [i, bad] of ['monorepo_test_path', 'monorepo test path'].entries()) {
      expect(() =>
        loadReport(
          report(`m6-sep-${i}.json`, {
            issueNumber: 1,
            invocation: { exitCode: 0 },
            skillGap: { category: bad, needed: 'x' },
          }),
        ),
      ).toThrow(CliError)
    }
  })

  it('合法 kebab-case 仍被接受（錨定，避免過度收緊）', () => {
    const r = loadReport(
      report('m6-ok.json', {
        issueNumber: 1,
        invocation: { exitCode: 0 },
        skillGap: { category: 'monorepo-test-path', needed: 'x' },
      }),
    )
    expect(r.skillGap?.category).toBe('monorepo-test-path')
  })
})

/**
 * M7 變異：`skillGap` 被接進 pipeline 判定（例如在 toAgentRun 中傳遞）。
 *
 * 這是本欄位最重要的安全契約（docs/20 E4 設計決策 D-2）：skillGap 是 agent
 * **自報**的訊號，若它能影響終態，agent 就多了一個「宣稱缺技能即改變判定」
 * 的施力點——與 docs/06 §5.1「agent 無權參與判定」直接牴觸。
 *
 * 釘法：同一份 report 加不加 skillGap，`main()` 的判定結果必須**逐欄相同**。
 * 若有人日後把 skillGap 接進 AgentRun 或計分，本測試立刻變紅。
 */
describe('M7 變異：skillGap 洩漏進 pipeline 判定', () => {
  it('加上 skillGap 不改變任何終態判定（outcome / labels / stopDecision）', () => {
    const base = {
      issueNumber: 201,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/util/format.test.ts'],
      changedLines: 40,
      assertionDelta: 6,
      hasAcceptanceCriteria: true,
    }
    const without = main([report('m7-without.json', base), catalog, riskPaths])
    const withGap = main([
      report('m7-with.json', { ...base, skillGap: { category: 'a-b', needed: 'x', context: 'y' } }),
      catalog,
      riskPaths,
    ])
    expect(withGap.result).toEqual(without.result)
  })

  it('needs-human 情境下加 skillGap 同樣不改變判定', () => {
    const base = {
      issueNumber: 202,
      invocation: { exitCode: 1, stdout: '', stderr: 'boom' },
    }
    const without = main([report('m7-nh-without.json', base), catalog, riskPaths])
    const withGap = main([
      report('m7-nh-with.json', { ...base, skillGap: { category: 'c-d', needed: 'z' } }),
      catalog,
      riskPaths,
    ])
    expect(withGap.result).toEqual(without.result)
  })
})
