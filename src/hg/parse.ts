/**
 * HG（人類閘門）簽核的機器可讀格式與化簡規則（docs/29 §8、§8.1；ADR-023 §4／ADR-024）。
 *
 * **問題**：HG0–HG7 目前只以導入追蹤 Issue 的勾選清單存在，程式無法讀。
 * 沒有結構化狀態，拓撲圖上的「鎖」就畫不出來（ADR-023），`factory-graph` 也無從輸出 `gates[]`。
 *
 * **解法**：簽核＝一則帶標記的 Issue 留言。標記對人可讀（下方仍可寫理由），對機器可解析：
 *
 *     <!-- factory:hg id=HG2 state=signed evidence=https://… -->
 *     HG2 已簽核：規模 M、billing 就緒度 R1。
 *
 * 幾條刻意的規則：
 *   - **機器人不得簽核**：`[bot]` 結尾的作者一律忽略（工廠自己不能簽自己的閘門，
 *     與「工廠從不發射 `stage/done`」同一防禦）。
 *   - **只有對 repo 有權限的人能簽**（2026-10-20）：GitHub 留言 API 的 `author_association`
 *     必須是 OWNER／MEMBER／COLLABORATOR。public repo 上任何人都能留言，若不檢查，
 *     陌生人一行標記就能簽核或撤回閘門。缺這個欄位視為無權限（不猜）。
 *   - **自訂閘門只接受 `gate_defs.signers`**：signers 是 GitHub 帳號；作者不在名單內的
 *     簽核／撤回不採計。HG 閘門沒有 signers，只套用上一條。
 *   - 被拒絕的簽核一律寫 warning，不靜默丟棄（「簽了但沒生效」必須看得出來）。
 *   - **最新一筆為準**：同一 (id, scope) 依留言時間排序，後者覆蓋前者；
 *     `state=revoked` 表示撤回，使該閘門回到 `missing`（可撤銷才可能誠實）。
 *   - **signed 必須附證據連結**：docs/29 §8 要求簽核記錄證據；沒有連結的簽核是空的。
 *   - **advisory 與 gate 分離**：本模組只回答「某閘門是否已簽」，不決定任何派工
 *     （ADR-024 §4）。判定要不要用這個結果，是呼叫端的事。
 */

/** `docs/29` §8 定義的人類閘門。 */
export const HG_IDS = ['HG0', 'HG1', 'HG2', 'HG3', 'HG4', 'HG5', 'HG6', 'HG7'] as const
export type HgGateId = (typeof HG_IDS)[number]
/** HG 或租戶自訂閘門（`<TENANT>-<NAME>`，ADR-025 §3）。 */
export type GateId = string

/** 租戶自訂閘門的命名規則（與 `src/process/spec.ts` 一致）。 */
export const CUSTOM_GATE_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/

/**
 * 記錄在「導入追蹤 Issue」上的閘門。
 *
 * HG0（每張工作項由人類送出）與 HG3（每顆 PR 的審查）發生在別的物件上
 * （Issue 本身、PR），不在導入追蹤 Issue 的留言裡；把它們列進來只會永遠顯示 missing。
 */
export const TRACKED_GATE_IDS: readonly GateId[] = ['HG1', 'HG2', 'HG4', 'HG5', 'HG6', 'HG7']

export type GateState = 'signed' | 'missing'

export interface HgComment {
  id: number
  body: string
  author: string
  createdAt: string
  /**
   * GitHub `author_association`（OWNER／MEMBER／COLLABORATOR／CONTRIBUTOR／NONE…）。
   * 缺席時視為無簽核權限。
   */
  association?: string
}

/** 可以簽核閘門的 `author_association`：對 repo 有寫入關係的人。 */
export const SIGNING_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR']

/** 自訂閘門 id → 允許簽核的 GitHub 帳號（來自模板 `gate_defs.signers`）。 */
export type GateSigners = ReadonlyMap<GateId, readonly string[]>

export function isAuthorizedSigner(comment: Pick<HgComment, 'association'>): boolean {
  return comment.association !== undefined && SIGNING_ASSOCIATIONS.includes(comment.association)
}

export interface HgEvent {
  id: GateId
  scope: string
  action: 'signed' | 'revoked'
  by: string
  at: string
  evidence: string
}

export interface GateStatus {
  id: GateId
  scope: string
  state: GateState
  signed_by?: string
  signed_at?: string
  evidence?: string
}

export interface GateReport {
  gates: GateStatus[]
  warnings: string[]
}

const MARKER = /<!--\s*factory:(hg|gate)\s+([^>]*?)\s*-->/g
const HTTP_URL = /^https?:\/\/\S+$/

/** 機器人帳號（GitHub App 與 GitHub Actions 的留言都以 `[bot]` 結尾）。 */
export function isBotAuthor(author: string): boolean {
  return author.endsWith('[bot]')
}

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>()
  for (const token of raw.split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    attrs.set(token.slice(0, eq), token.slice(eq + 1))
  }
  return attrs
}

function isHgGateId(value: string | undefined): value is HgGateId {
  return value !== undefined && (HG_IDS as readonly string[]).includes(value)
}

/**
 * 解析單一留言中的所有簽核事件。
 *
 * 一個留言可以帶多個標記（同一個人一次簽核多個閘門），因此回傳陣列。
 * 任何無法判讀的標記都會產生 warning 而不是靜默丟棄——靜默丟棄會讓「簽了但沒生效」
 * 看起來與「沒簽」一模一樣。
 */
export function parseCommentEvents(
  comment: HgComment,
  declaredGates?: readonly GateId[],
  signers?: GateSigners,
): { events: HgEvent[]; warnings: string[] } {
  const events: HgEvent[] = []
  const warnings: string[] = []
  if (isBotAuthor(comment.author)) return { events, warnings }
  const hasMarker = /<!--\s*factory:(?:hg|gate)\s/.test(comment.body)
  if (!hasMarker) return { events, warnings }
  if (!isAuthorizedSigner(comment)) {
    warnings.push(
      `comment ${comment.id}: ${comment.author} 對此 repo 沒有簽核權限（author_association=${comment.association ?? '未知'}），已忽略`,
    )
    return { events, warnings }
  }

  for (const match of comment.body.matchAll(MARKER)) {
    const kind = match[1] as 'hg' | 'gate'
    const attrs = parseAttrs(match[2] as string)
    const id = attrs.get('id')
    const state = attrs.get('state')
    const scope = attrs.get('scope') ?? 'system'
    const evidence = attrs.get('evidence') ?? ''

    if (kind === 'hg') {
      if (!isHgGateId(id)) {
        warnings.push(`comment ${comment.id}: 未知的閘門 id "${id ?? ''}"`)
        continue
      }
    } else {
      // 自訂閘門（ADR-025）：必須是 <TENANT>-<NAME>，且模板已宣告；否則不靜默接受。
      if (id === undefined || !CUSTOM_GATE_PATTERN.test(id) || isHgGateId(id)) {
        // 訊息刻意不用尖括號：避免被 SAST 當成 HTML 建構（raw-html-format false positive）。
        warnings.push(`comment ${comment.id}: 自訂閘門 id "${id ?? ''}" 不符 TENANT-NAME 格式`)
        continue
      }
      if (declaredGates === undefined) {
        warnings.push(`comment ${comment.id}: 未提供模板，無法確認自訂閘門 ${id}`)
        continue
      }
      if (!declaredGates.includes(id)) {
        warnings.push(`comment ${comment.id}: 模板未宣告自訂閘門 ${id}`)
        continue
      }
      const allowed = signers?.get(id)
      if (allowed !== undefined && !allowed.includes(comment.author)) {
        warnings.push(`comment ${comment.id}: ${comment.author} 不在 ${id} 的 signers（${allowed.join('、')}），已忽略`)
        continue
      }
    }
    if (state !== 'signed' && state !== 'revoked') {
      warnings.push(`comment ${comment.id}: ${id} 的 state 必須是 signed 或 revoked（收到 "${state ?? ''}"）`)
      continue
    }
    if (state === 'signed' && !HTTP_URL.test(evidence)) {
      warnings.push(`comment ${comment.id}: ${id} 已簽核但缺證據連結（evidence 必須是 http(s) URL）`)
      continue
    }
    events.push({
      id,
      scope,
      action: state,
      by: comment.author,
      at: comment.createdAt,
      evidence: state === 'signed' ? evidence : '',
    })
  }
  return { events, warnings }
}

/** 依時間排序後展開所有留言的事件（同時間以留言 id 決勝，避免非決定性）。 */
export function collectEvents(
  comments: readonly HgComment[],
  declaredGates?: readonly GateId[],
  signers?: GateSigners,
): { events: HgEvent[]; warnings: string[] } {
  const ordered = [...comments].sort((a, b) => {
    const byTime = a.createdAt.localeCompare(b.createdAt)
    return byTime !== 0 ? byTime : a.id - b.id
  })
  const events: HgEvent[] = []
  const warnings: string[] = []
  for (const comment of ordered) {
    const parsed = parseCommentEvents(comment, declaredGates, signers)
    events.push(...parsed.events)
    warnings.push(...parsed.warnings)
  }
  return { events, warnings }
}

/**
 * 把事件化簡成閘門狀態。
 *
 * - `expectedIds` 的每一個閘門都會出現在輸出中（預設 scope），沒事件者為 `missing`；
 * - 其他 scope（例如模組層級的 HG5）只要有事件就另外列出，讓「這個模組的 HG5 已簽」可見；
 * - `revoked` 之後回到 `missing`。
 */
export function reduceGates(
  events: readonly HgEvent[],
  expectedIds: readonly GateId[],
  defaultScope = 'system',
): GateStatus[] {
  const latest = new Map<string, HgEvent>()
  for (const event of events) {
    latest.set(`${event.id}\u0000${event.scope}`, event)
  }

  const gates: GateStatus[] = []
  for (const id of expectedIds) {
    const event = latest.get(`${id}\u0000${defaultScope}`)
    gates.push(event === undefined ? { id, scope: defaultScope, state: 'missing' } : toStatus(event))
  }
  for (const event of latest.values()) {
    if (event.scope === defaultScope) continue
    if (!expectedIds.includes(event.id)) continue
    gates.push(toStatus(event))
  }

  gates.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope))
  return gates
}

function toStatus(event: HgEvent): GateStatus {
  if (event.action === 'revoked') {
    return { id: event.id, scope: event.scope, state: 'missing' }
  }
  return {
    id: event.id,
    scope: event.scope,
    state: 'signed',
    signed_by: event.by,
    signed_at: event.at,
    evidence: event.evidence,
  }
}

/** 模板 `gate_defs` → 自訂閘門的 signers 對照表（HG 閘門不列：只檢查 repo 權限）。 */
export function signersOf(gateDefs: readonly { id: GateId; signers: readonly string[] }[] | undefined): GateSigners {
  return new Map((gateDefs ?? []).map((def) => [def.id, def.signers] as const))
}

/** 完整報告：事件 → 閘門狀態 ＋ warnings。 */
export function gateReport(
  comments: readonly HgComment[],
  expectedIds: readonly GateId[] = TRACKED_GATE_IDS,
  defaultScope = 'system',
  declaredGates?: readonly GateId[],
  signers?: GateSigners,
): GateReport {
  const { events, warnings } = collectEvents(comments, declaredGates, signers)
  return { gates: reduceGates(events, expectedIds, defaultScope), warnings }
}
