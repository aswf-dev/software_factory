# 00 — 來源研究精要

> **出處**：Gartner, Inc. | G00843405,《How to Maximize the Impact of Agentic AI in the SDLC》, 2026-01-19, 19 min read
> 作者：Manjunath Bhat, Philip Walsh, Bill Blosen, Mark O'Neill, Brian Minning
>
> **散布限制**：該研究禁止未經授權的重製與散布。本文件**僅摘錄構成本專案設計依據的重點與結構**，並標註頁碼供追溯；不重製原文全文。原始 PDF 置於 `docs/How_to_Maximize_the__843405_ndx.pdf`。

本文件的用途是把來源研究「凍結」成後續所有設計文件共用的詞彙與框架。後續文件引用本研究時，一律回指本文件的節次編號，而非各自重新詮釋原文。

---

## 1. 核心命題

AI 只有在**廣泛且有紀律地應用於 SDLC 多個階段**時才會提升生產力並降低摩擦。原文以 2025 Gartner AI in Software Engineering Survey（n=299，2025-04-29 至 2025-06-25，北美 150 / EMEA 104 / 亞太 45）佐證（p.20）：

| 指標 | 使用 AI ≥10 個場景 | 使用 AI <5 個場景 |
|---|---|---|
| 上市速度提升 | 66% | 35% |
| 創新產品與功能數增加 | 55% | 38% |
| 使用者/客戶滿意度提升 | 53% | 32% |
| 開發者工作滿意度提升 | 61% | 44% |

（p.1, p.3）

**對本專案的意義**：工廠的價值不來自「把 coding 做得更快」，而來自覆蓋率——必須橫跨 Plan 到 Operate。這直接支撐 `02-architecture.md` 為何不做成單純的「AI 寫程式機器人」。

> 原文引述（p.3）：「The teams that succeed with agentic development will be the ones who recognize that the entire software development life cycle needs to evolve in concert.」— Joe Magerramov, VP/Distinguished Engineer, AWS

---

## 2. 價值流六階段（Figure 3, p.7）

工作項從 **Request** 流向 **Delivery** 的完整 Lead Time，跨越六個階段：

```
Plan → Create → Verify → Release → Configure → Operate
```

Lead Time 由三種時間構成（Figure 3 圖例）：

| 時間類型 | 定義 | 處置原則 |
|---|---|---|
| **Value-Adding Process Time** | 真正產生價值的作業 | 保留；可用 AI 加速 |
| **Necessary Non-Value-Adding Process Time** | 不直接加值但必要（如合規審查） | 優化、自動化 |
| **Unnecessary Non-Value-Adding Process Time** | 純粹浪費 | **消除** |

圖中特別標註 **「Work item is idle」**——工作項在階段間等待的閒置段。

**對本專案的意義**：這是 `01-value-stream-map.md` 的分析骨架，也是 `08-metrics-kpi.md` 中「閒置比」指標的來源。改善的首要目標是閒置段而非作業本身。

---

## 3. 三階段路線圖（Figure 2, p.5）

### Phase 1：映射價值流以解除限制（p.5–p.10）

- **Step 1**：識別並解除系統性瓶頸，審慎地並用 AI 與非 AI 自動化。
  - 關鍵警告（p.6）：**「AI is not the solution to resolving every productivity blocker.」** 傳統自動化（CI、單元測試自動化、靜態程式碼分析、自動化生產部署）應視為引入 AI 前的**基本前提**。
  - 在系統性低效存在時零散導入 AI，會**放大**低效而非解決它（p.6）。
  - 案例 CBRE：評估後發現善用既有資料可觀測性工具比投資新 AI 方案更可行（p.6）。
  - 瓶頸具**流動性**：若只把 AI 用於程式碼生成，瓶頸會下移到 code review（p.6）。
- **Step 2**：改善**所有角色**的體驗，不只開發者——包含 PO、UX 設計師、平台工程師、安全工程師、品質工程師、AI 工程師、資料工程師（p.9）。
  - 案例 Vizient：以「同理心地圖」逼問三個問題——AI 如何影響我的工作／我的責任與擁有權／我的工作時程（p.9）。
- **Step 3**：建立內部開發者平台（IDP）以達成一致性與規模化，提供「paved roads」（刻意設計的鋪好的路）（p.9）。
  - 案例 Southern Company：團隊缺乏 prompt 與 context engineering 專業、且難以讓 AI 產出符合組織編碼標準；解法是以 IDP 作為 AI 能力的**抽象層**，把複雜任務標準化為自助式服務（如「Code Transformation Service」），讓開發者不必自己寫複雜 prompt（p.10）。

### Phase 2：以非同步工作流重新想像 SDLC（p.10–p.13）

- **Step 1**：以非同步 agentic 工作流平行化任務。
  - agentic coding IDE（原文舉例 Amazon Kiro、Cursor、Google Antigravity）支援 spec-driven development，使 AI 從「code assistant」升級為「feature builder」（p.11）。
  - 因多步驟任務耗時，必須非同步平行執行以避免閒置等待（p.11）。
  - 適合背景平行處理的工作：自動化 code review、自動修補安全漏洞、修復既有 bug、重構程式碼異味（p.11）。
  - **人類角色轉變為「數位指揮家」（digital conductor）**：編排 agent、清楚表達意圖，並**對 agent 產出負最終責任**（p.11）。
  - 現階段技術成熟度**無法保證一致性、準確性或可預測性**，故 human-in-the-loop 監督為**強制**（p.11）。
- **Step 2**：轉型工作流——辨識什麼該**消除**、什麼該**保留**（p.12）。
  - 該消除者：大規模手動測試的苦工、為取得開發測試環境而開票、例行重複的人工核准。
  - 方法：**反覆追問這個流程為何存在**；確實需要存在才談優化。
  - 必須保留的不變量：使用者同理心、有效的變革管理；創新的步調須配合使用者能吸收變革的步調。
- **Step 3**：強化 IDP 以治理與監控 AI SWE agent（p.13）。

### Phase 3：以自主交付實現零摩擦 SDLC（p.14–p.18）

- **Step 1**：實作自主自我改善迴圈。兩個早期跡象：vibe coding 平台（prompt-to-app）、自主工作負載最佳化（p.14）。
  - 兩者共同點：人類工作從**命令式（how）轉向宣告式（what）**；先例是 GitOps。自主軟體交付把 GitOps 的理念提升到整個 SDLC（p.14–15）。
- **Step 2**：擴充平台以支援自主交付與維運——自助式 AI 工具、Augmented FinOps、Augmented SRE（p.15–16）。
  - 預測：到 2029 年，60% 的 SRE 會把例行事故與事後檢討工作交給 AI agent，較 2025 年的 5% 大幅提升（p.16）。
- **Step 3**：依業務關鍵性、可接受風險、架構複雜度實施適當的人工監督（p.16）。

---

## 4. IDP 四大支柱（p.13–14）

平台工程團隊可從四個面向強化 IDP 以支援 AI agent：

| 支柱 | 原文定義 |
|---|---|
| **Guardrails** | 透過透明的資料記錄確保合規，並藉由阻擋無效請求保護系統 |
| **Credential management** | 集中管理 API key、支援 secrets manager，以實現安全的存取控制與存取路徑監控 |
| **Sandboxed environments** | 提供安全隔離的基礎設施以執行 AI agent 與 AI 生成的程式碼，使測試、評估、部署得以安全進行 |
| **Cost management** | 監控 AI 資源與推論成本，對異常支出模式發出告警 |

IDP 同時作為**設定與定期更新 guardrail 的規模化機制**：阻止 agent 呼叫未核准的工具，同時透過型錄與預建整合（模型型錄、MCP server 型錄、AI 工程工具）讓核准的工具更易於使用（p.13）。

**對本專案的意義**：這四項是 `05-guardrails-governance.md` 的章節骨架，且每一項都必須對應到具體的 DSH 設定或 Backstage 元件。

---

## 5. 自主性階梯與治理挑戰（Figure 9, p.13）

隨著自動化程度與複雜度上升：

| 層級 | 特性 | 對應治理挑戰 |
|---|---|---|
| **AI assistants** | 規則式任務，低自主性 | 究責與 guardrails |
| **Simple AI agents** | 專門化、任務特定、自主 | 互通性、可靠性與評估 |
| **Collaborative AI agents** | 跨多個任務專用 agent 協調，高能動性 | 編排與互動造成的**複合風險** |
| **AI agent ecosystems** | 跨多應用與組織協作 | 行為、協調、合規與**共謀（collusion）** |

圖中結論語：**「Agents are new insiders.」**（agent 是新的內部人）

**對本專案的意義**：這是 `05-guardrails-governance.md` 分級治理表的依據，也是架構決策 D4「雙層 guardrail」的直接理由——內部人風險不能只靠單層防護。

---

## 6. 人工監督的三軸判準（Figure 11, p.17）

三個因素構成滑動尺度，決定監督強度：

| 軸 | 低端 | 高端 |
|---|---|---|
| **Business criticality** | Tactical（戰術性） | Strategic（戰略性） |
| **Risk profile** | Low | High |
| **Complexity** | Low | High |

- **左端（低）→ human ON the loop**：允許更大自主性、需要較少人工監督。範例：內部 DevOps 工具、業務賦能應用。
- **右端（高）→ human IN the loop**：自主性較低、需要更多人工監督。範例：面向客戶的應用、構成核心競爭優勢的應用。

**定義區分（p.16）**：
- **Human in the loop**：agent 執行決策**前**需要明確、持續的人工核准。
- **Human on the loop**：agent 自主執行，人類監督，僅在例外、異常或告警時介入。

### 適用 human ON the loop 的範例（p.17）
- 內部業務賦能應用
- 小型 bug 修復、相依套件更新、設定變更
- 全庫重構以修正程式碼異味或替換已棄用的函式/API
- 產生程式碼與架構文件
- 產生單元測試套件、測試案例或測試資料
- 自主工作負載最佳化（預測自動擴縮需求、rightsizing 建議、依流量模式自動設定）

### 適用 human IN the loop 的範例（p.18）
- 策略性活動：產品管理、功能優先排序、理解複雜使用者需求、軟體架構
- 建構構成核心智慧財產的業務關鍵軟體
- 處理財務計算、敏感資料或**授權邏輯**相關程式碼
- 設計影響 systems of record 或共用模組的新功能與架構變更
- 驗證業務關鍵或安全關鍵用途的 AI 生成解法

**對本專案的意義**：`06-human-oversight-policy.md` 會把這個「滑動尺度」轉譯為機械可判定的計分規則。原文提供的是判斷方向，不是可執行規則——補上這一層是本專案的設計工作。

---

## 7. 三大警示（Cautions, p.4）

| 警示 | 原文重點 | 本專案的因應（詳見各文件） |
|---|---|---|
| **安全風險升高** | 強化基本安全衛生，並依業務關鍵性、可接受風險門檻、架構複雜度實施相應的人工監督 | `05` 雙層 guardrail、`06` 監督分級 |
| **效力「轉移」而非「節省」** | 別只聚焦編碼效率——開發者花更多時間在規劃、設計、架構、測試等非編碼工作。只優化編碼的風險是：開發期省下的時間，被更大的 code review 待辦積壓抵銷 | `07` stacked PR 縮小審查單元、`08` 納入 PR 大小與審查等待時間指標 |
| **技能退化** | AI 依賴侵蝕獨立判斷力，當工具失效或不可用時反而損害生產力；須持續發展核心工程與批判思考能力 | `06` 高風險類別維持人工主導、review 為必修 |

---

## 8. 成功衡量的原則（p.18–19）

必須超越傳統的**產出型生產力指標**（聚焦交付效率），納入**成果型創造力指標**（聚焦從構想、實驗、策略影響中擷取價值），以確保 AI 省下的時間**再投資於打造新穎且差異化的解法**。

原文特別指出：上游創造性活動（需求蒐集、使用者故事撰寫、構想發想）帶來的轉型影響大於單純的生產力改善。

Vizient 案例顯示：成功擷取價值需要領導者刻意「共同設計」人機關係，賦權員工實驗**個人化、角色導向的指標**，而非強加可能無法反映實際價值創造的生產力度量（p.19）。

**對本專案的意義**：`08-metrics-kpi.md` 採雙軌指標，且明文警告勿只優化產出型指標。

---

## 9. 策略規劃假設（p.2）

原文列出的預測，作為本專案的時程參考背景：

- 到 **2028** 年，非同步 SWE agent 工作流將使軟體工程團隊生產力提升 **30%–50%**，遠超 2025 年 AI code assistant 的 0%–20%。
- 到 **2027** 年，運用 AI 增強 SDLC 每個階段的平台工程團隊比例，將從不到 5% 增加到 **40%**。
- 到 **2028** 年，AI agent 與 assistant 將修補 **70%** 的軟體程式碼漏洞（透過更新相依套件或建議修正），較目前的 10% 大幅提升。

---

## 10. 本文件未涵蓋的原文內容

為聚焦於設計依據，以下原文內容未摘錄，需要時請查閱原始 PDF：

- Figure 4/5（p.8）：AI 增強使用案例與工具廠商清單。本專案的工具選型已由使用者決定（Backstage + DSH + GitHub），故不採用原文的廠商列表。
- Figure 12（p.19）：Vizient 讓員工共創工作未來的早期成果數據。
- 原文推薦的其他 Gartner 研究清單（p.20）。

---

## 未決事項

| 編號 | 事項 | 說明 |
|---|---|---|
| Q00-1 | 原文 Figure 1、2、6、7、8、10 為概念示意圖，本文件以文字轉述其結論而未逐圖描述 | 若後續設計需要精確引用某圖，需回查原始 PDF 對應頁 |
| Q00-2 | 原文的量化預測（§9）是否作為本專案的成功門檻 | 建議**不**直接採用為 KPI 目標值；本專案應以自身基線為準（見 `08-metrics-kpi.md`） |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
