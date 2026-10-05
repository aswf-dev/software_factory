/**
 * agent-pbt-audit 的語言表（ADR-019 R1、R6）。
 *
 * 支援範圍＝Hegel 官方有函式庫的 6 種語言（hegel.dev）。語言由**稽核目標的副檔名**
 * 判定，不讀 `factory.io/stack`（純宣告、無程式碼取用）也不讀 GitHub languages API
 * （統計的是整個 repo，多語言 repo 會選錯）。
 *
 * PBT 檔命名是 crosscheck 白名單的唯一依據。除 TS 外都是**工廠自訂的慣例**，
 * 不是上游規定；每種語言的第一張工單就是該語言的試點。
 */
import { minimatch } from 'minimatch'

export type PbtLanguage = 'typescript' | 'java' | 'go' | 'rust' | 'cpp' | 'ocaml'

export interface PbtLanguageSpec {
  id: PbtLanguage
  label: string
  /** 判定語言用的副檔名（含點、小寫）。 */
  extensions: readonly string[]
  /** 允許 audit 新增或修改的 PBT 檔 glob（minimatch，dot: true）。 */
  pbtGlobs: readonly string[]
  /** 前置作業是否能以 manifest 機械檢查；false＝改由 agent 的 smoke property 驗證。 */
  mechanicalPreflight: boolean
}

export const PBT_LANGUAGES: readonly PbtLanguageSpec[] = [
  {
    id: 'typescript',
    label: 'TypeScript/JavaScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    pbtGlobs: ['**/*.pbt.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    mechanicalPreflight: true,
  },
  {
    id: 'java',
    label: 'Java',
    extensions: ['.java'],
    pbtGlobs: ['**/src/test/**/*PbtTest.java'],
    mechanicalPreflight: true,
  },
  {
    id: 'go',
    label: 'Go',
    extensions: ['.go'],
    pbtGlobs: ['**/*_pbt_test.go'],
    mechanicalPreflight: true,
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: ['.rs'],
    // 只允許 tests/ 下的整合測試：寫在 src 內的 #[cfg(test)] mod 等於修改產品檔
    pbtGlobs: ['**/tests/**/*pbt*.rs'],
    mechanicalPreflight: true,
  },
  {
    id: 'cpp',
    label: 'C++',
    extensions: ['.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh'],
    pbtGlobs: ['**/*_pbt_test.{cc,cpp,cxx}'],
    mechanicalPreflight: false,
  },
  {
    id: 'ocaml',
    label: 'OCaml',
    extensions: ['.ml', '.mli'],
    pbtGlobs: ['**/test/**/*_pbt.ml'],
    mechanicalPreflight: false,
  },
]

/**
 * 常見但 Hegel 沒有官方函式庫的語言。命中時給出明確的「交還人類」訊息，而不是
 * 籠統的「無法判定語言」——ADR-019 R1：不因為沒有 Hegel 就改用別套 PBT。
 */
export const UNSUPPORTED_LANGUAGES: Readonly<Record<string, string>> = {
  '.py': 'Python',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.scala': 'Scala',
  '.cs': 'C#',
  '.fs': 'F#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.c': 'C',
}

/** 副檔名（含點、小寫）；`.d.ts` 視為無副檔名——型別宣告不是可測的程式碼。 */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (base.endsWith('.d.ts')) return ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i).toLowerCase()
}

export function languageForExtension(ext: string): PbtLanguageSpec | undefined {
  return PBT_LANGUAGES.find((l) => l.extensions.includes(ext))
}

export function languageSpec(id: PbtLanguage): PbtLanguageSpec {
  return PBT_LANGUAGES.find((l) => l.id === id) as PbtLanguageSpec
}

/** 路徑是否符合任一語言的 PBT 檔命名（crosscheck 白名單與「非 audit 不得產出」共用）。 */
export function isPbtTestPath(path: string): boolean {
  return PBT_LANGUAGES.some((l) => l.pbtGlobs.some((g) => minimatch(path, g, { dot: true })))
}
