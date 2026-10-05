/**
 * 工廠會貼到 Issue 上的所有 label — 單一真相來源。
 *
 * **為什麼需要這個模組**：`gh issue edit --add-label` **不會自動建立 label**，
 * 不存在就整條指令失敗。發射端（apply-*-labels）與 bootstrap
 * （factory-run.yml 的「Ensure factory labels exist」）是兩份各自維護的清單，
 * 新增一個 label 只改發射端就會在收尾階段炸掉。
 *
 * 實測（run 34731487680，Issue #287，2026-09-13）：
 *
 *     error: Command failed: gh issue edit 287 --add-label oversight/review,skill-gap
 *     ##[error]Process completed with exit code 1.
 *
 * `skill-gap` 是 docs/20 E4（skillGap 通道）加的發射端，bootstrap 沒跟著更新。
 * 後果特別惡劣：agent 的工作**已經成功**（crosscheck 過、judge 出了終態、PR 也開了），
 * 卻因為貼不上標籤而整個 run 被標成 failure 並貼 needs-human——
 * 成功的執行被偽裝成失敗，而真正的原因埋在 log 裡。
 *
 * 因此本清單由 `test/adversarial/factory-assets.test.ts` 釘住：
 * 每一個成員都必須出現在 factory-run.yml 的 `gh label create` 之中。
 *
 * 不含 `factory/approved`：那是**人類**貼給 factory-issue-check.yml 的核准信號，
 * 不由工廠發射，且因為它是觸發條件本身，無法由工廠自己 bootstrap（先有雞後有蛋）。
 * 它的建立屬於 repo 設定，見 docs/12 §6。
 */
import { TIER_LABEL } from './scoring/types.js'
import { NEEDS_HUMAN_LABEL } from './stop-rules/types.js'
import { PBT_AUDIT_LABEL } from './pbt-audit/intake.js'
import { SPEC_LABELS } from './write-spec/phase.js'

/** 技能缺口分類訊號（docs/25 §3）；不影響終態，只用於聚類。 */
export const SKILL_GAP_LABEL = 'skill-gap'

/**
 * 工廠**可能**貼上的 label 全集。
 *
 * 來源刻意用 import 而非重打字串：新增一個 oversight tier 或改動
 * NEEDS_HUMAN_LABEL 時，這裡自動跟上，不會變成第二份會漂移的清單。
 */
export const FACTORY_LABELS: readonly string[] = [
  ...Object.values(TIER_LABEL),
  NEEDS_HUMAN_LABEL,
  SKILL_GAP_LABEL,
  // agent-write-spec 狀態機中由工廠貼上的三個（ADR-018 §12）。
  // spec/approved、spec/model-declined 由人貼上，不在此列（仍由 workflow 預先建立）。
  SPEC_LABELS.phaseInvariants,
  SPEC_LABELS.phaseModel,
  SPEC_LABELS.outdated,
  // agent-pbt-audit（ADR-019 R2）：判定類型後自動貼上。
  PBT_AUDIT_LABEL,
]
