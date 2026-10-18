# ADR-025：多租戶公司流程模板——工廠固定 meta-contract，租戶擁有自己的流程

- **狀態**：已接受
- **日期**：2026-10-18
- **決定者**：平台架構（使用者裁決：同一平台多租戶、HG 固定但可自行新增、`scale` 與模板脫鉤）
- **對應**：`ADR-023`（`process.yaml` 與拓撲 UI）、`ADR-024`（執行語意）、`ADR-022`（前置工作項）、`docs/29` §6／§8／§9、`docs/10`（`Q-ORCH-4/5`）

## 脈絡

目標是「**每個專案或公司，可以依照各自的軟體開發流程，制定工廠的使用流程與步驟**」。

現況只能微調，不能制定：

- `src/process/spec.ts` 把模板名鎖成 `S|M|L`（`TEMPLATE_NAMES`），且 `scale === template`；
- `phases` 只能是模板的連續前綴、模板的 gates 一個都不能少、`extra_steps` 只能接在序列後且 id 不得衝突；
- `factory-next` 的「下一步」是模板序列的第一個未完成步驟——重排只會改變未來建議，不會改變已建立的 Issue 歷史。

同時，aswf.dev 的目標是**同一平台多租戶**：不同組織共用一套機制 repo、一套 CI 與一個 Scoreboard，但各自有 SDLC。目前平台沒有 tenant 概念，只有 GitHub App 身分與 Cloudflare Access。

因此要決定的是：**流程的擁有者是誰**。三個候選：A 受限實例編輯器、B 開放重排共用模板、C 租戶自有模板（本 ADR 選擇 C，A 保留為預設編輯面與過渡）。

## 決策

### 1. 三層分離

| 層 | 擁有者 | 內容 | 可否由租戶改 |
|---|---|---|---|
| **meta-contract** | 工廠 | step kind、task_type 白名單、phase P0–P5、必含 HG、自訂 gate 命名規則 | 否 |
| **租戶模板** | 租戶 | 階段／步驟順序、自訂 gate、版本 | 是（走 PR） |
| **系統實例** | 系統 | `template` 釘版本、`scale`、`extra_steps`、模組清單 | 是（走 PR） |

### 2. 租戶模板的識別、版本與審批

- 檔案：`templates/<tenant>/<name>.yaml`（機制 repo；`tenant` 為小寫 slug，例 `acme`）。
- id：`<tenant>/<name>`（例 `acme/review-first`）；`version` 為正整數，**發布後不可變**——改流程＝新版。
- 系統釘版本：`template: acme/review-first` ＋ `template_version: 3`（`ProcessSpec` 新欄位）。
- 審批：PR 到機制 repo，`CODEOWNERS` 按 `templates/<tenant>/**` 分派；新版本上線前由平台擁有者審查。
- 租戶不得修改其他租戶的模板；跨租戶的 gate id 也不得共用（見 §3 命名規則）。

### 3. meta-contract（租戶模板必須滿足）

- **step kind** 只有四種：`work-item`／`human`／`gate`／`decision`。
- **task_type** 必須是工廠既有清單（`agent-analyze` 等）；`human` 步驟用自由文字描述動作。
- **phase** 只能使用 `P0`–`P5`。租戶可用 `action` 表達自己的階段語意，但聚合與指標口徑固定。
- **必含閘門**：模板的 `gates` 必須包含 `HG1`、`HG2`、`HG4`、`HG5`、`HG6`，且每一步驟放在何處由模板決定（`HG0`／`HG3` 是每個工作項／PR 的閘門，不在模板 steps）。**租戶不得移除工廠閘門**。
- **自訂 gate**：
  - id 格式 `<TENANT-UPPER>-<NAME>`（例 `ACME-SECURITY`）；`HG[0-7]` 保留，前綴必填以保證全域唯一。
  - 每個自訂 gate 必須在模板的 `gates` 宣告，且帶 `scope`（`system|module|phase|pr`）與 `evidence` 要求（http(s) 連結，沿用 `docs/29` §8）。
  - 簽核沿用結構化留言，但標記改為 `<!-- factory:gate id=ACME-SECURITY state=signed evidence=… -->`；`factory:hg` 仍接受 HG id（向後相容）。
  - 自訂 gate **只能額外**，不得取代 meta-contract 的必含 HG。
- 租戶模板不得：新增 task_type、發明 phase、移除必含 HG、引用未宣告的 gate。

### 4. `scale` 與模板脫鉤

- `scale` 仍由人類宣告（HG2），代表治理強度與審查層級，**不再等於模板名**。
- `validateProcess` 移除 `scale === template`；改為 `scale ∈ {S,M,L}` 且 `template_version` 存在。
- 換模板不等於改規模；改規模仍須 HG2 重新裁定。

### 5. S/M/L 降為 preset

- 原本的 `processes/templates/{S,M,L}.yaml` 已移到 `templates/factory/{S,M,L}.yaml`，id 為 `factory/S` 等（第 2 階段已實作）。
- 既有系統以 `template: factory/S` ＋ `template_version: 1` 表達，行為不變。
- `docs/29` 的角色從「唯一方法論」改為「**工廠 presets 的來源**」；租戶模板是該租戶的方法論，但仍須滿足 meta-contract。

### 6. 對執行與呈現的影響（刻意最小）

- `factory-graph`／`factory-next` 已經以 `Template` 為輸入，**判定邏輯不動**；只換 loader（依 id＋version 載入）。
- `factory-snapshot` 需帶 `template` 與 `template_version`，consumer 才能選對定義。
- Scoreboard：定義層改讀模板 registry（S/M/L 只是其中三份）；流程目錄同時列出 preset 與租戶模板。
- **多租戶資料隔離不在本 ADR**：誰能看到哪個租戶的快照由 Access policy 決定，缺口記為 `Q-ORCH-5`。

## 後果

### 正面

- 租戶真正擁有自己的流程，而不是在工廠的序列上加减。
- meta-contract 把「不可退化的治理」寫成可驗證的集合（四種 kind、task_type 白名單、P0–P5、必含 HG），安全邊界從「不許重排」變成「不許用未定義的積木」。
- 版本化與釘版本讓歷史可追溯：模板改了不會回溯汙染已建立的 Issue。
- S/M/L 仍是預設，既有系統零遷移語意（只換 id）。

### 負面

- 模板治理成本上升：審批、版本、文件、`CODEOWNERS` 分租戶。
- 跨租戶指標可比性下降；用固定 P0–P5 與 task_type 緩解，但無法完全消除。
- 改動面橫跨 `spec.ts`、loader、parser、snapshot、Scoreboard 定義層。

### 中性

- A（受限實例編輯器）仍是 C 的預設編輯面：在沒有租戶模板時編輯 preset 實例；租戶模板上線後，同一個編輯器改成編輯模板 draft。
- 自訂 gate 的 quorum／證據等級留給 `Q-ORCH-4`，本 ADR 只定命名與解析。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| **B：開放重排共用 S/M/L 模板** | 重排會同時改變所有使用該模板的系統；若改成每系統複製一份，就是 C 但沒有 C 的審批與版本。且仍只能在工廠步集裡排，表達不了公司自己的階段。 |
| **只做 A：受限實例編輯器** | 表達力不足（只能加尾巴），無法回答「我們公司不做 P2 文件化」或「資安審查要在 P1 前」。 |
| **租戶自帶 repo 的模板（不進機制 repo）** | 無法用 `CODEOWNERS` 審批、無法釘版本、供應鏈面擴大。 |
| **完全自由的 schema（自訂 phase／task_type）** | 閘門、計分、指標口徑會碎掉；`factory-next` 與 supervision 的假設失效。 |

## 分階段實作

1. **本 PR（文件）**：ADR-025、ADR-023 §2 互引、`docs/10` 新增 `Q-ORCH-4/5`。
2. `src/process/spec.ts`：`TemplateSchema` 加 `tenant`／`name`／`version`；meta-contract 驗證；自訂 gate id 規則；`ProcessSpec` 加 `template_version`、移除 `scale === template`；S/M/L 移到 `templates/factory/`。
3. Loader／registry：`loadTemplate(id, version)`，目錄掃描或 `templates/index.yaml`。
4. `factory-graph`／`factory-next`：loader 換手（邏輯不動）。
5. `factory-snapshot`：快照帶 `template`／`template_version`。
6. `factory-hg`／`hg/parse.ts`：接受 `factory:gate` 的自訂 id（僅限模板已宣告者；未知 id → warning）。
7. Scoreboard：流程目錄列出租戶模板；定義層改讀 registry；編輯器（A）改為可編輯模板 draft。

## 重評觸發條件（任一成立即重新檢視）

1. 租戶 ≥ 3 且模板變更頻繁 → 檢討審批自動化與版本發布流程。
2. 自訂 gate 被用來繞過必含 HG → 收緊命名或移除自訂 gate。
3. 跨租戶指標無法比較 → 引入 phase 映射表（`Q-ORCH-5`）。

## 待決

| 編號 | 事項 |
|---|---|
| `Q-ORCH-4` | 自訂 gate 的簽核人數、證據等級、是否可撤回／需要 quorum |
| `Q-ORCH-5` | 多租戶資料隔離（Access policy 與 snapshot 可見性）＋ 跨租戶 phase 映射 |
