# ADR-009：Backstage 局部解凍——factory-work-item 模板作為統一入口

- **狀態**：已接受
- **日期**：2026-08-21
- **決定者**：使用者裁決（grill-me 設計會談）
- **對應**：`14-observation-period.md` §1.7（#50 凍結裁決之修正）、`03-idp-backstage.md` §3.4、`02-architecture.md` D1

## 脈絡

`docs/14 §1.7`（#50，2026-08-18）裁決 Backstage **凍結保留、不部署、不維運**，升級觸發條件為「第 2 位協作者或第 2 個 repo 進入」。當時理由：單人 repo 的 IDP 抽象層價值接近零、維運成本 > 價值。

本裁決的觸發情境**未成立**（仍為單人使用），但出現一個新的具體需求：factory 工作項的開立仍依賴**手動拼湊 GitHub Issue 表單**，而使用者希望以「自然語言描述 → LLM 產生制式欄位 → 人類審改 → 一鍵建 Issue 並觸發 agent」的流程統一入口，全部在 Backstage 完成。

因此本 ADR 對 #50 做**局部解凍**：不推翻凍結裁決的整體判斷，只解凍「factory-work-item 模板 + LLM 草稿 + direct dispatch」這條最小可行路徑。

## 決策

**解凍以下最小範圍**：

1. **新增 `factory-work-item` scaffolder Template**（repo 內版控於 `backstage/templates/factory-work-item/`）：表單欄位與 `.github/ISSUE_TEMPLATE/factory-work-item.yml` 對齊（task_type 4 選、需求描述 PRD、DoD 3/3 全勾、目標 repo、base_branch），加上「一句話需求」欄位作為 Issue title 來源。
2. **LLM 草稿整合**（客製 action + 客製欄位，repo 內版控於 `backstage/plugins/`）：
   - 可選「🎯 釐清需求」：grill-me 收斂版（一次一輪 frontier 問題、編號、附建議答案、上限 3 輪、可隨時跳過）；
   - 「✨ 一次生成全部欄位」：一次 LLM call 回結構化 JSON 回填各欄位；
   - 生成結果附「⚠️ 推測與未確認事項」，**僅顯示於表單審查畫面，不寫入 Issue body**。
3. **Issue 建立 + direct dispatch**：`github:issues:create`（body 依 `factory-issue-check` 的 `FIELD_TITLES` 格式構造，labels `meta/observation`）→ `github:actions:dispatch`（software_factory 的 factory-run.yml，帶 issue_number/repo/base_branch/task_type）。**人類在 Backstage 點擊送出＝核准**，取代 `factory/approved` label 閘門（label 觸發保留給 GitHub 原生路徑）。
4. **憑證**：本機 app-config 存放 philipz **PAT**（僅供人類發起的 workflow dispatch）與 **DeepSeek API key**（僅供草稿生成）。**ADR-006 不變**：agent 在 workflow 內仍以 App token 行動，PAT 不進入任何 agent 操作；App 不擴權（維持無 Actions write）。

**維持凍結的其餘範圍**：Backstage 其他 Template（new-service 等）、Scoreboard、TechDocs 部署、catalog 探索、維運承諾——全部維持 #50 凍結狀態。

## 後果

### 正面
- **統一入口**：工作項開立、審查、觸發集中於 Backstage，符合使用者「所有作業在 IDP 完成」的目標。
- **事前攔截強化**：表單欄位驗證（task_type 必選、PRD 非空、DoD 3/3）在建立前攔下不合規內容，取代 agent 執行中的 SR4 事後停手（docs/04 的既有精神）。
- **LLM 草稿符合治理**：docs/01 明載「agent 產生規格草稿、標示缺漏」為合法職責；本裁決把它機械化且保留人類最終送出權。
- **可逆性（D1 延續）**：所有工件 repo 內版控；關閉分支即完全退回 #50 凍結狀態。

### 負面
- 客製 action/欄位是新增維護面（`createTemplateAction` / `createScaffolderFieldExtension`）。
- PAT 與 DeepSeek key 存於本機 app-config——單人可接受，但需明記安全邊界（見下）。
- 三層防線的分工：direct dispatch **不等待** factory-issue-check（建 Issue 後立即 dispatch），不合規的最終攔截點是 agent 執行中的 SR4 停手。

### 中性
- 部署形式為本機 `yarn dev`（scaffold 於 repo 外 `../backstage-app/`，D1：Backstage 不入 repo）；部署步驟與驗證項記錄於 `docs/03 §3.4` 與 `backstage/versions.md`。

## 替代方案

### A. 維持完全凍結（不部署任何 Backstage）
**未採用的理由**：使用者明確需要統一入口；手動 GitHub 表單流程的摩擦是實際痛點，不是假設。

### B. 完整復活 Backstage（含 Scoreboard/TechDocs/catalog）
**未採用的理由**：#50 的判斷（單人 repo 維運成本 > 價值）仍然成立；只解凍被證實需要的路徑，其餘等升級條件（第 2 位協作者或第 2 個 repo）達成。

### C. 草稿痕跡寫入 Issue body
**未採用的理由**：使用者裁決不寫——Issue body 維持純 factory-work-item 格式；「AI 代擬需求」的防線由表單驗證 + pipeline 攔截承擔，不靠 body 標記。

## 安全邊界（明記）

- **PAT**：僅存本機 app-config（gitignored）；僅供 `github:actions:dispatch`（人類點擊發起）；**不**作為 agent 身分、**不**進 CI secrets、**不**進 repo。
- **DeepSeek API key**：僅存本機 app-config；僅供草稿生成 LLM call；草稿內容不寫入 Issue body，不影響稽核軌跡。
- **App 權限**：維持 ADR-006/D6 記錄（contents/PRs/Issues write、Actions/Metadata read），不新增 Workflows/Administration。

## 實作注意

- deploy-time 驗證 `github:issues:create` 於鎖版 `plugin-scaffolder-backend-module-github` 是否存在（約 v1.40 起）；缺則升版並記錄於 `backstage/versions.md`（比照 Q03-2 的驗證模式）。
- `factory-issue-check` 的 DoD 判定同步修正為「3 個 DoD 選項全部勾選」（`src/cli/factory-issue-check.ts`），使表單驗證與檢查器規則一致。
