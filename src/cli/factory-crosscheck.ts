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
 * 驗證模式（`--verify-only`，ADR-029 §5、§6）例外：驗證類 agent **不建分支、
 * 不 push、不開 PR**，因此事實來源改為「工作區（含本地 commit）相對 base 的
 * diff」——`git diff <base>` 已涵蓋 commit 與未提交變更，未追蹤的新檔另由
 * `git status --porcelain` 的 `??` 補上。未提交變更在此模式**不是** mismatch
 * （R2 裁決：可以 commit 到本地，不 commit 也以同一份 diff 比對），而變更範圍
 * 改由 `VERIFY_ALLOWED_GLOBS`（specs/** 與各語言測試檔）白名單檢查。
 *
 * 階段輸入的還原清單（`--restored-manifest`，R13）只扣除**還原後未被動過**的檔案：
 * 以 manifest 的 sha256 對磁碟重算，被改動或刪除的還原輸入反而是 agent 的違規
 * 變更，記為 `restored-input-modified`（R15）——這讓「還原輸入唯讀」成為機械規則。
 *
 * **diff 基準必須不可變**（`--base-sha`，R19／C2）：R2 允許驗證 agent 在本地
 * commit，而 agent 就站在 base 分支上——commit 一前進，`git diff <base>` 就變空：
 * 合規 agent 被判 no-trace／reported-not-in-diff 假紅，越界 agent 則整批變更消失
 * （白名單被繞過）。workflow 在 agent 之前把 HEAD 寫進 target 外的
 * `.factory/base-sha`，本 CLI 以 `--base-sha <40-hex>` 使用該 commit 並**忽略
 * 分支名**；形狀不合或解析不到 commit 一律 fail-loud，不默默退回分支名。
 * 所有 git 子行程另經 `git-safe` 執行（`GIT_NO_REPLACE_OBJECTS=1`、global／system
 * config 指向 `/dev/null`、worktree 以絕對路徑釘住、`--no-pager --no-ext-diff
 * --no-textconv --text`、`core.fsmonitor=false`、excludes／attributes 指向
 * `/dev/null`）：agent 以 `git replace`、repo-local config（textconv、fsmonitor、
 * 假 worktree）或 `.git/info/exclude`／`-diff` 屬性偽造 diff、`git status` 一律
 * 無效（N1、N4）。`git status` 仍會套用 `.git/info/exclude`，未追蹤交付另由
 * `collectUntrackedIgnoringInfoExclude` 補上（見 collectVerifyDiff）。
 *
 * **帶 `--facts` 時上述 git 路徑全部不執行**（R25）：事實由
 * `factory-verify-facts` 在 `$RUNNER_TEMP` 的 clean repo 重建（archive 不跑
 * clean filter、rsync 不讀 target git config、`git add -f` 不理 ignore 檔），
 * crosscheck 只讀 JSON 並以 `--base-sha` 交叉驗證 `facts.baseSha`。workflow 的
 * 驗證模式永遠走這條路；無 facts 的 `--verify-only` 只保留給相容性。
 *
 * 有意不做的檢查：changedLines 的數值精確比對（agent 的計數口徑可能不同，
 * 會誤傷）；PR 是否真的推送（需網路，且 factory-rescore 已在 PR 層獨立重計分）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { countAssertionDelta } from '../assertion-count/count.js'
import { isPbtTestPath } from '../pbt-audit/languages.js'
import { isVerifyAllowedPath, VERIFY_ALLOWED_GLOBS } from '../pipeline/verify-scope.js'
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
import { isLakeBuildArtifact } from './factory-verify-encrypt.js'
import { isNeutralisedPath, loadVerifyFacts, type VerifyFacts } from './factory-verify-facts.js'
import { execGit } from './git-safe.js'
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
export type MismatchCategory = 'scope' | 'consistency' | 'isolation'

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
  'verify-scope',
  'verify-neutralised-path',
])

/**
 * 驗證類白名單的實作在 `src/pipeline/verify-scope.ts`：`factory-verify-encrypt`
 * 也用它決定 bundle 要帶哪些 agent 改動的測試檔。此處 re-export 維持既有
 * 呼叫端（與測試）的 import 路徑不變。
 */
export { VERIFY_ALLOWED_GLOBS }

/**
 * 驗證類的變更範圍檢查；由 main 在 `--verify-only` 時呼叫（路徑已排除 .factory/**）。
 *
 * dot segment 只在 specs/** 內放行、`.github` 一律拒絕；細節見 `isVerifyAllowedPath`。
 */
export function checkVerifyScope(changedPaths: readonly string[]): CrosscheckMismatch[] {
  const outside = changedPaths.filter((p) => !isVerifyAllowedPath(p))
  if (outside.length === 0) return []
  return [
    {
      kind: 'verify-scope',
      detail:
        `驗證類 task 只允許 ${VERIFY_ALLOWED_GLOBS.join('、')} 的變更，實際 diff 含越界變更：${outside.join('、')}` +
        '。驗證 agent 只能寫規格樹與測試檔，不得修改正式程式碼、設定、依賴或 .github/**（ADR-029 §5、§6）',
    },
  ]
}

/**
 * N-version 變體隔離類的 mismatch kind（見 checkVariantIsolation）。report 可能完全誠實、
 * 變更也在範圍內——問題是兩個變體的交付物混在一起，比對失去意義，處置是修隔離。
 */
export const ISOLATION_MISMATCH_KINDS: ReadonlySet<string> = new Set([
  'variant-branch-prefix',
  'variant-foreign-reuse',
])

export function categorizeMismatch(kind: string): MismatchCategory {
  if (SCOPE_MISMATCH_KINDS.has(kind)) return 'scope'
  if (ISOLATION_MISMATCH_KINDS.has(kind)) return 'isolation'
  return 'consistency'
}

/** 各類別在標題中的措辭與順序。 */
const HEADLINE_PARTS: readonly [MismatchCategory, string][] = [
  ['scope', '變更超出任務類型允許的範圍'],
  ['isolation', 'N-version 變體隔離失敗'],
  ['consistency', 'report 與實際變更不一致'],
]

/** 留言與 ::error:: 的標題；沒有 mismatch 時為空字串。 */
export function crosscheckHeadline(mismatches: readonly CrosscheckMismatch[]): string {
  const present = new Set(mismatches.map((m) => categorizeMismatch(m.kind)))
  return HEADLINE_PARTS.filter(([category]) => present.has(category))
    .map(([, text]) => text)
    .join('，且 ')
}

/** N-version 雙模型競賽的變體代號（factory-run.yml 的 matrix.variant）。 */
export type VariantId = 'a' | 'b'

/** 變體 `v` 在 Issue `n` 上的分支前綴。 */
export function variantPrefix(issueNumber: number, variant: VariantId): string {
  return `factory/${issueNumber}-${variant}-`
}

/** 本 Issue 的 factory 分支（`factory/<n>-*` 或 `factory/<n>/*`，docs/07 §3.2 兩種命名）。 */
function isIssueBranch(branch: string, issueNumber: number): boolean {
  return branch.startsWith(`factory/${issueNumber}-`) || branch.startsWith(`factory/${issueNumber}/`)
}

/** 把 workflow 寫入的遠端分支清單（一行一個分支名）切成陣列。 */
export function parseRemoteBranches(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * N-version 變體隔離（fubon-tradingbot#713，run 38066416086）。
 *
 * 兩個變體平行處理同一張 Issue，唯一的區隔是分支前綴 `factory/<n>-<variant>-`。
 * 實證兩種破口，各對應一條規則：
 *
 * 1. `variant-branch-prefix`：本地分支沒有本變體前綴。變體 B 開了
 *    `factory/713-01-analysis`——另一變體無從分辨那是誰的交付。
 * 2. `variant-foreign-reuse`：本變體沒有任何交付（無本變體分支、changedPaths 為空），
 *    遠端卻已有本 Issue 的其他分支。變體 A 寫完報告後看到 B 的 PR，依「既有交付
 *    不重複開 PR」刪掉自己的成果，judge 仍判 ready-for-review。
 *
 * 規則 2 刻意不攔：遠端有**本變體**前綴的分支（本變體自己的重跑，沿用合法），以及
 * 遠端完全沒有其他分支（多半是停手規則，交由 judge 判定，不歸咎於隔離）。
 *
 * 遠端分支清單由 workflow 以 `git ls-remote` 取得、寫檔傳入——crosscheck 維持只讀
 * 本地資料。目標 repo 的 checkout 沒有其他分支的 remote-tracking ref，本地 git 看不到。
 */
export function checkVariantIsolation(input: {
  issueNumber: number
  variant: VariantId
  localBranches: readonly string[]
  remoteBranches: readonly string[]
  reportedPaths: readonly string[]
}): CrosscheckMismatch[] {
  const { issueNumber, variant, localBranches, reportedPaths } = input
  const prefix = variantPrefix(issueNumber, variant)
  const mismatches: CrosscheckMismatch[] = []

  const unprefixed = localBranches.filter((b) => !b.startsWith(prefix))
  if (unprefixed.length > 0) {
    mismatches.push({
      kind: 'variant-branch-prefix',
      detail:
        `N-version 變體 ${variant} 的分支必須以 \`${prefix}\` 開頭，實際有 ${unprefixed.join(', ')}` +
        '——兩個變體共用同一張 Issue，沒有變體前綴的分支會被另一變體誤認為既有交付',
    })
  }

  const remote = input.remoteBranches.filter((b) => isIssueBranch(b, issueNumber))
  const ownRemote = remote.filter((b) => b.startsWith(prefix))
  const foreignRemote = remote.filter((b) => !b.startsWith(prefix))
  const ownLocal = localBranches.filter((b) => b.startsWith(prefix))
  if (reportedPaths.length === 0 && ownLocal.length === 0 && ownRemote.length === 0 && foreignRemote.length > 0) {
    mismatches.push({
      kind: 'variant-foreign-reuse',
      detail:
        `N-version 變體 ${variant} 沒有自己的交付（沒有 \`${prefix}*\` 分支、changedPaths 為空），` +
        `但遠端已有其他分支 ${foreignRemote.join(', ')}——疑似把另一變體的 PR 當成既有交付而放棄產出，` +
        '兩個變體因此無法比對',
    })
  }
  return mismatches
}

/**
 * 沿用成立時要降級為 advisory 的「report vs diff」不一致 kinds：這些 diff 是先前 run
 * 的既有交付，不是本次未回報的變更。其餘 kinds（uncommitted-changes、scope、isolation、
 * requirements…）不降級——沿用不能掩蓋本次 run 自己的新問題。
 */
export const REUSE_DOWNGRADED_KINDS: ReadonlySet<string> = new Set([
  'unreported-changes',
  'diff-not-reported',
  'lines-missing',
])

export interface ReuseClaimInput {
  issueNumber: number
  reportedPaths: readonly string[]
  localBranches: readonly string[]
  /** N-version 模式的遠端分支清單；undefined＝非 N-version（無清單，只驗本地）。 */
  remoteBranches: readonly string[] | undefined
  variant: VariantId | undefined
}

/**
 * 機械驗證「沿用既有交付」（fubon-tradingbot#717 兩段教訓：
 * run 38106446065——qwen3.8-flash 正確沿用 PR #719、依重跑指引填 changedPaths=[]，
 * 但一致性檢查把分支上 710 行的既有交付比對空報告 → unreported-changes 假紅；
 * run 38109497975——修正版上線後兩個變體都正確填了 reusedExistingPr，卻因
 * 「本地找不到分支」被拒：agent 用 gh 檢視既有 PR、完全沒 checkout 舊分支，
 * 這是最乾淨的沿用姿態，反而被舊條件②懲罰）。
 *
 * 成立條件（全部機械可驗，不信自由文字）：
 *   1. changedPaths 為空（沿用又同時回報新變更＝自相矛盾，寧可紅燈交人類）；
 *   2. **既有交付存在**：N-version 模式下以遠端分支清單為權威證據（`git ls-remote`
 *      在 crosscheck 當下取得；分支在遠端＝先前 run 推送過，agent 不需 checkout）；
 *      只在本地、不在遠端的前綴分支＝本次 run 現做的，不算既有交付。
 *      非 N-version（無遠端清單）時退回本地分支證據（#595 型情境）。
 *
 * 已知剩餘缺口（刻意接受）：無法分辨「沿用既有 PR」與「本次 run 把新工作推進同一
 * 前綴分支後宣稱沿用」——那需要 PR createdAt/files 元資料（gh 呼叫）。遠端存在性
 * 已擋掉「本次新建且未推送」的情形；同分支追加 commit 的偽沿用留待 observe
 * （advisory 會把放行的檔案數／行數完整寫出，人類複核時看得見）。
 */
export function validateReuseClaim(
  input: ReuseClaimInput,
): { valid: true; branch: string } | { valid: false; reason: string } {
  if (input.reportedPaths.length > 0) {
    return {
      valid: false,
      reason: `changedPaths 非空（${input.reportedPaths.length} 個檔案）——與沿用既有交付相互矛盾`,
    }
  }
  const prefix =
    input.variant === undefined
      ? `factory/${input.issueNumber}-`
      : variantPrefix(input.issueNumber, input.variant)
  const matches = (b: string): boolean =>
    input.variant === undefined ? isIssueBranch(b, input.issueNumber) : b.startsWith(prefix)
  if (input.remoteBranches !== undefined) {
    // N-version：遠端清單是權威證據（agent 不必 checkout 既有分支）。
    const remoteMatch = input.remoteBranches.find(matches)
    if (remoteMatch !== undefined) return { valid: true, branch: remoteMatch }
    const localMatch = input.localBranches.find(matches)
    return {
      valid: false,
      reason:
        localMatch !== undefined
          ? `分支 ${localMatch} 只在本地、不在遠端清單——是本次 run 現做的，非先前 run 的既有交付`
          : `遠端與本地都找不到前綴 ${prefix} 的分支——「既有交付」不存在`,
    }
  }
  // 非 N-version（無遠端清單）：退回本地分支證據（#595 型情境）。
  const localMatch = input.localBranches.find(matches)
  if (localMatch === undefined) {
    return { valid: false, reason: `本地找不到前綴 ${prefix} 的分支——「既有交付」不存在於本 checkout` }
  }
  return { valid: true, branch: localMatch }
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

/**
 * 真實 git 的薄包裝：所有子行程都經 `git-safe`（N1：關閉 replace refs、
 * 隔離 global/system config）。測試以 fake runner 取代；真實 git 的
 * replace／惡意 config 行為由 `factory-crosscheck.test.ts` 的 N1 測試涵蓋。
 */
export const realGit: GitRunner = (args, cwd) => execGit(args, { cwd })

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
  verifyOnly = false,
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
  // 驗證模式：R2 裁決「可以 commit 到本地（不 push）」，且未提交也以同一份
  // 工作區 diff 比對——所以未提交變更不再是 mismatch（否則不 commit 的 agent
  // 會被自己的合規產出判紅）。變更範圍另由 checkVerifyScope 白名單把關。
  if (!verifyOnly && actual.uncommitted.length > 0) {
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
  //
  // 驗證模式不套用：驗證階段沒有「驗收條件→實作」的對應（完成與否由 G1–G4
  // 閘門決定，ADR-029 §2），task template 也不要求 requirements；硬套會讓
  // grill／quint／lean 三個階段的所有合規產出被判 needs-human。
  if (hasDiff && !verifyOnly) {
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

/**
 * `git status --porcelain` 的未追蹤檔（`??` 行）。
 *
 * 驗證模式沒有「先 commit 再比對」的前提：agent 可能直接寫了新檔而沒有
 * `git add`。`git diff <base>` 看不到未追蹤檔，若只靠它，合法的交付會被判
 * `no-trace`／`unreported-changes` 假紅——故以 status 補上。
 *
 * git 會以 C-style 引號包裹含空白／引號／控制字元／非 ASCII 的路徑
 * （`core.quotePath` 預設開啟），例如 `?? "specs/a b.qnt"`；不先解開就會把
 * 引號與跳脫序列當成路徑的一部分，讓合法的含空白檔名被判越界。
 */
export function parseUntrackedPaths(output: string): string[] {
  const out: string[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed.startsWith('?? ')) continue
    const n = normalizePath(unquoteGitPath(trimmed.slice(3)))
    if (n.length > 0) out.push(n)
  }
  return out
}

/** git C-style 引號的單字元跳脫（`git quote.c` 定義的同名集合）。 */
const GIT_QUOTE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
}

/**
 * 解開 git 的 C-style 引號（含 `\NNN` octal byte 跳脫，可跨多位元組 UTF-8）。
 * 沒有被引號完整包住時原樣回傳（不完整的引號不吞路徑）。
 */
function unquoteGitPath(raw: string): string {
  const quoted = /^"([\s\S]*)"$/.exec(raw)
  if (quoted === null) return raw
  const inner = raw.slice(1, -1)
  const bytes: number[] = []
  let last = 0
  for (const match of inner.matchAll(/\\([0-7]{1,3})|\\(.)/gs)) {
    bytes.push(...Buffer.from(inner.slice(last, match.index), 'utf8'))
    const octal = match[1]
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8) & 0xff)
    } else {
      const escaped = match[2] as string
      const code = GIT_QUOTE_ESCAPES[escaped]
      // 未知跳脫不在 git 的輸出裡；保留反斜線比靜默吞掉更安全
      if (code === undefined) bytes.push(...Buffer.from(`\\${escaped}`, 'utf8'))
      else bytes.push(code)
    }
    last = match.index + match[0]!.length
  }
  bytes.push(...Buffer.from(inner.slice(last), 'utf8'))
  return Buffer.from(bytes).toString('utf8')
}

/**
 * 未追蹤檔清單，目錄項逐目錄展開。
 *
 * `--untracked-files=all` 讓 git 把新目錄逐檔列出（預設收成單一 `?? specs/`）；
 * 但巢狀 git repo 等情況仍可能只給目錄項。此時以
 * `git ls-files --others --exclude-per-directory=.gitignore -- <dir>` 展開；展開仍為空
 * 就保留目錄項，不靜默丟掉一棵真實存在的未追蹤樹。
 * 刻意不用 `--exclude-standard`：那會套用 agent 可寫的 `.git/info/exclude`（N4）。
 */
function collectUntrackedPaths(git: GitRunner, statusOutput: string, target: string): string[] {
  const out: string[] = []
  for (const p of parseUntrackedPaths(statusOutput)) {
    if (!p.endsWith('/')) {
      out.push(p)
      continue
    }
    const dir = p.replace(/\/+$/, '')
    const listed = parseDiffNameOnly(
      git(['ls-files', '--others', '--exclude-per-directory=.gitignore', '--', dir], target),
    )
      .map(unquoteGitPath)
      .map(normalizePath)
    if (listed.length === 0) out.push(p)
    else out.push(...listed)
  }
  return out
}

/**
 * 未追蹤檔的權威清單（**不讀** `.git/info/exclude`／global ignore）。
 *
 * `git status --untracked-files=all` 與 `git ls-files --others --exclude-standard`
 * 都套用 `.git/info/exclude`——那是 agent 可寫的檔案面（`target/.git/info/exclude`），
 * 一行 `*` 就能讓整批新產出從事實清單消失；global ignore 的預設路徑
 * （`$XDG_CONFIG_HOME/git/ignore`）同理。
 * `--exclude-per-directory=.gitignore` 只讀版本庫自己的 `.gitignore`（tracked 檔，
 * 改動本身就會出現在 diff 裡），保留正常 ignore 語意、關掉這個繞道。
 */
function collectUntrackedIgnoringInfoExclude(git: GitRunner, target: string): string[] {
  return parseDiffNameOnly(
    git(['ls-files', '--others', '--exclude-per-directory=.gitignore'], target),
  )
    .map(unquoteGitPath)
    .map(normalizePath)
    .filter((p) => p.length > 0)
}

/**
 * 把 `factory-verify-facts` 的 JSON 轉成 crosscheck 的 `CrosscheckActual`
 * （R25）。驗證模式帶 `--facts` 時這是唯一的事實來源；`branches` 恆為空、
 * `uncommitted` 恆為空（clean repo 的事實沒有「未提交」的概念）。
 *
 * 這裡只防禦性過濾 neutralised 路徑的 **D（刪除）**：workflow 在 agent 之前已把
 * base 內的 instruction／skill 路徑移到一旁，那些刪除不是 agent 的越界變更；舊
 * facts（或漏掉排除的版本）也不能讓 tracked `.dsh`／`.agents` 的刪除變成 scope
 * 假紅。A（agent 新建）與 M（改寫）**必須保留**：R26 (d) 要求 agent 在
 * `.dsh`／`.agents` 下自建檔案時由 `verify-scope` 判紅，不能靜默吞掉。
 */
export function actualFromVerifyFacts(facts: VerifyFacts): CrosscheckActual {
  return {
    branches: [],
    paths: facts.changed
      .filter((entry) => entry.status !== 'D' || !isNeutralisedPath(entry.path))
      .map((entry) => entry.path),
    added: facts.linesAdded,
    deleted: facts.linesDeleted,
    uncommitted: [],
    assertionDelta: facts.assertionDelta,
  }
}

/**
 * 驗證模式的 git 事實（ADR-029 §5、§6；R2 裁決）。
 *
 * 驗證類 agent 不建分支，所以沒有 `factory/<issue>-*` 可比對；事實來源是
 * **工作區（含本地 commit）相對 base 的 diff**：
 *   - `git diff <base>`：已 commit 與未 commit 的變更（不含未追蹤檔）
 *   - `git status --porcelain` 的 `??`：未追蹤的新檔（通常就是新產出）
 *
 * `branches` 恆為空陣列：驗證模式沒有變體分支，變體隔離檢查不適用。
 * `uncommitted` 仍照實回報供診斷，但驗證模式不把它當 mismatch（main 判定）。
 *
 * `base` 通常是分支名；R19 後 main 會傳入 `--base-sha` 解析出的不可變 commit，
 * 兩者對 `git diff` 而言都只是 ref——本函式不區分，也不得退回分支名。
 *
 * `--no-renames` 是必要的（R24）：預設 rename 偵測會把「刪 A、加 B」摺成一筆
 * R100，`--name-only` 只列新路徑——把產品檔 `git mv` 成測試檔就能讓刪除從
 * verify-scope 白名單消失。關掉後舊路徑必以刪除出現，新測試檔仍以新增出現；
 * 三段 diff（paths／shortstat／assertion delta）都帶同一旗標，事實才一致。
 */
export function collectVerifyDiff(
  git: GitRunner,
  opts: { base: string; target: string },
): CrosscheckActual {
  const { base, target } = opts
  const diffPaths = parseDiffNameOnly(
    git(['diff', '--name-only', '--no-renames', base], target),
  ).map(normalizePath)
  const stat = parseShortStat(git(['diff', '--shortstat', '--no-renames', base], target))
  // 未追蹤檔不在 diff 內，補進來才算得出「有沒有交付」。`--untracked-files=all`
  // 是關鍵：預設會把整棵新目錄收成 `?? specs/`，回報 `specs/quint/model.qnt`
  // 的合規 run 會被判 reported-not-in-diff ＋ diff-not-reported 假紅。
  // 順序：diff 在前、untracked 在後，維持輸出的可預期性（測試與留言都依此順序）。
  const statusOutput = git(['status', '--porcelain', '--untracked-files=all'], target)
  const paths = [...diffPaths]
  for (const p of collectUntrackedPaths(git, statusOutput, target)) {
    // 已提交／已暫存的檔案也會出現在 status（`A `），但只有 `??` 會被
    // parseUntrackedPaths 取用；diff 與 untracked 理論上不重疊，仍去重避免
    // 同一路徑在 report 比對與白名單檢查中出現兩次。
    if (!paths.includes(p)) paths.push(p)
  }
  // status 會套用 `.git/info/exclude`（agent 可寫）：未追蹤交付可能整批被藏住。
  // 這條清單不讀它，補回 status 看不到的檔案（N4）。
  for (const p of collectUntrackedIgnoringInfoExclude(git, target)) {
    if (!paths.includes(p)) paths.push(p)
  }
  return {
    branches: [],
    paths,
    added: stat.added,
    deleted: stat.deleted,
    uncommitted: parseStatusPorcelain(statusOutput),
    assertionDelta: countAssertionDelta(git(['diff', '--unified=0', '--no-renames', base], target)).delta,
  }
}

/** 還原清單的一筆（`factory-verify-input` 在 agent 之前寫入，R13／R15）。 */
interface RestoredInput {
  path: string
  /** 還原當時寫入位元組的 sha256（hex、小寫）；crosscheck 會以磁碟重算，不信任這個值本身。 */
  sha256: string
}

/** manifest 的 sha256 欄位：64 位小寫 hex（與 `createHash('sha256').digest('hex')` 一致）。 */
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * 讀 `factory-verify-input` 寫的還原清單（R13、R15）。檔案不存在、非 JSON、形狀錯、
 * 重複路徑或含非還原白名單路徑都是 hard error：靜默忽略會讓有還原輸入的 run 回到
 * diff-not-reported 假紅，或讓壞掉的 manifest 悄悄失去扣除／唯讀驗證效果。
 *
 * 舊版 `{ "restored": ["<path>"] }` 直接拒絕、不自動升級（R15）：那個形狀沒有雜湊，
 * 無法判斷還原輸入是否被 agent 改動或刪除——而這正是「還原輸入唯讀」的唯一機械
 * 防線。清單由本 repo 的 restore 步驟產生，兩端必須同步；靜默接受舊形狀等於讓
 * 防線消失。
 *
 * 路徑也必須落在還原端允許的範圍（`specs/**` 或驗證白名單），且排除 PBT 測試檔與
 * `.lake/build`（R15）：manifest 在 runner 工作區、agent 有寫入權限，若接受任意
 * 路徑，agent 就能把自己改的產品程式碼列進 manifest 讓 crosscheck 與白名單檢查
 * 同時看不到；PBT 檔入列則可遮蔽 `pbt-outside-audit`，建置快取入列則等於宣稱可
 * 重建的產物是「還原輸入」。
 */
function loadRestoredManifest(path: string): RestoredInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new CliError(`--restored-manifest (${path}) 無法讀取或不是合法 JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`--restored-manifest (${path}) 必須是 JSON 物件`)
  }
  const restored = (parsed as { restored?: unknown }).restored
  if (!Array.isArray(restored)) {
    throw new CliError(
      `--restored-manifest (${path}) 的 restored 必須是 [{ "path", "sha256" }] 陣列（舊版字串陣列已不接受，見 R15）`,
    )
  }
  const entries: RestoredInput[] = []
  const seen = new Set<string>()
  for (const entry of restored) {
    if (typeof entry === 'string') {
      throw new CliError(
        `--restored-manifest (${path}) 是舊版格式 { "restored": [string] }——` +
          '需要 { "restored": [ { "path", "sha256" } ] }（R15：還原輸入唯讀，以雜湊驗證；不提供自動升級，請重跑還原步驟）',
      )
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CliError(`--restored-manifest (${path}) 的 restored 條目必須是 { path, sha256 } 物件`)
    }
    const { path: restoredPath, sha256 } = entry as { path?: unknown; sha256?: unknown }
    if (typeof restoredPath !== 'string') {
      throw new CliError(`--restored-manifest (${path}) 的 restored 條目缺 path（必須是字串）`)
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new CliError(`--restored-manifest (${path}) 的 restored 條目缺 sha256（必須是 64 位小寫 hex）`)
    }
    if (!isRestoredManifestPath(restoredPath)) {
      throw new CliError(
        `--restored-manifest (${path}) 含不在還原白名單內的路徑（還原端只寫 specs/** 與測試檔，且不得是 PBT 測試檔或 .lake/build）`,
      )
    }
    if (seen.has(restoredPath)) {
      throw new CliError(`--restored-manifest (${path}) 含重複路徑（扣除與驗證結果會取決於處理順序）`)
    }
    seen.add(restoredPath)
    entries.push({ path: restoredPath, sha256 })
  }
  return entries
}

/** manifest 的單一路徑是否可能是 `factory-verify-input` 還原的檔案。 */
function isRestoredManifestPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  const segments = p.split('/')
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git',
    )
  ) {
    return false
  }
  // PBT 檔只能由稽核工單產出（ADR-019 §2）：若可從 manifest 扣除，agent 就能在驗證
  // 階段寫 PBT 檔並讓 pbt-outside-audit 看不到它（R15）。
  if (isPbtTestPath(p)) return false
  // 建置快取可重建、也不是還原端的輸入（factory-verify-encrypt 不打包）——同一個
  // predicate，兩端不得漂移（R14、R15）。
  if (isLakeBuildArtifact(p)) return false
  return isVerifyAllowedPath(p)
}

/**
 * 驗證還原輸入仍是「唯讀」的（R15）：逐一以磁碟上的實際位元組重算 sha256，只有
 * **存在且雜湊相符**的路徑才算未動的還原輸入，才能從 agent 的 diff 扣除。
 *
 * 被改動或刪除的路徑反而是 agent 的（違規）變更：不扣除（讓 diff-not-reported
 * 也能現形），並產生 `restored-input-modified`——與 diff-not-reported 同等級的
 * hard mismatch。manifest 裡的雜湊只是「還原當時」的紀錄，判斷一律以重算結果為
 * 準：偽造或過期的雜湊不會被當成「檔案沒被動」的證據。
 */
/**
 * Lean proofs 階段可以合法改寫的還原輸入：`specs/lean/**`，但 `RULES.md` 除外
 * （那是 G3 簽核的規則轉錄，不是這一階段的交付）。
 */
function isLeanProofsDeliverable(path: string): boolean {
  if (!path.startsWith('specs/lean/')) return false
  return path !== 'specs/lean/RULES.md'
}

function verifyRestoredInputs(
  entries: readonly RestoredInput[],
  target: string,
  verifyPhase: string | undefined,
): { unchanged: string[]; mismatches: CrosscheckMismatch[] } {
  const unchanged: string[] = []
  const mismatches: CrosscheckMismatch[] = []
  for (const { path: restoredPath, sha256 } of entries) {
    // Lean proofs 階段的交付就是**改寫**上一階段（statements）還原回來的
    // `specs/lean/**`：填 `sorry`、更新 MODEL-MAP／REPORT／AUDIT。把這些檔當唯讀
    // 會讓合法的證明工作被判成 restored-input-modified（2026-10-29 真實 run
    // 40809048823 就是這樣失敗）。`specs/lean/RULES.md` 例外：它是 G3 簽核過的
    // 規則轉錄，兩個階段都必須唯讀。`specs/quint/**` 與其他輸入也維持唯讀。
    if (verifyPhase === 'proofs' && isLeanProofsDeliverable(restoredPath)) continue
    let current: string
    try {
      current = createHash('sha256')
        .update(readFileSync(resolve(target, restoredPath)))
        .digest('hex')
    } catch {
      // 刪除、被換成目錄、權限被改掉……都無法證明還是原本的輸入。
      mismatches.push({
        kind: 'restored-input-modified',
        detail:
          `還原的階段輸入已不存在或無法讀取：${restoredPath}——還原輸入是唯讀的，agent 不得刪除或替換` +
          '（ADR-029 §5；read-only 規則由 manifest 的 sha256 機械驗證）',
      })
      continue
    }
    if (current !== sha256) {
      mismatches.push({
        kind: 'restored-input-modified',
        detail:
          `還原的階段輸入被修改：${restoredPath}——目前的內容與還原時的 sha256 不符；` +
          '還原輸入是唯讀的，前一階段確認過的規格不得被本階段改寫（ADR-029 §5）',
      })
      continue
    }
    unchanged.push(restoredPath)
  }
  return { unchanged, mismatches }
}

/**
 * 把「雜湊相符的」已還原階段輸入從實際 diff 扣除（R13）。輸入不是 agent 的交付，
 * 不該被要求出現在 report.changedPaths；白名單與變更行數檢查也不該把它算進去。
 * 被改動的還原輸入不在 unchanged 內，因此仍留在 diff 裡（見 verifyRestoredInputs）。
 */
function subtractRestoredPaths(actual: CrosscheckActual, restored: readonly string[]): CrosscheckActual {
  if (restored.length === 0) return actual
  const excluded = new Set(restored)
  return {
    ...actual,
    paths: actual.paths.filter((p) => !excluded.has(p)),
    uncommitted: actual.uncommitted.filter((p) => !excluded.has(p)),
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

/** N-version 模式的輸入：變體代號與 workflow 寫入的遠端分支清單（一行一個）。 */
export interface VariantArgs {
  id: VariantId
  remoteBranchesPath: string
}

/** `--base-sha` 的格式（R19）：完整 40 位 hex commit；分支名／簡短 SHA 一律拒絕。 */
const BASE_SHA_HEX = /^[0-9a-f]{40}$/i

/**
 * 驗證 `--base-sha` 的形狀並正規化為小寫。刻意只收完整 40 位 hex：簡短 SHA 的
 * 解析規則取決於 repo 狀態（歧義時會變），不是「不可變 commit」。
 */
export function parseBaseSha(value: string): string {
  const sha = value.trim().toLowerCase()
  if (!BASE_SHA_HEX.test(sha)) {
    throw new CliError(
      `--base-sha 必須是完整的 40-hex commit（40 位十六進位；收到「${value}」）——` +
        '驗證模式的 diff 基準是 agent 啟動前的 HEAD，不是可移動的分支名（R19）',
    )
  }
  return sha
}

/**
 * 確認 `--base-sha` 在此 repo 解析得到 commit。解析不到就 fail-loud：默默退回
 * 分支名會讓 C2 的假紅／白名單繞過原樣重現，而且沒有任何訊號。
 */
export function resolveBaseSha(git: GitRunner, target: string, sha: string): string {
  try {
    const resolved = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], target).trim()
    if (resolved !== '') return resolved
  } catch {
    // 落到下方統一的 CliError：不把 git 的 stderr 當成使用者訊息
  }
  throw new CliError(
    `--base-sha ${sha} 在此 repo 解析不到 commit——拒絕以可移動的分支名替代（R19，fail closed）`,
  )
}

/**
 * 解析位置參數：
 * `<issueNumber> <reportPath> [--base <b>] [--target <t>] [--analyze-only]
 *  [--propose-skill-only] [--onboard-only] [--pbt-audit-only] [--verify-only]
 *  [--base-sha <40-hex>] [--restored-manifest <file>] [--facts <file>]
 *  [--write-spec-phase <invariants|model> --spec-name <name> --pr-bodies <json>
 *   [--source-snapshot <file>]] [--variant <a|b> --remote-branches <file>]`。
 */
export function parseArgs(argv: string[]): {
  issueNumber: number
  reportPath: string
  paths: CrosscheckCliPaths
  analyzeOnly: boolean
  proposeSkillOnly: boolean
  onboardOnly: boolean
  pbtAuditOnly: boolean
  verifyOnly: boolean
  /** agent 啟動前的 HEAD（R19）；存在時取代 `--base` 的分支名，只在 --verify-only 下有效。 */
  baseSha?: string | undefined
  /** `factory-verify-input` 的還原清單（只在 --verify-only 下有效）。 */
  restoredManifestPath?: string | undefined
  /** Lean 的 statements／proofs；proofs 允許改寫 specs/lean/** 的還原輸入（RULES.md 除外）。 */
  verifyPhase?: string | undefined
  /** `factory-verify-facts` 的輸出（只在 --verify-only 下有效）；存在時不得再對 target 跑 git。 */
  factsPath?: string | undefined
  requirementAnchors: string[]
  writeSpec?: WriteSpecArgs | undefined
  variant?: VariantArgs | undefined
} {
  const positional: string[] = []
  let variantId: string | undefined
  let remoteBranchesPath: string | undefined
  let base = 'software-factory'
  let target = 'target'
  let analyzeOnly = false
  let proposeSkillOnly = false
  let onboardOnly = false
  let pbtAuditOnly = false
  let verifyOnly = false
  let baseSha: string | undefined
  let restoredManifestPath: string | undefined
  /** Lean 的 statements／proofs 分流；proofs 允許改寫 specs/lean/** 的還原輸入。 */
  let verifyPhase: string | undefined
  let factsPath: string | undefined
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
    } else if (arg === '--verify-only') {
      verifyOnly = true
    } else if (arg === '--base-sha') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) {
        throw new CliError('--base-sha requires a full 40-hex commit SHA')
      }
      baseSha = parseBaseSha(v)
    } else if (arg === '--verify-phase') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError('--verify-phase requires statements|proofs')
      verifyPhase = v
    } else if (arg === '--restored-manifest') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError('--restored-manifest requires a path')
      restoredManifestPath = v
    } else if (arg === '--facts') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError('--facts requires a path')
      factsPath = v
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
    } else if (arg === '--variant') {
      variantId = value(++i, arg)
    } else if (arg === '--remote-branches') {
      remoteBranchesPath = value(++i, arg)
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  // 各「僅產出」模式的允許清單互不相同，同時指定會讓實際生效的規則變得含糊
  // ——寧可紅燈，也不要讓寬鬆的那一套悄悄成為實際規則（同 factory-judge 的立場）。
  // 以清單列舉而非兩兩比對：新增第五個模式時不會漏掉任何組合。
  const exclusive = (
    [
      ['--analyze-only', analyzeOnly],
      ['--propose-skill-only', proposeSkillOnly],
      ['--onboard-only', onboardOnly],
      ['--pbt-audit-only', pbtAuditOnly],
      ['--verify-only', verifyOnly],
      ['--write-spec-phase', specPhase !== undefined],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([flag]) => flag)
  if (exclusive.length > 1) {
    throw new CliError(`${exclusive.join(' 與 ')} 不可同時指定`)
  }
  // 驗證模式沒有分支，`--variant` 的隔離檢查（分支前綴、遠端分支清單）不適用；
  // 同時指定等於兩套互相矛盾的事實來源，fail-loud 而不是讓其中一套靜默失效。
  if (verifyOnly && (variantId !== undefined || remoteBranchesPath !== undefined)) {
    throw new CliError('--verify-only 不可與 --variant／--remote-branches 同時指定（驗證類不建分支）')
  }
  // 還原清單只有驗證模式會產生；其他模式帶了它等於接線錯誤，不可靜默忽略。
  if (restoredManifestPath !== undefined && !verifyOnly) {
    throw new CliError('--restored-manifest 只適用於 --verify-only（驗證模式的階段輸入還原）')
  }
  // 不可變 diff 基準同理：非驗證模式的事實來源是 factory/<issue>-* 分支，
  // 帶了 --base-sha 等於兩套基準並存——寧可紅燈，也不要讓其中一套靜默失效。
  if (baseSha !== undefined && !verifyOnly) {
    throw new CliError('--base-sha 只適用於 --verify-only（不可變 diff 基準是驗證模式的事實來源，R19）')
  }
  // facts 只有驗證模式會產生；其他模式帶了它等於接線錯誤，不可靜默忽略。
  if (factsPath !== undefined && !verifyOnly) {
    throw new CliError('--facts 只適用於 --verify-only（clean repo 的事實是驗證模式的輸入，R25）')
  }
  // facts 的 baseSha 必須與 --base-sha 交叉驗證；只帶 facts 等於少了一個獨立基準，
  // 無法確認 workflow 記下的 pre-agent commit 與事實檔是同一個。
  if (factsPath !== undefined && baseSha === undefined) {
    throw new CliError('--facts 需要同時指定 --base-sha（facts 的 baseSha 必須被獨立驗證，R25，fail closed）')
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
  // N-version：兩個旗標必須成對——只給 --variant 會讓「沿用另一變體」的檢查悄悄失效。
  let variant: VariantArgs | undefined
  if (variantId !== undefined) {
    if (variantId !== 'a' && variantId !== 'b') throw new CliError(`--variant must be a or b, got ${variantId}`)
    if (remoteBranchesPath === undefined) throw new CliError('--variant requires --remote-branches')
    variant = { id: variantId, remoteBranchesPath }
  } else if (remoteBranchesPath !== undefined) {
    throw new CliError('--remote-branches requires --variant')
  }
  return {
    issueNumber,
    reportPath,
    paths: { base, target },
    analyzeOnly,
    proposeSkillOnly,
    onboardOnly,
    pbtAuditOnly,
    verifyOnly,
    baseSha,
    restoredManifestPath,
    verifyPhase,
    factsPath,
    requirementAnchors,
    writeSpec,
    variant,
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
    verifyOnly,
    baseSha,
    restoredManifestPath,
    verifyPhase,
    factsPath,
    requirementAnchors,
    writeSpec,
    variant,
  } = parseArgs(argv)
  const report = loadReport(reportPath)
  // R25：帶 --facts 時，事實完全來自 workflow 在 clean repo 產生的 JSON；本步驟
  // 不得再對 agent 工作樹跑任何 git 命令（clean filter／index flags／ignore 檔
  // 因此沒有執行或說謊的機會）。--base-sha 仍獨立驗證：兩者不一致即紅燈。
  const facts = factsPath === undefined ? undefined : loadVerifyFacts(factsPath)
  if (facts !== undefined && baseSha !== facts.baseSha) {
    throw new CliError(
      `--base-sha ${String(baseSha)} 與 --facts 的 baseSha ${facts.baseSha} 不一致——` +
        '拒絕混用兩個 diff 基準（R19／R25，fail closed）',
    )
  }
  // 驗證類沒有分支（R2：本地 commit 可以、push 不行），事實來源改成工作區
  // 相對 base 的 diff；其餘模式維持 factory/<issue>-* 分支的三點 diff。
  // R19／C2：`--base-sha` 存在時以該不可變 commit 為基準，`--base` 的分支名
  // 完全不參與（agent 的本地 commit 會推進本地 base 分支）。
  let actual: CrosscheckActual
  if (verifyOnly && facts !== undefined) {
    actual = actualFromVerifyFacts(facts)
  } else if (verifyOnly) {
    actual = collectVerifyDiff(git, {
      base:
        baseSha === undefined
          ? paths.base
          : resolveBaseSha(git, paths.target, baseSha),
      target: paths.target,
    })
  } else {
    actual = collectActualDiff(git, { issueNumber, base: paths.base, target: paths.target })
  }
  // R13／R15：階段輸入是前一階段還原到工作區的檔案（tracked 檔案被覆寫時進 git
  // diff，新檔則是 untracked），不是本次 agent 的交付。只有還原後**沒有被動過**
  // （存在且 sha256 與 manifest 相符）的檔案才扣除；被改動或刪除的還原輸入留在
  // diff 裡，另記為 restored-input-modified（hard，與 diff-not-reported 同級）。
  let restoredInputMismatches: CrosscheckMismatch[] = []
  if (restoredManifestPath !== undefined) {
    const verified = verifyRestoredInputs(loadRestoredManifest(restoredManifestPath), paths.target, verifyPhase)
    actual = subtractRestoredPaths(actual, verified.unchanged)
    restoredInputMismatches = verified.mismatches
  }
  const mismatches = compareReportToActual(
    report,
    actual,
    analyzeOnly,
    proposeSkillOnly,
    onboardOnly,
    verifyOnly,
  )
  mismatches.push(...restoredInputMismatches)
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
  // 驗證類的白名單（ADR-029 §5、§6）：只允許 specs/** 與測試檔。放在 report
  // 一致性檢查之後：先確認 report 誠實，再確認變更範圍合法——兩者是不同處置。
  if (verifyOnly) {
    mismatches.push(...checkVerifyScope(changed))
    // R26 (d)：agent 在 neutralised 路徑下新建的檔案不能因為落在白名單內就放行
    //（例如 `specs/AGENTS.md` 符合 `specs/**`）。這裡用 `changed`（已扣除還原的
    // 階段輸入、也已濾掉 neutralised D）而不是原始 facts；outside-whitelist 者
    // 已由上一行涵蓋，這一行只補白名單內的漏網路徑。
    const neutralisedAllowed = changed.filter(
      (path) => isNeutralisedPath(path) && isVerifyAllowedPath(path),
    )
    if (neutralisedAllowed.length > 0) {
      mismatches.push({
        kind: 'verify-neutralised-path',
        detail:
          `agent 在 neutralised 路徑下新增／改寫檔案：${neutralisedAllowed.join('、')}` +
          '。`.dsh`／`.agents`／`AGENTS.md`／`AGENTS.local.md`／`CLAUDE.md`／`CLAUDE.local.md`' +
          ' 是 mechanism／instruction 面，即使路徑落在 specs／test 白名單內也不得由驗證 agent 建立（R26 (d)）',
      })
    }
  }
  let remoteBranches: string[] | undefined
  if (variant !== undefined) {
    remoteBranches = parseRemoteBranches(readFileSync(variant.remoteBranchesPath, 'utf8'))
    mismatches.push(
      ...checkVariantIsolation({
        issueNumber,
        variant: variant.id,
        localBranches: actual.branches,
        remoteBranches,
        reportedPaths: collectReportedPaths(report.changedPaths),
      }),
    )
  }
  // advisory 不參與 ok 判定（第一階段觀察期，見 CrosscheckOutput.advisories）
  const advisories = compareRequirementIds(report.requirements, requirementAnchors)
  // 重跑／沿用既有交付：report 帶 reusedExistingPr 時機械驗證（見 validateReuseClaim）。
  // 成立 → 把「既有 diff vs 空報告」的不一致降級為 advisory；不成立 → fail-loud。
  if (report.reusedExistingPr !== undefined) {
    const claim = validateReuseClaim({
      issueNumber,
      reportedPaths: collectReportedPaths(report.changedPaths),
      localBranches: actual.branches,
      remoteBranches,
      variant: variant?.id,
    })
    if (claim.valid) {
      const kept = mismatches.filter((m) => !REUSE_DOWNGRADED_KINDS.has(m.kind))
      mismatches.length = 0
      mismatches.push(...kept)
      const files = actual.paths.filter((p) => !isFactoryInternal(p))
      advisories.push({
        kind: 'reuse-of-existing-pr',
        detail:
          `沿用既有交付 PR #${report.reusedExistingPr}（分支 ${claim.branch}；其 diff ${files.length} 個檔案、` +
          `${actual.added + actual.deleted} 行屬先前 run 的交付，非本次未回報變更）；本次 changedPaths=[] 與沿用相符`,
      })
    } else {
      mismatches.push({
        kind: 'reuse-claim-unverified',
        detail: `report 宣稱沿用既有 PR #${report.reusedExistingPr}，但機械驗證不成立：${claim.reason}`,
      })
    }
  }
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
