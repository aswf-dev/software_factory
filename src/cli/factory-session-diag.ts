/**
 * factory-session-diag — DSH session log 的**無內容**結構診斷。
 *
 * 動機（fubon-tradingbot#717，run 38097217322）：qwen3.8-flash 變體在推理中描述一個不存在
 * 的環境（`/home/alex/projects/frontend`、Issue #702…），追了 70 分鐘的「sandbox 不穩定」
 * 後逾時、零交付。兩個假說只有 session log 分得開：
 *   H1：工具結果沒有送達模型（DSH/provider 路由問題），模型自行補上想像的輸出；
 *   H2：工具結果正常送達，模型自行編造。
 *
 * 但機制 repo 是 public、目標 repo 是 private：session log 含目標 repo 的原始碼與工具輸出，
 * **不得**原樣進 artifact。本 CLI 只輸出計數、長度、工具名與布林旗標——不含任何訊息內容、
 * 參數或結果文字，因此可以安全上傳。
 *
 * 判讀：
 *   - `callsWithoutResult`／`resultAfterNextStep` > 0 → 支持 H1（模型在拿到結果前就往下走）。
 *   - 幻影路徑最早出現在 **tool 參數**（模型自己寫進指令）而非 **tool 結果** → 支持 H2。
 */
import { writeFileSync } from 'node:fs'
import { discoverSessions } from '../usage/session-log.js'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

/**
 * 「不屬於本 runner 的家目錄路徑」：CI runner 的家目錄是 /home/runner，其他 /home/<user>/
 * 只可能來自模型編造（或真實環境異常——這正是要分辨的）。
 */
const PHANTOM_HOME = /\/home\/(?!runner\/)[A-Za-z0-9_.-]+\//g

export function countPhantomPaths(text: string): number {
  return text.match(PHANTOM_HOME)?.length ?? 0
}

export interface StepDiag {
  /** session 內的步驟序號（1 起算，依出現順序）。 */
  ordinal: number
  turn: number
  step: number
  model?: string | undefined
  durationMs?: number | undefined
  toolCalls: number
  toolNames: string[]
  callsWithoutResult: number
  resultAfterNextStep: number
  errorResults: number
  phantomInArgs: number
  phantomInResults: number
  /** assistant 訊息各類內容區塊的字元數（只有長度，不含內容）。 */
  blockChars: Record<string, number>
}

export interface SessionDiag {
  path: string
  eventCounts: Record<string, number>
  malformedLines: number
  models: string[]
  headerReasons: string[]
  steps: number
  toolCalls: number
  toolResults: number
  callsWithoutResult: number
  resultAfterNextStep: number
  orphanResults: number
  duplicateCallIds: number
  duplicateResults: number
  errorResults: number
  parallelCallSteps: number
  phantomInArgs: number
  phantomInResults: number
  /** 幻影路徑首次出現的步驟序號；undefined = 從未出現。 */
  firstPhantomInArgsStep?: number | undefined
  firstPhantomInResultsStep?: number | undefined
  stepsDetail: StepDiag[]
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

interface CallInfo {
  stepOrdinal: number
  resultSeq?: number | undefined
}

/** 分析一份 session log（JSONL 純文字）。壞行計數後略過，不中斷。 */
export function analyzeSession(path: string, text: string): SessionDiag {
  const eventCounts: Record<string, number> = {}
  const models: string[] = []
  const headerReasons: string[] = []
  const steps: (StepDiag & { startSeq: number; startTime?: number | undefined })[] = []
  const stepByKey = new Map<string, (typeof steps)[number]>()
  const calls = new Map<string, CallInfo>()
  let malformedLines = 0
  let currentModel: string | undefined
  let toolResults = 0
  let orphanResults = 0
  let duplicateCallIds = 0
  let duplicateResults = 0

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      malformedLines++
      continue
    }
    if (!isObject(ev)) {
      malformedLines++
      continue
    }
    const type = str(ev.type) ?? '(none)'
    eventCounts[type] = (eventCounts[type] ?? 0) + 1
    const data = isObject(ev.data) ? ev.data : {}
    const seq = num(ev.seq) ?? num(ev.seq0) ?? 0
    const key = `${num(data.turn) ?? -1}.${num(data.step) ?? -1}`

    if (type === 'request/context') {
      const id = `${str(data.provider) ?? '?'}/${str(data.model) ?? '?'}`
      currentModel = id
      if (!models.includes(id)) models.push(id)
    } else if (type === 'request/header') {
      const reason = str(data.reason)
      // 只收短的列舉值；長字串可能是自由文字，不進 artifact
      if (reason !== undefined && reason.length <= 40) headerReasons.push(reason)
    } else if (type === 'step/start') {
      const s = {
        ordinal: steps.length + 1,
        turn: num(data.turn) ?? -1,
        step: num(data.step) ?? -1,
        model: currentModel,
        toolCalls: 0,
        toolNames: [],
        callsWithoutResult: 0,
        resultAfterNextStep: 0,
        errorResults: 0,
        phantomInArgs: 0,
        phantomInResults: 0,
        blockChars: {},
        startSeq: seq,
        startTime: num(ev.time),
      }
      steps.push(s)
      stepByKey.set(key, s)
    } else if (type === 'step/end') {
      const s = stepByKey.get(key)
      const time = num(ev.time)
      if (s?.startTime !== undefined && time !== undefined) s.durationMs = time - s.startTime
    } else if (type === 'assistant/message') {
      const s = stepByKey.get(key)
      const content = isObject(data.message) ? data.message.content : undefined
      if (s !== undefined && Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block)) continue
          const blockType = str(block.type) ?? '(none)'
          const len = (str(block.text) ?? JSON.stringify(block)).length
          s.blockChars[blockType] = (s.blockChars[blockType] ?? 0) + len
        }
      }
    } else if (type === 'tool/call') {
      const s = stepByKey.get(key)
      const callId = str(data.callId)
      if (s === undefined || callId === undefined) continue
      if (calls.has(callId)) duplicateCallIds++
      calls.set(callId, { stepOrdinal: s.ordinal })
      s.toolCalls++
      const name = str(data.name) ?? '(none)'
      if (!s.toolNames.includes(name)) s.toolNames.push(name)
      s.phantomInArgs += countPhantomPaths(str(data.arguments) ?? '')
    } else if (type === 'tool/result') {
      toolResults++
      const message = isObject(data.message) ? data.message : {}
      const callId = isObject(message.source) ? str(message.source.callId) : undefined
      const call = callId === undefined ? undefined : calls.get(callId)
      if (call === undefined) {
        orphanResults++
        continue
      }
      if (call.resultSeq !== undefined) duplicateResults++
      call.resultSeq = seq
      const s = steps[call.stepOrdinal - 1] as (typeof steps)[number]
      const content = Array.isArray(message.content) ? message.content : []
      if (content.some((c) => isObject(c) && c.isError === true)) s.errorResults++
      s.phantomInResults += countPhantomPaths(JSON.stringify(content))
    }
  }

  // 每個 call 的結果是否在「下一步開始」之前到達（H1 的直接檢驗）
  for (const call of calls.values()) {
    const s = steps[call.stepOrdinal - 1] as (typeof steps)[number]
    const next = steps[call.stepOrdinal]
    if (call.resultSeq === undefined) s.callsWithoutResult++
    else if (next !== undefined && call.resultSeq > next.startSeq) s.resultAfterNextStep++
  }

  const stepsDetail: StepDiag[] = steps.map(({ startSeq: _seq, startTime: _time, ...rest }) => rest)
  const sum = (f: (s: StepDiag) => number) => stepsDetail.reduce((acc, s) => acc + f(s), 0)
  return {
    path,
    eventCounts,
    malformedLines,
    models,
    headerReasons,
    steps: stepsDetail.length,
    toolCalls: sum((s) => s.toolCalls),
    toolResults,
    callsWithoutResult: sum((s) => s.callsWithoutResult),
    resultAfterNextStep: sum((s) => s.resultAfterNextStep),
    orphanResults,
    duplicateCallIds,
    duplicateResults,
    errorResults: sum((s) => s.errorResults),
    parallelCallSteps: stepsDetail.filter((s) => s.toolCalls > 1).length,
    phantomInArgs: sum((s) => s.phantomInArgs),
    phantomInResults: sum((s) => s.phantomInResults),
    firstPhantomInArgsStep: stepsDetail.find((s) => s.phantomInArgs > 0)?.ordinal,
    firstPhantomInResultsStep: stepsDetail.find((s) => s.phantomInResults > 0)?.ordinal,
    stepsDetail,
  }
}

export interface SessionDiagOutput {
  sessions: SessionDiag[]
  skipped: string[]
}

export function parseArgs(argv: string[]): { sessionsRoot: string; outPath?: string } {
  let sessionsRoot: string | undefined
  let outPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = argv[i + 1]
    if (arg !== '--sessions-root' && arg !== '--out') throw new CliError(`unknown argument: ${arg}`)
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    i++
    if (arg === '--sessions-root') sessionsRoot = value
    else outPath = value
  }
  if (sessionsRoot === undefined) throw new CliError('缺少必填參數 --sessions-root')
  return { sessionsRoot, ...(outPath !== undefined ? { outPath } : {}) }
}

export function main(argv: string[]): SessionDiagOutput {
  const { sessionsRoot, outPath } = parseArgs(argv)
  const { logs, skipped } = discoverSessions({ sessionsRoot })
  const out = { sessions: logs.map((l) => analyzeSession(l.path, l.text)), skipped }
  if (outPath !== undefined) writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
  return out
}

/* v8 ignore start */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
