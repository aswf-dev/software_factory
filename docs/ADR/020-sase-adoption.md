# ADR-020：SASE 方法論的採用範圍與不採用理由

- **狀態**：已接受
- **日期**：2026-10-09
- **決定者**：平台架構（使用者經 grilling 逐項裁決，共 5 輪）
- **對應**：`docs/research/sase-adoption-analysis-2026-10-09.md`（完整分析與對照表）、`ADR-010`（多 agent，CRP 隨其觸發條件）、`ADR-005`（自主性上限，ACE 的邊界）、`Q03-6`（Backstage 降級凍結）、`ADR-019` R3（新增表單欄位的同步成本先例）、`docs/18`（G4／G6，MRP 的既有歸屬）
- **證據**：`docs/research/228`（#199 根因）、`docs/15`（試跑紀錄與教訓）、`docs/18`（silent failure 補強）、`docs/25`（技能撰寫迴圈）、`ADR-011`（模型鏈與逾時宣告）、`.factory/skill-gap-recovery/`（三次證據遺失）

## 脈絡

arXiv 2509.06216v3《Agentic Software Engineering: Foundational Pillars and a Research Roadmap》以裁併文形式進入 `docs/research/`。它提出 Structured Agentic Software Engineering（SASE）：以 ACE／AEE 兩個專用工作臺取代傳統 IDE，並以六類 version-controlled artifact（BriefingScript、LoopScript、MentorScript、CRP、MRP、VCR）承載人機之間的結構化對話。

問題是：**SASE 的提議是否構成本專案必須補的缺口？**

三個限制條件使這個問題不能靠「框架完整度」回答：

1. **本專案的設計依據是 Gartner G00843405**（`docs/00-source-summary.md`），且該文件明文把來源研究「凍結」成後續所有設計文件共用的詞彙與框架，要求「後續文件引用本研究時，一律回指本文件的節次編號」。SASE 的四支柱（actors／processes／tools／artifacts）與 Gartner 的四支柱（Guardrails／Credential management／Sandboxed environments／Cost management）**沒有血緣關係**；並存會製造雙詞彙體系。
2. **本專案已有 19 份 ADR（本 ADR 為第 20 份）、34 份 docs、1,834 則測試、2 個試點 repo 的實證基礎**，且多數 SASE 機制已有功能對應物（見 `research/sase-adoption-analysis-2026-10-09.md` §2.1）。
3. **本專案對「未驗證的主張」有明文紀律**：`docs/10-open-questions.md` §1.3 寫「這些數值若憑空設定，只有兩種結果——過嚴（頻繁誤擋）或過鬆（形同虛設）」。同一紀律適用於「要不要新增機制」：**沒有觀測證據支持的機制不導入**。

因此本 ADR 的判準是**已觀測痛點驅動**：只有能關閉一個已有觀測證據支持之缺口的機制才採用。證據分三級：E1 已完成根因調查的具名事件、E2 具名實證事件、E3 現行手段的結構性事實。

## 決策

### 1. SASE 不作為本專案的設計依據

SASE 僅作為**對照組**留存於 `docs/research/`，並在 `docs/GLOSSARY.md` §10 建立**單向詞彙對照**（工廠用語 → SASE 用語）。該表必須明寫「不作為設計依據；後續文件引用設計理由時，一律回指 `docs/00` 的 Gartner 節次，不得回指 SASE 論文節次」。

### 2. 逐項裁決

| SASE 項 | 裁決 | 決定性依據 |
|---|---|---|
| **ACE** 雙工作臺 | **不採用** | `Q03-6` 已裁決 Backstage 降級為純 GitHub 觸發、工件凍結；本 repo 為單人環境，無 N-to-N 指揮中心使用者（`Q12-4`）。SASE 的 ACE 會逆轉該裁決 |
| **AEE／ATIE** agent-native 工具鏈與 MCP | **不採用** | repo 零 MCP（無 `.mcp.json`，`config/dsh/` 無 MCP 設定）；無證據顯示 grep／文字搜尋造成失敗 |
| 論文**研究議程與教育**章節（§7.6、§3.3 benchmark） | **不採用** | 非生產系統範圍 |
| **N-version** 平行多版本 | **不採用** | token 預算門檻至今仍為 0＝不設限（`docs/10` L82），成本基線不存在；Anthropic 429 已是既有外部限制（`docs/13` L61），平行化會加劇 |
| **LoopScript** | **不採用** | 其核心主張（依任務分量宣告嚴謹度與資源）**已由非 SASE 手段實現**：`task_type` 分類 ＋ `risk-paths.yml` H1–H7 ＋ 三軸評分 ＋ `model-tiers.yaml` ＋ 本 ADR 家族中的 `ADR-011` 逾時宣告。最大單筆全損（50 分鐘／19.4M token／USD $0.306／0 commit／0 PR）**是靠宣告修好的**（`ADR-011` L51–55）。`factory-run.yml` 與 `runWorkItem` 的編排重複列為**工程觀察**（見「後果／中性」） |
| **CRP** 結構化徵詢 | **不採用**，隨 `ADR-010` 觸發條件一併重啟 | 兩次自然停手被判定「誠實且正確」（`docs/15` L148–149、`docs/13` L35）；#199 的重建成本源自 `apply-judge-labels` **契約缺口**（`docs/research/228` L18）；CRP 是多角色路由機制，單人環境無人可路由 |
| **BriefingScript** | **方向接受**，實作待另案開單（規格見 §3） | `docs/15` L150–152（人類寫的驗收標準數學上不可能滿足）、`.factory/skill-gap-recovery/camunda_hazelcast-25.md` L27（DoD 未補專有驗收條目 → 反覆停手）、`docs/14` L71–80（180 顆 PR、`defect/*` 0 筆，判讀為「感測器未運作」） |
| **MentorScript** | **延後**，併入 **Q20-SASE-1** 一起評估 | 增量＝規則**內容**驗證（`skills-lock.json` 只鎖 sha256，故「內容本身是錯的」完全通過驗證）；現行替代＝`docs/25` skill 撰寫迴圈。兩者的增量是同一件事（把人工迴圈機械化），拆兩個開關會讓同一件事有兩個門檻 |
| **MRP** | **部分已涵蓋**：引用 `docs/18` G4／G6，不重複開單；只為**保存期限與凍結追溯**新增 **Q20-SASE-2** | 證據最強（`ADR-011` L16「該次失敗的確切原因無法回溯」；judge/labels 崩潰三次，唯一證據只存於 ~90 天過期的 artifact，`docs/25` L160）；但「證據的真實性」已由 G4（紅燈 absence 未成為 evidence）與 G6（tests pass 只有自述）涵蓋。SASE 新增的部分僅為「證據會不會消失」 |
| **ATLE** 持久記憶 | **延後**，綁 **Q20-SASE-1** | 重複性實證：同型終態衝突「**100% 復發**」（`docs/research/228` L205–207）、opus 兩次自創 report 欄位（`docs/25` L194–196）、judge/labels 在兩個 repo 同型崩潰 |

### 3. BriefingScript 增量的範圍（工項規格，尚未開單）

本節記錄的是**規格**，不是承諾。開單與否由使用者決定；本 ADR 的分析交付止於此，**不建立 Issue、不觸發任何 agent 執行**。

三項增量，**全部落在既有 `需求描述（PRD）` textarea 內的新子段，不新增 `###` 表單欄位**：

1. **可驗證 DoD 硬閘門**：把 `src/cli/factory-issue-check.ts` 既有的 `VAGUE_TERMS`（L104–120）、`OBSERVABLE_PATTERNS`（L126–131）、`checkDodSpecificity`（L196–206）由**建議**升級為**影響 `ok`**（現行 `ok` 只看 `missing`、`spec.errors`、`pbtAudit.errors`、`pbtOutsideAudit`，L659–663）。
2. **`不變量：` PRD 子段**：沿用 `ADR-018` 的 `INV_*` 模式，可指向 `specs/<name>/*.qnt`。
3. **`已知問題 / 專有驗收條目：` PRD 子段**：對應「DoD 未補專有驗收條目 → 反覆停手」。

不新增表單欄位的理由是本 repo 自己的先例：`ADR-019` R3（L245）記載「新增欄位要同步 6 處（含 aswf.dev），機械檢查強度相同」，並因而刻意改用既有子段。**不得放寬**既有契約：DoD 三勾選 3/3 全勾（`DOD_LABELS` L66–70、L619–623）與 `agent-pbt-audit` 的「目標模組 / 檔案：」恰好一個路徑（`src/pbt-audit/intake.ts` L135、L140）。

## 觸發條件

以下三條為**可觀測事件**，非臆測數值。任一成立即開新 Issue 重啟評估並修訂本 ADR。在此之前，這些機制是**意識性不做**，不是遺漏。

| 編號 | 觸發條件（可觀測事件） | 登錄位置 |
|---|---|---|
| **Q20-SASE-1** | ATLE 持久記憶（併同 MentorScript 規則內容驗證增量）：**同一缺口類別跨兩個觀察期未收斂，或人工提案處理量超過協商門檻**。觀測來源為 `docs/25` 的技能缺口迴圈負荷。 | `docs/10-open-questions.md` §1.3 |
| **Q20-SASE-2** | MRP 證據保存期限與凍結追溯：**再次發生「失敗原因無法回溯」或「證據僅存於會過期的 artifact」**。前例為 run 36838600120（`ADR-011` L16）與三次 judge/labels 崩潰（`.factory/skill-gap-recovery/*` L3–6）。 | `docs/10-open-questions.md` §1.4 |
| **Q20-SASE-3** | 本決策自身：**出現公開的 SASE 實作案例、或論文修訂／正式發表**。論文目前為 arXiv 預印本（v3），評估基礎可能改變。 | `docs/10-open-questions.md` §1.4 |

> 現況：**0/3 成立 → 維持不採用。**

## SASE 未涵蓋而工廠已有

本節是「為何未採用」的核心論證，依 `docs/ADR/README.md`「為何未採用替代方案，因為那通常比決策本身更有資訊量」。

**SASE 全篇未提下列機制，而本專案已在運作**——其中包含本專案最核心的信任來源：

| 工廠機制 | 引註 |
|---|---|
| 三軸監督評分為**機械可判定閘門**，且有形式化模型 ＋ Apalache 不變量驗證 ＋ TS↔Quint oracle test | `src/scoring/`、`specs/scoring/score.qnt`、`test/quint/scoring-oracle.test.ts`、`ADR-008` |
| `report.json` 對 git diff 的**獨立交叉驗證**（`no-trace`、`unreported-changes`、`reported-not-in-diff`、`assertion-delta-*` 等 mismatch kinds） | `docs/18` L60–138、`src/cli/factory-crosscheck.ts` |
| `REQ-N` 對 `requirements[]` 的覆蓋檢查 | `src/cli/factory-issue-check.ts` L258–260、`docs/32` L72 |
| SR1–SR8 stop rules（agent 唯一的合法退出路徑） | `.dsh/skills/factory-stop-rules/SKILL.md`、`docs/04` L287 |
| 雙層 guardrail（DSH 層 ＋ GitHub 層） | `ADR-004`、`config/dsh/factory-guardrail.patch.yml` |
| **10 個模組要求 100% 分支覆蓋率**（scoring／stop-rules／pipeline／cli／model-tier 等） | `vitest.config.ts` L11–105 |
| `skills-lock.json` 雜湊鎖版 ＋ `--verify` fail-closed | `config/factory/skills-lock.json`、`src/cli/factory-skills-lock.ts` |
| G1 terminal-state guard（任何先前步驟崩潰即回填 `needs-human`） | `docs/18` |

**含義**：若以「框架完整度」為判準，會得出「本專案缺 6 項 SASE 機制」的結論；但同一份對照顯示 **SASE 也缺 9 項本專案機制**。判準若不是「已觀測痛點」，這個對照會系統性偏向論文。

## 後果

### 正面

- 「不採用」變成**有引註的立場**，而非預設。未來有人問「為什麼不用 SASE」時，答案是一份含證據分級的對照表，不是一句「不需要」。
- 雙詞彙漂移的風險被明文封住：`docs/00` 的凍結規則不變，SASE 只出現在 `docs/research/` 與 `GLOSSARY` §10。
- 3 個真正未解的問題從「不知道」變成「有門檻」：記憶與規則內容驗證、證據保存期限、本決策重啟。
- 唯一通過判準且有實作價值的增量（工單精確性）取得獨立工項，不再混在方法論討論裡。

### 負面

- CRP 與 N-version 的立場與論文相反。若 SASE 日後出現實作案例並證明其價值，需回頭重評（已由 Q20-SASE-3 承擔）。
- LoopScript 被降級為「工程觀察」而非方法論工作，意味著 `factory-run.yml`（1,332 行）與 `runWorkItem` 純函式的編排重複**不在任何工項的範圍內**。這是刻意接受的技術債：無事故歸因。
- MentorScript 與 ATLE 合併為單一觸發條件，代價是歸因模糊——若未來只有「規則內容驗證」需要而記憶不需要，拆分需重新評估。

### 中性

- 新增一份研究文件與 3 個 open question；`docs/10-open-questions.md` 的統計數字需標註未重算（依該檔既有做法）。
- 編排重複（workflow vs 純函式）被記錄為工程觀察，屬於既有事實的重新表述，非新增債務。
- 本 ADR 不處理 `docs/research/awslabs:aidlc-workflows-integration-2026-10-08.md`（同型的 AIDLC 提案，目前未被任何文件引用）。本專案仍**沒有**「外部方法論提案」的通用分流機制；本 ADR 是第一次此類裁決，但未建立通用程序。

## 替代方案

- **全面導入 SASE（ACE／AEE ＋ 六類 artifact）**：與 `Q03-6`、`ADR-005`、`ADR-010` 直接衝突；且多數機制已有功能對應物，導入成本換不到相應的信任增益。未採用。
- **以 SASE 取代 Gartner 作為框架來源**：三軸評分（business criticality／risk profile／complexity）與監督分級在 Gartner 的監督三軸上有直接血緣；換掉等於重做地基並重驗所有回指節次的文件。未採用。
- **全部不採用，且不留對照與觸發條件**：零成本，但失去對外文獻對話能力，且同一問題會被重新提起——`docs/research/` 已存在一份無人引用的同型提案即為前例。未採用。
- **把 AIDLC 提案一併納入本次分流**：範圍較大且 AIDLC 為 NotebookLM 匯出、引註流失、未經一手驗證，與 SASE 的信度等級不同，混在一起會拉低本次裁決的證據標準。本次使用者裁決只評 SASE。未採用（可另案）。
- **以 token 預算設限作為 N-version 的前置條件**：方向正確，但 `docs/10` L82 已記載門檻值待基線數據；在門檻設定前評估 N-version 無意義。故列不採用而非延後。

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q20-SASE-1 | ATLE 持久記憶（含 MentorScript 規則內容驗證增量） | 列觸發條件（見上）；登錄於 `docs/10-open-questions.md` §1.3 |
| Q20-SASE-2 | MRP 證據保存期限與凍結追溯 | 列觸發條件；登錄於 `docs/10-open-questions.md` §1.4 |
| Q20-SASE-3 | 本決策自身的重新檢視 | 列觸發條件；登錄於 `docs/10-open-questions.md` §1.4 |

> 本 ADR 的觸發條件細節為**來源**，`docs/10-open-questions.md` 為索引。修改時先改本文件，再同步索引（依 `docs/10` §3 維護規則）。
