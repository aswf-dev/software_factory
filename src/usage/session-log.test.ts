import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { collectSessionLogPaths, discoverSessions } from './session-log.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'session-log-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const headerOf = (createdAt: number): string => JSON.stringify({ type: 'session', version: 0, id: 's', createdAt, cwd: '/x' })

function writeZstd(dir: string, name: string, parts: string[]): void {
  const buf = Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p, 'utf8'))))
  writeFileSync(join(dir, name), buf)
}

describe('collectSessionLogPaths', () => {
  it('遞迴收集 session.jsonl 與 session.jsonl.zstd；忽略其他檔', () => {
    const d = join(tmp, 'tree')
    mkdirSync(join(d, 'p1'), { recursive: true })
    writeFileSync(join(d, 'p1', 'session.jsonl.zstd'), 'x')
    writeFileSync(join(d, 'p1', 'other.txt'), 'x')
    const nested = join(d, 'p2', 's1')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'session.jsonl'), 'x')
    const paths = collectSessionLogPaths(d)
    expect(paths).toEqual([join(d, 'p1', 'session.jsonl.zstd'), join(d, 'p2', 's1', 'session.jsonl')])
  })

  it('不存在或空的 root → 空陣列', () => {
    expect(collectSessionLogPaths(join(tmp, 'missing'))).toEqual([])
  })
})

describe('discoverSessions', () => {
  it('解碼 zstd 與純文字 log；回傳 text 與 path', () => {
    const d = join(tmp, 'ds1')
    mkdirSync(d, { recursive: true })
    writeZstd(d, 'session.jsonl.zstd', [`${headerOf(100)}\n`, '{"type":"assistant/chunk","data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1,"outputTokens":1}}}}\n'])
    writeFileSync(join(d, 'session.jsonl'), `${headerOf(200)}\nline2\n`)
    const found = discoverSessions({ sessionsRoot: d })
    expect(found.logs).toHaveLength(2)
    const texts = found.logs.map((l) => l.text).join('|')
    expect(texts).toContain('assistant/chunk')
    expect(texts).toContain('line2')
    expect(found.skipped).toEqual([])
  })

  it('sinceMs 過濾：createdAt < since 的 session 被排除', () => {
    const d = join(tmp, 'ds2')
    mkdirSync(d, { recursive: true })
    writeZstd(d, 'old.jsonl.zstd', [`${headerOf(100)}\n`])
    // session log 檔名必須是 session.jsonl*，才算是 session
    writeZstd(d, 'session.jsonl.zstd', [`${headerOf(500)}\n`])
    const found = discoverSessions({ sessionsRoot: d, sinceMs: 300 })
    expect(found.logs).toHaveLength(1)
    expect(found.logs[0]?.text).toContain('"createdAt":500')
  })

  it('sinceMs 過濾時 header 無法解析（非 JSON 首行）→ 保守納入不丟棄', () => {
    const d = join(tmp, 'ds-parse')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'session.jsonl'), 'not a header line\n{"a":1}\n')
    const found = discoverSessions({ sessionsRoot: d, sinceMs: 300 })
    expect(found.logs).toHaveLength(1)
    expect(found.skipped).toEqual([])
  })

  it('壞檔 → 進 skipped，不 fail', () => {
    const d = join(tmp, 'ds3')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'session.jsonl.zstd'), 'not zstd at all')
    const found = discoverSessions({ sessionsRoot: d })
    expect(found.logs).toEqual([])
    expect(found.skipped).toHaveLength(1)
  })

  it('root 不存在 → 空結果', () => {
    const found = discoverSessions({ sessionsRoot: join(tmp, 'nope'), sinceMs: 0 })
    expect(found.logs).toEqual([])
    expect(found.skipped).toEqual([])
  })
})
