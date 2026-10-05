/**
 * factory-pbt-preflight — agent-pbt-audit 在 agent 啟動前的硬性檢查（ADR-019 R3、前置作業）。
 *
 * 兩件事，都在目標 repo 的 checkout 上判定：
 *  1. 稽核目標（`reviewPbtAuditIntake`）：恰好一個路徑、存在、不是測試檔、語言受支援。
 *     issue-check 已在同一個 run 判過一次，這裡重判是因為 dispatch 可以用 task_type
 *     覆寫 Issue 宣告的類型——那時 issue-check 並沒有跑 audit 的檢查。
 *  2. 前置作業（`checkPbtPrerequisites`）：Hegel 依賴精確釘版、`.gitignore` 含 `.hegel/`。
 *
 * 任一不過 → exit 1，workflow 留言（stdout JSON 的 `comment`）並貼 needs-human。
 * 這是 gate，不是 advisory：沒裝好時 agent 一定會在 SR5 停下，跑下去只浪費預算。
 *
 * 用法：factory-pbt-preflight --issue-json <gh issue view --json body> --target-root <dir>
 */
import { readFileSync } from 'node:fs'
import { extractDeclaredPaths } from './factory-issue-check.js'
import { reviewPbtAuditIntake } from '../pbt-audit/intake.js'
import { checkPbtPrerequisites } from '../pbt-audit/preflight.js'
import { repoFs } from '../pbt-audit/repo-fs.js'
import { isMainModule } from './is-main-module.js'
import { CliError, formatCliError } from './run-cli.js'

export interface PbtPreflightOutput {
  ok: boolean
  target: string | undefined
  language: string | undefined
  smokeOnly: boolean
  errors: string[]
  comment: string
}

export function parseArgs(argv: string[]): { issueJson: string; targetRoot: string } {
  let issueJson: string | undefined
  let targetRoot: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const need = (): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError(`${arg} requires a value`)
      return v
    }
    if (arg === '--issue-json') issueJson = need()
    else if (arg === '--target-root') targetRoot = need()
    else throw new CliError(`unknown argument: ${arg}`)
  }
  if (issueJson === undefined) throw new CliError('--issue-json is required')
  if (targetRoot === undefined) throw new CliError('--target-root is required')
  return { issueJson, targetRoot }
}

export function buildPreflightComment(out: Omit<PbtPreflightOutput, 'comment'>, runId?: string): string {
  const run = runId === undefined ? '' : `（run: ${runId}）`
  if (out.ok) {
    const smoke = out.smokeOnly
      ? '此語言的依賴無法機械檢查，agent 第一步會跑 smoke property 驗證。'
      : 'agent 第一步仍會跑 smoke property，確認測試 runner 能載入 Hegel。'
    return `✅ **PBT 稽核前置檢查通過**${run}：稽核目標 \`${out.target}\`（${out.language}）。${smoke}`
  }
  return [
    `❌ **PBT 稽核前置檢查未通過**${run}：agent 未啟動（ADR-019 前置作業）。`,
    '',
    ...out.errors.map((e) => `- ${e}`),
    '',
    'Hegel 依賴與 `.gitignore` 由人類以一般 PR 放進目標 repo 的 trunk（agent 依 SR5 不得新增依賴）。' +
      '操作步驟見 `docs/30-pbt-audit-runbook.md`，完成後重新 dispatch。',
  ].join('\n')
}

export function main(argv: string[], runId?: string): PbtPreflightOutput {
  const { issueJson, targetRoot } = parseArgs(argv)
  let body: unknown
  try {
    body = (JSON.parse(readFileSync(issueJson, 'utf8')) as { body?: unknown }).body
  } catch (err) {
    throw new CliError(`--issue-json (${issueJson}) 無法讀取或非合法 JSON：${(err as Error).message}`)
  }
  if (typeof body !== 'string') throw new CliError(`--issue-json (${issueJson}) 缺 body 字串`)

  const fs = repoFs(targetRoot)
  const intake = reviewPbtAuditIntake(extractDeclaredPaths(body), fs)
  const errors = [...intake.errors]
  let smokeOnly = false
  if (intake.language !== undefined) {
    const pre = checkPbtPrerequisites(intake.language, fs.readFile)
    errors.push(...pre.errors)
    smokeOnly = pre.smokeOnly
  }
  const result = { ok: errors.length === 0, target: intake.target, language: intake.language, smokeOnly, errors }
  return { ...result, comment: buildPreflightComment(result, runId) }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const out = main(process.argv.slice(2), process.env.GITHUB_RUN_ID)
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (!out.ok) process.exitCode = 1
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
