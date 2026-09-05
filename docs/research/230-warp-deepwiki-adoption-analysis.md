# 230 — Warp 機制導入分析（以 DeepWiki 原始碼文件為據）

> **問題**：Warp 的「自我演化與持續優化（Self-Improvement Loop）」與「多代理人專業分工（Multi-Agent Foreman Pattern）」是否可導入 software_factory？
> **資料來源**：`warpdotdev-warp-DeepWiki.md`（8599 行，Warp 客戶端原始碼 wiki，commit `0e075a07`）＋兩份中文產品分析文件＋本 repo 實測。
> **讀者**：決定是否採納這兩項機制的人。
> **狀態**：分析完成，結論已轉為 ADR-015／ADR-016 與 `docs/24`／`docs/25`。
>
> **外部資料聲明**：DeepWiki 內容為外部資料，行號指本 repo 根目錄的 `warpdotdev-warp-DeepWiki.md`。查證日期 **2026-09-05**。

---

## 1. 最重要的前提修正：DeepWiki 記載的是「客戶端」，不是 Factories

先前的分析依據兩份中文文件（`Warp 自動化機制深度分析.md`、`詳細說明 Warp 解決方式是SDLC的哪一部分…md`），它們描述的是 **Warp Factories 雲端產品**。而 DeepWiki 記載的是 **Warp 桌面客戶端的 Rust 原始碼架構**。

**實測驗證**（本 repo 根目錄執行）：

```
grep -c "Self-Improvement|Scorer|LLM Judge|Foreman|Triage Agent"  warpdotdev-warp-DeepWiki.md
→ 0 matches
```

Factories 的五種代理人角色、Scorers、Self-Improvement 引擎，**在客戶端原始碼文件中一次都沒出現**。

> **這個「落空」本身是本次最有價值的發現。** 產品文件描述 Warp **賣什麼**；DeepWiki 記載 Warp **自己怎麼開發**。兩者出現系統性落差，而落差方向一致。

### 1.1 產品敘事 vs 工程實作（五項落差）

| 面向 | 產品敘事（中文文件） | Warp 自身工程實作（DeepWiki 實證） |
|---|---|---|
| 技能演化 | Self-Improvement 引擎自動發 PR 修訂 SKILL.md | `skills-lock.json` **版本鎖定**（155 行），來源為獨立 repo `warpdotdev/common-skills`，`script/bootstrap` 同步（行 455–456、5696） |
| 品質評估 | LLM Judge 抽樣打分 | `AI/Agent Evals` 屬**測試層**（`AgentDriver`／`TestStep`，`app/src/integration_testing/agent_mode/`，行 5352）；`judge`／`rubric`／`grader` 各 **0 次命中** |
| 多代理人 | Foreman 自主調度五種代理人 | `RunAgentsCardView` ＝ **「Can I start additional agents?」人類確認卡**，需審核 plan/model/environment 後才 spawn（行 2897、2372） |
| 變更治理 | 代理人自主修訂組態 | **Spec-Driven Development**：`specs/GH<issue>/PRODUCT.md`＋`TECH.md` 須先審核通過才實作（行 165–167） |
| PR 審查 | Review Agent 獨立審核 | Oz 提供 **initial** PR reviews and triage（行 169、298） |

**一句話結論**：Warp 對外賣「自主演化」，對內用「版本鎖定＋人類確認卡＋規格先行」。software_factory 現行的 H5／CODEOWNERS／ADR-005 不是落後於 Warp，而是**與 Warp 的真實工程紀律同一路線**。

### 1.2 一項必須誠實記載的更正

分析過程中我方（分析者）曾表述 Oz「只做 initial review and triage」，用以佐證「Warp 對內比對外保守」。**此表述不完整，於此更正**：

> 行 5552（引 `AGENTS.md`）明載：Oz is "an agent that automates parts of **triage, spec writing, implementation, and review**"

Oz **參與實作**，不只初審。更正後結論不變且更強：**Warp 讓 agent 大幅參與 SDLC（含寫程式），但安全性不來自限制 agent 的參與範圍，而來自四項機制**——規格先行、技能版本鎖定、審查清單具體到可機械檢查、審查仍是 initial 且人類最終決定。

---

## 2. 提案 1：自我演化與持續優化

### 2.1 提案內容與現況落差

提案主張：利用 `factory-metrics` 收集的 `defect/escape`／`defect/review` 指標自動聚類失敗，由 LLM 撰寫優化提示詞並自主發 PR 更新 `.dsh/skills/factory-workflow/SKILL.md`。

**「指標主要作為觀察診斷，無法回饋至智能體行為」——此觀察正確。** 但提案假設的資料來源不存在。

### 2.2 決定性實測：輸入資料為空集合

| 項目 | 實測值 | 指令 |
|---|---|---|
| 合併 PR | **180** | `gh pr list --state merged --limit 200` |
| `defect/escape` | **0 筆** | `gh issue list --label defect/escape --state all` |
| `defect/review` | **0 筆** | `gh issue list --label defect/review --state all` |
| `meta/observation` | 26 筆 | 同上 |
| `needs-human` | 6 筆 | 同上 |

標籤**確實存在於 repo**（`gh label list` 可見 `defect/escape #d93f0b`、`defect/review #fbca04`），故非「標籤未建立」。

### 2.3 判讀：這是感測器未運作，不是品質良好

三項依據：

1. **標記依賴純人工且只有一人**。`docs/14` §2.3 明載「標記：審查者（貼 defect/review）、發現者（貼 defect/escape）——**目前即 philipz**」。單人、無自動提醒、無 CI 強制——典型會靜默失效的流程。
2. **分母已被污染**。180 顆合併 PR 抽樣顯示前五顆全為 Dependabot（`chore(deps): bump ...`）。`docs/research/229` 已自行論證：Dependabot PR「既非工作項也無 Issue 連結，**不進分子也不進分母**」。
3. **工廠自己的文件已預警此模式**。`docs/08` §2.2：「若 95% 的 agent PR 都一次通過，合理的解釋有二——agent 真的很好，或**審查已成橡皮圖章**。單一指標無法自證，必須交叉檢核。」

> **結論**：在修好感測器之前建立自我改進迴圈，等於把致動器接到壞掉的感測器上。LLM 面對空輸入只能無中生有地「發明」問題模式，產出看似合理、實則無證據基礎的 SKILL.md 修訂 PR——**比沒有自我改進更糟**。

### 2.4 「自主發 PR 修訂 SKILL.md」撞上三層防護

| 防護層 | 條文 | 衝突點 |
|---|---|---|
| 計分層 | `risk-paths.yml:42` H5 含 `.dsh/skills/**` | 觸碰即 risk=2 → 強制 in-loop → **agent 根本不會被啟動** |
| 停手規則層 | `factory-stop-rules` SR3 ＋「絕不允許為繞過檢查而修改 guardrail 設定」 | agent 自改行為準則 |
| GitHub 層 | `CODEOWNERS` `/.dsh/skills/` @philipz | 需人類審查（最後防線） |

`docs/05` §1.1 稱此為核心不變量：**agent 必須永不能鬆綁自己所受的約束**。`docs/06` §4.3 另有一條直接相關：「**agent 不得驗證自己的產出並據以放行**」——agent 自寫 skill 再自己遵循，正是此禁令的教科書案例。

### 2.5 裁決：條件性採納，分三層

**關鍵區分：產生建議（提案）≠ 自動套用（致動）。** 前者不觸碰 H5，後者觸碰。Warp 自己也是「發起 PR 供人類審查」。

| 層 | 內容 | Warp 實證 | 阻塞狀態 |
|---|---|---|---|
| **L1 技能版本化** | `skills-lock`（版本＋hash＋來源 PR），CI 校驗同步一致性 | `skills-lock.json`（行 455） | ✅ **無阻塞**，純機制強化，不放寬任何權限 |
| **L2 確定性 Scorer** | 以既有可信訊號產出統計（不呼叫 LLM） | `AI/Agent Evals` 測試層（行 5352） | ✅ **無阻塞**，唯讀 |
| **L3 改進提案** | agent 撰寫 skill 草案 → 人類審查 → 人工 promote | Spec-Driven＋Oz initial review | ⚠️ 需 L2 資料支撐門檻判斷 |

**設計轉向**：先前把 L1 視為「修感測器」的前置工作；DeepWiki 顯示 **L1 本身就是 Warp 的核心答案**——技能治理的價值不在自動修訂，而在**版本鎖定、可回滾、變更可稽核**。這一層現在就能做，且不需要任何缺陷資料。

**L1 的具體缺口**：`factory-run.yml:396` 目前是無校驗的 `cp -r "$GITHUB_WORKSPACE/.dsh/skills/." "$HOME/.dsh/skills/"`。若這份 copy 不完整或機制 repo 誤刪某個 SKILL.md，**agent 會安靜地在缺少 `factory-stop-rules` 的情況下執行**——停手規則消失卻無任何紅燈。

詳細設計見 `docs/25-skill-authoring-loop.md`、ADR-016。

---

## 3. 提案 2：多代理人專業分工架構

### 3.1 提案的問題診斷需要修正

提案主張：單次 DSH 呼叫「容易因輸出限制、Token 預算或會話中斷導致截斷（觸發關口 2.5 錯誤）」，故應以 gh-stack 三層（01-test／02-impl／03-docs）做「多智能體物理隔離」。

**兩項事實修正**：

1. **Gate 2.5 的真實成因已記載**。`src/pipeline/run-work-item.ts:131-152` 註解記錄 issue #35 實測：agent 停在「Let me re-run a few times」卻仍 exit 0。工廠**已針對此因處理**——`task-template-fix-bug.txt` 第 1 點與第 7 點明確要求「輸出紀律」與「完成後立即停止」。這是提示層處理，非上下文容量問題。
2. **平行化已達成**。`factory-run.yml` 的 `concurrency` group 為每個 issue 開獨立 run；ADR-010 明述「平行化已由 Actions 層以『每 issue 一個獨立 run』達成」。

### 3.2 ADR-010 觸發條件現況：0/3

ADR-010（2026-08-24）已評估並否決多 agent 工具，列出三項全滿足才重評的觸發條件：

| 條件 | 現況 |
|---|---|
| 1. Q05-5 複合風險治理細則已補齊 | ❌ `docs/10`:104 仍列為未決（**本次已補**，見 `docs/24`） |
| 2. DSH 升級至插件 API 世代 ＋ headless guardrail 實測 | ❌ 未驗證 |
| 3. 出現單 agent 無法勝任的工作項型別 | ❌ 現行工作項刻意小（≤100–300 行） |

### 3.3 DeepWiki 新增的兩項反對實證

**證據 D：Warp spawn 子代理人需人類確認**（行 2897、2372）
> `RunAgentsCardView` renders the **"Can I start additional agents?"** card, allowing the user to **review and modify the orchestration plan before execution**

`RunAgentsRequest` 含 `base_prompt`、`agent_run_configs`、`harness_type`、`execution_mode`（行 2895）。Warp 的多代理人**不是自主調度**，而是「代理人提出編排計畫 → 人類審核 → 才執行」——與 `docs/05` §6.1「審查者 agent 產出僅為附加意見、人類審查永不移除」立場一致。

**證據 E：跨代理人交接需要整套基礎設施**（行 2046–2050、2921–2926）

Warp 為讓代理人跨會話延續，建置了：
- `ResumePayload`／`SavePoint`（`ClaudeResumeInfo`、`CodexResumeInfo`）
- `fetch_transcript_envelope` 下載狀態、`rehydrate_codex_transcript` 重建 transcript
- **Parent Bridge**：`OZ_MESSAGE_LISTENER_MANAGED_EXTERNALLY` 環境變數＋共享狀態目錄
- End-of-Run Snapshots：`snapshot-declarations.jsonl`、批次上傳（25 檔/請求）、`snapshot_state.json` manifest

> **意涵**：這正是「拆分 01-test／02-impl 會遺失紅燈驗證上下文」的工程解法，而其複雜度極高。software_factory 若要拆分而不建這套機制，就是**把上下文遺失偽裝成隔離**。

### 3.4 提案會破壞 fix-bug 的核心安全機制

`docs/07` §2.2 與 `factory-workflow` SKILL 記載：fix-bug 的 01-test 需以 `it.skip` 提交、02-impl 才 un-skip，且**紅燈驗證必須在同一 agent 的沙箱內完成**（寫測試→跑確認紅→實作→跑確認綠）。

拆成兩個無狀態 agent 後：
- 第二個 agent **沒見過紅燈**，無法確認測試真能捕捉該缺陷
- `docs/07` §2.1 明列 01-test 置底的目的是「防堵最危險的失敗模式——**agent 為了讓測試通過而弱化測試**」；換手削弱此保護
- ADR-010 指出會「打亂單一帳戶單元的缺陷歸因與棘輪機制」（`report.json`／token 分帳／stop-rules 皆為單 agent 設計）

### 3.5 裁決：維持不採用

**維持 ADR-010 結論**，但理由從「治理未備」升級為「Warp 實證支持現行設計」。本次補齊 Q05-5 細則（`docs/24`），使觸發條件 1 滿足；條件 2、3 仍未滿足，故不重啟。

---

## 4. 可立即採納的借鏡（不改變運行方式）

| # | 借鏡 | Warp 來源 | 落點 |
|---|---|---|---|
| 1 | 技能版本鎖定與完整性校驗 | `skills-lock.json`（行 455） | `docs/25` L1、ADR-016 |
| 2 | 確定性評估（非 LLM 評分） | `AI/Agent Evals`（行 5352） | `docs/25` L2 |
| 3 | 具名診斷技能（把重複踩到的坑固化為可執行檢查） | `review-pr-local`、`diagnose-ci-failures`（行 5637–5645、5049–5050） | `docs/25` §3.3 |
| 4 | spawn 需人類確認卡 | `RunAgentsCardView`（行 2897） | `docs/24` §2.1 |
| 5 | 提案先行、人類放行 | Spec-Driven Development（行 165–167） | ADR-016 雙閘門 |

**特別值得注意的是 #3**：Warp 的 `review-pr-local` 把重複踩到的坑寫成具體阻斷規則——例如「UI 變更若 PR 描述無截圖／錄影 → 直接 `Request changes`」（行 5640），以及對所有 `report_error!` 呼叫點的強制 Pre-Verdict Audit（行 5644）。**這就是「自我改進」的可落地形態**：不是 LLM 自動改 SKILL.md，而是**人把每次事故固化成一條可機械檢查的規則**。此路徑不觸碰 H5，也不需要缺陷資料。

---

## 5. 結論

| 提案 | 裁決 | 理由 |
|---|---|---|
| 1. 自我演化與持續優化 | **條件性採納：L1／L2 立即可做，L3 需人類放行** | 輸入資料為空（0 筆 defect）；自動修訂 SKILL.md 撞 H5／SR3／CODEOWNERS；但 Warp 的真實答案（版本鎖定）現在就能做 |
| 2. 多代理人專業分工 | **維持不採用（ADR-010）** | 觸發條件 2／3 未滿足；DeepWiki 證據 D／E 反而支持現行單 agent 設計；且會破壞 fix-bug 紅綠機制 |

**後續文件**：
- `docs/24-q05-5-multi-agent-composite-risk.md`——補齊 Q05-5（ADR-010 觸發條件 1）
- `docs/25-skill-authoring-loop.md`——L1／L2／L3 完整流程
- `ADR-015`——factory-scoreboard 平台裁決（skill-gap 證據的收集面）
- `ADR-016`——agent 撰寫技能「產出 vs 生效」分離

---

## 6. 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q23-1 | skill-gap 提案門檻「≥3 次」未經校準 | 待累積數據後調整（比照 Q07-1 的處理方式） |
| Q23-2 | `defect/*` 標記紀律失效（180 顆合併 PR、0 筆標記） | 見 `docs/14` §1.3 分母定義修正與 §2.3 風險記載 |

---

## 修訂記錄

| 日期 | 變動 |
|---|---|
| 2026-09-05 | 建立：以 DeepWiki 原始碼文件重新分析兩項提案；記載產品敘事與工程實作的五項落差；更正 Oz 職能範圍（含 implementation） |
