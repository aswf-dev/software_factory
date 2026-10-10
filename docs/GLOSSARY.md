# 詞彙表

> **用途**：統一全部文件的用語，避免同一概念出現多種說法造成誤解。
> **規則**：新文件一律採用本表的「標準用語」；若必須使用變體（如 GitHub 標籤），須在本表登錄。

---

## 1. 核心概念

| 標準用語 | 英文 | 定義 | 定義出處 |
|---|---|---|---|
| **工作項** | work item | 從 Request 到 Delivery 的一個可獨立交付的變更。本專案中等同一個 GitHub Issue | `01` §1.1 |
| **價值流** | value stream | 工作項流經的完整路徑，共六階段 | `00` §2 |
| **Lead Time** | — | Issue 建立 → PR 合併的 wall-clock 時間，**包含等待** | `01` §1.1 |
| **Process Time** | — | 實際作業時間，**不含等待** | `01` §1.1 |
| **閒置比** | idle ratio | (Lead Time − Process Time) / Lead Time | `08` §2.1 |
| **paved road** | — | IDP 提供的、刻意設計的標準路徑 | `00` §3 Phase 1 |
| **數位指揮家** | digital conductor | 人類的新角色：編排 agent、表達意圖，並對產出負最終責任 | `00` §3 Phase 2 |

## 2. 價值流六階段（順序固定，不可改寫）

```
Plan → Create → Verify → Release → Configure → Operate
```

各階段的處置判定見 `01` §5。**文件中一律使用英文階段名**，不譯。

## 3. 監督層級（易混淆，請特別注意）

| 標準用語 | 定義 | 允許的變體 | 變體使用場合 |
|---|---|---|---|
| **human on the loop** | agent 自主執行，人類監督，僅在例外、異常或告警時介入 | `on-the-loop`、`oversight/on-loop` | 行文簡稱／GitHub 標籤 |
| **human in the loop** | agent 執行決策**前**需要明確、持續的人工核准 | `in-the-loop`、`oversight/in-loop` | 行文簡稱／GitHub 標籤 |

### 三個 GitHub 標籤（對應 `06` §4 的三個計分區間）

| 標籤 | 計分 | 意義 |
|---|---|---|
| `oversight/on-loop` | 0–1 | agent 可建立 PR 並自動合併（須另符合 `06` §4.1 全部條件） |
| `oversight/review` | 2–4 | agent 可建立 PR，**不得合併**；需人類逐一審查核准 |
| `oversight/in-loop` | 5–6 | agent **不得實作**，僅可產出分析與方案 |

> **注意**：中間區間（2–4）的標籤名為 `oversight/review`，它**不是** `00` §6 原文的兩分法用語，而是本專案為「需人類審查但仍可由 agent 產出」這個中間狀態新增的第三檔。原文只區分 in/on the loop 兩級；本專案細分為三級，是刻意的設計補充。

> **定義出處**：`00` §6（原文定義）。**兩者僅一字之差但意義相反**，撰寫時務必確認。
>
> **GitHub 標籤採用不帶 `the` 的短形式**（`oversight/on-loop`、`oversight/in-loop`），因標籤需簡短；文件內敘述則用完整形式。

### 監督分級的三軸（`06` §3）

| 標準用語 | 英文 | annotation |
|---|---|---|
| **業務關鍵性** | business criticality | `factory.io/business-criticality` |
| **風險輪廓** | risk profile | `factory.io/risk-profile` |
| **架構複雜度** | complexity | `factory.io/complexity` |

## 4. 四個平面（`02` §1）

| 標準用語 | 承載元件 | 職責 |
|---|---|---|
| **IDP 入口** | Backstage | 自助觸發與展示 |
| **Control Plane** | GitHub | 狀態、觸發、閘門、稽核 |
| **Execution Plane** | DSH | 受限環境中執行任務 |
| **Delivery Plane** | gh stack | 組織為可審查的 PR 疊 |

## 5. IDP 四大支柱（`00` §4，順序固定）

1. **Guardrails**（護欄）
2. **Credential management**（憑證管理）
3. **Sandboxed environments**（沙箱環境）
4. **Cost management**（成本管理）

> 引用時一律使用英文原名或上述固定譯名，避免出現「防護欄」「密鑰管理」等變體。

## 6. 工廠專有名詞

| 標準用語 | 定義 | 出處 |
|---|---|---|
| **停手規則** | agent 必須停止並交還人類的條件 | `04` §3.3 |
| **`needs-human`** | agent 唯一的合法退出路徑（GitHub 標籤） | `02` §3.2 |
| **二次判定** | PR 建立後以實際 diff 重新計分，**只升不降** | `06` §5.3 |
| **風險硬性規則** | 觸及即判定 risk=2 的路徑類別（H1–H7） | `06` §3.2 |
| **PR 疊** | 一個工作項拆成的有序小 PR 集合 | `07` §2.1 |
| **單向棘輪** | 條件只能收緊不能放寬的設計模式 | `06` §4.1 |
| **規模等級** | 棕地系統的小型／中型／大型分級，以系統為單位；**只決定導入流程，不進入監督計分** | `29` §4 |
| **就緒度** | 模組的 R0／R1／R2 等級（建置可重現、CI、覆蓋率），決定該模組可開的工作項類型 | `29` §5 |
| **導入階段** | 棕地導入的 P0 納管 → P1 現況分析 → P2 文件化 → P3 安全網 → P4 維護改善 → P5 演進 | `29` §6 |
| **人類閘門** | 棕地導入中必須由具名人類簽核的關卡（HG0–HG7） | `29` §8 |
| **驗證閘門** | P3 出口條件：核心模組通過 Quint 或 Hegel 驗證，或經人類簽核豁免 | `29` §10 |
| **導入追蹤 Issue** | 每個系統一張、不派工的普通 Issue，記錄所有人類閘門的簽核 | `29` §2 |

## 7. 指標分類（`08`）

| 標準用語 | 定義 | 用途 |
|---|---|---|
| **產出型指標** | 衡量工廠運作效率 | **診斷**（找瓶頸） |
| **成果型指標** | 衡量業務價值產出 | **判定成敗**（是否值得繼續） |

> **不要混用**「生產力指標」「效率指標」等變體。

## 8. 語言慣例

| 對象 | 語言 |
|---|---|
| 文件、規格、說明、註解 | 繁體中文 |
| 程式碼識別名、檔名、branch 名、commit message | 英文 |
| 技術專有名詞（Backstage、stacked PR、sandbox、guardrail 等） | 保留英文，不強譯 |

## 9. 常見的錯誤用法

| ❌ 避免 | ✅ 使用 | 原因 |
|---|---|---|
| 「AI 自動完成」 | 「agent 執行，人類審查」 | 避免暗示無人監督（違反 D5） |
| 「全自動化」 | 「on-the-loop 自動合併」 | 本專案不追求完全自主 |
| 「exit 0 代表成功」 | 「exit 0 代表回合正常結束」 | 不代表任務正確完成（`04` §4.2） |
| 「agent 判斷風險」 | 「CI 計分判定風險」 | agent 無權參與自身的風險判定（`06` §5.1） |
| 「HG1 硬規則」「H1 閘門」 | 「人類閘門 HG1」／「風險硬性規則 H1」 | HG0–HG7 是人類簽核關卡（`29` §8），H1–H7 是風險路徑規則（`06` §3.2），兩者無關 |
| 「大型專案所以 complexity 加分」 | 「規模等級只決定導入流程」 | 規模等級與三軸計分正交（`29` §1.1） |

> 最後一列尤其重要：**agent 不判定自己的監督層級**。任何暗示 agent 有此權限的表述都與 `06` 的設計相牴觸。

## 10. SASE 方法論對照（僅供外部文獻對話）

下表為**單向對照**：左欄是本專案的標準用語，右欄是 arXiv 2509.06216v3（Structured Agentic Software Engineering, SASE）的對應用語。用途只有一個——與外部文獻對話時能互相指認。

| 工廠用語 | SASE 用語 | 關係 | 出處 |
|---|---|---|---|
| 工作項（GitHub Issue）＋ 需求描述（PRD）／驗收標準（DoD） | BriefingScript | 功能對應，型態不同（自由文字 vs 五段結構）。本專案已接受其增量方向，實作另開工項 | `.github/ISSUE_TEMPLATE/factory-work-item.yml`、`ADR-020` 決策 3 |
| `factory-run.yml` ＋ `task_type` ＋ `risk-paths.yml` ＋ 三軸評分 ＋ 逾時宣告 | LoopScript | 目的已達成（依任務宣告嚴謹度），但非宣告式語言。**不採用** | `ADR-011`、`ADR-020` 決策 2 |
| `.dsh/skills/*` ＋ `config/factory/skills-lock.json` ＋ `25` | MentorScript | 散文規則 ＋ 雜湊鎖版；**無內容驗證**（sha256 只鎖版本）。增量併入 Q20-SASE-1 | `25`、`ADR-016` |
| `report.json`／`judge.json`／`crosscheck.json`／`factory-run-<issue>` artifact | Merge-Readiness Pack | 證據分散；「真實性」已由 `18` G4／G6 涵蓋；**保存期限與凍結追溯**列 Q20-SASE-2 | `18`、`ADR-020` 決策 2 |
| `needs-human` ＋ `openQuestions[]` ＋ SR1–SR8 | Consultation Request Pack | 無結構化徵詢 artifact。**不採用**（隨 `ADR-010` 觸發條件重啟） | `.dsh/skills/factory-stop-rules/SKILL.md`、`ADR-020` 決策 2 |
| PR 核准 ＋ `spec/approved` ＋ `factory/approved` ＋ HG0–HG7 | Version Controlled Resolution | 無「與請求相連」的裁決 artifact；`spec/*` 標籤流已具兩階段人類裁決的形狀 | `29` §8、`28` §標籤表 |
| Backstage（已降級凍結）＋ DSH headless ＋ sandbox | ACE／AEE | 雙工作臺方向一致；ACE 部分已裁決「維運負擔不值得」 | `Q03-6`、`ADR-002` |
| （無對應） | ATLE／ATIE（持久記憶、agent-native 工具鏈） | 硬缺席。列 Q20-SASE-1（記憶）／ATIE 不採用 | `ADR-020` 決策 2 |
| （無對應） | N-version 平行多版本 | **不採用**（token 預算門檻仍未設定，無成本基線） | `10` L82、`ADR-020` 決策 2 |

> 本表**不作為設計依據**。後續文件引用設計理由時，一律回指 `docs/00-source-summary.md` 的 Gartner 節次，**不得回指 SASE 論文節次**——`00` 的凍結規則（§8）不因本表而改變。裁決理由見 `ADR-020`。
