import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeZstdLog, scanZstdFrames } from './zstd.js'

/** 把數段文字各自壓成獨立 frame 再串接（模擬 DSH 的逐批 flush 寫法）。 */
function framesOf(parts: string[]): Buffer {
  return Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p, 'utf8'))))
}

describe('scanZstdFrames', () => {
  it('單 frame：掃出唯一範圍且覆蓋整份 buffer', () => {
    const buf = zstdCompressSync(Buffer.from('hello\n', 'utf8'))
    const frames = scanZstdFrames(buf)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ start: 0, end: buf.length })
  })

  it('多 frame：逐 frame 掃出連續範圍', () => {
    const buf = framesOf(['line1\n', 'line2\n', 'line3\n'])
    const frames = scanZstdFrames(buf)
    expect(frames).toHaveLength(3)
    expect(frames[0]?.start).toBe(0)
    expect(frames[2]?.end).toBe(buf.length)
  })

  it('開頭非 magic → 拋錯（corrupt，不是靜默空結果）', () => {
    expect(() => scanZstdFrames(Buffer.from('not zstd data at all!!')))
      .toThrow(/frame magic/)
  })

  it('空 buffer → 空陣列', () => {
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual([])
  })

  it('torn tail（只留完整 frame 後綴數個 bytes）→ 只回完整 frame', () => {
    const buf = framesOf(['complete\n', 'partial-data-here'])
    // 把第二個 frame 截斷成半截
    const first = zstdCompressSync(Buffer.from('complete\n', 'utf8'))
    const secondFull = zstdCompressSync(Buffer.from('partial-data-here', 'utf8'))
    const torn = Buffer.concat([first, secondFull.subarray(0, secondFull.length - 10)])
    const frames = scanZstdFrames(torn)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.end).toBe(first.length)
  })

  it('torn tail 只差 checksum（<4 bytes）→ 只回完整 frame', () => {
    const first = zstdCompressSync(Buffer.from('ok\n', 'utf8'))
    const secondFull = zstdCompressSync(Buffer.from('tail\n', 'utf8'))
    // 只拿第二個 frame 的前 3 bytes（不足 checksum）
    const torn = Buffer.concat([first, secondFull.subarray(0, secondFull.length - 1)])
    const frames = scanZstdFrames(torn)
    expect(frames).toHaveLength(1)
  })

  it('frame 檔頭被截斷（不足 magic+header）→ 只回前面的完整 frame', () => {
    const first = zstdCompressSync(Buffer.from('ok\n', 'utf8'))
    const torn = Buffer.concat([first, zstdCompressSync(Buffer.from('x\n', 'utf8')).subarray(0, 5)])
    const frames = scanZstdFrames(torn)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.end).toBe(first.length)
  })
})

describe('decodeZstdLog', () => {
  it('多 frame 依序解碼並串接', () => {
    const buf = framesOf(['{"type":"session"}\n', '{"a":1}\n', '{"b":2}\n'])
    expect(decodeZstdLog(buf)).toBe('{"type":"session"}\n{"a":1}\n{"b":2}\n')
  })

  it('空內容（單 frame 壓縮空字串）→ 回空字串', () => {
    const buf = zstdCompressSync(Buffer.from('', 'utf8'))
    expect(decodeZstdLog(buf)).toBe('')
  })

  it('frame 內容損壞（magic 後接非 frame 資料 ≥4 bytes）→ 拋錯（fail-loud）', () => {
    const good = zstdCompressSync(Buffer.from('ok\n', 'utf8'))
    const corrupted = Buffer.concat([good, Buffer.from('this is not a frame')])
    // scan 對「有完整長度的下一個 frame 開頭但不是 zstd」應 fail-loud，而非靜默截斷
    expect(() => scanZstdFrames(corrupted)).toThrow(/frame magic/)
  })

  it('完全不是 zstd → 拋錯', () => {
    expect(() => decodeZstdLog(Buffer.from('garbage garbage garbage', 'utf8'))).toThrow()
  })
})
