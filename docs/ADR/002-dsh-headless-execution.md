# ADR-002：agent 執行走 DSH headless 一次性呼叫

- **狀態**：已接受
- **日期**：2026-08-16
- **決定者**：平台架構
- **對應**：`02-architecture.md` D2、`04-agent-execution-dsh.md`

## 脈絡

工廠需要一個能被 CI 驅動的 agent 執行方式。CI 的基本需求是：可判定成敗、無互動、無常駐、可擷取結果。

使用者已選定 DeepSeek Harness (DSH) 作為 agent 執行核心。DSH 提供多種 profile（web、tui、headless）。

## 決策

**所有自動化 agent 工作以 `dsh --profile headless "<task>"` 執行**，不使用互動式 session。

### 已查證的契約（來源：`@deepseek-ai/dsh-headless` README、`dsh --help`）

| 面向 | 行為 |
|---|---|
| 執行模型 | 建立全新持久化 Agent，任務作為一般 user message 送出，等待靜止 |
| stdout | 最後一則非空的 assistant 文字 |
| stderr | 成功時為空；終止性錯誤才寫入代碼與訊息 |
| exit code | 最終 `turn/end` 完成 → 0；否則 → 1 |
| 網路埠 | 不開啟任何監聽埠 |

## 後果

### 正面
- 四項特性**逐一對應** CI 需求，無須額外包裝。
- exit code 使成敗判定機械化，不依賴解析輸出文字。
- 無常駐程序，無埠暴露，攻擊面小。
- 執行器可替換——契約僅為「一次性呼叫 + 自足任務 + exit code + stdout」。

### 負面
- **每次呼叫無狀態**，跨呼叫沒有記憶（`04` §1.3）。
- **只能送出一個任務，無互動追問**（套件明列的限制）——任務描述必須自足。
- 必須透過 `dsh` 啟動器執行（`ctx.appExit` 由啟動器擁有），不可繞過。

### 中性
- 無狀態性**推動了兩項設計**：知識沉澱於 repo 的 skills、記憶外部化至 GitHub。這與 ADR-001 互相支撐——執行平面本來就無狀態，狀態不放 GitHub 也無處可放。

## 重要提醒

> **exit 0 代表「agent 的回合正常結束」，不代表「任務正確完成」。**

任務正確性由 GitHub 層的 required checks 與人類審查判定（見 ADR-004）。把 exit 0 當作品質保證是本契約最容易被誤解、也最危險的一點。

## 替代方案

### A. 互動式 session（web/tui profile）
**未採用的理由**：需要人在旁回應，無法無人化執行；且會開啟監聽埠，在 CI 中既無必要也增加暴露面。

### B. 直接呼叫 LLM API，自建 agent 迴圈
**未採用的理由**：需自行實作工具呼叫、沙箱、憑證管理、token 計量——而 DSH 已提供且經過驗證（見 ADR-004 的四支柱對應）。重造輪子且品質更差。

### C. 使用其他 agent CLI（如 claude、codex）
**未採用的理由**：使用者已選定 DSH。且 DSH 的 sandbox/credentials/token-meter 恰好對應 `00` §4 的 IDP 四支柱，整合成本最低。

> 註：本機環境確實同時安裝了 `claude` 與 `codex` CLI。若未來需要替換，ADR-002 的最小契約（一次性呼叫 + exit code + stdout）使替換成本可控。
