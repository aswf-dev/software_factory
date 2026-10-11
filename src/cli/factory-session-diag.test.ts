/**
 * factory-session-diag 單元測試（src/cli/** 100% branch 閘門）。
 *
 * 兩個假說各有一組合成 session log：H1（結果沒送達、模型先往下走）與 H2（結果正常、
 * 幻影路徑最早出現在模型自己寫的參數裡）。另釘住「輸出不含任何內容」這個安全前提。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeSession, countPhantomPaths, main, parseArgs } from './factory-session-diag.js'

let seq = 0
const ev = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, seq: ++seq, time: seq * 1000, data, ...extra })
const step = (turn: number, s: number) => ev('step/start', { turn, step: s })
const stepEnd = (turn: number, s: number) => ev('step/end', { turn, step: s })
const call = (turn: number, s: number, callId: string, args = '{"command":"ls"}', name = 'bash') =>
  ev('tool/call', { turn, step: s, callId, name, arguments: args })
const result = (callId: string, text = 'ok', isError = false) =>
  ev('tool/result', {
    message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: text, isError }] },
  })
const assistant = (turn: number, s: number, content: unknown[]) =>
  ev('assistant/message', { turn, step: s, message: { role: 'assistant', content } })

const SECRET = 'PRIVATE_SOURCE_CODE_MUST_NOT_LEAK'

describe('countPhantomPaths', () => {
  it('只算 /home/<非 runner>/ 路徑', () => {
    expect(countPhantomPaths('/home/runner/work/x /home/alex/projects/frontend /home/david55/a/')).toBe(2)
    expect(countPhantomPaths('/home/runner/work /tmp/x')).toBe(0)
  })
})

describe('analyzeSession', () => {
  it('健康的 session：每個 call 都在下一步前拿到結果、無幻影', () => {
    seq = 0
    const text = [
      ev('session'),
      ev('request/context', { provider: 'qwen', model: 'qwen3.8-flash' }),
      ev('request/header', { reason: 'initial' }),
      step(0, 0),
      assistant(0, 0, [{ type: 'thinking', text: 'plan' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]),
      call(0, 0, 'c1'),
      result('c1', '/home/runner/work/target'),
      stepEnd(0, 0),
      step(0, 1),
      assistant(0, 1, [{ type: 'text', text: 'done' }]),
      stepEnd(0, 1),
    ].join('\n')
    const d = analyzeSession('s.jsonl', text)
    expect(d).toMatchObject({
      models: ['qwen/qwen3.8-flash'],
      headerReasons: ['initial'],
      steps: 2,
      toolCalls: 1,
      toolResults: 1,
      callsWithoutResult: 0,
      resultAfterNextStep: 0,
      orphanResults: 0,
      phantomInArgs: 0,
      phantomInResults: 0,
      malformedLines: 0,
    })
    expect(d.firstPhantomInArgsStep).toBeUndefined()
    expect(d.stepsDetail[0]).toMatchObject({ ordinal: 1, model: 'qwen/qwen3.8-flash', toolNames: ['bash'], durationMs: 4000 })
    expect(d.stepsDetail[0]?.blockChars.thinking).toBe(4)
    expect(d.stepsDetail[0]?.blockChars['tool-call']).toBeGreaterThan(0)
  })

  it('H1：結果沒送達或晚於下一步 → callsWithoutResult／resultAfterNextStep', () => {
    seq = 0
    const text = [
      step(0, 0),
      call(0, 0, 'lost'),
      call(0, 0, 'late'),
      stepEnd(0, 0),
      step(0, 1), // 模型在 'late' 的結果到達前就開始下一步
      result('late'),
      stepEnd(0, 1),
    ].join('\n')
    const d = analyzeSession('h1.jsonl', text)
    expect(d.callsWithoutResult).toBe(1)
    expect(d.resultAfterNextStep).toBe(1)
    expect(d.parallelCallSteps).toBe(1)
  })

  it('H2：幻影路徑最早出現在模型自己寫的 tool 參數，結果裡才跟著出現', () => {
    seq = 0
    const text = [
      step(0, 0),
      call(0, 0, 'c1', '{"workdir":"/home/alex/projects/frontend"}'),
      result('c1', 'bash: cd: /home/alex/projects/frontend: No such file or directory', true),
      step(0, 1),
      call(0, 1, 'c2'),
      result('c2'),
    ].join('\n')
    const d = analyzeSession('h2.jsonl', text)
    expect(d.firstPhantomInArgsStep).toBe(1)
    expect(d.firstPhantomInResultsStep).toBe(1)
    expect(d.phantomInArgs).toBe(1)
    expect(d.errorResults).toBe(1)
  })

  it('輸出不含任何訊息內容、參數或結果文字（public artifact 的安全前提）', () => {
    seq = 0
    const text = [
      ev('request/header', { reason: `${SECRET} long free text that is definitely more than forty characters` }),
      ev('user/message', { content: [{ type: 'text', text: SECRET }] }),
      step(0, 0),
      assistant(0, 0, [{ type: 'text', text: SECRET }]),
      call(0, 0, 'c1', `{"command":"cat ${SECRET}"}`),
      result('c1', SECRET),
    ].join('\n')
    expect(JSON.stringify(analyzeSession('x.jsonl', text))).not.toContain(SECRET)
  })

  it('壞行、非物件、缺欄位、孤兒與重複都計數而不中斷', () => {
    seq = 0
    const text = [
      '{not json',
      '[1,2]',
      JSON.stringify({ seq0: 99, data: {} }), // 沒有 type、用 seq0
      '',
      JSON.stringify({ type: 'bare' }), // 沒有 data、沒有 seq
      ev('request/context', {}), // provider/model 缺 → ?/?
      ev('request/context', {}), // 同一模型不重複列入
      ev('request/header', {}),
      ev('step/end', { turn: 9, step: 9 }), // 不存在的步驟
      ev('assistant/message', { turn: 9, step: 9, message: { content: [] } }), // 不存在的步驟
      ev('tool/call', { turn: 9, step: 9, callId: 'x' }), // 不存在的步驟 → 略過
      step(0, 0),
      ev('step/end', { turn: 0, step: 0 }, { time: undefined }), // 沒有 time → 無 duration
      ev('assistant/message', { turn: 0, step: 0, message: { content: ['not-object', { text: 'no type' }, { type: 'image' }] } }),
      ev('assistant/message', { turn: 0, step: 0, message: 'not-object' }),
      ev('tool/call', { turn: 0, step: 0 }), // 沒有 callId → 略過
      ev('tool/call', { turn: 0, step: 0, callId: 'd' }), // 沒有 name
      ev('tool/call', { turn: 0, step: 0, callId: 'd', name: 'bash' }), // 重複 callId
      result('d'),
      result('d'), // 重複結果
      result('ghost'), // 孤兒
      ev('tool/result', { message: 'not-object' }), // 沒有 callId → 孤兒
      ev('tool/result', { message: { source: { callId: 'd' }, content: 'not-array' } }),
      ev('tool/result', {}),
      ev('step/start', {}), // turn/step 缺 → -1
    ].join('\n')
    const d = analyzeSession('messy.jsonl', text)
    expect(d.malformedLines).toBe(2)
    expect(d.eventCounts['(none)']).toBe(1)
    expect(d.models).toEqual(['?/?'])
    expect(d.headerReasons).toEqual([])
    expect(d.duplicateCallIds).toBe(1)
    expect(d.duplicateResults).toBe(2)
    expect(d.orphanResults).toBe(3)
    expect(d.stepsDetail[0]?.durationMs).toBeUndefined()
    expect(d.stepsDetail[0]?.toolNames).toEqual(['(none)', 'bash'])
    expect(d.stepsDetail[0]?.blockChars).toMatchObject({ '(none)': 7, image: 16 })
    expect(d.stepsDetail[1]).toMatchObject({ turn: -1, step: -1 })
  })
})

describe('parseArgs', () => {
  it('解析 --sessions-root 與 --out', () => {
    expect(parseArgs(['--sessions-root', 's', '--out', 'o.json'])).toEqual({ sessionsRoot: 's', outPath: 'o.json' })
    expect(parseArgs(['--sessions-root', 's'])).toEqual({ sessionsRoot: 's' })
  })
  it('缺必填、缺值、未知參數 → CliError', () => {
    expect(() => parseArgs([])).toThrow(/缺少必填參數 --sessions-root/)
    expect(() => parseArgs(['--sessions-root'])).toThrow(/--sessions-root requires a value/)
    expect(() => parseArgs(['--sessions-root', '--out'])).toThrow(/requires a value/)
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/unknown argument: --bogus/)
  })
})

describe('main', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'session-diag-'))
    const dir = join(root, '--proj--', 'session-1')
    mkdirSync(dir, { recursive: true })
    seq = 0
    writeFileSync(join(dir, 'session.jsonl'), [step(0, 0), call(0, 0, 'c1'), result('c1')].join('\n'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('掃描 sessions-root、寫出 --out', () => {
    const out = join(root, 'diag.json')
    const r = main(['--sessions-root', root, '--out', out])
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]?.toolCalls).toBe(1)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(r)
  })
  it('未指定 --out 只回傳；不存在的 root → 空結果', () => {
    expect(main(['--sessions-root', join(root, 'nope')])).toEqual({ sessions: [], skipped: [] })
  })
})
