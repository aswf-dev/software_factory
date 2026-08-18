import { describe, expect, it } from 'vitest'
import { buildHandoverReport } from './stop-rules.js'
import type { StopRuleViolation } from './types.js'

/**
 * Mutation-strength tests for `buildHandoverReport`（docs/07 §4.2、docs/14 觀察期試跑 #49）。
 *
 * 這份交還報告（handover report）是 agent 停手時貼到 Issue 的下方格式，人類與
 * tools 靠它接手而非重做。它的「格式」本身是有價值的契約：開頭標頭、逐條
 * 圓點清單（`- `）、加粗 rule 識別碼（`**SRn-*`）、全形冒號分隔、一行一條、
 * 結尾「下一步」。行/分支覆蓋測不出這些格式結構——既有 `stop-rules.test.ts`
 * （45 則）對報告的所有斷言都只用到 `toContain(..)`，只驗證子字串存在，
 * 對「結構」完全沒有牙齒。
 *
 * 下列每個變異以「手改 src/stop-rules/stop-rules.ts 套用 → 重跑本檔變紅 →
 * 還原變綠」驗證（與 parse-args-mutation / write-report-mutation / #45 loadReport
 * / #48 apply-judge-labels 的 mutation test 同法）。四個變異在既有套件下皆實測
 * GREEN（存活——既有套件只 `toContain(rule) / toContain(reason)`，格式結構被
 * 改動後子字串仍在，全數放行），是本檔新增的價值：
 *
 *  | ID | Mutation（破壞報告的格式結構）                              | Before | After |
 *  |----|---------------------------------------------------------------|--------|-------|
 *  | M1 | 去除每條違規的圓點前綴 `- `（`- **r**：` → `**r**：`）       | GREEN  | RED   |
 *  | M2 | 去除 rule 識別碼的加粗 `**`（`**r**` → `r`）                  | GREEN  | RED   |
 *  | M3 | 全形冒號分隔 `：` 改 ASCII `:`（`**r**：` → `**r**: `）        | GREEN  | RED   |
 *  | M4 | 一行一條被破壞（`join('\n')` 改空白分隔，全部黏成一行）        | GREEN  | RED   |
 *
 * 「Before」= 既有套件（stop-rules.test.ts，45 則）；「After」= 加上本檔。這些
 * 格式結構被破壞後，人類審查者看到的分節、圓點清單、加粗強調與逐條可讀性
 * 都會退化——`toContain` 不會攔下，只有明確錨定格式的反例斷言能攔。
 */

/** 固定的兩條違規，用作可重現的輸入。 */
const RULES: readonly StopRuleViolation[] = [
  {
    rule: 'SR1-sync-failed',
    reason: '`gh stack sync` 連續 2 次失敗，疑似語意衝突',
  },
  {
    rule: 'SR6-weakened-tests',
    reason: '測試斷言淨減少 3 條',
  },
]

/** 目前實作輸出的精確格式：開頭、圓點加粗清單、全形冒號、一行一條、結尾。 */
function expected(): string {
  return [
    '## 工廠執行中止',
    '',
    '**觸發規則**：2 條',
    '',
    '- **SR1-sync-failed**：`gh stack sync` 連續 2 次失敗，疑似語意衝突',
    '- **SR6-weakened-tests**：測試斷言淨減少 3 條',
    '',
    '**下一步**：需人類接手處理。agent 不會自行重試或放寬規則。',
  ].join('\n')
}

describe('M1 變異：去除每條違規的圓點前綴 `- `', () => {
  /**
   * 報告以 Markdown 圓點清單逐條列出違規（`- **rule**：reason`）。若把
   * 圓點前綴去掉（list 化 → 純文字段落），`toContain('SR1-sync-failed')`
   * 仍會通過（rule 子字串還在），破壞了其為「可逐條瀏覽的清單」這條格式契約。
   * 本段錨定：每條違規的輸出行必須以 `- **rule**：` 開頭。
   */
  it('每條違規都以 `- ` 圓點清單前綴呈現', () => {
    const out = buildHandoverReport(RULES)
    for (const v of RULES) {
      expect(out).toContain(`- **${v.rule}**：`)
    }
  })

  it('單條違規也輸出為圓點清單（錨定，避免只在多條時成立）', () => {
    const out = buildHandoverReport([RULES[0]!])
    expect(out).toContain('- **SR1-sync-failed**：')
  })
})

describe('M2 變異：去除 rule 識別碼的加粗 `**`', () => {
  /**
   * rule 識別碼（`SR1-sync-failed` 等）在報告中用 `**...**` 加粗強調，讓人類
   * 一眼定位是哪條規則觸發。若去掉加粗標記，`toContain('SR1-sync-failed')`
   * 仍通過（識別碼字串還在）；格式契約「識別碼以粗體呈現」不受 `toContain`
   * 保護。本段錨定：輸出必須含加粗的 `**rule**` 字面。
   */
  it('rule 識別碼以 `**...**` 加粗出現在報告', () => {
    const out = buildHandoverReport(RULES)
    for (const v of RULES) {
      expect(out).toContain(`**${v.rule}**`)
    }
  })

  it('加粗標記必須緊貼識別碼（`**SR1-sync-failed**` 連續字面）', () => {
    const out = buildHandoverReport(RULES)
    expect(out).toContain('**SR1-sync-failed**')
  })
})

describe('M3 變異：全形冒號分隔 `：` 改 ASCII `:`', () => {
  /**
   * rule 與 reason 之間用全形冒號 `：`（`- **rule**：reason`）。若換成半形
   * `:`，`toContain('SR1-sync-failed')` 與 `toContain(reason)` 兩者仍通過（兩段
   * 子字串都在），只有「此處必須是全形冒號」的格式契約被破壞。既有套件
   * （Before GREEN）從未斷言輸出行的字面 shape。
   */
  it('每條違規的 rule 與 reason 之間是全形冒號（`**rule**：`）', () => {
    const out = buildHandoverReport(RULES)
    for (const v of RULES) {
      expect(out).toContain(`- **${v.rule}**：`)
    }
  })

  it('anchor：不含 ASCII 半形冒號直接接在 rule 識別碼後', () => {
    const out = buildHandoverReport(RULES)
    expect(out).not.toContain(`- **${RULES[0]!.rule}**:`)
  })
})

describe('M4 變異：一行一條被破壞（join 分隔改空白，全部黏成一行）', () => {
  /**
   * 報告靠 `lines.join('\n')` 把「每一條違規獨立一行」呈現。若改以空白或
   * 其他字元 join，所有子字串（rule、reason、標頭、footer）仍在，`toContain`
   * 全綠；但「每條違規單獨一行、可逐條閱讀」的結構契約被破壞了。本段錨定：
   * 每一條 rule 都位於檔案中獨立的一行。
   */
  it('每一條違規都獨立一行（`- **rule**` 之間的輸出以換行為界）', () => {
    const out = buildHandoverReport(RULES)
    const lines = out.split('\n')
    expect(lines.some((l) => l === '- **SR1-sync-failed**：`gh stack sync` 連續 2 次失敗，疑似語意衝突')).toBe(true)
    expect(lines.some((l) => l === '- **SR6-weakened-tests**：測試斷言淨減少 3 條')).toBe(true)
  })

  it('結尾「下一步」footer 獨立一行（分節），不是黏成整段', () => {
    const out = buildHandoverReport(RULES)
    // footer 行以 `**下一步**` 開頭且自成一行：其前方必須是換行、行內沒有夾帶
    // 任何違規條目（圓點清單），才能一行一條、分節閱讀。
    const footerLine = out.split('\n').find((l) => l.startsWith('**下一步**'))
    expect(footerLine).toBe('**下一步**：需人類接手處理。agent 不會自行重試或放寬規則。')
    expect(out).toContain('不會自行重試或放寬規則。')
  })
})

describe('完整格式快照（docs/07 §4.2 交還報告）', () => {
  /**
   * 整份報告與預期字串完全相等，一次釘住所有格式元素（標頭、規則計數、
   * 圓點加粗清單、全形冒號、一行一條、footer、空行分節）。任何一個格式
   * 元素被改動都會讓此快照變紅。
   */
  it('給定兩條違規時，輸出與規定的格式字串完全一致', () => {
    expect(buildHandoverReport(RULES)).toBe(expected())
  })

  it('零違規 → 空字串（不印任何標頭）', () => {
    expect(buildHandoverReport([])).toBe('')
  })
})
