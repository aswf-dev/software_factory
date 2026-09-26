/**
 * write-spec 的階段判定（ADR-018 §3、§12）。
 *
 * 一張 Issue 跑兩個 run：先不變量、經人工核准後再跑 as-is 模型。階段**完全由
 * 狀態推導**——Issue 標籤、trunk 上的檔案、進行中的 PR——開單時不填、派工時也
 * 不能指定。提供「指定階段」的途徑，就等於留下跳過第一階段的後門。
 *
 * 判定在任何 LLM 成本發生前執行；拒絕時由 factory-run 留言說明並停止。
 */

/** 規格流程的狀態標籤（ADR-018 §3、Q29）。 */
export const SPEC_LABELS = {
  phaseInvariants: 'spec/phase-invariants',
  /** 由 CODEOWNERS 的人類在合併不變量 PR 之後貼上；工廠不發射。 */
  approved: 'spec/approved',
  phaseModel: 'spec/phase-model',
  /** 放棄模型階段；由人貼上。 */
  declined: 'spec/model-declined',
  /** 模型跑完之後不變量又重做（Q28）。 */
  outdated: 'spec/model-outdated',
} as const

export interface PhaseState {
  issueOpen: boolean
  labels: readonly string[]
  /** `spec/approved` 存在，且最後一次貼標者是 CODEOWNERS 裡的人類。 */
  approvedByHuman: boolean
  /** trunk 上已有 `specs/<name>/invariants.qnt`。 */
  invariantsOnTrunk: boolean
  /** 本工作項尚未合併、仍開著的 factory PR 數。 */
  openFactoryPrs: number
}

export interface PhaseDecision {
  decision: 'invariants' | 'model' | 'refuse'
  reason: string
  labelsToAdd: string[]
  labelsToRemove: string[]
}

const refuse = (reason: string): PhaseDecision => ({
  decision: 'refuse',
  reason,
  labelsToAdd: [],
  labelsToRemove: [],
})

export function decidePhase(s: PhaseState): PhaseDecision {
  const has = (label: string): boolean => s.labels.includes(label)
  if (!s.issueOpen) {
    return refuse('Issue 已關閉。若要重做不變量，請先重新打開 Issue 並移除 `spec/approved`')
  }
  if (has(SPEC_LABELS.declined)) {
    return refuse('已貼 `spec/model-declined`（放棄模型階段）')
  }
  if (s.openFactoryPrs > 0) {
    return refuse(`本工作項有 ${s.openFactoryPrs} 個 factory PR 仍在審查中，請先合併或關閉，避免重複產出`)
  }
  if (has(SPEC_LABELS.approved)) {
    if (!s.approvedByHuman) {
      return refuse(
        '`spec/approved` 不是由 CODEOWNERS 裡的人類貼上，視為未核准。請由 CODEOWNERS 移除後重新貼上',
      )
    }
    if (!s.invariantsOnTrunk) {
      return refuse('已貼 `spec/approved`，但 trunk 上還沒有 `invariants.qnt`——請先合併不變量 PR 再核准')
    }
    return {
      decision: 'model',
      reason: '不變量已核准且已在 trunk 上 → 模型階段',
      labelsToAdd: [SPEC_LABELS.phaseModel],
      labelsToRemove: [SPEC_LABELS.phaseInvariants, SPEC_LABELS.outdated].filter(has),
    }
  }
  // 未核准 → 不變量階段。若這張 Issue 曾跑過模型，代表不變量正在重做，
  // 舊的模型結果對應的是舊不變量（Q28：事件發生當下標記，不靠排程）。
  const redo = has(SPEC_LABELS.phaseModel)
  return {
    decision: 'invariants',
    reason: redo ? '不變量重做（先前的模型結果已過期）→ 不變量階段' : '尚未核准 → 不變量階段',
    labelsToAdd: redo ? [SPEC_LABELS.phaseInvariants, SPEC_LABELS.outdated] : [SPEC_LABELS.phaseInvariants],
    labelsToRemove: redo ? [SPEC_LABELS.phaseModel] : [],
  }
}

/**
 * CODEOWNERS 中的個人帳號（小寫）。略過註解、團隊（`@org/team`，無法在此解析
 * 成員，fail-closed）與 email。
 */
export function parseCodeowners(text: string): Set<string> {
  const owners = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0] as string
    for (const token of line.trim().split(/\s+/).slice(1)) {
      if (token.startsWith('@') && !token.includes('/')) owners.add(token.slice(1).toLowerCase())
    }
  }
  return owners
}

export interface LabelEvent {
  login: string
  type: string
}

/**
 * `spec/approved` 的**最後一次**貼標者是否為 CODEOWNERS 裡的人類。
 * 以最後一次為準：人貼過之後又被 bot 重貼，就不再算人工核准。
 */
export function isHumanCodeownerApproval(
  events: readonly LabelEvent[],
  codeowners: ReadonlySet<string>,
): boolean {
  const last = events.at(-1)
  if (last === undefined) return false
  if (last.type !== 'User' || last.login.endsWith('[bot]')) return false
  return codeowners.has(last.login.toLowerCase())
}

export type SnapshotInput =
  | { kind: 'issue'; repo: string; issueNumber: number; capturedAt: string; content: string }
  | { kind: 'path'; path: string; trunkSha: string; capturedAt: string; content: string }

/**
 * `specs/<name>/source.md` 的內容：標頭註明來源與擷取時間，本文為原文。
 * 由 CI 寫入；crosscheck 以同一份檔案逐字元比對 agent 提交的版本。
 */
export function buildSourceSnapshot(input: SnapshotInput): string {
  const origin =
    input.kind === 'issue'
      ? `${input.repo}#${input.issueNumber} 的「需求描述（PRD）」`
      : `${input.path} @ ${input.trunkSha}`
  const body = input.content.endsWith('\n') ? input.content : `${input.content}\n`
  return [
    '<!-- factory:source-snapshot（ADR-018）：由 CI 寫入，不得修改；不變量須逐字引用本檔 -->',
    `<!-- 來源：${origin} · 擷取：${input.capturedAt} -->`,
    '',
    body,
  ].join('\n')
}
