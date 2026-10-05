/**
 * factory-pbt-audit-comment — 產生 agent-pbt-audit 的機制留言（ADR-019 R4、R10）。
 *
 * agent 不開 Issue、不自己留言：它把候選發現寫進 report.json 的 `pbtAudit`，本 CLI
 * 在 run 結束後讀出來，連同**機制實測**的數據（牆鐘、diff 裡的 PBT 檔與 property 數）
 * 組成一則留言，由 workflow 貼到稽核 Issue。
 *
 * 實測數據直接讀目標 repo 的 git（與 crosscheck 共用 collectActualDiff），不讀
 * crosscheck.json：crosscheck 拋例外時不會寫出 JSON，而那正是最需要留言說明的情況。
 *
 * **永遠 exit 0、不擋 run**：留言是紀錄，不是 gate（同 factory-usage、factory-push-event
 * 的立場）。report.json 不存在或壞掉時照樣產生留言，只是自報段落寫明缺席。
 *
 * 用法：factory-pbt-audit-comment --issue <n> --report <path> --target <dir> --base <branch>
 *       --run-id <id> [--agent-start <epoch 秒> --agent-end <epoch 秒>]
 */
import { readFileSync } from 'node:fs'
import { buildPbtAuditComment, countProperties } from '../pbt-audit/comment.js'
import { isPbtTestPath } from '../pbt-audit/languages.js'
import { collectActualDiff, isFactoryInternal, realGit, type GitRunner } from './factory-crosscheck.js'
import { isMainModule } from './is-main-module.js'
import { CliError, formatCliError } from './run-cli.js'

export interface PbtCommentArgs {
  issueNumber: number
  reportPath: string
  target: string
  base: string
  runId: string
  agentStart?: number | undefined
  agentEnd?: number | undefined
}

export function parseArgs(argv: string[]): PbtCommentArgs {
  const v: Partial<Record<string, string>> = {}
  const allowed = ['--issue', '--report', '--target', '--base', '--run-id', '--agent-start', '--agent-end']
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!allowed.includes(arg)) throw new CliError(`unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    v[arg] = value
  }
  for (const req of ['--issue', '--report', '--target', '--base', '--run-id']) {
    if (v[req] === undefined) throw new CliError(`${req} is required`)
  }
  const issueNumber = Number(v['--issue'])
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError(`--issue must be a positive integer, got ${v['--issue'] as string}`)
  }
  // 時間戳記取不到（step 被跳過、env 為空字串）時視為量不到，不讓留言失敗。
  const epoch = (raw: string | undefined): number | undefined => {
    const n = Number(raw)
    return raw === undefined || raw === '' || !Number.isFinite(n) || n <= 0 ? undefined : n
  }
  return {
    issueNumber,
    reportPath: v['--report'] as string,
    target: v['--target'] as string,
    base: v['--base'] as string,
    runId: v['--run-id'] as string,
    agentStart: epoch(v['--agent-start']),
    agentEnd: epoch(v['--agent-end']),
  }
}

/** report.json 的 `pbtAudit` 原值；檔案不存在或不是 JSON 物件時回傳 undefined。 */
function readPbtAudit(reportPath: string): unknown {
  try {
    const raw: unknown = JSON.parse(readFileSync(reportPath, 'utf8'))
    return typeof raw === 'object' && raw !== null ? (raw as { pbtAudit?: unknown }).pbtAudit : undefined
  } catch {
    return undefined
  }
}

export function main(argv: string[], git: GitRunner = realGit): { comment: string; pbtFiles: string[] } {
  const args = parseArgs(argv)
  const actual = collectActualDiff(git, { issueNumber: args.issueNumber, base: args.base, target: args.target })
  const pbtFiles = actual.paths.filter((p) => !isFactoryInternal(p) && isPbtTestPath(p))
  const propertyCounts: Record<string, number | undefined> = {}
  for (const path of pbtFiles) {
    // 由最上層的分支往下找：stacked 分支裡越上層越新。檔案在任何分支都讀不到時
    // （例如被刪掉的 PBT 檔）就是未計數，不猜。
    let count: number | undefined
    for (const branch of [...actual.branches].reverse()) {
      try {
        count = countProperties(path, git(['show', `${branch}:${path}`], args.target))
        break
      } catch {
        // 該分支沒有此檔
      }
    }
    propertyCounts[path] = count
  }
  const wall =
    args.agentStart !== undefined && args.agentEnd !== undefined && args.agentEnd >= args.agentStart
      ? (args.agentEnd - args.agentStart) * 1000
      : undefined
  return {
    comment: buildPbtAuditComment(readPbtAudit(args.reportPath), { agentWallClockMs: wall, pbtFiles, propertyCounts }, args.runId),
    pbtFiles,
  }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2)).comment}\n`)
  } catch (err) {
    // 留言是紀錄不是 gate：參數錯誤也只在 stderr 報告，exit 0 不擋 run
    process.stderr.write(`${formatCliError(err)}\n`)
  }
}
/* v8 ignore stop */
