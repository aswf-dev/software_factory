/**
 * write-spec 開單欄位檢查（ADR-018 §4、§5）——零 LLM 成本、零網路請求。
 *
 * `agent-write-spec` 開單時必填兩個欄位：
 * - **規格名稱**：決定 `specs/<name>/` 目錄，也因此固定了 `invariants.qnt` 的路徑。
 * - **規格來源**：不變量必須逐字引用的意圖出處。三種形式：
 *   `issue`（由 CI 快照 PRD 欄位）、repo 內相對路徑、固定版本的 https URL。
 *
 * 另外檢查使用門檻：Issue 宣告的目標路徑命中 risk-paths 的 H 規則，或目標 repo
 * 的 catalog 有 `factory.io/quint-spec` 標註。write-spec 只用於高風險模組。
 *
 * 結果分兩類：
 * - `errors`：確定不合規 → issue-check 判「格式不合規」，不派工。
 * - `deferred`：此處缺少判斷所需的資料（例如機制 repo 的 issues 事件沒有 checkout
 *   目標 repo）→ 只提示，由 factory-run 派工時以完整資料重新判定。
 */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

/**
 * 規格名稱：kebab-case 小寫英數，會成為目錄名，故限長。
 * 以字串匯出，讓 Backstage 表單的 JSON Schema `pattern`／`maxLength` 能逐字比對
 *（對抗性測試 factory-assets 釘住兩邊一致）。
 */
export const SPEC_NAME_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$'
export const SPEC_NAME_MAX = 64
const SPEC_NAME_RE = new RegExp(SPEC_NAME_PATTERN)

/** URL 路徑中代表「固定版本」的段落：40 位 commit SHA，或版號（v1.2.3／1.2）。 */
const PINNED_SEGMENT_RES: readonly RegExp[] = [/^[0-9a-f]{40}$/, /^v?\d+\.\d+(?:\.\d+)?$/]

export type SpecSourceKind = 'issue' | 'path' | 'url'

export interface SpecSourceClassification {
  kind: SpecSourceKind
  /** 有值即代表格式不合規。 */
  error?: string
}

export interface SpecIntakeContext {
  /** PRD 宣告路徑命中的 H 規則數；undefined = 未提供 risk-paths，無法判斷。 */
  riskHits: number | undefined
  /** 目標 repo catalog 是否有 quint-spec 標註；undefined = 未提供 catalog，無法判斷。 */
  quintSpecAnnotated: boolean | undefined
  /** 相對於目標 repo 根目錄的檔案是否存在；undefined = 未 checkout 目標 repo，無法判斷。 */
  fileExists: ((relPath: string) => boolean) | undefined
}

export interface SpecIntakeReview {
  specName?: string | undefined
  specSource?: string | undefined
  sourceKind?: SpecSourceKind | undefined
  /** 確定不合規的原因；非空即不派工。 */
  errors: string[]
  /** 此處無法判斷、延後到 dispatch 時由 factory-run 判定的項目（提示用）。 */
  deferred: string[]
}

export function isValidSpecName(name: string): boolean {
  return name.length <= SPEC_NAME_MAX && SPEC_NAME_RE.test(name)
}

export function classifySpecSource(raw: string): SpecSourceClassification {
  const value = raw.trim()
  if (value.toLowerCase() === 'issue') return { kind: 'issue' }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!value.toLowerCase().startsWith('https://')) {
      return { kind: 'url', error: `規格來源 URL 只接受 https：\`${value}\`` }
    }
    let segments: string[]
    try {
      segments = new URL(value).pathname.split('/').filter((s) => s.length > 0)
    } catch {
      return { kind: 'url', error: `規格來源 URL 無法解析：\`${value}\`` }
    }
    const pinned = segments.some((s) => PINNED_SEGMENT_RES.some((re) => re.test(s)))
    if (!pinned) {
      return {
        kind: 'url',
        error:
          `規格來源 URL 必須是固定版本（路徑含 40 位 commit SHA 或版號），否則日後的逐字引用會對不上原文：\`${value}\`。` +
          '沒有版本的網頁（例如 `/latest/`）請先存檔進 repo，再填 repo 內路徑。',
      }
    }
    return { kind: 'url' }
  }

  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    return { kind: 'path', error: `規格來源必須是 repo 內的相對路徑：\`${value}\`` }
  }
  if (normalized.split('/').includes('..')) {
    return { kind: 'path', error: `規格來源不得以 \`..\` 指向 repo 外：\`${value}\`` }
  }
  return { kind: 'path' }
}

export function reviewSpecIntake(
  specName: string | undefined,
  specSource: string | undefined,
  ctx: SpecIntakeContext,
): SpecIntakeReview {
  const errors: string[] = []
  const deferred: string[] = []

  if (specName === undefined) {
    errors.push('缺「規格名稱」（決定 `specs/<name>/` 目錄）')
  } else if (!isValidSpecName(specName)) {
    errors.push(`「規格名稱」必須是 kebab-case 小寫英數、最長 ${SPEC_NAME_MAX} 字元：\`${specName}\``)
  }

  let sourceKind: SpecSourceKind | undefined
  if (specSource === undefined) {
    errors.push('缺「規格來源」（repo 內路徑、固定版本 https URL，或 `issue`）')
  } else {
    const c = classifySpecSource(specSource)
    sourceKind = c.kind
    if (c.error !== undefined) {
      errors.push(c.error)
    } else if (c.kind === 'path') {
      if (ctx.fileExists === undefined) {
        deferred.push(`規格來源 \`${specSource.trim()}\` 的存在性：dispatch 時於目標 repo trunk 檢查`)
      } else if (!ctx.fileExists(specSource.trim())) {
        errors.push(`規格來源 \`${specSource.trim()}\` 不存在於目標 repo 的 trunk 分支`)
      }
    }
  }

  const riskHit = ctx.riskHits !== undefined && ctx.riskHits > 0
  if (!riskHit && ctx.quintSpecAnnotated !== true) {
    if (ctx.riskHits !== undefined && ctx.quintSpecAnnotated !== undefined) {
      errors.push(
        '不符合 write-spec 使用門檻：只用於高風險模組——PRD 宣告的目標路徑須命中 `risk-paths.yml` 的 H 規則，' +
          '或目標 repo 的 `catalog-info.yaml` 須有 `factory.io/quint-spec` 標註',
      )
    } else {
      deferred.push('使用門檻（H 規則或 quint-spec 標註）：dispatch 時以目標 repo 的設定判定')
    }
  }

  return { specName, specSource, sourceKind, errors, deferred }
}

/**
 * 目標 repo 的 catalog 是否有非空的 `factory.io/quint-spec` 標註。
 * 讀不到或不是合法 YAML 一律回傳 false（fail-closed：無法確認就不算標註）。
 */
export function loadQuintSpecAnnotated(catalogPath: string): boolean {
  let raw: unknown
  try {
    raw = load(readFileSync(catalogPath, 'utf8'))
  } catch {
    return false
  }
  const annotations = (raw as { metadata?: { annotations?: Record<string, unknown> } } | null)
    ?.metadata?.annotations
  const value = annotations?.['factory.io/quint-spec']
  return typeof value === 'string' && value.trim().length > 0
}
