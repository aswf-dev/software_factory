/**
 * factory-crosscheck — 把 agent 自報的 report.json 與目標 repo 的實際 git diff
 * 交叉驗證（docs/18 §2.3，G3）。
 *
 * 動機：report.json 是 agent 自報（外部且不可信）。judge 的 zod 只驗證形狀、
 * 不驗證真實性——若 agent 在 changedPaths/changedLines 上漏報或造假，SR6/SR4/
 * 重計分全部建立在錯誤輸入上。本 CLI 用 git 事實交叉檢查報告的變更主張，
 * mismatch 即 fail-loud（exit 1）→ CI 貼 needs-human。
 *
 * 檢查的對象是「報告是否反映實際發生的變更」，不是「變更是否正確」——後者仍由
 * CI 與人類審查判定（docs/02 D4）。
 *
 * 資料來源（全部為目標 repo checkout 內的本地事實，無網路依賴）：
 *   - 本地分支 factory/<issue>-* 與 factory/<issue>/*（agent 以 gh stack 建立；
 *     docs/07 §3.2 兩種命名皆涵蓋）
 *   - 各分支相對 base 的三點 diff（--name-only / --shortstat）
 *   - 工作樹狀態（--porcelain）——成功執行後不應殘留未提交變更
 *
 * 有意不做的檢查：changedLines 的數值精確比對（agent 的計數口徑可能不同，
 * 會誤傷）；PR 是否真的推送（需網路，且 factory-rescore 已在 PR 層獨立重計分）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { countAssertionDelta } from '../assertion-count/count.js'
import { adviseUnreportedSkillGap, type UnreportedTrigger } from '../skill-gap/unreported.js'
import { isValidSpecName } from '../write-spec/intake.js'
import {
  checkClosingKeywords,
  checkOpenQuestions,
  checkSourceSnapshot,
  checkSpecScope,
  specPaths,
  type SpecPhase,
} from '../write-spec/scope.js'
import { checkPbtAuditScope, checkPbtOutsideAudit } from '../pbt-audit/scope.js'
import { ReportSchema } from './factory-judge.js'
import { isMainModule } from './is-main-module.js'
import { CliError, formatCliError } from './run-cli.js'

export interface CrosscheckActual {
  /** 本地存在的 factory/<issue>-* 分支名。 */
  branches: string[]
  /** 全部分支相對 base 的 union 變更路徑（已排除 .factory/**，後續過濾）。 */
  paths: string[]
  /** 全部分支的 added 行數總和（--shortstat）。 */
  added: number
  /** 全部分支的 deleted 行數總和。 */
  deleted: number
  /** 工作樹未提交變更的路徑（--porcelain）。 */
  uncommitted: string[]
  /**
   * CI **實算**的測試斷言淨增減（`src/assertion-count`），對照 report 自報的
   * `assertionDelta`。無分支時為 0。
   *
   * 取**各分支的最小值**，不是總和：stacked PR 的 02-impl 相對 base 已包含
   * 01-test 的變更，相加會把同一批斷言算兩次，而且能讓「01 加 5、02 淨減 1」
   * 合出正數 +4，把真正的淨減少藏起來。取最小值對單分支完全精確，對堆疊分支
   * 則倒向「任一分支看起來在刪斷言就算數」——安全方向。
   */
  assertionDelta: number
}

/**
 * mismatch 的性質：
 * - `scope`：變更超出任務類型允許的範圍（政策違規）。report 可能完全誠實，問題在「做了不該做的事」。
 * - `consistency`：report 與實際 git 事實不一致，或其他完整性檢查未通過。
 * 兩者的處置不同（前者要改工單或改規則，後者要查 agent 的回報），留言標題必須分開，
 * 否則人會往錯的方向查（philipz/fubon-tradingbot#654：報告誠實，標題卻寫「不一致」）。
 */
export type MismatchCategory = 'scope' | 'consistency'

export interface CrosscheckMismatch {
  kind: string
  detail: string
  /** main() 輸出前填入；內部比對函式不必設定。 */
  category?: MismatchCategory | undefined
}

/** 白名單類（任務類型允許的變更範圍）的 mismatch kind；其餘（含未知）一律視為 consistency。 */
export const SCOPE_MISMATCH_KINDS: ReadonlySet<string> = new Set([
  'pbt-outside-audit',
  'pbt-audit-scope',
  'pbt-audit-deletion',
  'analyze-code-change',
  'propose-skill-scope',
  'onboard-scope',
  'write-spec-scope',
])

export function categorizeMismatch(kind: string): MismatchCategory {
  return SCOPE_MISMATCH_KINDS.has(kind) ? 'scope' : 'consistency'
}

/** 留言與 ::error:: 的標題；沒有 mismatch 時為空字串。 */
export function crosscheckHeadline(mismatches: readonly CrosscheckMismatch[]): string {
  const scope = mismatches.some((m) => categorizeMismatch(m.kind) === 'scope')
  const consistency = mismatches.some((m) => categorizeMismatch(m.kind) === 'consistency')
  if (scope && consistency) return '變更超出任務類型允許的範圍，且 report 與實際變更不一致'
  if (scope) return '變更超出任務類型允許的範圍'
  if (consistency) return 'report 與實際變更不一致'
  return ''
}

export interface CrosscheckOutput {
  issueNumber: number
  ok: boolean
  report: { changedPaths: string[] | undefined; changedLines: number | undefined }
  actual: CrosscheckActual
  mismatches: CrosscheckMismatch[]
  /** 留言與 ::error:: 用的標題（見 crosscheckHeadline）；ok 時為空字串。 */
  headline: string
  /**
   * Advisory 發現：**不影響 `ok`、不擋 run**（REQ id 錨定第一階段）。
   *
   * 與 mismatches 分開存放是刻意的：DoD 條目由自由文字解析而來，解析規則與
   * agent 的理解可能有正當落差，直接 fail-loud 會製造大量假陽性，重蹈
   * `defect/*` 標記「機制存在但被繞過」的覆轍（docs/14 §1、docs/25 §7）。
   * 先觀察真實落差率，再由人類裁決是否升為紅燈。
   */
  advisories: CrosscheckMismatch[]
}
/** git 命令注入點（測試以 fake 取代）；cwd 為目標 repo checkout。 */
export type GitRunner = (args: string[], cwd?: string) => string

/* v8 ignore start -- 真實 git 二進位的薄包裝：單元測試一律注入 fake runner */
export const realGit: GitRunner = (args, cwd) => {
  return execFileSync('git', args, { encoding: 'utf8', cwd })
}
/* v8 ignore stop */

/** 把 `git for-each-ref --format=%(refname:short)` 的輸出切成分支名清單。 */
export function parseForEachRefOutput(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** 把 `git diff --name-only` 的輸出切成路徑清單。 */
export function parseDiffNameOnly(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * 把 `git diff --shortstat` 的輸出切成 {added, deleted}。
 * 輸出格式（insertions/deletions 可能缺一或全缺）：
 *   " 2 files changed, 30 insertions(+), 5 deletions(-)"
 *   " 1 file changed, 10 insertions(+)"
 *   " 1 file changed"
 *   ""（無變更）
 */
export function parseShortStat(output: string): { added: number; deleted: number } {
  const changed = output.match(/(\d+) files? changed/)
  if (changed === null) return { added: 0, deleted: 0 }
  const add = output.match(/(\d+) insertions?\(\+\)/)
  const del = output.match(/(\d+) deletions?\(-\)/)
  return { added: add === null ? 0 : Number(add[1]), deleted: del === null ? 0 : Number(del[1]) }
}

/** 把 `git status --porcelain` 的輸出切成路徑清單（每行最後一個欄位；rename 取新路徑）。 */
export function parseStatusPorcelain(output: string): string[] {
  const out: string[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const tokens = trimmed.split(/\s+/)
    // tokens 恆非空（trimmed 非空）；slice(-1)[0] 即最後欄位
    out.push(tokens.slice(-1)[0] as string)
  }
  return out
}

/** 把路徑正規化：去前後空白、去開頭的 `./`。 */
export function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '')
}

/** report 的內部產物（.factory/**）不算「變更」，兩側比對前都要排除。 */
export function isFactoryInternal(p: string): boolean {
  return p.startsWith('.factory/')
}

/** 把 report 的 changedPaths 正規化並排除 .factory/**。undefined = 未回報 → []。 */
export function collectReportedPaths(changedPaths: readonly string[] | undefined): string[] {
  if (changedPaths === undefined) return []
  const out: string[] = []
  for (const p of changedPaths) {
    const n = normalizePath(p)
    if (n.length > 0 && !isFactoryInternal(n)) out.push(n)
  }
  return out
}

/**
 * 比較 report 的變更主張與 git 事實，回傳 mismatch 清單（空 = 一致）。
 * 方向刻意雙向：回報了不存在的變更（假完成）與存在卻未回報的變更（隱藏變更）
 * 同樣危險，都要交還人類。
 */
export function compareReportToActual(
  report: {
    changedPaths?: readonly string[] | undefined
    changedLines?: number | undefined
    assertionDelta?: number | undefined
    requirements?: readonly { id: string; status: string }[] | undefined
  },
  actual: CrosscheckActual,
  analyzeOnly = false,
  proposeSkillOnly = false,
  onboardOnly = false,
): CrosscheckMismatch[] {
  const mismatches: CrosscheckMismatch[] = []
  const reported = collectReportedPaths(report.changedPaths)
  const actualPaths = actual.paths.filter((p) => !isFactoryInternal(p))
  const hasDiff = actualPaths.length > 0
  const actualTotal = actual.added + actual.deleted

  // agent-analyze（docs/20 C1）：僅分析不實作——變更只允許 docs/**（報告檔）。
  // 任何 src/、設定、測試變更都是型別契約違反，fail-loud 交還人類。
  if (analyzeOnly) {
    const forbidden = actualPaths.filter((p) => !p.startsWith('docs/'))
    if (forbidden.length > 0) {
      mismatches.push({
        kind: 'analyze-code-change',
        detail: `analyze 模式（僅分析不實作）只允許 docs/ 下的報告檔，實際 diff 含非文件變更：${forbidden.join('、')}`,
      })
    }
  }

  // agent-propose-skill（E6、ADR-016 §3 閘門 1）：只允許 proposals/skills/** 與 docs/**。
  //
  // **這是 ADR-016 的安全樞紐**。提案之所以安全，是因為 proposals/ 不在任何 DSH
  // 探索 rank 上（rank 100=.dsh/skills、200=.agents/skills、300=custom、
  // 400=user-dsh、500=user-agents），因此**誤合併也不會生效**——此推論已於
  // 2026-09-06 以真實 dsh headless 呼叫實測確認（對照組 .dsh/skills 下的探針被
  // 發現、proposals/ 下的探針未被發現）。
  //
  // 若 agent 能繞道寫進 .dsh/skills/**，它就能自訂自己的行為準則並自我放行，
  // 直接推翻 docs/05 §1.1「agent 不得鬆綁自身約束」與 docs/06 §4.3。
  // 因此這裡是 allowlist（白名單）而非 blocklist：未明列者一律拒絕。
  if (proposeSkillOnly) {
    const forbidden = actualPaths.filter(
      (p) => !p.startsWith('proposals/skills/') && !p.startsWith('docs/'),
    )
    if (forbidden.length > 0) {
      mismatches.push({
        kind: 'propose-skill-scope',
        detail: `propose-skill 模式只允許 proposals/skills/ 與 docs/ 下的變更，實際 diff 含越界變更：${forbidden.join('、')}`,
      })
    }
  }

  // agent-onboard（納管分析）：只允許 proposals/onboarding/** 與 docs/**。
  //
  // **賭注高於 ADR-016**。納管當下目標 repo 尚無 catalog-info.yaml 與
  // risk-paths.yml——也就是說**還沒有任何人審過這個 repo 的風險評級**。
  // 若 agent 能把分析結果直接寫進正位，它就是在自己宣告自己的監督等級，
  // 之後所有工作項的計分都建立在這份未經裁定的自我宣告上，
  // docs/05 §1.1 的核心不變量（agent 不得修改 guardrail 本身）當場失效。
  //
  // proposals/onboarding/ 之所以安全，理由與 ADR-016 同構但更直接：
  // 它**不是任何機制的讀取路徑**——factory-score 讀 catalog-info.yaml、
  // factory-run 讀 .github/factory/risk-paths.yml，兩者都不會看 proposals/。
  // 因此誤合併也不改變任何評級；三軸必須由人類親手搬檔才會生效，
  // 而搬檔的人必然看過內容（這正是監督模型賴以成立的那個動作）。
  //
  // 同樣是 allowlist：未明列者一律拒絕，且不與 proposals/skills/ 互穿
  //（兩者是不同型別的提案通道，互穿等於型別契約失效）。
  if (onboardOnly) {
    const forbidden = actualPaths.filter(
      (p) => !p.startsWith('proposals/onboarding/') && !p.startsWith('docs/'),
    )
    if (forbidden.length > 0) {
      mismatches.push({
        kind: 'onboard-scope',
        detail:
          `onboard 模式只允許 proposals/onboarding/ 與 docs/ 下的變更，實際 diff 含越界變更：${forbidden.join('、')}` +
          '。catalog-info.yaml 與 .github/factory/risk-paths.yml 必須由人類審核後親手搬檔至正位',
      })
    }
  }

  // SR6 的反向鎖（`src/assertion-count`）。SR6「絕不允許為通過測試而弱化斷言」
  // 的輸入是 agent 自報的 assertionDelta，而該欄位是 .optional()——**漏填就等於
  // SR6 從未存在**。這裡只鎖住那一個會讓 SR6 被繞過的方向：實算為負、自報卻沒有
  // 說負。反方向（自報比實算保守）與任何數值差異都不進 mismatch，見
  // adviseAssertionDelta：跨語言計數是啟發式的，比對數值必然假陽性連發。
  if (actual.assertionDelta < 0 && !(report.assertionDelta !== undefined && report.assertionDelta < 0)) {
    const reportedText =
      report.assertionDelta === undefined ? '未回報' : `回報 ${report.assertionDelta}`
    mismatches.push({
      kind: 'assertion-delta-understated',
      detail:
        `CI 實算測試斷言淨減少 ${Math.abs(actual.assertionDelta)} 條，report 卻${reportedText}` +
        '——SR6（不得為通過測試而弱化斷言）的輸入與實際不符，交還人類',
    })
  }

  if (reported.length > 0 && !hasDiff && actual.branches.length === 0 && actual.uncommitted.length === 0) {
    mismatches.push({
      kind: 'no-trace',
      detail: `報告宣稱變更 ${reported.length} 個檔案，但找不到 factory/<issue>-* 分支、diff 為空且工作樹無變更——疑似假完成`,
    })
  }
  if (hasDiff && reported.length === 0) {
    mismatches.push({
      kind: 'unreported-changes',
      detail: `git diff 有 ${actualPaths.length} 個檔案但 report 未回報任何 changedPaths`,
    })
  }
  const reportedNotInActual = reported.filter((p) => !actualPaths.includes(p))
  if (reportedNotInActual.length > 0) {
    mismatches.push({
      kind: 'reported-not-in-diff',
      detail: `回報了未出現在實際 diff 的檔案：${reportedNotInActual.join('、')}`,
    })
  }
  const actualNotInReported = actualPaths.filter((p) => !reported.includes(p))
  if (actualNotInReported.length > 0) {
    mismatches.push({
      kind: 'diff-not-reported',
      detail: `實際 diff 有未回報的檔案：${actualNotInReported.join('、')}`,
    })
  }
  if (hasDiff && (report.changedLines === undefined || report.changedLines === 0)) {
    mismatches.push({
      kind: 'lines-missing',
      detail: `diff 非空（合計 ${actualTotal} 行）但 report 未回報變更行數`,
    })
  }
  if (!hasDiff && report.changedLines !== undefined && report.changedLines > 0) {
    mismatches.push({
      kind: 'lines-without-diff',
      detail: `report 宣稱變更 ${report.changedLines} 行但 diff 為空`,
    })
  }
  if (actual.uncommitted.length > 0) {
    mismatches.push({
      kind: 'uncommitted-changes',
      detail: `工作樹仍有未提交變更：${actual.uncommitted.join('、')}`,
    })
  }
  // G8（docs/18 §4、docs/20 B1）：requirements[{id,status}] 是「驗收條件→測試/實作→
  // status」的證據槽。有實質變更卻未回報 requirements，或條目 id/status 為空，
  // 都是靜默缺漏——crosscheck 必須 fail-loud，不讓「每條驗收條件一個明確狀態」
  // 的契約被空值矇混。注意：shape（型別/enum）已由 ReportSchema 的 zod 收緊，
  // 此處只管內容完備性（有 diff 卻未回報、blank id/status）。
  if (hasDiff) {
    const reqs = report.requirements ?? []
    if (reqs.length === 0) {
      mismatches.push({
        kind: 'requirements-missing',
        detail: `diff 非空（含 ${actualPaths.length} 個檔案）但 report 未回報 requirements（G8 需求追蹤證據槽）`,
      })
    } else if (reqs.some((r) => r.id.trim() === '' || r.status.trim() === '')) {
      mismatches.push({
        kind: 'requirements-incomplete',
        detail: 'requirements 存在條目但 id 或 status 為空——每條驗收條件必須有一個明確狀態',
      })
    }
  }
  return mismatches
}

/**
 * REQ id 錨定比對（**advisory，不影響 ok**）。
 *
 * G8 只驗 `requirements` 存在且非空，不驗 id 是否對應真實驗收條件——agent 可回報
 * `{id:"req-1"}` 而該 id 不指向任何 DoD 條目，形式通過但語意落空。本函式比對
 * `factory-issue-check` 回寫 Issue 的 `REQ-n` 錨點。
 *
 * 回傳 advisory 而非 mismatch 的理由見 `CrosscheckOutput.advisories`。
 *
 * @param anchors Issue 留言宣告的合法 id；**空陣列代表無錨點可比**（Issue 未經
 *                新版 issue-check 檢查過），此時不發話——沒有基準就不該指控。
 */
export function compareRequirementIds(
  reported: readonly { id: string; status: string }[] | undefined,
  anchors: readonly string[],
): CrosscheckMismatch[] {
  if (anchors.length === 0) return []
  const reqs = reported ?? []
  if (reqs.length === 0) return []

  const known = new Set(anchors)
  const unknown = reqs.map((r) => r.id).filter((id) => !known.has(id))
  const covered = new Set(reqs.map((r) => r.id))
  const uncovered = anchors.filter((id) => !covered.has(id))

  const out: CrosscheckMismatch[] = []
  if (unknown.length > 0) {
    out.push({
      kind: 'requirements-unknown-id',
      detail: `report 回報了未出現在 Issue 錨點的 id：${unknown.join('、')}（合法錨點：${anchors.join('、')}）`,
    })
  }
  if (uncovered.length > 0) {
    out.push({
      kind: 'requirements-uncovered',
      detail: `Issue 的驗收條件未被 report 涵蓋：${uncovered.join('、')}`,
    })
  }
  return out
}

/**
 * 自報 `assertionDelta` 與 CI 實算落差的 **advisory** 面（危險的那一面在
 * `compareReportToActual` 的 `assertion-delta-understated`）。
 *
 * 只在「自報說淨減少、實算沒有」時發話。這是**安全方向**——自報比實算保守，
 * SR6 會照常觸發、沒有任何規則被繞過——所以它不擋 run，只作為觀察期的落差訊號：
 * 若這一類長期偏高，代表計數樣式漏認了某個框架，該補的是 `ASSERTION_PATTERNS`。
 *
 * 數值差異一律不發話。跨語言的斷言計數是啟發式的，數值相等比對會製造大量假陽性，
 * 而假陽性會訓練人忽略訊號（`docs/25` §7「紀律失效」是同一個失敗模式）。
 */
export function adviseAssertionDelta(
  reported: number | undefined,
  measured: number,
): CrosscheckMismatch[] {
  if (measured < 0) return [] // 危險方向由 mismatch 處理，不重複發話
  if (reported === undefined || reported >= 0) return []
  return [
    {
      kind: 'assertion-delta-overstated',
      detail:
        `report 回報測試斷言淨減少 ${Math.abs(reported)} 條，CI 實算為 ${measured}` +
        '——安全方向（SR6 仍會觸發），但計數樣式可能漏認了該專案的測試框架',
    },
  ]
}

/**
 * 判定本次 run 是否落在「該回報技能缺口」的情境（`null` = 無異常，不發話）。
 *
 * crosscheck **不知道終態**（judge 尚未執行），因此用兩個它看得見的代理訊號：
 *
 *  1. 自身抓到 mismatch → 這次必然 needs-human。**這一格只有 crosscheck 能補**：
 *     workflow 的 judge 步驟要求 crosscheck 成功，crosscheck 失敗時 judge 根本
 *     不會執行（實證：run 35098422118 的步驟列表無 Judge terminal state）。
 *  2. 零產出（report 宣告無變更且實際 diff 也是空的）→ 通常代表 agent 停手。
 *     實證：run 34586354343（needs-human、changedPaths 0、無 skillGap）。
 *
 * mismatch 優先於零產出：前者是更明確的失敗訊號，detail 也更有助於查因。
 *
 * **已知未涵蓋**：judge 因停手規則判 needs-human、但 agent 確實有產出的情況
 * （實證：run 34457060253，11 個 changedPaths、終態 needs-human、無 skillGap）
 * ——那要由 `factory-judge` 端的 `needs-human` 觸發補上，本函式看不到終態。
 */
export function detectUnreportedTrigger(
  report: { changedPaths?: readonly string[] | undefined },
  actual: CrosscheckActual,
  mismatches: readonly CrosscheckMismatch[],
): UnreportedTrigger | null {
  if (mismatches.length > 0) return 'crosscheck-mismatch'
  const reported = collectReportedPaths(report.changedPaths)
  const actualPaths = actual.paths.filter((p) => !isFactoryInternal(p))
  if (reported.length === 0 && actualPaths.length === 0) return 'no-output'
  return null
}

/** 從目標 repo checkout 收集 git 事實。 */
export function collectActualDiff(
  git: GitRunner,
  opts: { issueNumber: number; base: string; target: string },
): CrosscheckActual {
  const { issueNumber, base, target } = opts
  const branchOutput = git(
    [
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/factory/${issueNumber}-*`,
      `refs/heads/factory/${issueNumber}/*`,
    ],
    target,
  )
  const branches = parseForEachRefOutput(branchOutput)
  const paths: string[] = []
  let added = 0
  let deleted = 0
  const perBranchAssertionDelta: number[] = []
  for (const branch of branches) {
    const names = parseDiffNameOnly(git(['diff', '--name-only', `${base}...${branch}`], target))
    for (const raw of names) {
      // parseDiffNameOnly 已濾掉空行，normalize 後不會是空字串
      const n = normalizePath(raw)
      if (!paths.includes(n)) paths.push(n)
    }
    const stat = parseShortStat(git(['diff', '--shortstat', `${base}...${branch}`], target))
    added += stat.added
    deleted += stat.deleted
    // --unified=0：只要 +/- 行，不要脈絡行。脈絡行含斷言時兩側都會出現，
    // 對稱地相消，但會讓輸出膨脹數倍且毫無收益。
    perBranchAssertionDelta.push(
      countAssertionDelta(git(['diff', '--unified=0', `${base}...${branch}`], target)).delta,
    )
  }
  const uncommitted = parseStatusPorcelain(git(['status', '--porcelain'], target))
  return {
    branches,
    paths,
    added,
    deleted,
    uncommitted,
    assertionDelta: perBranchAssertionDelta.length === 0 ? 0 : Math.min(...perBranchAssertionDelta),
  }
}

/** 讀取並驗證 report.json（契約同 factory-judge，共用 ReportSchema）。 */
function loadReport(reportPath: string) {
  const text = readFileSync(reportPath, 'utf8')
  const parsed = ReportSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new CliError(`report (${reportPath}) is invalid: ${detail}`)
  }
  return parsed.data
}

export interface CrosscheckCliPaths {
  base: string
  target: string
}

/**
 * agent-write-spec 模式的輸入（ADR-018 §9 護欄①、§12）。階段與規格名稱由
 * factory-run 依 Issue 狀態推導後傳入；PR 描述與 source.md 快照由 workflow
 * 以 gh 取得、寫成檔案——crosscheck 本身維持只讀本地資料。
 */
export interface WriteSpecArgs {
  phase: SpecPhase
  specName: string
  /** CI 寫入的 source.md 快照；不變量階段必填。 */
  sourceSnapshotPath?: string | undefined
  /** JSON 字串陣列：本工作項各 factory PR 的描述。 */
  prBodiesPath: string
}

/**
 * 解析位置參數：
 * `<issueNumber> <reportPath> [--base <b>] [--target <t>] [--analyze-only]
 *  [--propose-skill-only] [--onboard-only] [--pbt-audit-only]
 *  [--write-spec-phase <invariants|model> --spec-name <name> --pr-bodies <json>
 *   [--source-snapshot <file>]]`。
 */
export function parseArgs(argv: string[]): {
  issueNumber: number
  reportPath: string
  paths: CrosscheckCliPaths
  analyzeOnly: boolean
  proposeSkillOnly: boolean
  onboardOnly: boolean
  pbtAuditOnly: boolean
  requirementAnchors: string[]
  writeSpec?: WriteSpecArgs | undefined
} {
  const positional: string[] = []
  let base = 'software-factory'
  let target = 'target'
  let analyzeOnly = false
  let proposeSkillOnly = false
  let onboardOnly = false
  let pbtAuditOnly = false
  let requirementAnchors: string[] = []
  let specPhase: string | undefined
  let specName: string | undefined
  let sourceSnapshotPath: string | undefined
  let prBodiesPath: string | undefined
  const value = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} requires a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--base') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError('--base requires a branch name')
      base = v
    } else if (arg === '--target') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError('--target requires a directory')
      target = v
    } else if (arg === '--analyze-only') {
      analyzeOnly = true
    } else if (arg === '--propose-skill-only') {
      proposeSkillOnly = true
    } else if (arg === '--onboard-only') {
      onboardOnly = true
    } else if (arg === '--pbt-audit-only') {
      pbtAuditOnly = true
    } else if (arg === '--requirement-anchors') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) {
        throw new CliError('--requirement-anchors requires a comma-separated id list')
      }
      requirementAnchors = v.split(',').map((s) => s.trim()).filter((s) => s !== '')
    } else if (arg === '--write-spec-phase') {
      specPhase = value(++i, arg)
    } else if (arg === '--spec-name') {
      specName = value(++i, arg)
    } else if (arg === '--source-snapshot') {
      sourceSnapshotPath = value(++i, arg)
    } else if (arg === '--pr-bodies') {
      prBodiesPath = value(++i, arg)
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  // 各「僅產出」模式的允許清單互不相同，同時指定會讓實際生效的規則變得含糊
  // ——寧可紅燈，也不要讓寬鬆的那一套悄悄成為實際規則（同 factory-judge 的立場）。
  // 以清單列舉而非兩兩比對：新增第四個模式時不會漏掉任何組合。
  const exclusive = (
    [
      ['--analyze-only', analyzeOnly],
      ['--propose-skill-only', proposeSkillOnly],
      ['--onboard-only', onboardOnly],
      ['--pbt-audit-only', pbtAuditOnly],
      ['--write-spec-phase', specPhase !== undefined],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([flag]) => flag)
  if (exclusive.length > 1) {
    throw new CliError(`${exclusive.join(' 與 ')} 不可同時指定`)
  }
  const issueNumber = Number(positional[0])
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError(`issueNumber must be a positive integer, got ${positional[0] ?? '(missing)'}`)
  }
  const reportPath = positional[1]
  if (reportPath === undefined) throw new CliError('reportPath is required')
  // write-spec：指定了階段，其餘輸入就必須齊全——接線漏傳某個參數時，
  // 寧可紅燈，也不要讓對應的檢查被悄悄跳過。
  let writeSpec: WriteSpecArgs | undefined
  if (specPhase !== undefined) {
    if (specPhase !== 'invariants' && specPhase !== 'model') {
      throw new CliError(`--write-spec-phase must be invariants or model, got ${specPhase}`)
    }
    if (specName === undefined) throw new CliError('--write-spec-phase requires --spec-name')
    if (!isValidSpecName(specName)) throw new CliError(`--spec-name is not a valid spec name: ${specName}`)
    if (prBodiesPath === undefined) throw new CliError('--write-spec-phase requires --pr-bodies')
    if (specPhase === 'invariants' && sourceSnapshotPath === undefined) {
      throw new CliError('--write-spec-phase invariants requires --source-snapshot')
    }
    writeSpec = { phase: specPhase, specName, sourceSnapshotPath, prBodiesPath }
  }
  return {
    issueNumber,
    reportPath,
    paths: { base, target },
    analyzeOnly,
    proposeSkillOnly,
    onboardOnly,
    pbtAuditOnly,
    requirementAnchors,
    writeSpec,
  }
}

/**
 * 各 factory 分支相對 base 被刪除的檔案（agent-pbt-audit 用，ADR-019 §5）。
 *
 * `--no-renames` 是必要的：預設的 rename 偵測會把「刪 A、加 B」顯示成一筆改名，
 * `--name-only` 只列新路徑——把產品檔改名成 `*.pbt.test.*` 就能讓刪除從白名單
 * 檢查中消失。關掉 rename 偵測後，舊路徑一定以刪除出現。
 */
export function collectDeletedPaths(
  git: GitRunner,
  opts: { base: string; target: string; branches: readonly string[] },
): string[] {
  const out: string[] = []
  for (const branch of opts.branches) {
    const names = parseDiffNameOnly(
      git(['diff', '--name-only', '--no-renames', '--diff-filter=D', `${opts.base}...${branch}`], opts.target),
    )
    for (const raw of names) {
      const n = normalizePath(raw)
      if (!out.includes(n)) out.push(n)
    }
  }
  return out
}

/** 讀 --pr-bodies：必須是字串陣列，否則 fail-loud（格式錯誤不得等同「沒有 PR」）。 */
function loadPrBodies(path: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(raw) || !raw.every((b) => typeof b === 'string')) {
    throw new CliError(`--pr-bodies (${path}) must be a JSON array of strings`)
  }
  return raw
}

/** 各 factory 分支上某檔案的內容；分支上沒有該檔（git show 非零結束）就不列入。 */
function readOnBranches(git: GitRunner, target: string, branches: readonly string[], path: string): string[] {
  const out: string[] = []
  for (const branch of branches) {
    try {
      out.push(git(['show', `${branch}:${path}`], target))
    } catch {
      // 該分支沒有此檔
    }
  }
  return out
}

export function main(argv: string[], git: GitRunner = realGit): CrosscheckOutput {
  const {
    issueNumber,
    reportPath,
    paths,
    analyzeOnly,
    proposeSkillOnly,
    onboardOnly,
    pbtAuditOnly,
    requirementAnchors,
    writeSpec,
  } = parseArgs(argv)
  const report = loadReport(reportPath)
  const actual = collectActualDiff(git, { issueNumber, base: paths.base, target: paths.target })
  const mismatches = compareReportToActual(
    report,
    actual,
    analyzeOnly,
    proposeSkillOnly,
    onboardOnly,
  )
  // PBT 範圍（ADR-019 §2、§5、R6）：audit 只能新增或修改 PBT 檔、不得刪除；其他類型
  // 不得產出 PBT 檔。前者是 in-loop 豁免的前提之一（apply-score-labels.ts）。
  const changed = actual.paths.filter((p) => !isFactoryInternal(p))
  if (pbtAuditOnly) {
    const deleted = collectDeletedPaths(git, {
      base: paths.base,
      target: paths.target,
      branches: actual.branches,
    }).filter((p) => !isFactoryInternal(p))
    mismatches.push(...checkPbtAuditScope([...new Set([...changed, ...deleted])], deleted))
  } else {
    mismatches.push(...checkPbtOutsideAudit(changed))
  }
  // advisory 不參與 ok 判定（第一階段觀察期，見 CrosscheckOutput.advisories）
  const advisories = compareRequirementIds(report.requirements, requirementAnchors)
  if (writeSpec !== undefined) {
    const { phase, specName } = writeSpec
    mismatches.push(
      ...checkSpecScope(phase, specName, actual.paths.filter((p) => !isFactoryInternal(p))),
    )
    mismatches.push(
      ...checkSourceSnapshot(
        phase,
        readOnBranches(git, paths.target, actual.branches, specPaths(specName).source),
        writeSpec.sourceSnapshotPath === undefined
          ? undefined
          : readFileSync(writeSpec.sourceSnapshotPath, 'utf8'),
      ),
    )
    const prBodies = loadPrBodies(writeSpec.prBodiesPath)
    const closing = checkClosingKeywords(phase, issueNumber, prBodies)
    mismatches.push(...closing.mismatches)
    advisories.push(...closing.advisories)
    // 護欄④（ADR-018 §9）：先例（requirements 必填）在 crosscheck；PR 描述也只有這裡拿得到
    mismatches.push(...checkOpenQuestions(report.openQuestions, prBodies))
  }
  advisories.push(...adviseAssertionDelta(report.assertionDelta, actual.assertionDelta))
  advisories.push(
    ...adviseUnreportedSkillGap(
      detectUnreportedTrigger(report, actual, mismatches),
      report.skillGap !== undefined,
    ),
  )
  return {
    issueNumber,
    ok: mismatches.length === 0,
    report: { changedPaths: report.changedPaths, changedLines: report.changedLines },
    actual,
    mismatches: mismatches.map((m) => ({ ...m, category: categorizeMismatch(m.kind) })),
    headline: crosscheckHeadline(mismatches),
    advisories,
  }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const out = main(process.argv.slice(2))
    // mismatch 也要印出完整 JSON（CI 要拿 mismatches 建留言），再以 exit 1 表示失敗
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (!out.ok) process.exitCode = 1
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
