# 02 — 系統架構

> **依據**：`00-source-summary.md`（來源框架）、`01-value-stream-map.md` §5（階段處置判定）
> **讀者**：要實作或評估本工廠的工程師
> **本文件的地位**：架構的單一事實來源。後續 `03`–`07` 各自展開其中一個平面的細節，不得與本文件牴觸。

---

## 1. 架構總覽

```
              ┌────────────────────────────────────────────┐
   人類角色 → │  Backstage — IDP 入口（唯一 paved road）      │
  PO/開發/SRE │  ・Software Catalog：服務、擁有者、風險等級     │
              │  ・Software Templates：工廠任務的自助入口       │
              │  ・TechDocs：本 docs/ 直接發佈                │
              │  ・Scoreboard：KPI 與成本看板                 │
              └───────────────┬────────────────────────────┘
                              │ 觸發（Template → workflow_dispatch）
                              ▼
              ┌────────────────────────────────────────────┐
              │  Control Plane — GitHub（唯一事實來源）        │
              │  ・Work Item  = Issue（含 oversight 標籤）    │
              │  ・Run        = Actions workflow run         │
              │  ・Gate       = PR review + required checks  │
              │  ・Audit      = Issue/PR/run 的既有歷程        │
              └───────────────┬────────────────────────────┘
                              │ 呼叫（一次性、可審計、有 exit code）
                              ▼
              ┌────────────────────────────────────────────┐
              │  Execution Plane — DSH                      │
              │  dsh --profile headless "<task>"            │
              │  ・sandbox + permission preset  →ᴾ¹ 支柱三   │
              │  ・credentials service          →ᴾ² 支柱二   │
              │  ・token-meter + OTel           →ᴾ³ 支柱四   │
              │  ・skills = 工廠標準作業程序（SOP）             │
              └───────────────┬────────────────────────────┘
                              │ 產出
                              ▼
              ┌────────────────────────────────────────────┐
              │  Delivery Plane — gh stack                  │
              │  一疊小顆、可獨立審查的 PR                     │
              └────────────────────────────────────────────┘
```

四個平面各有單一職責，且**依賴方向由上而下、不回頭**：Backstage 不知道 DSH 的存在細節，DSH 不知道 Backstage 的存在。兩者僅透過 GitHub 這層契約耦合。

---

## 2. 核心架構決策

各決策的完整脈絡與替代方案見 `docs/ADR/`（ADR-001~007 依 D1~D7 正序編號）。

> **關於本節的排列順序**：D1–D4 為初始設計決策；**D6、D7 為後續由使用者裁決後補入**，置於 D4 之後、D5 之前，因其（身分與 CI 平台）是 D5 自主性上限的前提。**D5 置於最後**，因它總結前六項的風險立場。編號一經指定即不再變動，以維持與 ADR 及其他文件引用的一致。

### D1：GitHub 是唯一事實來源，Backstage 是入口而非狀態機

**決策**：工作項狀態、執行紀錄、審查閘門、稽核歷程一律存放於 GitHub（Issue / PR / Actions run）。Backstage **不儲存**工廠狀態，只做展示與觸發。

**理由**：
- 小團隊（3–10 人）不應維運額外的工作流資料庫。
- 雙寫必然產生不一致；GitHub 已提供狀態機、權限、稽核與通知。
- Backstage 若掉線，工廠仍可運作（降級路徑，見 §6）。

**後果**：Backstage 的 Catalog 是 GitHub 資料的**投影**，須容忍最終一致性。任何「只存在於 Backstage」的狀態都是架構違規。

---

### D2：agent 執行一律走 `dsh --profile headless`

**決策**：所有自動化 agent 工作以一次性 headless 呼叫執行，不使用互動式 session。

**已驗證的事實**（來源：`@deepseek-ai/dsh-headless` README）：
- 呼叫形式為 `dsh --profile headless "<task>"`。
- 執行器建立一個全新的持久化 Agent，將任務作為一般 user message 送出，等待靜止（quiescence）。
- 將**最後一則非空的 assistant 文字寫入 stdout**。
- **exit code：最終 `turn/end` 完成 → 0，否則 → 1**；終止性錯誤另將代碼與訊息寫入 stderr，成功執行則 stderr 為空。
- **不開啟任何監聽埠**。

**理由**：CI 需要的正是「可判定成敗、無互動、無常駐」的執行單元。上述四項特性逐一對應。

**後果**：
- 每次呼叫是無狀態的；跨呼叫的記憶必須外部化（寫入 repo 或 Issue 留言）。
- 單次呼叫只能送出一個任務，無互動追問（README 明列此限制）。因此任務描述必須自足。

---

### D3：一個工作項 = 一疊 stacked PR

**決策**：agent 的產出不是一顆大 PR，而是一疊有序的小 PR（典型：`01-test` → `02-impl` → `03-docs`）。

**理由**：直接回應 `00` §7 的警示——只優化 Create 會讓瓶頸下移到 Verify 的 code review，導致「效力轉移而非節省」。把審查單元縮小到人類能在數分鐘內判讀，是本架構對該警示的具體因應。

**後果**：需要 stacked PR 工具鏈（`gh stack`，已驗證安裝 v0.0.2）。合併必須依疊序由底而頂。詳見 `07-stacked-pr-workflow.md`。

---

### D4：雙層 guardrail

**決策**：guardrail 同時實施於兩層，且**兩層都必須獨立成立**：

| 層 | 機制 | 防護對象 |
|---|---|---|
| **DSH 層** | sandbox mode、approval policy、skills 規則 | agent 在執行期能做什麼 |
| **GitHub 層** | branch protection、required checks、CODEOWNERS、App 權限 | agent 的產出能否進入主線 |

**理由**：`00` §5 的結論語「**Agents are new insiders**」。內部人風險的特性是——單層防護一旦被繞過就完全失守。DSH 層若失效，GitHub 層仍能阻止未經審查的變更落地；反之亦然。

**後果**：任一層都不得因「另一層已經擋住了」而放寬。這是刻意的冗餘。

---

### D6：agent 以 GitHub App 身分行動（已裁決）

**決策**：工廠 agent 使用專屬的 **GitHub App**（安裝於目標 repo）作為身分，**不使用個人 PAT**，也不共用人類帳號。

**理由**：
- **稽核可辨識**：Issue 留言、commit、PR 都能明確區分「人做的」與「agent 做的」。若用個人 PAT，`philipz` 的操作與 agent 的操作在歷程中無法分辨，`00` §5「agents are new insiders」的追責前提即失效。
- **權限可收斂**：App 的權限以安裝範圍授予，可精確到 repo 與 API 類別，且與任何個人的權限脫鉤。
- **憑證可輪替**：App 以短效 installation token 運作，不需長期存放高權限密鑰。
- **離職/換人不影響**：身分屬於系統而非個人。

**權限設定（最小化，且刻意排除自我修改能力）**：

| 權限 | 等級 | 理由 |
|---|---|---|
| Contents | Read & write | 建立分支、推送 commit |
| Pull requests | Read & write | 建立與更新 PR |
| Issues | Read & write | 讀取工作項、回報進度與 `needs-human` |
| Actions | Read | 讀取自身 run 狀態 |
| Metadata | Read | 必要基礎權限 |
| **Administration** | **不授予** | 否則 agent 可改 branch protection |
| **Workflows** | **不授予** | 否則 agent 可改 CI 定義 |

> **與 D4 的關聯**：後兩項的排除是 §7「agent 不得擁有修改 guardrail 本身的權限」這條不變量的**具體執行方式**。若授予 Administration 或 Workflows 權限，雙層防護將退化為零層。

**後果**：
- CI 中需以 App 的 private key 換取 installation token（標準做法為 `actions/create-github-app-token`）。
- App 的 private key 是本系統最敏感的密鑰，須存於 GitHub Secrets，且**永不進入 agent 的 context**（見 `05`）。
- GitHub App 由人類建立與安裝，此步驟不可自動化（見 `09` 第 1 期）。

---

### D7：CI 平台採用 GitHub Actions（已裁決）

**決策**：以 **GitHub Actions** 作為唯一的 CI/CD 執行平台與工廠的 Control Plane 執行引擎。

**理由**：
- 與 D1（GitHub 為唯一事實來源）自然一致，不引入第三方系統與額外的身分整合。
- workflow_dispatch 提供 Backstage Template 的觸發端點。
- run 歷程即稽核紀錄，無須另建。

**與 `00` §3 Phase 1 前提條件的關係**：來源研究明示 CI、單元測試自動化、靜態分析、自動化部署是**引入 AI 之前的基本前提**。採用 GitHub Actions 即是滿足此前提的載體——但**平台就緒不等於前提就緒**：仍須確認目標 repo 實際具備測試與靜態分析的 workflow。此驗證列為 `09` 第 0 期的出場條件。

**後果**：
- runner 為 Linux（`ubuntu-latest`），與本機 macOS 開發環境不同；DSH 沙箱的跨平台行為需驗證（Q02-2 仍成立）。
- 受 GitHub Actions 的並行數與時間上限約束，影響 `00` §3 Phase 2 的「非同步平行化」可達程度。

---

### D5：自主性上限設定為「on-the-loop 且限定低風險類別」

**決策**：本專案**不追求**完全自主交付。agent 自動合併僅限於 `06-human-oversight-policy.md` 計分為低風險的類別。

**理由**：
- `00` §3 Phase 2 明示現階段技術成熟度無法保證一致性、準確性與可預測性，人類監督為強制。
- `00` §7 的技能退化警示。
- `00` §6 的三軸判準。

**後果**：`00` §3 Phase 3 描述的 vibe coding 全自主與生產環境自癒，**不在本專案範圍**。這是有意識的自我設限，不是能力不足。

---

## 3. 各平面詳述

### 3.1 Backstage（IDP 入口）

**唯一職責**：讓人以自助方式觸發工廠能力，並看見結果。

| 元件 | 用途 |
|---|---|
| Software Catalog | 登錄服務、擁有者、以及**風險等級 annotation**（供 `06` 計分使用） |
| Software Templates | 工廠任務的自助入口（如「建立新服務」「請 agent 修 bug」） |
| TechDocs | 直接發佈本 `docs/` 目錄 |
| Scoreboard | 展示 `08-metrics-kpi.md` 的指標與成本 |

**設計約束**：
- Template 的動作是**觸發 GitHub workflow_dispatch 或建立 Issue**，不直接呼叫 DSH。
- Catalog 中的風險等級是**輸入**（人為登錄的事實），不是 agent 可自行修改的值。

詳見 `03-idp-backstage.md`。

---

### 3.2 GitHub（Control Plane）

**唯一職責**：承載工作項狀態、觸發執行、施加閘門、留存稽核。

| 概念 | GitHub 實體 | 說明 |
|---|---|---|
| 工作項 | Issue | 含驗收條件與 `oversight/*` 標籤 |
| 執行 | Actions workflow run | 一次 run = 一次 DSH headless 呼叫（或數次） |
| 閘門 | PR review + required checks | D4 的 GitHub 層 |
| 稽核 | Issue/PR/run 歷程 | 不另建稽核系統 |

**狀態流轉**（以 Issue 標籤表示）：

```
  needs-refinement ──► ready ──► in-progress ──► in-review ──► done
                                      │              │
                                      └──► needs-human ◄┘
```

`needs-human` 是 agent 的**唯一合法退出路徑**：任何 agent 無法自行完成的情況（連續 rebase 失敗、超出風險等級、成本超限），一律標記此標籤並停手，交還人類。

---

### 3.3 DSH（Execution Plane）

**唯一職責**：在受限環境中執行一次自足的任務，並回報成敗。

**執行契約**（依 D2 已驗證事實）：

```bash
# CI 中的呼叫形式
dsh --profile headless "<自足的任務描述>"
# stdout ← 最後一則非空 assistant 文字
# exit 0 ← 最終 turn/end 完成
# exit 1 ← 其他情況（stderr 含錯誤代碼與訊息）
```

**IDP 四支柱對應到 DSH 的具體機制**（均為已查證的套件能力）：

| 支柱（`00` §4） | DSH 機制 | 查證來源 |
|---|---|---|
| **Guardrails** | `dsh-sandbox-policy`：`read-only` / `workspace-write` / `danger-full-access` 三種模式，**預設 `read-only`（fail-safe）**；每個 session 的模式為不可變的 durable 事件 | `dsh-sandbox-policy` README |
| **Credential management** | `dsh-credentials`：**設定只攜帶對密鑰的參照，永不攜帶密鑰本身**（如 `apiKeyEnv: DEEPSEEK_API_KEY`）；每次操作即時解析、不跨操作快取 | `dsh-credentials` README |
| **Sandboxed environments** | `dsh-sandbox`（含 landlock 原生模組）+ 容器隔離；`dsh-permission-presets` 將 sandbox 模式與核准政策綁為具名預設 | `dsh-permission-presets` README |
| **Cost management** | `dsh-token-meter`：以 session 為單位的 token 計量；`dsh-session-telemetry-otel`：OTel 遙測輸出 | `dsh-token-meter` README |

**skills 作為工廠的 SOP**：`dsh-skill-filesystem` 掃描專案層、自訂層與使用者層的 skill 根目錄。工廠的標準作業程序（如何拆 PR、如何寫 commit、如何自審）以 skill 形式寫在 repo 內，成為版控的一部分。這正是 `00` §3 Phase 1 Step 3 的 Southern Company 案例所指的「抽象層」——開發者不必自己寫複雜 prompt。

詳見 `04-agent-execution-dsh.md` 與 `05-guardrails-governance.md`。

---

### 3.4 gh stack（Delivery Plane）

**唯一職責**：把一個工作項的變更組織為可獨立審查的有序 PR 疊。

**已驗證的指令面**（`gh stack` v0.0.2）：
`init`、`add`、`submit`、`push`、`rebase`、`sync`、`merge`、`view`、`checkout`、`switch`、`up`/`down`/`top`/`bottom`、`link`、`unstack`。

詳見 `07-stacked-pr-workflow.md`。

---

## 4. 端到端控制流

以「修復一個 bug」為例：

```
1. 人：在 Backstage 選擇 Template「請 agent 修 bug」，填入 Issue 連結
       └─► Backstage 觸發 GitHub workflow_dispatch
2. GitHub Actions：讀取 Issue，依 06 規則計分 → 貼上 oversight 標籤
       ├─ 計分 5–6（in-loop）→ 停止，標記 needs-human，通知人類
       └─ 計分 0–4 → 續行
3. Actions：以受限權限啟動 DSH
       dsh --profile headless "<任務：修復 Issue #123，遵循 repo skills>"
4. DSH agent：讀碼 → 寫測試 → 實作 → 自審 → gh stack 建立 PR 疊
5. Actions：判讀 exit code
       ├─ exit 1 → 標記 needs-human，附上 stderr
       └─ exit 0 → 續行
6. GitHub 閘門：required checks + CODEOWNERS
       ├─ 計分 0–1（on-loop，低風險類別）→ 可自動合併
       └─ 計分 2–4 → 等待人類 review（agent 不得合併）
7. 合併：依疊序由底而頂
8. 度量：run 的 token 用量與時間戳記寫入 08 的指標來源
```

**每一個判定點都是機械可判定的**（標籤、exit code、計分），沒有依賴 agent 自我宣稱的環節。這是本架構的關鍵性質：**信任來自結構，不來自 agent 的自述**。

---

## 5. 依賴方向與耦合

```
Backstage ──依賴──► GitHub ◄──依賴── DSH
                      ▲
                      └── 唯一的整合契約
```

- **Backstage → GitHub**：透過 GitHub API（Catalog 匯入、workflow_dispatch）。
- **DSH → GitHub**：透過 `gh` CLI（讀 Issue、建 PR）。
- **Backstage ⇄ DSH**：**無直接依賴**。這是刻意的——任一方可替換而不影響另一方。

**替換成本**：若未來更換 IDP（Backstage → 其他），DSH 與 CI 不需改動；若更換 agent 執行器（DSH → 其他），只需維持「一次性呼叫 + exit code + stdout」的契約。

---

## 6. 失敗與降級路徑

| 失敗情境 | 偵測方式 | 降級行為 |
|---|---|---|
| Backstage 不可用 | 健康檢查 | **工廠仍可運作**：直接在 GitHub 建 Issue、手動觸發 workflow（D1 的直接效益） |
| DSH 呼叫失敗 | exit code = 1 | 標記 `needs-human`，附 stderr 內容；**不自動重試**（見下方註） |
| DSH 逾時 | CI job timeout | 同上，並記錄已消耗的 token |
| 成本超出單一工作項上限 | token-meter 讀數 | 中止執行、標記 `needs-human`、告警 |
| `gh stack sync` 連續兩次失敗 | 指令 exit code | 停手、標記 `needs-human`（規則見 `07` §3.3、§4.1） |
| GitHub API 限流 | HTTP 429 | 指數退避重試；仍失敗則標記並停手 |
| 風險計分落入 in-loop | 計分規則 | 不啟動 agent 實作，只產出分析供人類參考 |

> **不自動重試的理由**：LLM 執行具非決定性，盲目重試會放大成本且可能產生不同的錯誤產出。重試必須是人類的決定，或針對**已知的暫時性錯誤**（如網路、限流）才自動化。

**共同原則**：所有降級路徑的終點都是 `needs-human` + 人類可讀的失敗原因。**agent 永不靜默失敗，也永不自行放寬限制**。

---

## 7. 安全模型

依 D4，兩層各自的最小要求：

### DSH 層
- **CI 中固定使用 `workspace-write`**，於 session 建立時即釘選；**永不使用 `danger-full-access`**。
  > DSH 的部署預設為 `read-only`（fail-safe），但工廠的 factory profile 在 patch 層明確設為 `workspace-write`（`04` §2.3）。**agent 無法在執行中自我提權**——已查證 sandbox 模式於 session 建立時釘選，之後的設定變更不影響既有 session（`05` §2.1）。
- 憑證以參照方式設定，**GitHub token 等密鑰不進入 agent 的 context**。
- agent 的工作目錄限定於該次 run 的 workspace。

### GitHub 層
- `main` 受 branch protection 保護，禁止直接推送。
- required status checks 必須全綠才可合併。
- CODEOWNERS 對高風險路徑（授權、金流、敏感資料）強制指定人類審查者。
- agent 使用的 token 權限最小化（僅需 repo 範圍，且不得具備變更 branch protection 的權限）。

> **關鍵不變量**：**agent 不得擁有修改 guardrail 本身的權限**。任何允許 agent 改動 branch protection、CODEOWNERS、或 CI 設定的設計，都會使 D4 的雙層防護退化為零層。此規則無例外。

---

## 8. 本架構未涵蓋的範圍

明確排除，以免誤解：

- **生產環境自動修復**（`01` §2.6、D5）。
- **多組織/多團隊的 agent 生態系**（`00` §5 的最高層級；本專案止於 collaborative agents）。
- **Augmented FinOps 的自動成本優化執行**（僅監控與告警，不自動調整資源）。
- **vibe coding 式的 prompt-to-app 全自主流程**。

---

## 未決事項

| 編號 | 事項 | 影響 | 需要誰決定 |
|---|---|---|---|
| Q02-1 | `$DSH_HOME/profiles` 目前**只有 `web` profile**，headless profile 尚未佈建 | 實作首步必須確認 headless profile 的佈建方式 | 實作時驗證 |
| Q02-2 | DSH 在 CI（Linux runner）中的執行方式尚未驗證；landlock 為 Linux 機制，本機為 macOS | 沙箱行為可能跨平台不一致 | 實作時驗證 |
| Q02-3 | Backstage 版本與插件相容性未經連網查證 | 見 `09` 第 1 期 | 實作時鎖版 |
| ~~Q02-4~~ | ~~agent 使用哪一個 GitHub 身分~~ | **已裁決 → D6：GitHub App** | ✅ 使用者已決定 |
| Q02-5 | 單一工作項的 token 成本上限值 | 影響 §6 的中止門檻 | 需先取得基線數據（`08`） |
| ~~Q02-6~~ | ~~目標 repo 是否已具備測試與靜態分析 workflow~~ | **已確認尚未具備** | ✅ 已建立 `.github/workflows/test.yml` 與測試框架（`11`）；56 則測試實跑通過 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
