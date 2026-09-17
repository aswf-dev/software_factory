/**
 * 「該回報卻沒回報技能缺口」的 advisory 判定（docs/25 §2.1／§2.3）。
 *
 * **要解決的具體問題：`skillGap` 欄位缺席有兩種截然不同的含義，而資料上長得一樣。**
 *
 * | 含義 | 例子 |
 * |---|---|
 * | 確實沒有缺口（正常且預期） | run 35177914830：乾淨完成、開出 PR、32 tests 綠 |
 * | 遇到了卻沒想到要回報 | run 35098422118：crosscheck `requirements-missing` 失敗，仍無 `skillGap` |
 *
 * 2026-09-17 盤點 09-09 以來 13 次 run 後，這個歧義有了量化證據：**全部 5 筆
 * 缺口只來自 `deepseek-v4-pro`（3 筆）與 `qwen3.8-flash`（2 筆）**；而 claude
 * 家族在 4 次「該考慮回報」的情境中 0 次填寫（其中 opus 兩次連 `requirements`
 * 都改用自創欄位）。`docs/25` §7 記載的緩解證據「agent 會主動填寫 skillGap，故
 * T1 不依賴人工紀律」來自**單一一次 qwen run**——實際上 T1 不依賴人類紀律，
 * 但**高度依賴模型**。把可見性寄託在模型自覺上，訊號就會隨路由政策悄悄斷掉
 * （`deepseek-v4-pro` 已於 2026-09-11 因官方退役而從 tier 設定中移除）。
 *
 * 本模組把那個判斷從「模型自覺」移到「機制提醒」：**不擋 run、不改終態、
 * 不改變任何標籤**，只在 advisory 欄位留下一行，讓人類（與後續聚類）看得見。
 * 這是 REQ id 錨定第一階段的同款作法（`factory-crosscheck.ts` 的 `advisories`）
 * ——DoD 與缺口都由自由文字判定，直接 fail-loud 會製造假陽性而重蹈
 * `defect/*` 標籤失效的覆轍。
 *
 * **刻意不做的事**：不猜測缺口內容、不代 agent 生成 `category`。虛構的缺口比
 * 沒有缺口更糟——它會污染 `docs/25` §3 的「同 category ≥3 次」門檻。
 */

/** advisory 的 kind（下游以此字串聚類，等同契約）。 */
export const SKILL_GAP_UNREPORTED_KIND = 'skill-gap-unreported'

/** 與 `CrosscheckMismatch` 結構相容；刻意不 import 該型別以避免 cli ↔ 模組循環。 */
export interface SkillGapAdvisory {
  kind: string
  detail: string
}

/**
 * 觸發情境。三者都代表「這次 run 沒有順利完成」，但偵測點不同：
 *
 *  - `crosscheck-mismatch`：crosscheck 抓到報告與 git 事實不符 → 必然 needs-human。
 *    **judge 在此情境不會執行**（workflow 的 judge 步驟要求 crosscheck 成功），
 *    所以這一格只能由 crosscheck 自己補。
 *  - `no-output`：agent 沒有產生任何變更（通常是停手）。crosscheck 看得到，
 *    但它不知道終態，故以「零產出」為代理訊號。
 *  - `needs-human`：judge 判定的真實終態，涵蓋停手規則等 crosscheck 看不到的原因。
 */
export type UnreportedTrigger = 'crosscheck-mismatch' | 'no-output' | 'needs-human'

const TRIGGER_DETAIL: Record<UnreportedTrigger, string> = {
  'crosscheck-mismatch': 'crosscheck 判定報告與實際 git diff 不符（本次必為 needs-human）',
  'no-output': 'agent 未產生任何變更（零 changedPaths 且無實際 diff，通常代表停手）',
  'needs-human': 'judge 終態為 needs-human',
}

/**
 * 判定是否該提醒「未回報技能缺口」。
 *
 * @param trigger 觸發情境；`null` 代表本次 run 沒有異常，不發話。
 * @param hasSkillGap report 是否已回報缺口（`null` 與缺席皆視為未回報——
 *        目前兩者在 `ReportSchema` 中同義，故此處只收布林，由呼叫端正規化）。
 * @returns 0 或 1 條 advisory。回傳陣列而非可空值，是為了讓呼叫端能直接
 *          `push(...)` 進既有的 advisories 陣列，不必在每個呼叫點寫判空分支。
 */
export function adviseUnreportedSkillGap(
  trigger: UnreportedTrigger | null,
  hasSkillGap: boolean,
): SkillGapAdvisory[] {
  if (trigger === null) return []
  if (hasSkillGap) return []
  return [
    {
      kind: SKILL_GAP_UNREPORTED_KIND,
      detail:
        `${TRIGGER_DETAIL[trigger]}，但 report.json 未回報 skillGap。` +
        '請確認這是「確實沒有技能缺口」還是「遇到了但沒回報」' +
        '（docs/25 §2.1；此為 advisory，不影響終態與標籤）',
    },
  ]
}

/** advisories 陣列中是否含本模組的 kind（供 push-event 等下游判讀）。 */
export function hasUnreportedSkillGapAdvisory(advisories: unknown): boolean {
  if (!Array.isArray(advisories)) return false
  return advisories.some(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      (a as { kind?: unknown }).kind === SKILL_GAP_UNREPORTED_KIND,
  )
}
