/**
 * 技能缺口留言格式契約測試（docs/25 §2.1）。
 *
 * 這裡刻意不只用 toContain：留言格式是 docs/25 §2.2 聚類器的解析錨點，
 * 「欄位存在」不等於「格式正確」。整份快照用來釘住標頭字樣、欄位順序、
 * 粗體與全形冒號——這正是 docs/15 §1.4（buildHandoverReport）學到的教訓：
 * 只驗子字串的斷言對格式退化完全沒有牙齒。
 */
import { describe, expect, it } from 'vitest'
import { renderSkillGapMarkdown } from './render.js'

describe('renderSkillGapMarkdown（格式即契約）', () => {
  it('三欄齊全時輸出 docs/25 §2.1 的完整格式', () => {
    const md = renderSkillGapMarkdown({
      category: 'monorepo-test-path',
      needed: 'pnpm workspace 下 vitest 設定分散於各 package 的路徑解析 SOP',
      context: 'issue #201 要為 packages/core 補測試，但既有 skill 未說明如何定位子套件的 vitest.config',
    })
    expect(md).toBe(
      [
        '### 🧩 技能缺口回報',
        '- **分類**：`monorepo-test-path`',
        '- **需要**：pnpm workspace 下 vitest 設定分散於各 package 的路徑解析 SOP',
        '- **情境**：issue #201 要為 packages/core 補測試，但既有 skill 未說明如何定位子套件的 vitest.config',
      ].join('\n'),
    )
  })

  it('context 缺席時整行省略，不輸出空欄位', () => {
    const md = renderSkillGapMarkdown({
      category: 'java-multimodule-mvn',
      needed: '多模組 Maven 專案的測試路徑定位',
    })
    expect(md).toBe(
      [
        '### 🧩 技能缺口回報',
        '- **分類**：`java-multimodule-mvn`',
        '- **需要**：多模組 Maven 專案的測試路徑定位',
      ].join('\n'),
    )
    expect(md).not.toContain('情境')
  })

  it('分類以反引號包裹（聚類器據此擷取 category）', () => {
    const md = renderSkillGapMarkdown({ category: 'gh-stack-conflict-detail', needed: 'x' })
    expect(md).toContain('- **分類**：`gh-stack-conflict-detail`')
  })

  it('標頭為固定字樣（聚類器的段落起點）', () => {
    const md = renderSkillGapMarkdown({ category: 'a-b', needed: 'x' })
    expect(md.split('\n')[0]).toBe('### 🧩 技能缺口回報')
  })
})
