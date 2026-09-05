# ADR-010：多 agent 團隊工具（dsh-agent-teams / workflow 工具）延後採用

- **狀態**：已接受
- **日期**：2026-08-24
- **決定者**：平台架構（分析結論，經 plan 審查核准）
- **對應**：`02-architecture.md` D5、`05-guardrails-governance.md` §6.1 與 Q05-5、`10-open-questions.md` Q05-5

## 脈絡

factory 的 skills（`.dsh/skills/factory-*`）與 GitHub Actions templates（`factory-run.yml`、`task-template-*.txt` 等）目前皆以**單一 DSH headless agent 處理單一工作項**為前提：一次 run = 一次 `dsh --profile headless` 呼叫，產出單一 `report.json`，由 judge / stop-rules / token 預算（SR7）消費。

同時存在兩類「多 agent 工具」選項：

1. **dsh-agent-teams 插件**（`@nanmicoder/dsh-agent-teams`，2026-08 檢視 v0.1.13）：把一個 DSH 會話變成「隊長 + 可續聊成員」的團隊，提供 10 個 `agent_teams_*` 工具、帶依賴的任務 DAG、原子轉派/接管、直達訊息、`<workspace>/.agent-teams/` 檔案狀態與 Web 活動面板。
2. **workflow 工具**（harness 的大型多 agent 編排：JS 腳本、phases、fan-out 大量子代理）。

本 ADR 評估：工廠**現階段是否需要**採用其中任一。

## 決策

**目前不採用，且不應在現階段引入。** 兩類工具的採用被以下門檻阻擋（門檻內容見 `05-guardrails-governance.md` §6.1 的補充）：

1. **治理門檻（Q05-5）**：多 agent 協作引入「兩個 agent 互相確認彼此錯誤」的複合風險；`docs/05` 未決事項 Q05-5 明定「引入多 agent 前必須先補」複合風險治理細則——該細則**至今未補**。在補齊前引入，等於違反工廠自身的治理順序。
2. **架構前提**：D5 自主性上限為「on-the-loop 且限定低風險類別」；目前工作項刻意保持小規模（單一關注點 ≤100 行單 PR、stacked ≤200–300 行），平行化已由 Actions 層以「每 issue 一個獨立 run」達成——不存在需要 fan-out 團隊的任務規模。
3. **技術相容性未驗證**：工廠鎖 `@deepseek-ai/dsh`（package.json 0.1.1-rc.2）；插件面向 DSH rc.6–rc.8 世代 API（`shell.overlay`、`ctx.webServer/workspaceRegistry`），其核心價值（活動面板、slash 命令）屬 Web 情境，而工廠跑 headless CI。引進前須驗證插件在 `factory-guardrail.patch.yml`（workspace-write + approval never）下可組合、狀態檔寫入不違反沙箱。
4. **guardrail 路徑不可由 agent 觸碰**：安裝插件 = 修改 DSH 設定面，屬 factory-stop-rules SR3（需改 CI 設定）與 H5 的保護範圍——只能由人類決策。

**維持不變**：`.dsh/skills/**`、`.github/workflows/**`、`.github/factory/**`、`package.json`、guardrail 設定全部不動。

## 後果

### 正面

- 維持「單一帳戶單元」的缺陷歸因與棘輪機制（`06` §5.3 二次判定）不被打亂。
- 不擴大 CI 的 token 消耗、逾時面與沙箱驗證面（`11`、`dsh-sandbox-probe.yml`）。
- 治理順序保持誠實：先補 Q05-5，再談工具。

### 負面

- 暫時放棄多 agent 帶來的分工潛力（如「一個寫碼、一個審查」的附加意見審查者）。
- 未來若翻案，需重新驗證版本相容性（本 ADR 的技術檢查可能隨 DSH 升級而過時）。

### 中性

- `dsh-agent-teams` 在**互動式 Web 情境**（開發者本機 DSH 會話內臨時組團隊）的價值不受本 ADR 影響——那是與 CI 工廠迴圈獨立的議題，可另行評估。

## 替代方案

- **立即引入 dsh-agent-teams**：被治理門檻（Q05-5）擋下；且 report/judge/token 管線需先重新設計為「隊長聚合報告」。
- **立即引入 workflow 工具做 fan-out**：工作項規模與監督模型均不匹配；屬過度設計。
- **不記錄本評估**：門檻失憶，未來可能無脈絡地重啟討論——故以本 ADR 留存脈絡與觸發條件。

## 觸發條件（全部滿足才重新評估）

1. ~~Q05-5 複合風險治理細則已補齊~~ → ✅ **已補齊（2026-09-05，`docs/24`）**：五項細則（spawn 需人類確認、審查者產出僅附加意見、缺陷歸因與棘輪延伸到團隊、token 分帳與 report 聚合格式、stop-rules 由隊長繼承/轉交）。
2. DSH 升級至插件目標 API 世代，且插件在 headless + factory guardrail overlay 下實測通過（沿用 `dsh-sandbox-probe` 模式）。 → ❌ **未驗證**
3. 出現單 agent 無法勝任的工作項型別，或 roadmap 明示的 Phase 3 之後階段明確要求角色分工。 → ❌ **未滿足**（現行工作項刻意小，≤100–300 行）

**現況：1/3 滿足 → 維持不採用。**

## 補記：2026-09-05 DeepWiki 複查（維持不採用，並新增實證）

以 Warp 客戶端原始碼文件（`warpdotdev-warp-DeepWiki.md`，commit `0e075a07`）複查本 ADR 的結論。**該文件記載的是 Warp 桌面客戶端，非 Warp Factories**——`Foreman`／`Triage Agent`／`Scorer`／`LLM Judge` 全數 **0 次命中**。分析全文見 `docs/research/230`。

複查產生兩項**支持維持不採用**的新實證：

| 證據 | 內容 | 意涵 |
|---|---|---|
| **D** | `RunAgentsCardView` 渲染「**Can I start additional agents?**」確認卡，讓使用者**在執行前審核與修改編排計畫**（plan／model／environment）（行 2897、2372） | Warp 的多代理人**不是自主調度**，而是「agent 提計畫 → 人類確認 → 才 spawn」——與本 ADR 及 `docs/05` §6.1 立場一致，已納為 `docs/24` §2.1 細則 1 的藍本 |
| **E** | 跨代理人交接需 `ResumePayload`／`SavePoint`、`fetch_transcript_envelope`、`rehydrate_codex_transcript`、Parent Bridge、End-of-Run Snapshots（行 2046–2050、2921–2926） | 安全交接需**整套狀態重建基礎設施**。缺此設施而拆分，是把「上下文遺失」偽裝成「隔離」 |

**對「以 stacked PR 三層做多 agent 物理隔離」提案的具體反對**：`docs/07` §2.2 要求 fix-bug 的 01-test 紅燈驗證**在同一 agent 沙箱內完成**；拆給兩個無狀態 agent 後，第二個**沒見過紅燈**，無法確認測試真能捕捉該缺陷——而 `docs/07` §2.1 明列 01-test 置底正是為了「防堵 agent 為了讓測試通過而弱化測試」。**這是靜默失效**。

此外，該提案欲解決的「Gate 2.5 截斷」另有成因：`run-work-item.ts:131-152` 記載 issue #35 實測為「agent 停在 Let me re-run a few times 卻仍 exit 0」，已由 `task-template-*.txt` 的輸出紀律與「完成後立即停止」處理；平行化亦已由 Actions 層「每 issue 一個獨立 run」達成。
