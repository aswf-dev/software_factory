---
exported: 2026-10-08T09:01:36.922Z
source: NotebookLM Studio
title: 軟體工廠架構優化
---

# 軟體工廠架構優化

Exported: 2026/10/8 下午5:01:36

---

將 **awslabs/aidlc-workflows** 的核心設計融入 **philipz/software\_factory**，能精準解決後者在多儲存庫擴展、執行期即時護欄、多 Agent 信任盲區與知識沉澱等方面的瓶頸。以下是六個最適合借鑑與整合的關鍵模組：

* * *

1\. 逆向工程知識庫（CodeKB）整合至多儲存庫（Multi-Repo）前置流程

-   **現狀瓶頸**：`software_factory` 在 Phase 2 擴展至跨儲存庫（Multi-Repo）時，主要依賴 Backstage 的 `factory-draft` 透過 LLM 生成 Issue 需求1more\_horiz，Agent 執行時缺乏對目標專案全域架構的結構化認識，容易耗損 Token 探索程式碼45。-   **整合方案**：
    -   引進 AIDLC 的 **Stage 2.1（Reverse Engineering）** 與 **codekb/<repo>/** 機制，在外部專案接入工廠時，預先生成架構、API、組件清單與相依性等 9 大持久化 Markdown 資產6more\_horiz。-   引入 **codekb-scope-diff** 工具，在 CI 觸發 `factory-run.yml` 前比對程式庫異動指紋（CURRENT/STALE）10more\_horiz，將過期或局部的架構知識更新後再餵給 DSH Agent，大幅提高修復 Bug 與增補測試的準確度。

* * *

2\. 對抗式審查（Adversarial Reviewer）化解多 Agent 協同顧慮（ADR-010）

-   **現狀瓶頸**：`software_factory` 為了防止「多個 Agent 互相確認彼此的錯誤（Composite Risk）」，在 ADR-010 中刻意延後了多 Agent 團隊協同，維持 1:1 任務執行與人類審查1314。-   **整合方案**：
    -   AIDLC 的 **對抗式審查架構（Adversarial Reviewer）** 專門解決上述盲點：專職審查者（如架構與產品審查 Agent）採取\*\*「直到確認就緒前一律反駁（refute-until-READY）」\*\*的立場，並設定嚴格的對話輪次預算（`maxTurns: 60`）與非就緒判決合約1516。-   引入 **aidlc-reviewer-scope.ts** 限制審查者的檔案讀取範圍，禁止審查者介入生命週期跳轉16more\_horiz，並配合 **review-freeze.ts** 凍結已審查產物1920。-   效益：在 Stacked PR 發起前先通過本地對抗審查並取得 `REVIEW_COMPLETED` 憑證2122，讓 `software_factory` 能安全解除 ADR-010 限制，減少高風險工單等待人類審查的時間（消除 IDLE 時間）13more\_horiz。

* * *

3\. 即時攔截勾子（Flow-Altering PreToolUse Hooks）補強 Stop Rules

-   **現狀瓶頸**：`software_factory` 的安全機制依賴沙盒（Landlock）與 **事後／結束後判定（Post-hoc）**——即 Agent 執行完畢寫出 `report.json` 後，由 `factory-judge` 判定 Stop Rules（SR1–SR7）或在 PR 生成後執行 `factory-rescore`25more\_horiz。若 Agent 在執行中偏離常軌，容易造成長達數十分鐘的 CI 資源浪費2930。-   **整合方案**：
    -   移植 AIDLC 的 **PreToolUse 攔截勾子** 到 DSH 或執行環境層：
        -   **plan-approval-guard.ts**：在 Agent 調用 Edit/Write 工具前實體攔截，強制要求必須先有經核准的測試契約與實作計畫（Plan-before-generation）才能寫入程式碼3132。-   **state-transition-guard.ts**：防止 Agent 試圖以 Bash 指令繞過狀態機流程3133。-   **aidlc-continue-workflow.ts****（Stop Hook）**：配備「無進展計數器（No-Progress Counter）」，在循環打轉時主動中斷並觸發交接，避免長時間逾時3435。

* * *

4\. 形式化可追溯性與防幻覺感測器（Sensors）

-   **現狀瓶頸**：`software_factory` 在工單進入前僅以正規表示式檢查 Issue 欄位與 DoD 勾選框（`factory-issue-check.ts`）536，尚未在程式碼生成階段自動檢驗「業務需求標籤是否 1:00 映射到測試斷言」。-   **整合方案**：
    -   引入 AIDLC 的 **aidlc-sensor-traceability.ts**：在 `01-test` 與 `02-impl` 的 Stacked PR 生成後，自動校驗所有需求編號（FR/NFR/AC）在測試案例與實作程式碼中的覆蓋狀態（OK、GAP、ORPHAN）22more\_horiz。-   引入 **aidlc-sensor-claim-sources.ts**：強制檢查 Agent 在報告與程式碼註解中的各項論述是否具備專案記憶或既定依據，防止產生無根據的幻覺性實作38。

* * *

5\. Git Worktree 與 Bolt 隔離切片技術

-   **現狀瓶頸**：`software_factory` 主要將整個任務工作區放在單一目錄（如 `target/`）中以 `gh-stack` 管理分支22more\_horiz。遇到複雜或平行任務時，容易發生 Git 狀態髒污或衝突2241。-   **整合方案**：
    -   整合 AIDLC 的 **Bolt 機制與** **aidlc-worktree.ts**42more\_horiz：
        -   針對不同子任務單元（Unit of Work），動態分流至獨立的 Git Worktree（命名規範如 `bolt-<id8>_<slug>`），使工作區與分支達到物理級隔離42more\_horiz。-   結合 `aidlc-swarm.ts check` 的無狀態比對防篡改機制，在合併回 `software-factory` 基準分支前完成一致性校驗46more\_horiz。

* * *

6\. 持久化經驗學習循環（Learnings Ritual）

-   **現狀瓶頸**：`software_factory` 的規範（如 SOP、Stop Rules、Prompt Templates）多半以靜態檔案維護（`.dsh/skills/` 與 `.github/factory/`）49more\_horiz。當某個工作項目觸發 `needs-human` 且由人工介入修復後，失敗經驗不會自動沉澱為系統規則2552。-   **整合方案**：
    -   引進 AIDLC 的 **Learnings 循環機制（****aidlc-learnings.ts****）**5354：
        -   任務執行中記錄執行日記（偏差、取捨、疑問）53。-   在人工介入或任務結案時，執行衝突破析與審核，將踩坑經驗自動向上提煉至空間層級的記憶檔案（`team.md` 或 `project.md`）5455。-   後續 Agent 執行特定任務時動態注入這些規則，避免類似的 CI 失敗或安全攔截重複發生。

* * *

整合建議結論

整合模組

AIDLC 技術組件

解決 Software Factory 之問題

整合侵入性

**程式碼認知前置**

CodeKB + `codekb-scope-diff`610

跨專案調度時缺乏脈絡、Token 耗損嚴重14

**低**（可在 CI 觸發前以獨立工具生成）

**對抗式審查審計**

Reviewer Agents + `review-freeze.ts`1519

ADR-010 暫緩多 Agent 協同、依賴人工 Review 阻塞1323

**中**（作為 PR 發起前的一道本機驗證門禁）

**執行期即時護欄**

PreToolUse Hooks（Plan Guard 等）3132

僅靠事後評分判定，防護延遲且易發生超時2529

**中**（需掛載至 DSH / Runner 執行層）

**規格溯源檢查**

Traceability & Claim Sensors3738

DoD 僅檢查格式勾選，無邏輯覆蓋保證536

**低**（整合至 `factory-judge` 判定流程）26

**經驗自演進**

Learnings Ritual + 記憶體系5355

Agent 犯錯經驗無法制度化沉澱至規則庫2549

**低**（於 Handover 報告流程後追加持久化步驟）56

透過將 AIDLC 的\*\*「前置認知（CodeKB）」、「行中即時攔截（Hooks）」與「對抗審查（Reviewers）」\*\*引入 `software_factory`，能夠在維持原有 GitHub SSoT 與嚴格三軸風險評分（One-Way Ratchet）的基礎上57more\_horiz，大幅擴展自動化工廠能安全處理的任務複雜度。

* * *

💡 想針對上述哪一項（例如：**如何在 DSH 執行環境中掛載 PreToolUse Hooks**，或是**如何以 CodeKB 改造 Backstage Issue 生成流程**）深入規劃實作步驟嗎？
