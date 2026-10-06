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

/** 變更動詞（中英）；行內出現才把 PBT 路徑視為「要求變更」。 */
const EDIT_CUE = /加回|新增|加入|加到|放進|寫入|寫進|修改|改寫|更新|補上|測試：|\b(?:add|adds|adding|modify|update|rewrite|edit|append)\b/i
/** 否定語境：行內出現即整行不判讀（「不碰」清單、「維持綠燈」）。 */
const NEGATION_CUE = /不碰|不得|不可|不要|不修改|不改|不動|禁止|勿|排除|維持|保持|\b(?:do not|don't|must not|never|without)\b/i
/** 斷詞：空白與中英標點都是邊界；路徑本身只含 [\w./*{}@-]。 */
const TOKEN_RE = /[\w@./*{}-]+/g

/**
 * 非 agent-pbt-audit 工單的 PRD 是否要求新增或修改 PBT 測試檔（ADR-019 §2）。
 *
 * 這類工單派工後必定被 crosscheck 判 `pbt-outside-audit`；開單檢查先擋，省下整個
 * run（回歸：philipz/fubon-tradingbot#654）。判讀刻意保守，只抓「具體路徑＋變更動詞」：
 * - 含 glob（`*`）的寫法是規則描述，不是要改的檔；
 * - 行內有否定語境（不碰、維持綠燈…）整行略過；
 * - code fence 內是程式碼，不是指示。
 * 漏抓仍有 crosscheck 兜底；誤抓的代價是人改寫 PRD 措辭。
 */
export function findPbtEditRequests(requirement: string): string[] {
  const found: string[] = []
  let inFence = false
  for (const line of requirement.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || NEGATION_CUE.test(line) || !EDIT_CUE.test(line)) continue
    for (const raw of line.match(TOKEN_RE) ?? []) {
      const token = raw.replace(/[.]+$/, '')
      if (token.includes('*') || !isPbtTestPath(token) || found.includes(token)) continue
      found.push(token)
    }
  }
  // 同一檔先以完整路徑、再以檔名出現（或相反）時只留完整路徑
  return found.filter((f) => !found.some((g) => g !== f && g.endsWith(`/${f}`)))
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
