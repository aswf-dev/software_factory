import { describe, expect, it } from 'vitest'
import {
  buildJudgeComment,
  computeJudgeLabels,
  PHASE1_HUMAN_REVIEW_NOTE,
} from './apply-judge-labels.js'

/**
 * Mutation-strength tests for the pure functions of `apply-judge-labels`
 * (`computeJudgeLabels`/`buildJudgeComment`, docs/14 觀察期試跑 #48)。
 *
 * 這些測試的用途與先前的 `*-mutation.test.ts` 相同：證明既有套件對這兩顆
 * 純函式有「牙齒」，而不只是行/分支覆蓋（`src/cli/**` 已是 100% branch）。
 * 每一段都是一次具體的原始碼變異，並描出該變異在既有套件下能存活、只有
 * 本檔的反例斷言會把它抓回紅燈的行為契約。
 *
 * 逐一以「手改 src/cli/apply-judge-labels.ts 套用該變異 → 重跑本檔變紅 →
 * 還原 → 變綠」驗證。三個變異在既有套件（apply-judge-labels.test.ts）下皆實測
 * GREEN（存活，/tmp 觀測記錄見下方表格），是本檔新增的價值：
 *
 *  | ID | Mutation                                                      | Before | After |
 *  |----|---------------------------------------------------------------|--------|-------|
 *  | M1 | 去除 needs-human 去重守衛（`&& !labels.includes(...)` 移除，一律 push）| GREEN  | RED   |
 *  | M2 | 純函式失效：`const labels = [...judge.labels]` 改為直接參考 `judge.labels`（push 污染輸入陣列） | GREEN  | RED   |
 *  | M3 | 留言標頭 `## 工廠執行結果：` 被改寫/抽換                                    | GREEN  | RED   |
 *  | M4 | 去除 skill-gap 去重守衛（E4 新增分支，一律 push）                            | GREEN  | RED   |
 *  | M5 | `hasSkillGap` 併入 `requiresHuman`（`|| hasSkillGap`）——自報訊號影響監督層級 | GREEN  | RED   |
 *
 * M1/M2 對應 Issue 標題的「純函式」價值：`computeJudgeLabels` 必須回傳新陣列
 * 且不得重複貼 `needs-human`——既有的 4 則純函式斷言全部使用 `toContain(..)`，
 * 既抓不到重複、也不驗證輸入未被就地修改，因此過去放寬去重守衛或改傳參考都
 * 不會讓套件變紅。M3 的標頭是 `buildJudgeComment` 的隱性契約（人類/工具靠
 * 開頭 `## 工廠執行結果：` 辨識一個 judge 結果留言），既有套件從未斷言標頭，
 * 改換標頭同樣存活。
 */

/** 建構 JudgeLike 物件（`as never` 對齊 apply-judge-labels.test.ts 的手法）。 */
const RESULT = (outcome: string, labels: string[], summary: string): unknown => ({
  outcome,
  labels,
  summary,
})

describe('M1 變異：去除 needs-human 去重守衛（一律 push）', () => {
  /**
   * 當 outcome 已是 `needs-human` 且 labels 已含 `needs-human` 時，函式必須
   * 保持陣列不重複。既定套件（M1 Before GREEN）只用 `toContain('needs-human')`，
   * 因而 `['needs-human','needs-human']` 這種重複仍會被寬容放行；只有意圖上
   * 的「不重複」斷言能釘住這條去重守衛。
   */
  it('needs-human 且 labels 已含 needs-human → 不產生重複', () => {
    const out = computeJudgeLabels(RESULT('needs-human', ['needs-human'], 'SR3 觸發') as never)
    expect(out.labels).toEqual(['needs-human'])
  })

  it('ready-for-review（中性結局）→ 原樣透傳，不推入 needs-human', () => {
    const out = computeJudgeLabels(
      RESULT('ready-for-review', ['oversight/on-loop'], 'ok') as never,
    )
    expect(out.labels).toEqual(['oversight/on-loop'])
  })
})

describe('M2 變異：純函式失效（labels 改傳參考，push 污染輸入陣列）', () => {
  /**
   * `computeJudgeLabels` 是 Issue「純函式」的核心契約：不能就地修改呼叫者的
   * `judge.labels`。若把 `[...judge.labels]` 改成直接參考 `judge.labels`，
   * needs-human 時的 `labels.push('needs-human')` 會回頭污染輸入陣列。既有
   * 套件（Before GREEN）從未重取輸入檢查，改傳參考完全存活；本段把它釘住。
   */
  it('不修改呼叫者的 judge.labels 陣列（純函式無副作用）', () => {
    const judge = { outcome: 'needs-human', labels: ['oversight/review'], summary: 'x' }
    computeJudgeLabels(judge as never)
    expect(judge.labels).toEqual(['oversight/review'])
    expect(Object.is(judge.labels, computeJudgeLabels(judge as never).labels)).toBe(false)
  })
})

describe('M3 變異：留言標頭 `## 工廠執行結果：` 被改寫', () => {
  /**
   * `buildJudgeComment` 的開頭標頭是人類/工具辨識「這是一則 factory-judge
   * 結果留言」的隱性契約。既有套件只 `toContain(summary/PHASE1_..._NOTE)`，
   * 從未斷言開頭標頭（Before GREEN），抽換或刪除標頭都能存活；本段以字首
   * 截斷的方式釘住標頭格式。
   */
  it('留言以 `## 工廠執行結果：<outcome>` 開頭', () => {
    expect(buildJudgeComment('needs-human', 'SR3 觸發')).toMatch(
      /^## 工廠執行結果：needs-human/,
    )
  })

  it('ready-to-automerge 的留言仍以標頭開頭，並附 Phase 1 人審註記', () => {
    const comment = buildJudgeComment('ready-to-automerge', 'ok')
    expect(comment).toMatch(/^## 工廠執行結果：ready-to-automerge/)
    expect(comment).toContain(PHASE1_HUMAN_REVIEW_NOTE)
  })
})

/**
 * M4 變異：去除 `skill-gap` 去重守衛（`&& !labels.includes('skill-gap')` 移除）。
 *
 * 與 M1 同性質，但施加在 E4 新增的分支上。judge.labels 已含 `skill-gap`
 * （例如二次判定 rescore 後重貼）時若一律 push，`gh issue edit --add-label`
 * 會收到 `skill-gap,skill-gap`。此變異在只用 toContain 的斷言下完全存活。
 */
describe('M4 變異：去除 skill-gap 去重守衛', () => {
  it('labels 已含 skill-gap 且 hasSkillGap → 不產生重複', () => {
    const out = computeJudgeLabels(RESULT('ready-for-review', ['skill-gap'], 'x') as never, true)
    expect(out.labels).toEqual(['skill-gap'])
  })

  it('hasSkillGap=false → 不推入 skill-gap（錨定，避免無條件貼標）', () => {
    const out = computeJudgeLabels(RESULT('ready-for-review', ['oversight/review'], 'x') as never, false)
    expect(out.labels).toEqual(['oversight/review'])
  })
})

/**
 * M5 變異：`hasSkillGap` 被接進 `requiresHuman` 的計算。
 *
 * 這是 E4 的監督層級契約（docs/25 §2.1「不擋終態」）：技能缺口是**分類訊號**，
 * 不是監督層級。若有人把它寫成
 *   `const requiresHuman = judge.outcome !== 'blocked-in-loop' || hasSkillGap`
 * 一個 blocked-in-loop（agent 從未執行）的工作項會因自報缺口而被要求人審，
 * 等於讓 agent 的自報影響流程。既有斷言多用 toContain 檢查標籤，抓不到
 * requiresHuman 的極性變化，本段將其釘死。
 */
describe('M5 變異：skillGap 洩漏進 requiresHuman', () => {
  it('blocked-in-loop + hasSkillGap → requiresHuman 仍為 false', () => {
    const out = computeJudgeLabels(RESULT('blocked-in-loop', ['oversight/in-loop'], 'x') as never, true)
    expect(out.requiresHuman).toBe(false)
  })

  it('requiresHuman 僅由 outcome 決定：同 outcome 下 hasSkillGap 不改變其值', () => {
    for (const outcome of ['blocked-in-loop', 'ready-to-automerge', 'ready-for-review', 'needs-human']) {
      const withGap = computeJudgeLabels(RESULT(outcome, [], 'x') as never, true)
      const without = computeJudgeLabels(RESULT(outcome, [], 'x') as never, false)
      expect(withGap.requiresHuman, `outcome=${outcome}`).toBe(without.requiresHuman)
    }
  })
})
