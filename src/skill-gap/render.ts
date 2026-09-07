/**
 * 技能缺口 → Issue 留言 markdown 渲染（docs/25 §2.1、docs/20 E4）。
 *
 * **本檔的輸出格式是契約，不是排版偏好。** docs/25 §2.2 的聚類器（Scoreboard
 * `/skill-gaps` 與 `scripts/weekly-metrics.sh`）以這幾行為解析錨點；標頭字樣、
 * 欄位順序、粗體與全形冒號一旦變動，既有留言與新留言就會落入不同解析分支，
 * 跨月份的計數會靜默斷裂——而 docs/25 §3 的「同 category ≥3 次」提案門檻
 * 正是建立在該計數之上。因此格式變更等同契約變更，須連同聚類端一起評估。
 *
 * 為何獨立成模組（而非寫在 apply-judge-labels 裡）：對稱於 src/usage/render.ts，
 * 讓格式契約能被獨立測試與快照釘住，且 apply-judge-labels 已受 100% 分支門檻，
 * 純渲染邏輯外置可讓兩者各自維持最小職責。
 */
import type { SkillGap } from '../cli/factory-judge.js'

/**
 * 渲染技能缺口段落。
 *
 * `context` 缺席時**整行省略**，不輸出空欄位——留白的「**情境**：」對聚類器
 * 與人類都是雜訊，且會讓「有回報但無內容」與「未回報」在視覺上混淆。
 */
export function renderSkillGapMarkdown(gap: SkillGap): string {
  const lines = [
    '### 🧩 技能缺口回報',
    `- **分類**：\`${gap.category}\``,
    `- **需要**：${gap.needed}`,
  ]
  if (gap.context !== undefined) {
    lines.push(`- **情境**：${gap.context}`)
  }
  return lines.join('\n')
}
