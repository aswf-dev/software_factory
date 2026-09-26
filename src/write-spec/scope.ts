/**
 * write-spec 的變更範圍、source.md 快照與關閉關鍵字檢查（ADR-018 §9 護欄①、§12）。
 *
 * 由 factory-crosscheck 呼叫（它負責從 git 與 GitHub 取得事實），這裡只做判斷：
 * - **階段白名單**：不變量階段不得碰模型、模型階段不得改已核准的不變量。這是
 *   「寫不變量和寫模型的是兩個不同 run」這條獨立性的機械保證——agent 不能在
 *   同一個 run 裡同時調整兩邊，讓結果剛好一致。
 * - **source.md 快照**：不變量必須逐字引用意圖出處，而那份出處由 CI 寫入；agent
 *   若改寫它，引用就失去意義。
 * - **關閉關鍵字**：一張 Issue 要跑兩個 run，不變量 PR 若寫 `Closes #N`，合併時
 *   Issue 就被關閉，模型階段永遠不會發生。
 */

export type SpecPhase = 'invariants' | 'model'

export interface SpecFinding {
  kind: string
  detail: string
}

export interface SpecPathSet {
  dir: string
  source: string
  invariants: string
  model: string
  instances: string
  verify: string
  traces: string
}

/** 固定目錄結構（ADR-018 §6）。 */
export function specPaths(name: string): SpecPathSet {
  const dir = `specs/${name}/`
  return {
    dir,
    source: `${dir}source.md`,
    invariants: `${dir}invariants.qnt`,
    model: `${dir}model.qnt`,
    instances: `${dir}instances.qnt`,
    verify: `${dir}verify.yml`,
    traces: `${dir}traces/`,
  }
}

/**
 * 階段白名單（allowlist：未明列者一律拒絕）。越界路徑依原因分組，讓留言直接
 * 說明「為什麼不能改」，而不只是列出檔名。
 */
export function checkSpecScope(phase: SpecPhase, name: string, changedPaths: readonly string[]): SpecFinding[] {
  const p = specPaths(name)
  const allowed = phase === 'invariants' ? [p.invariants, p.source] : [p.model, p.instances, p.verify]
  const ciOnly: string[] = []
  const frozen: string[] = []
  const other: string[] = []
  for (const path of changedPaths) {
    if (path.startsWith('docs/') || allowed.includes(path)) continue
    if (path.startsWith(p.traces)) ciOnly.push(path)
    else if (phase === 'model' && (path === p.invariants || path === p.source)) frozen.push(path)
    else other.push(path)
  }
  if (ciOnly.length + frozen.length + other.length === 0) return []

  const reasons: string[] = []
  if (other.length > 0) {
    const allowList = [...allowed, 'docs/**'].map((a) => `\`${a}\``).join('、')
    reasons.push(`${phase} 階段只允許 ${allowList}，越界：${other.join('、')}`)
  }
  if (frozen.length > 0) {
    reasons.push(`不變量與其出處已核准，模型階段不得修改：${frozen.join('、')}`)
  }
  if (ciOnly.length > 0) {
    reasons.push(`\`${p.traces}\` 只能由 CI 寫入（反例由 CI 計算，agent 不得自行提供）：${ciOnly.join('、')}`)
  }
  return [{ kind: 'write-spec-scope', detail: reasons.join('；') }]
}

/**
 * 不變量階段：source.md 必須存在，且與 CI 快照逐字元一致。
 * `branchContents` 是各 factory 分支上 source.md 的內容（分支上沒有該檔就不列入）。
 * 模型階段不檢查：source.md 已隨不變量核准，任何改動都會先被白名單攔下。
 */
export function checkSourceSnapshot(
  phase: SpecPhase,
  branchContents: readonly string[],
  snapshot: string | undefined,
): SpecFinding[] {
  if (phase !== 'invariants') return []
  if (branchContents.length === 0) {
    return [
      {
        kind: 'write-spec-source-missing',
        detail: '不變量階段的分支上沒有 source.md——不變量的 `// source:` 引用沒有可對照的出處',
      },
    ]
  }
  if (branchContents.some((c) => c !== snapshot)) {
    return [
      {
        kind: 'write-spec-source-tampered',
        detail: 'source.md 與 CI 寫入的快照不一致——意圖原文只能由 CI 擷取，agent 不得改寫',
      },
    ]
  }
  return []
}

/** GitHub 的九個關閉關鍵字，後接可選冒號與 `#N` 或 `owner/repo#N`。 */
const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi

/** 文字中以關閉關鍵字引用的 Issue 編號（依出現順序）。 */
export function findClosingReferences(text: string): number[] {
  return [...text.matchAll(CLOSING_RE)].map((m) => Number(m[1]))
}

/**
 * 不變量 PR 不得關閉本 Issue（fail-loud：狀態機會被提前終結）；
 * 模型 PR 沒有關閉本 Issue 只給 advisory（後果是 Issue 多開一段時間，可人工補關）。
 */
export function checkClosingKeywords(
  phase: SpecPhase,
  issueNumber: number,
  prBodies: readonly string[],
): { mismatches: SpecFinding[]; advisories: SpecFinding[] } {
  const closes = prBodies.some((b) => findClosingReferences(b).includes(issueNumber))
  if (phase === 'invariants') {
    return {
      mismatches: closes
        ? [
            {
              kind: 'write-spec-closes-in-invariants',
              detail:
                `不變量階段的 PR 以關閉關鍵字引用了 #${issueNumber}——合併時 Issue 會被關閉，模型階段永遠不會發生。` +
                `請改為 \`Refs #${issueNumber}\``,
            },
          ]
        : [],
      advisories: [],
    }
  }
  return {
    mismatches: [],
    advisories: closes
      ? []
      : [
          {
            kind: 'write-spec-model-no-closes',
            detail: `模型階段的 PR 都沒有 \`Closes #${issueNumber}\`——合併後 Issue 不會自動關閉，會一直出現在待辦搜尋中`,
          },
        ],
  }
}
