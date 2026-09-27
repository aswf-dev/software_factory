/**
 * factory-push-event — 把一次 factory run 的既有產物組裝成事件，送往 Scoreboard
 * （docs/26 §2、ADR-015）。
 *
 * 輸入：report.json（含 usage 區塊）、judge.json、crosscheck.json、model.json。
 * 輸出：stdout 印出送出的事件 JSON（CI 存檔便於除錯）。
 *
 * 設計立場（docs/26 §2.3）：**純資料搬運，無判斷邏輯**。
 *   - 不重新計算成本、不判定終態、不推論 skill-gap；
 *   - 缺檔以 null 填入，不中止；
 *   - 這一點很重要：若推送端有自己的判斷，就會出現「後台數字與 Issue 標籤
 *     不一致」的可能。事件必須是既有事實的**忠實副本**。
 *
 * 收集面永不影響執行面（docs/26 設計原則）：本 CLI **任何失敗都 exit 0**，
 * 包含網路錯誤、後台離線、token 未設定。工廠的終態判定完全不受影響。
 * 這與 factory-usage「量測是附註不是 gate」同一立場。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { hasUnreportedSkillGapAdvisory } from '../skill-gap/unreported.js'
import { isMainModule } from './is-main-module.js'
import { CliError } from './run-cli.js'

export interface FactoryPushEventArgs {
  repo: string
  issueNumber: number
  runId: number | null
  taskType: string
  reportPath?: string | undefined
  judgePath?: string | undefined
  crosscheckPath?: string | undefined
  modelPath?: string | undefined
  /**
   * 本次 run 實際載入的技能集合版本（`factory-skills-lock --verify` 的 `digest`）。
   *
   * **由 CI 以旗標傳入，刻意不從 report.json 讀。** 原實作讀
   * `report.skillsDigest`，而 report.json 是 agent 自己寫的檔案——若這個欄位可由
   * agent 回報，agent 就能宣稱任意的技能版本，而這個欄位的全部用途正是「用來判斷
   * 某個 skill 放行後 gap 是否消失」（`docs/25` §5 第 4 步）。可被受測者填寫的
   * 量測值沒有意義。空字串與缺席同義（→ `null`）。
   */
  skillsDigest?: string | undefined
  /** 只組裝並印出事件，不實際送出（供 CI dry_run 與本機驗證）。 */
  dryRun: boolean
}

export function parseArgs(argv: string[]): FactoryPushEventArgs {
  let repo: string | undefined
  let issue: string | undefined
  let runId: string | undefined
  let taskType: string | undefined
  let reportPath: string | undefined
  let judgePath: string | undefined
  let crosscheckPath: string | undefined
  let modelPath: string | undefined
  let skillsDigest: string | undefined
  let dryRun = false
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const next = (): string | undefined => argv[++i]
    const need = (flag: string): string => {
      const v = next()
      if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} requires a value`)
      return v
    }
    if (arg === '--repo') repo = need('--repo')
    else if (arg === '--issue') issue = need('--issue')
    else if (arg === '--run-id') runId = need('--run-id')
    else if (arg === '--task-type') taskType = need('--task-type')
    else if (arg === '--report') reportPath = need('--report')
    else if (arg === '--judge') judgePath = need('--judge')
    else if (arg === '--crosscheck') crosscheckPath = need('--crosscheck')
    else if (arg === '--model') modelPath = need('--model')
    else if (arg === '--skills-digest') skillsDigest = need('--skills-digest')
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--')) throw new CliError(`unknown argument: ${arg}`)
    else positional.push(arg)
  }

  if (repo === undefined) throw new CliError('--repo is required')
  if (issue === undefined) throw new CliError('--issue is required')
  if (taskType === undefined) throw new CliError('--task-type is required')
  if (positional.length > 0) throw new CliError(`unexpected positional arguments: ${positional.join(', ')}`)

  const issueNumber = Number(issue)
  if (!Number.isInteger(issueNumber) || issueNumber < 0) {
    throw new CliError(`--issue must be a non-negative integer, got ${issue}`)
  }

  let parsedRunId: number | null = null
  if (runId !== undefined && runId !== '') {
    const n = Number(runId)
    // run_id 不合法時降級為 null 而非中止：事件仍有價值，只是少了回溯連結。
    parsedRunId = Number.isInteger(n) && n >= 0 ? n : null
  }

  return {
    repo,
    issueNumber,
    runId: parsedRunId,
    taskType,
    reportPath,
    judgePath,
    crosscheckPath,
    modelPath,
    skillsDigest,
    dryRun,
  }
}

/** 讀 JSON；檔案不存在或壞 JSON 一律回 undefined（docs/26 §1.2：必須容忍缺檔）。 */
function readJson(path: string | undefined): Record<string, unknown> | undefined {
  if (path === undefined) return undefined
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    return raw as Record<string, unknown>
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 取第一條停手規則 id。
 *
 * StopDecision 的形狀是 `{ mustStop, violations: [{ rule, reason }], … }`，
 * 沒有頂層 `rule` 欄位；事件 schema 的 `stop_reason` 是單值，故取首條為代表。
 * 未停手（mustStop=false）或無 violations 時回 null。
 */
function firstStopRule(stopDecision: Record<string, unknown> | undefined): string | null {
  const violations = stopDecision?.['violations']
  if (!Array.isArray(violations)) return null
  for (const v of violations) {
    const rule = asRecord(v)?.['rule']
    if (typeof rule === 'string') return rule
  }
  return null
}

/** event_id = sha256(run_id:issue_number) 前 32 字元（docs/26 §3，與接收端同演算法）。 */
export function deriveEventId(runId: number | null, issueNumber: number): string {
  return createHash('sha256').update(`${runId ?? 'no-run'}:${issueNumber}`).digest('hex').slice(0, 32)
}

/** `philipz/software_factory` → owner + repo；無斜線時 owner 留空字串由呼叫端決定。 */
export function splitRepo(full: string): { owner: string; repo: string } {
  const idx = full.indexOf('/')
  if (idx <= 0) return { owner: 'unknown', repo: full }
  return { owner: full.slice(0, idx), repo: full.slice(idx + 1) }
}

export interface WorkItemEvent {
  event_id: string
  schema_version: 2
  occurred_at: string
  source: string
  owner: string
  repo: string
  issue_number: number
  run_id: number | null
  task_type: string
  model_tier: string | null
  usage: unknown
  outcome: string | null
  skill_gap: unknown
  stop_reason: string | null
  crosscheck_mismatches: string[]
  skills_digest: string | null
  extra: Record<string, unknown>
}

/**
 * 組裝事件：只做欄位搬運與缺檔降級。
 *
 * 注意 crosscheck 只取 `kind` **不取 `detail`** —— detail 含檔案路徑與 issue
 * 內容（隱私，docs/26 §1.1 約束 3、§6）。
 */
export function buildEvent(args: FactoryPushEventArgs, now: () => Date = () => new Date()): WorkItemEvent {
  const report = readJson(args.reportPath)
  const judge = readJson(args.judgePath)
  const crosscheck = readJson(args.crosscheckPath)
  const model = readJson(args.modelPath)

  const result = asRecord(judge?.['result'])
  const stopDecision = asRecord(result?.['stopDecision'])
  const mismatches = Array.isArray(crosscheck?.['mismatches']) ? crosscheck['mismatches'] : []

  const { owner, repo } = splitRepo(args.repo)

  return {
    event_id: deriveEventId(args.runId, args.issueNumber),
    schema_version: 2,
    occurred_at: now().toISOString(),
    source: 'factory-ci',
    owner,
    repo,
    issue_number: args.issueNumber,
    run_id: args.runId,
    task_type: args.taskType,
    model_tier: typeof model?.['tier'] === 'string' ? model['tier'] : null,
    // usage 直接透傳，欄位名不改（docs/26 §1.1 約束 1）。
    // unavailableReason 一併帶過去，看板才能顯示「無資料」而非 $0（約束 2）。
    usage: report?.['usage'] ?? null,
    outcome: typeof result?.['outcome'] === 'string' ? result['outcome'] : null,
    // skillGap 由 agent 自報（工作項 E4 接線）；尚未存在時為 null。
    skill_gap: report?.['skillGap'] ?? null,
    // StopDecision 沒有單一 `rule` 欄位，而是 `violations[]`；取第一條規則 id
    // 作為代表（docs/26 schema 的 stop_reason 為單值）。
    stop_reason: firstStopRule(stopDecision),
    crosscheck_mismatches: mismatches
      .map((m) => asRecord(m)?.['kind'])
      .filter((k): k is string => typeof k === 'string'),
    // CI 量測值，非 agent 自報（見 FactoryPushEventArgs.skillsDigest）。
    skills_digest: args.skillsDigest !== undefined && args.skillsDigest !== '' ? args.skillsDigest : null,
    // REQ id 錨定訊號（RTM）。放進 extra 而非新增頂層欄位，是為了不改動
    // schema v2——接收端（factory-scoreboard）的 extra 為前向相容槽，零改動即可
    // 收下（docs/26 §1）。累積後可統計「哪一類驗收條件最常 failed」，那是**不依賴
    // agent 自報 skillGap** 的技能缺口訊號（docs/25 §2.3 T3）。
    // 只送 id，不送條文內容（隱私，docs/26 §1.1 約束 3）。
    extra: buildRequirementExtra(report, crosscheck, judge),
  }
}

/**
 * 由 report 與 crosscheck 萃取需求追蹤訊號。
 *
 * 兩者皆缺時回傳空物件——`extra` 是選用槽，不製造空欄位噪音。
 */
export function buildRequirementExtra(
  report: Record<string, unknown> | undefined,
  crosscheck: Record<string, unknown> | undefined,
  judge?: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}

  const reqs = report?.['requirements']
  if (Array.isArray(reqs)) {
    const failed = reqs
      .filter((r) => asRecord(r)?.['status'] === 'failed')
      .map((r) => asRecord(r)?.['id'])
      .filter((id): id is string => typeof id === 'string')
    if (failed.length > 0) extra['requirements_failed'] = failed
    extra['requirements_total'] = reqs.length
  }

  const advisories = crosscheck?.['advisories']
  if (Array.isArray(advisories) && advisories.length > 0) {
    extra['requirement_advisories'] = advisories
      .map((a) => asRecord(a)?.['kind'])
      .filter((k): k is string => typeof k === 'string')
  }

  // 「該回報卻沒回報技能缺口」：以單一布林送出，而非把兩邊的 advisory 陣列
  // 都塞進事件。理由有二：
  //  1. crosscheck 與 judge 可能對**同一次 run** 各發一條（例如零產出 ＋
  //     needs-human），送陣列會讓後台需要自行去重；布林由構造上就不重複。
  //  2. 兩處的 detail 對聚類沒有額外價值——真正要聚類的是缺口本身（skill_gap），
  //     這裡只需要知道「這次 run 屬於缺口訊號可能漏掉的那一類」。
  // 不發生時**不寫入欄位**（不製造 `false` 噪音，與本函式其他欄位同慣例）。
  if (
    hasUnreportedSkillGapAdvisory(crosscheck?.['advisories']) ||
    hasUnreportedSkillGapAdvisory(judge?.['advisories'])
  ) {
    extra['skill_gap_unreported'] = true
  }
  return extra
}

export interface PushOutcome {
  event: WorkItemEvent
  /** 是否實際送出（dry-run 或缺 URL/token 時為 false）。 */
  pushed: boolean
  /** 未送出或送出失敗的原因；成功時為 null。 */
  skippedReason: string | null
  status?: number | undefined
}

/**
 * 送出事件。
 *
 * 一律 resolve、永不 throw —— 呼叫端據此保證 exit 0。
 */
export async function pushEvent(
  event: WorkItemEvent,
  url: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  if (url === undefined || url === '') {
    return { event, pushed: false, skippedReason: 'SCOREBOARD_URL 未設定' }
  }
  if (token === undefined || token === '') {
    return { event, pushed: false, skippedReason: 'SCOREBOARD_TOKEN 未設定' }
  }

  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    })
    if (!res.ok) {
      return { event, pushed: false, skippedReason: `HTTP ${res.status}`, status: res.status }
    }
    return { event, pushed: true, skippedReason: null, status: res.status }
  } catch (err) {
    return { event, pushed: false, skippedReason: `網路錯誤：${(err as Error).message}` }
  }
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<PushOutcome> {
  const args = parseArgs(argv)
  const event = buildEvent(args, now)
  if (args.dryRun) {
    return { event, pushed: false, skippedReason: 'dry-run' }
  }
  return pushEvent(event, env['SCOREBOARD_URL'], env['SCOREBOARD_TOKEN'], fetchImpl)
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  void (async () => {
    try {
      const outcome = await main(process.argv.slice(2))
      process.stdout.write(`${JSON.stringify(outcome.event, null, 2)}\n`)
      if (!outcome.pushed && outcome.skippedReason !== null) {
        process.stderr.write(`scoreboard 未送出：${outcome.skippedReason}\n`)
      }
    } catch (err) {
      // 參數錯誤等也不擋 run——收集面永不影響執行面（docs/26 設計原則）。
      process.stderr.write(`scoreboard 推送失敗（已忽略）：${(err as Error).message}\n`)
    }
    // 刻意永遠 exit 0。
    process.exitCode = 0
  })()
}
/* v8 ignore stop */
