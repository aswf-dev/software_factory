/**
 * factory-terminal — 彙整各變體的結果，產出 Issue 唯一的一份終態（ADR-021）。
 *
 * 背景：N-version 的兩個變體原本各自往 Issue 貼終態標籤與留言，結果是兩邊的**聯集**
 * （例如 `needs-human` 與另一邊的監督標籤同時存在），而且兩個變體共用 `run_id`，
 * G1 守衛以 run id 判斷「是否已有終態」會誤判。改由 compare job 呼叫本 CLI，作為
 * **唯一寫入者**：
 *
 *   - 任一變體可審查 → ready-for-review（N-version 一律由人選勝者，不自動合併）；
 *   - 沒有可審查者 → needs-human；全部只是 blocked-in-loop → blocked-in-loop；
 *   - 所有變體都沒啟動 agent → 不寫入（前置閘門已有自己的訊號，同 G2 的規則）；
 *   - 監督標籤取最嚴格者（單向棘輪：寧可多一分審查，不可少）。
 *
 * 留言帶 `terminalMarker(runId)`：G1（compare job 最後一步）與 G2（factory-run-cleanup）
 * 只認這個標記，不再認「任何含 run id 的留言」——變體的細節留言、規格階段留言都含
 * run id，舊判斷會因此誤以為終態已寫入。
 *
 * 純資料轉換：本 CLI 只輸出 JSON（write／outcome／labels／comment），貼標籤與留言由
 * workflow 執行，方便以 stub 驗證。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillGapSchema, type SkillGap } from './factory-judge.js'
import { PHASE1_HUMAN_REVIEW_NOTE } from './apply-judge-labels.js'
import { renderSkillGapMarkdown } from '../skill-gap/render.js'
import { SKILL_GAP_LABEL } from '../labels.js'
import { NEEDS_HUMAN_LABEL } from '../stop-rules/types.js'
import { TIER_LABEL } from '../scoring/types.js'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export type VariantId = 'a' | 'b'
export type Outcome = 'ready-to-automerge' | 'ready-for-review' | 'blocked-in-loop' | 'needs-human'

/** run job 最後一步記下的各步驟結果（`steps.<id>.outcome`）。 */
export interface StepOutcomes {
  agent: string
  crosscheck: string
  specverify: string
  judge: string
}

export interface VariantArtifacts {
  steps?: unknown
  judge?: unknown
  report?: unknown
  /** factory-usage 產出的用量 markdown（docs/08 §2.3：成本附於 Issue 終態留言）。 */
  usageMarkdown?: string | undefined
}

export interface VariantTerminal {
  variant: VariantId
  /** judged＝有合法 judge；failed＝某步驟失敗；not-started＝agent 未啟動；missing＝沒有產物。 */
  state: 'judged' | 'failed' | 'not-started' | 'missing'
  outcome: Outcome
  labels: string[]
  reason: string
  skillGap?: SkillGap | undefined
  usageMarkdown?: string | undefined
}

/** G1／G2 判斷「本 run 的終態已寫入」的唯一依據。 */
export function terminalMarker(runId: number): string {
  return `<!-- factory:terminal run=${runId} -->`
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function parseSkillGap(v: unknown): SkillGap | undefined {
  const r = SkillGapSchema.safeParse(v)
  return r.success ? r.data : undefined
}

const OUTCOMES: readonly Outcome[] = ['ready-to-automerge', 'ready-for-review', 'blocked-in-loop', 'needs-human']

function failed(variant: VariantId, reason: string, skillGap: SkillGap | undefined): VariantTerminal {
  return { variant, state: 'failed', outcome: 'needs-human', labels: [], reason, skillGap }
}

/** 由單一變體的產物推導它的終態；用量 markdown 原樣附上（空白視為缺席）。 */
export function deriveVariant(variant: VariantId, a: VariantArtifacts): VariantTerminal {
  const v = deriveOutcome(variant, a)
  const usage = a.usageMarkdown?.trim()
  return usage === undefined || usage === '' ? v : { ...v, usageMarkdown: usage }
}

function deriveOutcome(variant: VariantId, a: VariantArtifacts): VariantTerminal {
  const steps = asRecord(a.steps)
  const report = asRecord(a.report)
  const reportGap = parseSkillGap(report?.['skillGap'])
  if (steps === undefined) {
    return { variant, state: 'missing', outcome: 'needs-human', labels: [], reason: '沒有執行產物（job 可能被中止）', skillGap: reportGap }
  }
  const agent = steps['agent']
  if (agent === 'skipped' || agent === '' || agent === undefined) {
    return { variant, state: 'not-started', outcome: 'needs-human', labels: [], reason: 'agent 未啟動' }
  }
  if (agent !== 'success') {
    return failed(variant, report?.['timedOut'] === true ? 'agent 逾時' : 'agent 執行失敗', reportGap)
  }
  if (steps['crosscheck'] === 'failure') return failed(variant, '報告與實際變更不一致（crosscheck）', reportGap)
  if (steps['specverify'] === 'failure') return failed(variant, '規格驗證未通過', reportGap)

  const result = asRecord(asRecord(a.judge)?.['result'])
  const outcome = result?.['outcome']
  const labels = result?.['labels']
  if (
    typeof outcome !== 'string' ||
    !(OUTCOMES as readonly string[]).includes(outcome) ||
    !Array.isArray(labels) ||
    !labels.every((l) => typeof l === 'string')
  ) {
    return failed(variant, 'agent 已完成但沒有終態判定（judge 步驟失敗）', reportGap)
  }
  const summary = result?.['summary']
  return {
    variant,
    state: 'judged',
    outcome: outcome as Outcome,
    labels: labels as string[],
    reason: typeof summary === 'string' ? summary : '',
    skillGap: parseSkillGap(asRecord(asRecord(a.judge)?.['report'])?.['skillGap']) ?? reportGap,
  }
}

const TIER_ORDER = [TIER_LABEL['on-loop'], TIER_LABEL.review, TIER_LABEL['in-loop']]

/** 監督標籤取最嚴格者；其餘非監督標籤原樣保留（去重）。 */
function mergeLabels(variants: VariantTerminal[]): string[] {
  const all = variants.flatMap((v) => v.labels)
  const tiers = all.filter((l) => TIER_ORDER.includes(l))
  const strictest = tiers.sort((x, y) => TIER_ORDER.indexOf(y) - TIER_ORDER.indexOf(x))[0]
  const others = all.filter((l) => !TIER_ORDER.includes(l) && l !== NEEDS_HUMAN_LABEL)
  return [...(strictest === undefined ? [] : [strictest]), ...new Set(others)]
}

const ICON: Record<Outcome, string> = {
  'ready-to-automerge': '✅',
  'ready-for-review': '✅',
  'blocked-in-loop': '⚠️',
  'needs-human': '❌',
}

export interface TerminalInput {
  runId: number
  nversion: boolean
  variants: VariantTerminal[]
}

export interface TerminalResult {
  write: boolean
  outcome?: Outcome | undefined
  labels: string[]
  comment?: string | undefined
}

export function aggregateTerminal({ runId, nversion, variants }: TerminalInput): TerminalResult {
  const considered = variants.filter((v) => v.state !== 'not-started')
  if (considered.length === 0) return { write: false, labels: [] }

  const ready = considered.filter((v) => v.outcome === 'ready-for-review' || v.outcome === 'ready-to-automerge')
  let outcome: Outcome
  let labels: string[]
  if (ready.length > 0) {
    // N-version 一律由人選勝者：即使某一邊可自動合併，彙整後也只能是 ready-for-review。
    outcome = nversion ? 'ready-for-review' : (ready[0] as VariantTerminal).outcome
    labels = mergeLabels(ready)
  } else if (considered.every((v) => v.outcome === 'blocked-in-loop')) {
    outcome = 'blocked-in-loop'
    labels = mergeLabels(considered)
  } else {
    outcome = 'needs-human'
    labels = [...mergeLabels(considered), NEEDS_HUMAN_LABEL]
  }
  const gaps = considered.filter((v) => v.skillGap !== undefined)
  if (gaps.length > 0) labels.push(SKILL_GAP_LABEL)

  const lines = [terminalMarker(runId), `## 工廠執行結果：${outcome}`, '']
  if (nversion) {
    lines.push(
      outcome === 'ready-for-review'
        ? 'N-version：至少一個變體可審查。請比對兩個變體的 PR，**在勝者的 PR 按「Ready for review」**——工廠會自動把同一變體的其餘 PR 轉正、關閉另一變體的 draft（分支保留），審查後照常按 Merge。（備援：機制 repo 的「Factory N-version Pick」workflow）'
        : 'N-version：沒有任何變體可審查，已交還人類。',
      '',
      '| 變體 | 終態 | 說明 |',
      '| :--- | :--- | :--- |',
      ...variants.map((v) => `| ${v.variant.toUpperCase()} | ${ICON[v.outcome]} ${v.state === 'not-started' ? '未啟動' : v.outcome} | ${v.reason.replace(/\n/g, ' ')} |`),
    )
  } else {
    lines.push((considered[0] as VariantTerminal).reason)
    if (outcome === 'ready-to-automerge') lines.push('', PHASE1_HUMAN_REVIEW_NOTE)
  }
  // 用量（成本）段落：docs/08 §2.3 承諾附於 Issue 終態留言（原由 apply-judge-labels 附上）。
  for (const v of considered.filter((x) => x.usageMarkdown !== undefined)) {
    lines.push('', '---', '', ...(nversion ? [`**變體 ${v.variant.toUpperCase()} 用量**`, ''] : []), v.usageMarkdown as string)
  }
  // 技能缺口段落維持 `### 🧩 技能缺口回報` 格式（docs/25 聚類解析依賴此標題）。
  for (const v of gaps) {
    lines.push('', '---', '', ...(nversion ? [`（變體 ${v.variant.toUpperCase()}）`, ''] : []), renderSkillGapMarkdown(v.skillGap as SkillGap))
  }
  return { write: true, outcome, labels, comment: lines.join('\n') }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path) ?? '') as unknown
  } catch {
    return undefined
  }
}

/** 由 artifact 目錄（compare job 下載的 `artifacts/<variant>`）讀取產物；缺檔或壞 JSON 皆視為缺席。 */
export function readVariant(variant: VariantId, dir: string): VariantTerminal {
  return deriveVariant(variant, {
    steps: readJson(join(dir, '.factory/steps.json')),
    judge: readJson(join(dir, '.factory/judge.json')),
    report: readJson(join(dir, 'target/.factory/run/report.json')),
    usageMarkdown: readText(join(dir, 'target/.factory/run/usage.md')),
  })
}

export function main(argv: string[]): TerminalResult {
  let runId: number | undefined
  let nversion = true
  const dirs: [VariantId, string][] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new CliError(`${arg} requires a value`)
      return v
    }
    if (arg === '--run-id') {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 0) throw new CliError('--run-id must be a non-negative integer')
      runId = n
    } else if (arg === '--nversion') nversion = value() === 'true'
    else if (arg === '--variant-dir') {
      const m = value().match(/^(a|b)=(.+)$/)
      if (m === null) throw new CliError('--variant-dir must be <a|b>=<dir>')
      dirs.push([m[1] as VariantId, m[2] as string])
    } else throw new CliError(`unknown argument: ${arg}`)
  }
  if (runId === undefined) throw new CliError('--run-id is required')
  if (dirs.length === 0) throw new CliError('at least one --variant-dir is required')
  return aggregateTerminal({ runId, nversion, variants: dirs.map(([v, d]) => readVariant(v, d)) })
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`)
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
