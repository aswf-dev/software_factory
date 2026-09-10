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

  /**
   * 迴歸（DSH 0.1.5-rc.1 升級）：session log 檔名加入了 format generation。
   *
   * 0.1.2 寫 `session.jsonl(.zstd)`；0.1.5 的 session-persistence-jsonl 改以
   * `session.v${generation}.jsonl(.zstd)` 命名（實測產出 `session.v3.jsonl.zstd`，
   * 對應 release note 的「會話資料格式升級至 V3」）。
   *
   * 只認舊字面名會讓 factory-usage 在升級後**一個 session 都找不到**——量測
   * 靜默回報 unavailable、成本追蹤全歸零，且因為 usage 是「附註不是 gate」
   * 不會讓任何 run 變紅，屬於無聲失效。故以 generation 為浮動段比對。
   */
  it('辨識帶 format generation 的檔名 session.v3.jsonl(.zstd)（DSH 0.1.5 升級迴歸）', () => {
    const d = join(tmp, 'gen')
    mkdirSync(join(d, 's1'), { recursive: true })
    writeFileSync(join(d, 's1', 'session.v3.jsonl.zstd'), 'x')
    mkdirSync(join(d, 's2'), { recursive: true })
    writeFileSync(join(d, 's2', 'session.v3.jsonl'), 'x')
    // 未來的 generation 也不該再壞一次
    mkdirSync(join(d, 's3'), { recursive: true })
    writeFileSync(join(d, 's3', 'session.v10.jsonl.zstd'), 'x')
    expect(collectSessionLogPaths(d)).toEqual([
      join(d, 's1', 'session.v3.jsonl.zstd'),
      join(d, 's2', 'session.v3.jsonl'),
      join(d, 's3', 'session.v10.jsonl.zstd'),
    ])
  })

  it('不誤收近似檔名（session.lock / session.header / 非 session 前綴）', () => {
    const d = join(tmp, 'near')
    mkdirSync(d, { recursive: true })
    for (const n of ['session.lock', 'session.header', 'session.v3.json', 'notsession.jsonl']) {
      writeFileSync(join(d, n), 'x')
    }
    expect(collectSessionLogPaths(d)).toEqual([])
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
