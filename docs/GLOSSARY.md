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

> 最後一列尤其重要：**agent 不判定自己的監督層級**。任何暗示 agent 有此權限的表述都與 `06` 的設計相牴觸。
