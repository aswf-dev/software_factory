# ADR-004：雙層 guardrail（DSH 層 + GitHub 層）

- **狀態**：已接受
- **日期**：2026-08-16
- **決定者**：平台架構 / 安全
- **對應**：`02-architecture.md` D4、`05-guardrails-governance.md`

## 脈絡

`00-source-summary.md` §5（Figure 9）的結論語只有一句，但改變了整個治理設計的前提：

> **「Agents are new insiders.」**（agent 是新的內部人）

內部人風險的特性是：**擁有合法憑證、在信任邊界內活動、行為看似正常**。傳統的周界防護對此無效。

同時，`00` §5 指出隨自主性上升，治理挑戰從「究責與 guardrails」升級到「編排與互動的複合風險」。

## 決策

**guardrail 同時實施於兩層，且兩層都必須獨立成立**：

| 層 | 機制 | 防護對象 |
|---|---|---|
| **DSH 層** | sandbox mode、approval policy、skills 規則 | agent 在**執行期**能做什麼 |
| **GitHub 層** | branch protection、required checks、CODEOWNERS、App 權限 | agent 的**產出**能否進入主線 |

### 核心不變量（無例外）

> **agent 不得擁有修改 guardrail 本身的權限。**

由 ADR-006 的 App 權限設計（不授予 `Administration` 與 `Workflows`）機制執行，並由 CODEOWNERS 保護 `.github/`、`CODEOWNERS`、`catalog-info.yaml`、`.dsh/skills/`。

## 後果

### 正面
- **任一層失效時，另一層仍能防護**：DSH 層失效 → GitHub 層阻止變更落地；GitHub 層設定錯誤 → DSH 層限制執行期破壞。
- 對應到 DSH 已有的原生機制（已查證），無須自建：

| 支柱（`00` §4） | DSH 機制 | 關鍵性質 |
|---|---|---|
| Guardrails | `dsh-sandbox-policy` | 預設 `read-only`（fail-safe）；模式為 durable 事件，session 建立時**釘選**，agent 無法執行中自我提權 |
| Credentials | `dsh-credentials` | 設定只帶**參照**不帶密鑰；逐操作解析不快取 |
| Sandbox | `dsh-sandbox` + Actions runner | 每次 run 全新用完即棄的環境 |
| Cost | `dsh-token-meter` + OTel | 可量測 |

### 負面
- 刻意的冗餘意味著設定維護在兩處。
- 兩層都需驗證，治理檢查清單較長（`05` §8）。

### 中性
- **任一層都不得因「另一層已經擋住了」而放寬**。這是本 ADR 最容易在實務中被侵蝕的規則——因為放寬總是有短期理由。

## 已知的殘餘風險

> **GitHub-hosted runner 的出向網路預設不受限**（Q05-1）。

agent 可存取任意外部網址，存在資料外洩與供應鏈攻擊風險。第一階段的緩解為**偵測與嚇阻**（stop-rules、PR 審查、CODEOWNERS 保護相依清單），**非預防**。

接受此風險的理由：(a) 執行環境用完即棄；(b) 產出必經人類審查；(c) 密鑰不進 agent context。

**但這是已知缺口，不是已解決的問題。** 若處理敏感資料，須改用 self-hosted runner + 出向白名單。

## 替代方案

### A. 僅 DSH 層（信任沙箱）
**未採用的理由**：沙箱設定錯誤或有繞過方式時，錯誤產出可直接進入主線。且沙箱無法判斷「變更在語意上是否恰當」——它只管檔案存取，不管商業邏輯正確性。

### B. 僅 GitHub 層（信任審查）
**未採用的理由**：執行期的破壞（如刪除檔案、洩漏憑證）在產出審查前就已發生。審查看的是 diff，看不到過程。

### C. 三層以上（加入網路層白名單）
**未採用的理由**：第一階段成本不成比例（需 self-hosted runner）。已明確記錄為殘餘風險 Q05-1，而非假裝不存在。**這是有意識的取捨，保留未來升級路徑。**
