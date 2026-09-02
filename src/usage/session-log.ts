/**
 * 從 DSH home 找出「某次 run 的 session logs」（docs/04 §5 量測路徑）。
 *
 * DSH 把每個 session 的 durable log 存在
 *   <DSH_HOME>/sessions/<projectKey(cwd)>/<sessionId>/session.jsonl.zstd
 * （compression: zstd 時為 .jsonl.zstd，none 時為 .jsonl）。
 *
 * 一次 factory-run 的 agent 步驟可能啟動多個 dsh 行程（model chain 每個
 * provider 一次、或重試），因此「該 run」= 資料夾內在 --since-ms 之後建立的
 * 全部 session log。GH-hosted runner 每 job 全新 VM、DSH_HOME 由本 job 建立，
 * 故遞迴掃描 sessions-root 內所有 session.jsonl*（zstd 或純文字）即為本 run
 * 專屬；--since-ms 額外防呆（本機並行 run 時可只取某時間點之後）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeZstdLog } from './zstd.js'
import type { SessionLogInput } from './aggregate.js'

/** session log 檔名（zstd 與純文字皆接受）。 */
const SESSION_LOG_NAMES = ['session.jsonl.zstd', 'session.jsonl'] as const

function isSessionLogName(name: string): boolean {
  return (SESSION_LOG_NAMES as readonly string[]).includes(name)
}

/** 遞迴收集 sessionsRoot 下所有 session log 檔路徑。 */
export function collectSessionLogPaths(sessionsRoot: string): string[] {
  if (!existsSync(sessionsRoot)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full)
      } else if (isSessionLogName(entry)) {
        out.push(full)
      }
    }
  }
  walk(sessionsRoot)
  return out.sort()
}

/** 讀 session log 的第一行（session header，含 createdAt/cwd）。 */
function readHeaderLine(text: string): Record<string, unknown> | undefined {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (first === undefined) return undefined
  try {
    return JSON.parse(first) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export interface DiscoverSessionsOptions {
  sessionsRoot: string
  /** 只取 header.createdAt >= sinceMs 的 session（防呆；0 = 全部）。 */
  sinceMs?: number | undefined
}

export interface DiscoveredSessions {
  /** 找到且可解碼的 session logs。 */
  logs: SessionLogInput[]
  /** 找到但無法解碼/無法判定時間的 session 檔（診斷）。 */
  skipped: string[]
}

/** 掃描並解碼該 run 的 session logs。壞檔跳過（不 fail，量測是附註不是 gate）。 */
export function discoverSessions(opts: DiscoverSessionsOptions): DiscoveredSessions {
  const logs: SessionLogInput[] = []
  const skipped: string[] = []
  for (const path of collectSessionLogPaths(opts.sessionsRoot)) {
    try {
      const bytes = readFileSync(path)
      const text = path.endsWith('.zstd') ? decodeZstdLog(bytes) : bytes.toString('utf8')
      if (opts.sinceMs !== undefined && opts.sinceMs > 0) {
        const header = readHeaderLine(text)
        const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : undefined
        if (createdAt !== undefined && createdAt < opts.sinceMs) continue
        // header 無法讀取時不猜測：保守納入（同 run 內不影響，跨 run 有 since 防呆）
      }
      logs.push({ path, text })
    } catch {
      skipped.push(path)
    }
  }
  return { logs, skipped }
}
