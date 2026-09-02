/**
 * Zstandard multi-frame decoder（session log 讀取用）。
 *
 * DSH 的 session log（.jsonl.zstd）是「多個獨立 zstd frame 依序串接」的容器：
 * 每次 flush 把一批事件壓成一個 frame 附加到檔尾（見 dsh-session-persistence-jsonl
 * 的 scanZstdFrames / compressZstdFrame）。Node 的 `zstdDecompressSync` 一次只解
 * 一個 frame——直接對整份檔呼叫只會拿到第一個 frame 的內容。故必須先掃出每個
 * complete frame 的 [start,end) 範圍，再逐 frame 解碼拼接。
 *
 * 這裡只處理 factory-usage 需要的 subset：不做視窗解碼，只沿 frame header /
 * block header 的位元欄位走讀「每個 frame 佔多少 bytes」。演算法對齊 zstd 規格
 * 與 DSH 自身的 scanZstdFrames（兩者一致）；完整但結構不合法的 frame 拋錯，
 * 檔尾不完整的 frame（被 kill 的 run 可能留下 torn tail）視為可容忍、停在最後
 * 一個 complete frame——與 DSH 讀取 torn-tail 的修復策略方向一致（只回可驗證的
 * 部分）。
 */

/** zstd frame magic（小端 uint32 0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216

import { zstdDecompressSync } from 'node:zlib'

/** 掃出 buffer 中所有 complete frame 的 [start,end) 範圍。 */
export function scanZstdFrames(buffer: Buffer): { start: number; end: number }[] {
  const frames: { start: number; end: number }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break // 不足 magic，視為 torn tail
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // 保留位元檢查：bit4 未用、bit3 保留（與 DSH scanZstdFrames 相同）
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break // 檔頭不完整
    offset += remainingHeaderBytes
    let frameComplete = true
    for (;;) {
      if (buffer.length - offset < 3) {
        frameComplete = false
        break
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        frameComplete = false
        break
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (!frameComplete) break
    if (checksum) {
      if (buffer.length - offset < 4) break // checksum 不完整
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 解出 .jsonl.zstd 的完整純文字。
 * @param buffer 整個檔的 bytes。
 * @returns 所有 complete frame 的串接內容。
 */
export function decodeZstdLog(buffer: Buffer): string {
  const frames = scanZstdFrames(buffer)
  if (frames.length === 0) return ''
  const parts: string[] = []
  for (const { start, end } of frames) {
    try {
      const decoded = zstdDecompressSync(buffer.subarray(start, end))
      parts.push(decoded.toString('utf8'))
    } catch (err) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, {
        cause: err,
      })
    }
  }
  return parts.join('')
}
