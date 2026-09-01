# 21 — 候選工作類型清單（未完成，逐步完善）

> **用途**：收攏「適合加入軟體工廠但尚未完成」的工作類型候選，含評估、前置條件、紅線與排序建議。**本文件是活文件**——候選增減、試點結果、裁決都先更新此處，再同步 `docs/20` §7（延後項目）與 `docs/10`（未決事項）。
> **依據**：`docs/19` §6.2（候選類型）、§6.6（共識修正）、`docs/20` §7（延後項目）；2026-09-01 C1 試點（T1/T2/T3）後修訂。
> **讀者**：決定「下一個工作類型做什麼」的人。

---

## 1. 現況：5 型已完成

| 類型 | 狀態 |
|---|---|
| agent-add-tests / agent-fix-bug / agent-update-deps / agent-write-docs | ✅ 既有四型 |
| **agent-analyze**（C1） | ✅ 已完成並試點驗證（#227＋T1/T2/T3；in-loop 僅分析模式、報告品質佳） |

**新增一型的機制已成熟**（C1 試點實測補修後）：

| # | 接線 | 備註 |
|---|---|---|
| 1 | `.github/ISSUE_TEMPLATE/factory-work-item.yml` 下拉 | |
| 2 | `.github/workflows/factory-run.yml` options 陣列 | |
| 3 | `.github/factory/task-template-<type>.txt` | 缺檔 fallback＋`::warning::` |
| 4 | `.dsh/skills/factory-workflow/SKILL.md` 任務型別分支 | |
| 5 | `test/adversarial/factory-assets.test.ts` 釘死清單 | 5→6 型 |
| 6 | **`backstage/templates/factory-work-item/template.yaml` enum** | ⚠️ **#238 漂移教訓**——凍結工件仍是宣告入口 |
| 7 | `config/dsh/model-tiers.yaml` 路由（auto 依複雜度） | |
| 8 | `docs/07` 拆分規則＋`docs/09` 路由說明 | |

**類型級限制機制**（`docs/06` §4.1 條件清單）：計分與任務類型正交（`task_type` 不進計分）——語意風險類型的**唯一施力點**是條件清單加類型級限制。

---

## 2. 候選類型詳表（全部未完成）

### 2.1 `agent-write-spec`（規格/設計草稿）— P1

| 面向 | 內容 |
|---|---|
| 定義 | 產出規格/設計草稿（前瞻文件：需求釐清、方案設計、驗收條件草案），**不產程式碼**；人類審查後才成為實作工作項的輸入 |
| 依據 | `docs/00` §3 Phase 2 Step 1 spec-driven development；`docs/01` §2.1「agent 產規格草稿」已合法；SWEBOK Ch1 §4、Ch3 §4.6 |
| 風險 | **產出物低／流程位置高**（`docs/19` §6.6 第 3 點）——語意正確性無自動機制可驗證（G3 是誠實性檢查非正確性檢查）、錯誤被下游放大（一份誤解規格 → 多個正確實作的錯誤東西） |
| 前置條件 | **四護欄**：①產出標記 draft ②類型級禁自動合併（docs/06 §4.1）③`spec/approved` 標籤 ④DoD 含未決事項 |
| 為何未完成 | Q19-2 裁決「analyze 先、其餘後議」；護欄是流程約束（需人類紀律）非機械約束 |
| 與 analyze 互補 | analyze 描述現況（有客觀事實對照）、write-spec 描述未來（無對照基準）——analyze 試點已證明報告型機制可行 |

### 2.2 `agent-refactor`（重構）— P1

| 面向 | 內容 |
|---|---|
| 定義 | 行為保持的重構（code smell、取代棄用 API），characterization tests 先釘住行為再重構 |
| 依據 | `docs/00` §3 Phase 2 Step 1 明列「重構程式碼異味」；`docs/06` §4.2 on-the-loop 清單；SWEBOK Ch7 §4.2 |
| 風險 | 中——動共用抽象（H4）自動落入人類審查；行為保持需機械證明（重構前後測試全綠） |
| 前置條件 | **新的拆分規則**（第一個需要新 stacking 的類型）：01-test（characterization）→ 02-impl（重構）→ 03-docs |
| 為何未完成 | 原裁決順序「analyze → refactor」；第一個需要新拆分規則的類型，原建議等路徑走順——C1 後路徑已走順，前置條件成熟 |

### 2.3 `agent-security-fix`（安全漏洞修補）— P1

| 面向 | 內容 |
|---|---|
| 定義 | 安全漏洞修補（依 Dependabot/掃描結果），DoD 附 CVE/CWE 引用 |
| 依據 | `docs/00` §3 Phase 2 Step 1「自動修補安全漏洞」；§9「2028 年修補 70% 漏洞」預測；SWEBOK Ch13 §4.6 |
| 風險 | **中高且特殊**：路徑式計分對語意風險系統性偏弱（`docs/19` §6.6 第 4 點）——SQLi 修補可落在不命中任何 H 規則的路徑、計分低至 0–1 |
| 前置條件 | **類型級限制**（`docs/06` §4.1 加「security-fix 一律人類審查，無論計分」）——需先修改政策＋對應測試 |
| 為何未完成 | 需要政策變更（非純接線）；試點教訓確認「語意風險只能靠類型級限制」但尚未落地為規則 |

### 2.4 `agent-migrate`（框架/API/語言遷移）— P2

| 面向 | 內容 |
|---|---|
| 定義 | 大範圍遷移（框架/API/語言）；`docs/06` §4.2「替換已棄用函式/API」 |
| 風險/前置 | 範圍太大，docs/07 拆分規則需重新設計（非單一拆分可涵蓋） |
| 為何未完成 | 高複雜度、需架構層裁決——建議觀察期後再評估 |

### 2.5 `agent-release-notes`（CHANGELOG/release notes）— P2

| 面向 | 內容 |
|---|---|
| 定義 | 從合併歷史產出 CHANGELOG/release notes（SWEBOK Ch8 §6.2） |
| 前置條件 | 需先有**釋出管理流程**（P1-1：semver tag＋CHANGELOG 慣例）——否則無產出對象 |
| 為何未完成 | P1-1（釋出管理）仍在「逐項後議」清單 |

---

## 3. 紅線（不適合加入，理由不變）

| 候選 | 為何不行 |
|---|---|
| `agent-ci-fix`／`agent-guardrail-update` | SR3＋H5＋D6 App 權限（無 Administration/Workflows）——雙層防護的核心 |
| `agent-review-own` | `docs/06` §4.3 禁止 agent 驗證自己的產出並據以放行 |
| `agent-architect-decision` | `docs/00` §6 架構屬 human-in-the-loop；agent 只能產草稿（write-spec），不能決策 |
| `agent-incident-fix` | D5 自主性上限明確排除；`docs/06` §7.1「緊急不放寬，移除 agent」 |
| `agent-auto-review` | ⚠️ 灰色：dogfooding 情境下工廠審查自己產出＝自我驗證循環；若要開放僅限審查非 agent 產出、僅供人類參考 |

---

## 4. 排序建議（Q21-1 待裁決）

| 順位 | 類型 | 理由 | 需先裁決 |
|---|---|---|---|
| **1** | `agent-refactor` | 原裁決順序「analyze → refactor」下一棒；授權最充分；characterization 拆分技術明確；路徑已走順 | 拆分規則設計（重構前後全綠＋無行為變更的驗收語意） |
| **2** | `agent-write-spec` | 填補 Validation 缺口（`docs/19` 指「流水線完全沒防護的一面」）；與 analyze 共用報告型機制；機制負擔比 refactor 小（單層、無新拆分） | 四護欄落地形式（draft 標記慣例、spec-approved 標籤） |
| **3** | `agent-security-fix` | 高價值（2028 預測）但需政策先行 | `docs/06` §4.1 類型級限制（政策變更） |
| 4–5 | `agent-migrate`、`agent-release-notes` | P2，依賴釋出管理與觀察期數據 | 釋出管理（P1-1）先裁 |

> **替代選項**：若 Validation 缺口優先，可把 `agent-write-spec` 提到第一順位——機制負擔小，難點在人類紀律（四護欄）。

---

## 5. 逐步完善的節奏

| 時機 | 動作 |
|---|---|
| 新類型進入候選（試點衍生、SWEBOK 對照新發現） | 更新本文件候選表 |
| Q21 裁決 | 候選轉正為 `docs/20` 工項（比照 C1 流程：開 Issue→八處接線→對抗性測試→試點） |
| 觀察期（docs/14）數據累積 | 校準排序建議與前置條件 |
| 候選被否決 | 移入 §3 紅線（附理由） |

---

## 未決事項

| 編號 | 事項 | 需要誰決定 |
|---|---|---|
| Q21-1 | 下一型選哪個：`agent-refactor`（原順序）｜`agent-write-spec`（Validation 優先）｜`agent-security-fix`（需政策先行） | 使用者 |
| Q21-2 | 若選 write-spec：「類型級禁自動合併」是否立即納入（涉及 docs/06 §4.1 政策變更） | 使用者 |
| Q21-3 | 若選 refactor：characterization 拆分規則的驗收語意是否照 docs/19 §6.2 設計 | 使用者 |
| Q21-4 | 類型擴充是否等觀察期數據（docs/14）再裁，還是不受阻塞 | 使用者 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
