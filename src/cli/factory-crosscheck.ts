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
}

export interface CrosscheckMismatch {
  kind: string
  detail: string
}

export interface CrosscheckOutput {
  issueNumber: number
  ok: boolean
  report: { changedPaths: string[] | undefined; changedLines: number | undefined }
  actual: CrosscheckActual
  mismatches: CrosscheckMismatch[]
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
    requirements?: readonly { id: string; status: string }[] | undefined
  },
  actual: CrosscheckActual,
): CrosscheckMismatch[] {
  const mismatches: CrosscheckMismatch[] = []
  const reported = collectReportedPaths(report.changedPaths)
  const actualPaths = actual.paths.filter((p) => !isFactoryInternal(p))
  const hasDiff = actualPaths.length > 0
  const actualTotal = actual.added + actual.deleted

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
  return mismatches
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
  }
  const uncommitted = parseStatusPorcelain(git(['status', '--porcelain'], target))
  return { branches, paths, added, deleted, uncommitted }
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

/** 解析位置參數：`<issueNumber> <reportPath> [--base <b>] [--target <t>]`。 */
export function parseArgs(argv: string[]): {
  issueNumber: number
  reportPath: string
  paths: CrosscheckCliPaths
} {
  const positional: string[] = []
  let base = 'software-factory'
  let target = 'target'
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
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  const issueNumber = Number(positional[0])
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError(`issueNumber must be a positive integer, got ${positional[0] ?? '(missing)'}`)
  }
  const reportPath = positional[1]
  if (reportPath === undefined) throw new CliError('reportPath is required')
  return { issueNumber, reportPath, paths: { base, target } }
}

export function main(argv: string[], git: GitRunner = realGit): CrosscheckOutput {
  const { issueNumber, reportPath, paths } = parseArgs(argv)
  const report = loadReport(reportPath)
  const actual = collectActualDiff(git, { issueNumber, base: paths.base, target: paths.target })
  const mismatches = compareReportToActual(report, actual)
  return {
    issueNumber,
    ok: mismatches.length === 0,
    report: { changedPaths: report.changedPaths, changedLines: report.changedLines },
    actual,
    mismatches,
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
