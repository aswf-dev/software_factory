/**
 * agent-pbt-audit 的變更範圍檢查（ADR-019 §5 白名單、R6）。由 factory-crosscheck
 * 呼叫（它負責從 git 取得事實），這裡只做判斷。
 *
 * 兩條規則，方向相反：
 * - **audit 只能碰 PBT 檔**：只允許新增或修改符合各語言命名慣例的檔案，**不得刪除**。
 *   這是 in-loop 豁免（`IN_LOOP_ALLOWED_TASK_TYPES`）的前提之一：audit 能在
 *   human-in-the-loop 的 repo 上跑，是因為它碰不到產品程式碼。
 * - **其他類型不得產出 PBT 檔**：PBT 只在稽核工作項出現（ADR-019 §2）。開發當下寫
 *   的 property，依據只能來自 agent 剛讀的 Issue 與自己即將寫的實作——正是 ADR-008
 *   禁止的「以自撰依據驗證自撰產出」。派送端已不把 hegel skill 給其他類型，這裡是
 *   第二道防線。
 */
import { isPbtTestPath } from './languages.js'

export interface PbtScopeFinding {
  kind: string
  detail: string
}

export function checkPbtAuditScope(changedPaths: readonly string[], deletedPaths: readonly string[]): PbtScopeFinding[] {
  const findings: PbtScopeFinding[] = []
  const deleted = new Set(deletedPaths)
  const outside = changedPaths.filter((p) => !deleted.has(p) && !isPbtTestPath(p))
  if (outside.length > 0) {
    findings.push({
      kind: 'pbt-audit-scope',
      detail:
        `agent-pbt-audit 只允許新增或修改 PBT 測試檔（各語言命名慣例見 ADR-019 R6），越界：${outside.join('、')}` +
        '。產品程式碼、設定與依賴由人類處理；若前置作業不足，應依 stop-rule 停下而不是自行修改',
    })
  }
  if (deletedPaths.length > 0) {
    findings.push({
      kind: 'pbt-audit-deletion',
      detail:
        `agent-pbt-audit 不得刪除檔案：${deletedPaths.join('、')}` +
        '。PBT 只新增、不取代既有測試（ADR-019 §6）；失敗的 property 寫進候選發現，不刪測試',
    })
  }
  return findings
}

export function checkPbtOutsideAudit(changedPaths: readonly string[]): PbtScopeFinding[] {
  const pbt = changedPaths.filter((p) => isPbtTestPath(p))
  if (pbt.length === 0) return []
  return [
    {
      kind: 'pbt-outside-audit',
      detail:
        `PBT 測試檔只能由 agent-pbt-audit 產出（ADR-019 §2），本工作項卻變更了：${pbt.join('、')}` +
        '。開發當下的 property 依據只能來自本次產出，違反「不得以自撰依據驗證自撰產出」',
    },
  ]
}
