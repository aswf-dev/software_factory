# 03 — 內部開發者平台（Backstage）

> **依據**：`00-source-summary.md` §3 Phase 1 Step 3（建立 IDP 與 paved roads）、`02-architecture.md` §3.1（Backstage 的唯一職責）、D1（Backstage 是入口而非狀態機）
> **讀者**：建置與維護 IDP 的平台工程師
>
> ⚠️ **版本查證聲明**：撰寫本文件時**無法連網查證** Backstage 的最新版本、插件相容性與 API 變動（工作環境的 web search 無 API key）。以下所有涉及套件名稱、設定欄位、CLI 指令的內容，均標註為「待實作驗證」，實作首步必須鎖版並以官方文件核對。這是風險 R5 的落實，不是疏漏。

---

## 1. Backstage 在本架構中的定位

### 1.1 為什麼需要 IDP

來源研究 `00` §3 Phase 1 Step 3 的論點是：**建立 IDP 是達成一致性與規模化的基礎實踐**，其核心是提供「paved roads」——刻意設計的鋪好的路。

Southern Company 案例（`00` §3 Phase 1 Step 3）點出了沒有 IDP 時的實際失敗樣態：

- 開發團隊**缺乏 prompt 與 context engineering 的專業**；
- **難以確保 AI 產出符合組織的編碼標準**，驗證耗時。

其解法是把 IDP 當作 **AI 能力的抽象層**，將複雜任務標準化為自助式服務（如「Code Transformation Service」），**讓開發者不必自己撰寫複雜的 prompt，也不必費時理解複雜的 AI 產出**。

**本專案照此設計**：Backstage 的 Template 就是那層抽象。使用者填幾個欄位，而不是寫 prompt。prompt 工程的成果沉澱在 repo 的 skills 中（見 `04`），由平台維護者一次寫好、全團隊共用。

### 1.2 唯一職責與明確的非職責

| ✅ Backstage 負責 | ❌ Backstage 不負責 |
|---|---|
| 提供人類自助觸發工廠能力的入口 | **儲存工廠狀態**（狀態在 GitHub — D1） |
| 展示服務型錄、擁有者、風險等級 | 執行 agent（執行在 DSH — D2） |
| 發佈文件（TechDocs） | 施加合併閘門（閘門在 GitHub — D4） |
| 展示 KPI 與成本看板 | 直接呼叫 DSH（無直接依賴 — `02` §5） |

> **架構違規的判準**：任何「只存在於 Backstage 而 GitHub 沒有」的工廠狀態，都是違反 D1。實作審查時以此為檢查點。

---

## 2. Software Catalog：登錄什麼、為何登錄

Catalog 是 Backstage 的核心資料模型。本專案只用它承載**風險分級所需的事實**與**擁有權**，不擴張成無所不包的 CMDB。

### 2.1 實體模型

採用 Backstage 標準的實體種類（Kind）：

| Kind | 本專案的用途 |
|---|---|
| `Component` | 一個可獨立交付的服務或程式庫 = 一個 repo（或 monorepo 中的一個套件） |
| `System` | 一組協作的 Component（如「訂單系統」） |
| `Group` | 團隊；作為 `owner` 的目標 |
| `User` | 個人；映射到 GitHub 帳號 |

**刻意不使用**：`Resource`、`Domain`、`API`。小團隊用不到，過早引入只會增加維護負擔而無人填寫（型錄一旦失準就失去信任，反成負債）。

### 2.2 工廠專屬 annotation（本專案的關鍵設計）

`06-human-oversight-policy.md` 的三軸計分需要**客觀事實**作為輸入。這些事實由人類在 Catalog 中登錄，成為 agent 無法自行竄改的參照。

```yaml
# catalog-info.yaml — 置於每個 repo 根目錄
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: order-service
  description: 訂單處理服務
  annotations:
    # --- Backstage 標準 annotation ---
    github.com/project-slug: my-org/order-service
    backstage.io/techdocs-ref: dir:.

    # --- 工廠專屬 annotation（本專案定義）---
    # 業務關鍵性：tactical | operational | strategic
    factory.io/business-criticality: strategic
    # 風險輪廓：low | medium | high
    factory.io/risk-profile: high
    # 架構複雜度：low | medium | high
    factory.io/complexity: medium
    # 是否允許 agent 自動合併（最終仍受 06 計分與 CODEOWNERS 約束）
    factory.io/agent-automerge: "false"
spec:
  type: service
  lifecycle: production
  owner: group:default/payments-team
```

**設計要點**：

1. **三軸 annotation 直接對應 `00` §6 的 Figure 11 三軸**，命名刻意貼近原文用語以便追溯。
2. **這些值由人類登錄，agent 不得修改**。`catalog-info.yaml` 應納入 CODEOWNERS 保護（見 `05`）。若 agent 能自行調降風險等級，整個監督分級即形同虛設。
3. `factory.io/agent-automerge` 是**額外的一道人為否決權**：即使計分判定為低風險，擁有者仍可強制關閉自動合併。**只能收緊、不能放寬**。

> ⚠️ 待實作驗證：annotation 的命名空間 `factory.io/` 需確認不與既有 Backstage annotation 衝突；讀取方式需確認 Catalog API 的實際欄位路徑。

### 2.3 型錄的資料來源

依 D1，Catalog 是 GitHub 的**投影**：

```
GitHub repos（catalog-info.yaml）──探索──► Backstage Catalog
```

採用 Backstage 的 GitHub 探索機制自動掃描組織下的 repo，而非手動註冊。理由：手動註冊必然過時。

> ⚠️ 待實作驗證：GitHub 探索的插件名稱、設定格式與所需權限。

---

## 3. Software Templates：工廠能力的自助入口

這是 `00` §3 Phase 1 Step 3 所述「抽象層」的具體實現，也是使用者接觸工廠的**唯一入口**。

### 3.1 Template 清單（第一階段）

刻意從**少量、高頻、低風險**的能力開始。每個 Template 的動作都止於「在 GitHub 建立 Issue 或觸發 workflow」——**Template 不直接呼叫 DSH**（`02` §5）。

| Template | 使用者輸入 | 觸發動作 | 對應價值流階段 |
|---|---|---|---|
| **`new-service`** | 服務名、擁有團隊、三軸風險等級 | 由 repo 範本建立新 repo，含 `catalog-info.yaml`、CI workflow、CODEOWNERS | Plan → Create |
| **`agent-fix-bug`** | 既有 Issue 連結 | 為該 Issue 貼上 `ready` 標籤並觸發工廠 workflow | Create |
| **`agent-add-tests`** | repo、目標模組 | 建立 Issue 並觸發（低風險類別，`00` §6 明列） | Create |
| **`agent-update-deps`** | repo | 建立 Issue 並觸發（低風險類別） | Create |
| **`agent-write-docs`** | repo、範圍 | 建立 Issue 並觸發（低風險類別） | Create |

**選擇這五項的理由**：後四項全部落在 `00` §6 明列的 human-on-the-loop 範例中（小型 bug 修復、相依更新、產生文件、產生單元測試），是風險最低、最能建立信任的起點。`new-service` 則是 paved road 的入口——新服務從第一天就帶著正確的 guardrail 出生。

### 3.2 Template 的骨架

```yaml
# templates/agent-fix-bug/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: agent-fix-bug
  title: 請 agent 修復 bug
  description: 將既有的 bug Issue 交由工廠 agent 處理
spec:
  owner: group:default/platform-team
  type: service
  parameters:
    - title: 工作項資訊
      required: [repoUrl, issueNumber]
      properties:
        repoUrl:
          title: 目標 repo
          type: string
          ui:field: RepoUrlPicker
        issueNumber:
          title: Issue 編號
          type: number
          description: 該 Issue 必須已具備明確的重現步驟與驗收條件
  steps:
    - id: dispatch
      name: 觸發工廠工作流
      action: github:actions:dispatch
      input:
        repoUrl: ${{ parameters.repoUrl }}
        workflowId: factory-run.yml
        branchOrTagName: main
        workflowInputs:
          issue_number: ${{ parameters.issueNumber }}
  output:
    links:
      - title: 查看執行狀態
        url: ${{ steps.dispatch.output.workflowRunUrl }}
```

> ⚠️ 待實作驗證：`github:actions:dispatch` 這個 scaffolder action 的**確切名稱、輸入欄位與輸出**未經連網查證。若該內建 action 不存在或簽章不同，替代方案是撰寫自訂 scaffolder action，或改以 Template 建立 Issue、由 Issue 標籤事件觸發 workflow（後者耦合更鬆，可能反而更好）。

### 3.3 Template 的設計原則

1. **輸入必須是使用者知道的事實**，不是 prompt。若某欄位要求使用者描述「希望 agent 怎麼做」，代表抽象層失敗——那份知識該寫進 skill。
2. **前置條件寫在描述中**（如上例的「必須已具備重現步驟與驗收條件」），並由 workflow 實際檢查，不只是口頭約定。
3. **輸出一定包含可追蹤的連結**，讓使用者知道去哪看結果。

---

## 4. TechDocs：文件即平台的一部分

**決策**：本 `docs/` 目錄直接作為 TechDocs 來源發佈。

**理由**：工廠的規則（監督分級、PR 拆分、guardrail）必須讓所有角色隨手可查。文件若與 repo 分離就會漂移——`01` §3 的消除清單 E6 正是此理。

設定方式為在 `catalog-info.yaml` 標註 `backstage.io/techdocs-ref: dir:.` 並提供 `mkdocs.yml`：

```yaml
# mkdocs.yml
site_name: Software Factory
docs_dir: docs
nav:
  - 總覽: README.md
  - 來源研究精要: 00-source-summary.md
  - 價值流地圖: 01-value-stream-map.md
  - 系統架構: 02-architecture.md
  - IDP（Backstage）: 03-idp-backstage.md
  - Agent 執行（DSH）: 04-agent-execution-dsh.md
  - 治理與 Guardrails: 05-guardrails-governance.md
  - 人工監督政策: 06-human-oversight-policy.md
  - Stacked PR 流程: 07-stacked-pr-workflow.md
  - 指標與 KPI: 08-metrics-kpi.md
  - 路線圖: 09-roadmap.md
  - 未決事項: 10-open-questions.md
  - 詞彙表: GLOSSARY.md
plugins:
  - techdocs-core
```

> ⚠️ 待實作驗證：`techdocs-core` 插件版本與 mkdocs 相容性。

---

## 5. Scoreboard：指標與成本的展示面

Backstage 展示 `08-metrics-kpi.md` 定義的指標。**Backstage 不計算指標，只呈現**（D1：不儲存工廠狀態）。

| 展示內容 | 資料來源 |
|---|---|
| 各階段 Lead Time 與閒置比 | GitHub Issue/PR 時間戳記 |
| PR 大小分布、一次通過率 | GitHub PR API |
| agent 成本（token / 工作項） | DSH token-meter → OTel → 指標後端 |
| `needs-human` 發生率與原因分布 | GitHub Issue 標籤 |

> ⚠️ 待實作驗證：採用自訂插件或既有的 GitHub Insights 類插件，需視實際可用性決定。第一階段可先以 GitHub 內建的 Insights 與一份手動報表替代，**不必為了看板而阻塞工廠上線**。

---

## 6. 部署形態（小團隊）

依使用者確認的範圍（小團隊共用、接 GitHub）：

| 項目 | 決策 | 理由 |
|---|---|---|
| 部署方式 | 單一容器，Docker Compose | 小團隊；Kubernetes 是過度工程 |
| 資料庫 | PostgreSQL（容器） | Backstage 正式部署需要；SQLite 僅適合本機試跑 |
| 認證 | GitHub OAuth | 團隊已有 GitHub 帳號，不另建身分系統 |
| 存取範圍 | 內網或需登入 | Catalog 含服務拓撲，不宜公開 |
| 升級策略 | 鎖定版本，季度評估升級 | Backstage 迭代快，浮動版本會反覆破壞 |

**本機開發起步**（供評估與試作）：

```bash
# ⚠️ 以下指令未經連網查證，實作時須以官方文件核對
npx @backstage/create-app@latest
cd <app-name>
yarn install
yarn dev   # 預設 http://localhost:3000
```

> **本機環境已具備的條件**（已實測）：Node v22.21.1、Docker 29.7.2。Backstage 對 Node 版本有明確要求，須確認 v22 落在支援範圍內；若否，以 nvm 切換至受支援的 LTS。

---

## 7. 與其他平面的介面契約

| 介面 | 方向 | 契約內容 | 失效時的降級 |
|---|---|---|---|
| Catalog 探索 | GitHub → Backstage | 讀取各 repo 的 `catalog-info.yaml` | 型錄過時；不影響工廠執行 |
| Template 觸發 | Backstage → GitHub | workflow_dispatch 或建立 Issue | **人類可直接在 GitHub 操作**（`02` §6） |
| 風險 annotation | Backstage → 計分邏輯 | 三軸值供 `06` 讀取 | **缺值時一律採最嚴格值**（見下） |
| 指標展示 | GitHub/OTel → Backstage | 唯讀 | 看板空白；不影響工廠執行 |

> **關鍵 fail-safe 規則**：若某 Component 缺少三軸 annotation，計分**一律採最高風險值**（strategic / high / high），即落入 human-in-the-loop。這與 DSH sandbox 預設 `read-only` 的 fail-safe 精神一致（`02` §3.3）——**缺乏資訊時偏向保守，絕不偏向放行**。

---

## 8. 實施順序

1. 建立 GitHub App（D6）與必要的 Secrets — **人類手動，不可自動化**。
2. 本機跑起 Backstage，確認版本相容性，**鎖版**。
3. 為 1–2 個試點 repo 撰寫 `catalog-info.yaml`（含三軸 annotation），驗證探索可用。
4. 實作 `agent-add-tests` 一個 Template（最低風險，`00` §6 明列的 on-the-loop 類別），端到端打通。
5. 驗證通過後，再擴充其餘 Template。
6. TechDocs 與 Scoreboard 最後補上（不阻塞工廠上線）。

> **順序的理由**：先打通一條最窄的端到端路徑再擴張。若先建完整型錄與五個 Template 才試跑，任何架構誤判都會在最貴的時候才暴露。

---

## 未決事項

| 編號 | 事項 | 影響 | 處置 |
|---|---|---|---|
| Q03-1 | Backstage 版本、`create-app` 指令、插件名稱與設定格式**全部未經連網查證** | 本文件所有 Backstage 技術細節 | 實作首步鎖版並以官方文件核對 |
| Q03-2 | `github:actions:dispatch` scaffolder action 是否存在及其簽章 | §3.2 的 Template 實作 | 若不存在，改用「Template 建 Issue → 標籤事件觸發」的鬆耦合方案 |
| Q03-3 | Node v22.21.1 是否在 Backstage 支援範圍 | 本機開發環境 | 實作時確認；必要時以 nvm 切版 |
| Q03-4 | `factory.io/` annotation 命名空間是否與既有慣例衝突 | §2.2 | 實作時確認 |
| Q03-5 | Scoreboard 採自訂插件或既有插件 | §5 | 第一階段可用手動報表替代，不阻塞上線 |
| Q03-6 | Backstage 的維運負擔是否值得（小團隊可能偏重） | 整體投資報酬 | 建議在第 1 期結束時以實際使用率重新評估（見 `09` kill criteria） |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
