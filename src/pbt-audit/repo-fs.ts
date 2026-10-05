/**
 * 目標 repo checkout 的唯讀檔案存取，供 intake 與 preflight 注入（測試以假物件取代）。
 *
 * 路徑一律相對於 repo 根；含 `..` 或絕對路徑的輸入直接視為不存在——intake 已先擋，
 * 這裡是第二道防線，避免讀到 checkout 外的檔案。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

/** 遞迴列檔時跳過的目錄：依賴與版控資料不是被稽核的程式碼，且可能極大。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '_build', 'vendor'])

/** 列檔上限：單一模組不該有這麼多檔案；超過時只看前段即可判定多數語言。 */
export const LIST_LIMIT = 5000

export interface RepoFs {
  pathKind: (relPath: string) => 'file' | 'dir' | undefined
  listFiles: (relDir: string) => string[]
  readFile: (relPath: string) => string | undefined
}

export function repoFs(root: string, limit: number = LIST_LIMIT): RepoFs {
  const resolve = (rel: string): string | undefined => {
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return undefined
    return join(root, rel)
  }
  const kind = (abs: string): 'file' | 'dir' | undefined => {
    try {
      const st = statSync(abs)
      return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : undefined
    } catch {
      return undefined
    }
  }
  return {
    pathKind: (rel) => {
      const abs = resolve(rel)
      return abs === undefined ? undefined : kind(abs)
    },
    listFiles: (relDir) => {
      const start = resolve(relDir)
      const out: string[] = []
      if (start === undefined) return out
      const walk = (dir: string): void => {
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (out.length >= limit) return
          const abs = join(dir, e.name)
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(abs)
          } else if (e.isFile()) {
            out.push(relative(root, abs).split('\\').join('/'))
          }
        }
      }
      walk(start)
      return out.sort()
    },
    readFile: (rel) => {
      const abs = resolve(rel)
      if (abs === undefined || kind(abs) !== 'file') return undefined
      return readFileSync(abs, 'utf8')
    },
  }
}
