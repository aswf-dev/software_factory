/**
 * agent-pbt-audit 開單檢查（ADR-019 R3、R1）——零 LLM 成本、零網路請求。
 *
 * 範圍沿用需求描述裡既有的「目標模組 / 檔案：」（`extractDeclaredPaths`），不新增
 * 表單欄位：機械檢查強度相同，而新增欄位要同步 GitHub 表單、Backstage、兩個 repo
 * 的 buildIssueBody、FIELD_TITLES 與 aswf.dev。
 *
 * 規則：
 * - 恰好一個路徑：`hegel` skill 會要求盤點目標的全部公開 API，範圍過大時 PR 無法
 *   review、發現報告也會過長（ADR-019 §5）。
 * - 存在於目標 repo，且不是測試檔：稽核的對象是產品程式碼。
 * - 語言是 Hegel 支援的 6 種之一：檔案看副檔名；目錄看其下非測試原始檔裡最多的
 *   Hegel 語言副檔名，同票即無法判定。
 *
 * 與 write-spec 的 intake 相同，結果分 `errors`（不派工）與 `deferred`（此處沒有
 * 目標 repo 的 checkout，由 factory-run 派工時重判）。
 */
import { isTestPath } from '../assertion-count/count.js'
import {
  extensionOf,
  isPbtTestPath,
  languageForExtension,
  UNSUPPORTED_LANGUAGES,
  type PbtLanguage,
} from './languages.js'

export const PBT_AUDIT_TASK_TYPE = 'agent-pbt-audit'

/** factory-run 判定類型後自動貼上的標籤（ADR-019 R2）：只用於篩選與試行統計，不是觸發條件。 */
export const PBT_AUDIT_LABEL = 'pbt/audit'

export interface PbtAuditIntakeContext {
  /** 目標 repo 內相對路徑的類型；undefined＝未 checkout 目標 repo，無法判斷。 */
  pathKind: ((relPath: string) => 'file' | 'dir' | undefined) | undefined
  /** 目錄下全部檔案（相對於 repo 根，遞迴）；pathKind 有值時必須一併提供。 */
  listFiles: ((relDir: string) => string[]) | undefined
}

export interface PbtAuditIntakeReview {
  target?: string | undefined
  language?: PbtLanguage | undefined
  errors: string[]
  deferred: string[]
}

const HAND_BACK = '依 ADR-019 R1，Hegel 沒有官方函式庫的語言一律停止並交還人類，不改用別套 PBT'

/** 正規化宣告路徑：去掉開頭的 `./` 與結尾的 `/`、統一分隔符。 */
export function normalizeTarget(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function isTestLike(path: string): boolean {
  return isTestPath(path) || isPbtTestPath(path)
}

/** 依單一檔案判定語言；回傳 language 或錯誤訊息。 */
export function languageOfFile(path: string): { language?: PbtLanguage; error?: string } {
  const ext = extensionOf(path)
  const lang = languageForExtension(ext)
  if (lang !== undefined) return { language: lang.id }
  const unsupported = UNSUPPORTED_LANGUAGES[ext]
  if (unsupported !== undefined) {
    return { error: `稽核目標 \`${path}\` 是 ${unsupported}：${HAND_BACK}` }
  }
  return {
    error: `無法由副檔名判定 \`${path}\` 的語言（支援 TS/JS、Java、Go、Rust、C++、OCaml）：${HAND_BACK}`,
  }
}

/** 依目錄內非測試原始檔的多數副檔名判定語言（同票或沒有 Hegel 語言檔即無法判定）。 */
export function languageOfDir(dir: string, files: readonly string[]): { language?: PbtLanguage; error?: string } {
  const counts = new Map<PbtLanguage, number>()
  for (const f of files) {
    if (f.split('/').includes('node_modules') || isTestLike(f)) continue
    const lang = languageForExtension(extensionOf(f))
    if (lang !== undefined) counts.set(lang.id, (counts.get(lang.id) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (top === undefined) {
    return { error: `目錄 \`${dir}\` 下沒有 Hegel 支援語言的原始檔：${HAND_BACK}` }
  }
  if (ranked[1] !== undefined && ranked[1][1] === top[1]) {
    return {
      error:
        `目錄 \`${dir}\` 內 ${top[0]} 與 ${ranked[1][0]} 檔案數相同，無法判定語言——` +
        '請把「目標模組 / 檔案：」改成單一檔案或單一語言的子目錄',
    }
  }
  return { language: top[0] }
}

export function reviewPbtAuditIntake(declared: readonly string[], ctx: PbtAuditIntakeContext): PbtAuditIntakeReview {
  const errors: string[] = []
  const deferred: string[] = []

  if (declared.length === 0) {
    errors.push('需求描述缺「目標模組 / 檔案：」——agent-pbt-audit 必須宣告恰好一個稽核目標（模組目錄或檔案）')
    return { errors, deferred }
  }
  if (declared.length > 1) {
    errors.push(
      `agent-pbt-audit 一次只稽核一個模組或檔案，「目標模組 / 檔案：」宣告了 ${declared.length} 個：` +
        `${declared.map((p) => `\`${p}\``).join('、')}——請拆成多張工單`,
    )
    return { errors, deferred }
  }

  const target = normalizeTarget(declared[0] as string)
  if (target === '' || target.startsWith('/') || /^[a-z]:\//i.test(target) || target.split('/').includes('..')) {
    errors.push(`稽核目標必須是 repo 內的相對路徑：\`${declared[0] as string}\``)
    return { target, errors, deferred }
  }
  if (isTestLike(target) || isTestLike(`${target}/`)) {
    errors.push(`稽核目標 \`${target}\` 是測試檔或測試目錄——稽核的對象是產品程式碼`)
    return { target, errors, deferred }
  }

  if (ctx.pathKind === undefined || ctx.listFiles === undefined) {
    // 沒有目標 repo 的 checkout：檔案看副檔名可以先判；目錄要等 dispatch。
    const ext = extensionOf(target)
    if (ext !== '') {
      const r = languageOfFile(target)
      if (r.error !== undefined) errors.push(r.error)
      deferred.push(`稽核目標 \`${target}\` 的存在性：dispatch 時於目標 repo trunk 檢查`)
      return { target, language: r.language, errors, deferred }
    }
    deferred.push(`稽核目標 \`${target}\` 的存在性與語言：dispatch 時於目標 repo trunk 判定`)
    return { target, errors, deferred }
  }

  const kind = ctx.pathKind(target)
  if (kind === undefined) {
    errors.push(`稽核目標 \`${target}\` 不存在於目標 repo 的 trunk 分支`)
    return { target, errors, deferred }
  }
  const r = kind === 'file' ? languageOfFile(target) : languageOfDir(target, ctx.listFiles(target))
  if (r.error !== undefined) errors.push(r.error)
  return { target, language: r.language, errors, deferred }
}
