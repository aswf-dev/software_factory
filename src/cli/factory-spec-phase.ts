/**
 * factory-spec-phase — agent-write-spec 的階段判定（ADR-018 §12），零 LLM 成本。
 *
 * factory-run 在 agent 啟動前呼叫：收集 Issue 標籤、`spec/approved` 的貼標者、
 * 進行中的 factory PR、trunk 上的 `invariants.qnt`，交給 `decidePhase`。
 * 結果為不變量階段時，同時寫出 `source.md` 快照——意圖原文由 CI 擷取，
 * agent 只能引用、不能改寫（crosscheck 以同一份快照逐字元比對）。
 *
 * 輸出 JSON（stdout）：`{ decision, reason, specName, sourceKind, labelsToAdd,
 * labelsToRemove, snapshotPath? }`。拒絕不是 CLI 錯誤——由 workflow 讀
 * `decision` 決定留言與停止；只有輸入或設定錯誤才以 exit 1 結束。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { classifySpecSource, isValidSpecName, type SpecSourceKind } from '../write-spec/intake.js'
import {
  buildSourceSnapshot,
  decidePhase,
  isHumanCodeownerApproval,
  parseCodeowners,
  SPEC_LABELS,
  type LabelEvent,
  type PhaseDecision,
} from '../write-spec/phase.js'
import { specPaths } from '../write-spec/scope.js'
import { extractField } from './factory-issue-check.js'
import { isMainModule } from './is-main-module.js'
import { CliError, formatCliError } from './run-cli.js'

/** 外部指令注入點（`gh`／`git`）；測試以 fake 取代。 */
export type ExecRunner = (cmd: string, args: string[]) => string

/* v8 ignore start -- 真實二進位的薄包裝：單元測試一律注入 fake runner */
const realExec: ExecRunner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })
/* v8 ignore stop */

export interface SpecPhaseArgs {
  issueNumber: number
  repo: string
  target: string
  /** 另存一份快照供 crosscheck 比對（不在 target 內，agent 碰不到）。 */
  snapshotOut?: string | undefined
}

export interface SpecPhaseOutput extends PhaseDecision {
  specName?: string | undefined
  sourceKind?: SpecSourceKind | undefined
  snapshotPath?: string | undefined
}

export function parseArgs(argv: string[]): SpecPhaseArgs {
  let issue: string | undefined
  let repo: string | undefined
  let target = 'target'
  let snapshotOut: string | undefined
  const value = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} requires a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--repo') repo = value(++i, arg)
    else if (arg === '--target') target = value(++i, arg)
    else if (arg === '--snapshot-out') snapshotOut = value(++i, arg)
    else if (!arg.startsWith('--') && issue === undefined) issue = arg
    else throw new CliError(`unknown argument: ${arg}`)
  }
  const issueNumber = Number(issue)
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError(`issueNumber must be a positive integer, got ${issue ?? '(missing)'}`)
  }
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new CliError(`--repo must be owner/name, got ${repo ?? '(missing)'}`)
  }
  return { issueNumber, repo, target, snapshotOut }
}

/** GitHub 依序搜尋的 CODEOWNERS 位置。 */
const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

function readCodeowners(target: string): Set<string> {
  const found = CODEOWNERS_LOCATIONS.map((p) => join(target, p)).find((p) => existsSync(p))
  return found === undefined ? new Set() : parseCodeowners(readFileSync(found, 'utf8'))
}

/** `gh --jq` 逐行輸出的 JSON 物件。 */
function parseJsonLines(output: string): unknown[] {
  return output
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

export function main(
  argv: string[],
  exec: ExecRunner = realExec,
  now: () => Date = () => new Date(),
): SpecPhaseOutput {
  const { issueNumber, repo, target, snapshotOut } = parseArgs(argv)
  const issue = JSON.parse(
    exec('gh', ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'state,labels,body']),
  ) as { state: string; labels: { name: string }[]; body: string }
  const labels = issue.labels.map((l) => l.name)

  const specName = extractField(issue.body, 'spec_name')
  const specSource = extractField(issue.body, 'spec_source')
  const source = specSource === undefined ? undefined : classifySpecSource(specSource)
  if (specName === undefined || !isValidSpecName(specName) || source === undefined || source.error !== undefined) {
    // issue-check 已在更早的步驟擋下這種情況；走到這裡代表接線或順序出錯。
    return {
      decision: 'refuse',
      reason: 'Issue 的「規格名稱」或「規格來源」缺漏或不合法（應已由 factory-issue-check 擋下）',
      labelsToAdd: [],
      labelsToRemove: [],
    }
  }

  // 只有貼了 spec/approved 才需要查 timeline（省一次 API 呼叫）
  let approvedByHuman = false
  if (labels.includes(SPEC_LABELS.approved)) {
    const events = parseJsonLines(
      exec('gh', [
        'api',
        '--paginate',
        `repos/${repo}/issues/${issueNumber}/timeline`,
        '--jq',
        `.[] | select(.event == "labeled" and .label.name == "${SPEC_LABELS.approved}") | {login: .actor.login, type: .actor.type}`,
      ]),
    ) as LabelEvent[]
    approvedByHuman = isHumanCodeownerApproval(events, readCodeowners(target))
  }

  const openHeads = JSON.parse(
    exec('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'headRefName']),
  ) as { headRefName: string }[]
  const openFactoryPrs = openHeads.filter(
    (p) =>
      p.headRefName.startsWith(`factory/${issueNumber}-`) || p.headRefName.startsWith(`factory/${issueNumber}/`),
  ).length

  const paths = specPaths(specName)
  const decision = decidePhase({
    issueOpen: issue.state === 'OPEN',
    labels,
    approvedByHuman,
    invariantsOnTrunk: existsSync(join(target, paths.invariants)),
    openFactoryPrs,
  })
  const out: SpecPhaseOutput = { ...decision, specName, sourceKind: source.kind }
  if (decision.decision !== 'invariants') return out

  const capturedAt = now().toISOString()
  const snapshot =
    source.kind === 'issue'
      ? buildSourceSnapshot({
          kind: 'issue',
          repo,
          issueNumber,
          capturedAt,
          content: extractField(issue.body, 'requirement') ?? '',
        })
      : buildSourceSnapshot({
          kind: 'path',
          path: specSource as string,
          trunkSha: exec('git', ['-C', target, 'rev-parse', 'HEAD']).trim(),
          capturedAt,
          content: readFileSync(join(target, (specSource as string).trim()), 'utf8'),
        })
  const inTarget = join(target, paths.source)
  mkdirSync(dirname(inTarget), { recursive: true })
  writeFileSync(inTarget, snapshot)
  if (snapshotOut !== undefined) {
    mkdirSync(dirname(snapshotOut), { recursive: true })
    writeFileSync(snapshotOut, snapshot)
  }
  return { ...out, snapshotPath: inTarget }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`)
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
