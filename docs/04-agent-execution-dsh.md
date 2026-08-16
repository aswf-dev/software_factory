# 04 — Agent 執行平面（DeepSeek Harness）

> **依據**：`02-architecture.md` D2（headless 執行契約）、§3.3（DSH 的唯一職責）、`00-source-summary.md` §3 Phase 1 Step 3（IDP 作為 AI 能力的抽象層）
> **讀者**：實作 CI 工作流與撰寫工廠 skills 的工程師
>
> **查證聲明**：與 `03` 不同，本文件的 DSH 事實**多數已由本機安裝的套件原始碼與 README 直接查證**。已查證者標註來源套件；未查證者明確標示 ⚠️。

---

## 1. 執行契約（已查證）

### 1.1 呼叫形式

```bash
dsh --profile headless "<自足的任務描述>"
```

**已查證的行為**（來源：`@deepseek-ai/dsh-headless` README、`dsh --help`）：

| 面向 | 行為 |
|---|---|
| 執行模型 | Loader 就緒後，執行器讀取 `ctx.agentDefaultModel`，**建立一個全新的持久化 Agent**，將任務作為一般 user message 送出，等待靜止（quiescence） |
| stdout | **最後一則非空的 assistant 文字** |
| stderr | 成功執行時**保持空白**；終止性錯誤才寫入錯誤代碼與訊息 |
| exit code | 最終 `turn/end` 完成 → **0**；否則 → **1** |
| 網路埠 | **不開啟任何監聽埠** |
| 任務來源 | 命令列的位置參數；**空白或僅含空白的任務會在執行器啟動前被拒絕** |

**這四項特性逐一對應 CI 的需求**：可判定成敗（exit code）、可擷取結果（stdout）、無互動、無常駐。這是 D2 選擇 headless 而非互動式 session 的完整理由。

### 1.2 已知限制（來源套件明列，不可迴避）

| 限制 | 對工廠設計的影響 |
|---|---|
| **只能送出一個任務**，無互動追問介面 | 任務描述**必須自足**；agent 不能中途要求澄清。這推動了「知識沉澱在 skills」的設計（§3） |
| `ctx.appExit` 由啟動器擁有 | 必須透過 `dsh` 啟動器執行，不可繞過啟動器直接掛載 headless profile |

### 1.3 無狀態性與其後果

每次呼叫建立**全新的 Agent**，因此跨呼叫**沒有記憶**。工廠的記憶必須外部化：

| 記憶類型 | 存放位置 |
|---|---|
| 工作項脈絡 | GitHub Issue 內容與留言 |
| 專案慣例與 SOP | repo 內的 skills（§3） |
| 前次嘗試的結果 | Issue 留言或 PR 討論 |
| 程式碼現況 | repo 本身 |

> **設計推論**：這正是 D1（GitHub 為唯一事實來源）能夠成立的原因——執行平面本來就是無狀態的，狀態不放 GitHub 也無處可放。兩個決策互相支撐。

---

## 2. Profile 與設定分層（已查證）

### 2.1 Profile 的組成方式

已查證的 profile 結構（來源：`$DSH_HOME/profiles/web/`）：

```
$DSH_HOME/profiles/<name>/
├── package.json        # 宣告要疊哪些 bundle
├── cordis.patch.yml    # 使用者覆寫層（套用於所有 bundle 層之後）
├── cordis.yml
└── pnpm-workspace.yaml
```

`package.json` 的關鍵欄位（實際範例）：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
```

**分層順序**（來源：`dsh --help`、`dsh-base` patch 註解）：

```
空 profile 根
  └─► bundle 層（依序，如 dsh-base → dsh-headless）
        └─► 使用者 cordis.patch.yml
              └─► --patch <path> 額外覆寫（可重複）
```

**每一列以 id 定位，後寫覆蓋先寫；patch 會替換整個 `config` 而非合併。** 這一點對工廠很重要：覆寫某列設定時必須寫出**完整**設定，不能只寫想改的欄位。

### 2.2 工廠的 profile 設計

工廠不修改 `dsh-headless` 套件本身，而是建立**專屬 profile** 並以 patch 層施加 guardrail：

```
$DSH_HOME/profiles/factory/
├── package.json        # bundles: [dsh-base, dsh-headless]
└── cordis.patch.yml    # 工廠的 guardrail 覆寫層
```

```json
{
  "name": "dsh-profile-factory",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    }
  }
}
```

呼叫時即為：

```bash
dsh --profile factory "<任務描述>"
```

> ⚠️ **待實作驗證（重要）**：`$DSH_HOME/profiles` 目前**只有 `web` profile**（已實測），`headless` profile 尚未佈建。`dsh --profile headless` 是否會自動佈建、或需先手動建立 profile 目錄，**必須在實作第一步驗證**。這是 Q02-1。

### 2.3 guardrail 覆寫層的內容

```yaml
# $DSH_HOME/profiles/factory/cordis.patch.yml
# ⚠️ 各列的 id 與 config 結構待實作驗證；此處展示意圖與分層方式

# 沙箱：CI 中限定 workspace-write，永不使用 danger-full-access
- id: sandbox-policy
  config:
    mode: workspace-write
    # workspaceRoot 由 session 的 cwd 決定（已查證：session cwd 優先於 fallback）

# 核准政策：CI 無人可回應，必須為 never（拒絕而非等待）
- id: approval
  config:
    policy: never
```

**設計理由**：

1. **`mode: workspace-write` 而非 `danger-full-access`**：agent 只需改動該次 run 的 workspace。已查證 `dsh-sandbox-policy` 的預設是 `read-only`（fail-safe），三種模式為 `read-only` / `workspace-write` / `danger-full-access`。
2. **`approval/policy: never`**：CI 中無人可回應核准提示。設為 `never` 使需要核准的操作**直接被拒絕**，而不是無限等待到 job timeout。這是「快速失敗優於靜默卡死」的落實。

> **已查證**：`dsh-permission-presets` 將 `sandbox/mode` 與 `approval/policy` 綁為具名預設，內建 `workspace-write`（workspace-write + ask）與 `danger-full-access`（danger-full-access + never）。工廠需要的是 **workspace-write + never** 這個組合，內建預設中沒有，故需自訂或直接設定兩個 knob。⚠️ 確切設定方式待驗證。

---

## 3. Skills：工廠的標準作業程序

### 3.1 為什麼 skills 是本設計的關鍵

`00` §3 Phase 1 Step 3 的 Southern Company 案例指出：團隊**缺乏 prompt 與 context engineering 專業**、且**難以讓 AI 產出符合組織編碼標準**。解法是 IDP 作為抽象層，把複雜任務標準化。

在本架構中，**skills 就是那層抽象的載體**：

- 平台維護者把「本團隊如何拆 PR、如何寫 commit、如何自審」寫成 skill，**寫一次、全隊共用**；
- 使用者透過 Backstage Template 填幾個欄位即可（`03` §3.3），不必寫 prompt；
- skills 存在 repo 內，**受版控、可審查、可演進**。

### 3.2 Skill 的探索規則（已查證）

來源：`@deepseek-ai/dsh-skill-filesystem` README。

| Rank | 來源 | 路徑 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | 設定的 `customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

**已查證的關鍵事實**：

- **專案根目錄是「最近的含 `.git` 的祖先目錄」**；沒有則用當前 cwd。
- 格式為**目錄套件 `<name>/SKILL.md`** 或**扁平檔案 `<name>.md`**；**刻意不支援巢狀 `**/SKILL.md`**。
- Frontmatter 必填 `name` 與 `description`，選填 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。
- **名稱必須是 kebab-case**。
- 無效的 invocation 值會**整個 skill 被丟棄並警告**（fail closed），而非退回寬鬆預設。

> **對工廠的直接意義**：工廠 skills 放在**目標 repo 的 `.dsh/skills/`**（rank 100，最高優先），即隨程式碼版控、隨 PR 審查、隨專案演進。這是「paved road 與程式碼同源」的具體做法。

### 3.3 工廠 skills 清單（第一階段）

置於目標 repo 的 `.dsh/skills/`：

```
.dsh/skills/
├── factory-workflow/SKILL.md      # 主流程：如何處理一個工作項
├── factory-pr-stacking/SKILL.md   # 如何拆分 stacked PR（對應 07）
├── factory-self-review/SKILL.md   # 提交前的自審清單
└── factory-stop-rules/SKILL.md    # 何時必須停手交還人類
```

**`factory-stop-rules` 是其中最重要的一個**——它把 `02` §6 的降級路徑寫成 agent 可讀的規則：

```markdown
---
name: factory-stop-rules
description: 工廠 agent 必須停手並交還人類的情況。任何一條觸發即停止，不得自行放寬。
---

# 停手規則

以下任一情況發生時，**立即停止**，在 Issue 留言說明原因，貼上 `needs-human` 標籤，然後結束：

1. 同一顆 PR 連續兩次 `gh stack sync` 失敗。（**CI 中一律用 `sync` 不用 `rebase`**：`sync` 為非互動且衝突時會還原所有分支；`rebase` 需互動介入，在 CI 中會卡住至逾時。詳見 `07` §3.3）
2. 任務涉及授權邏輯、金流計算、敏感資料處理。
3. 需要修改 CI 設定、branch protection、CODEOWNERS 或 `catalog-info.yaml`。
4. 驗收條件不明確，無法判斷完成與否。
5. 需要新增未在既有相依清單中的套件。
6. 測試無法在不放寬斷言的情況下通過。

**絕不允許的行為**：
- 為了讓測試通過而刪除或弱化測試斷言。
- 為了繞過檢查而修改 guardrail 設定。
- 在不確定時猜測並繼續——不確定就停手。
```

> **設計要點**：第 3 條與第 6 條直接防堵「agent 為了完成任務而拆掉防護」這類最危險的失敗模式。這在 skill 層（提示）與 GitHub App 權限層（機制，D6 不授予 Administration/Workflows）**雙重執行**——符合 D4 雙層 guardrail 的精神：提示可能被忽略，權限不會。

### 3.4 任務描述的自足性要求

因 §1.2 的限制（無互動追問），CI 送出的任務描述必須自足。建議結構：

```
處理 GitHub Issue #<n>（repo: <owner>/<repo>）。

1. 先載入並遵循 .dsh/skills/ 中的 factory-workflow 與 factory-stop-rules。
2. 讀取該 Issue 的內容與驗收條件。
3. 依 factory-pr-stacking 的規則拆分並建立 stacked PR。
4. 完成後在 Issue 留言回報產出的 PR 編號。

若觸發任何停手規則，依該規則處理後結束。
```

> **注意**：任務描述本身**不重複 skill 的內容**，只指向它。理由：skill 會演進，任務模板若複製其內容就會漂移（`01` §3 消除清單 E6 的同一個道理）。

---

## 4. 在 GitHub Actions 中執行（D7）

### 4.1 工作流骨架

```yaml
# .github/workflows/factory-run.yml
name: Factory Run
on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: 目標 Issue 編號
        required: true
        type: number

# 最小權限：僅宣告本 job 自身所需
permissions:
  contents: read

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30        # 硬性上限，對應 02 §6 的逾時降級
    steps:
      - uses: actions/checkout@v7

      # D6：以 GitHub App 身分取得短效 token
      - name: Mint app token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.FACTORY_APP_ID }}
          private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}

      - uses: actions/setup-node@v7
        with:
          node-version: 22

      - name: Run factory agent
        id: agent
        env:
          # 憑證以環境變數參照傳遞，不寫入設定檔（見 05）
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        run: |
          set -o pipefail
          npx -y @deepseek-ai/dsh --profile factory \
            "$(cat .github/factory/task-template.txt | \
               sed 's/<ISSUE>/${{ inputs.issue_number }}/')" \
            | tee agent-output.txt

      # exit code 判讀由上一步的非零退出自動處理；
      # 失敗時執行以下標記步驟
      - name: Mark needs-human on failure
        if: failure()
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          gh issue edit ${{ inputs.issue_number }} --add-label needs-human
          gh issue comment ${{ inputs.issue_number }} \
            --body "工廠執行失敗（run: ${{ github.run_id }}），已交還人類處理。"
```

> ⚠️ **待實作驗證**：
> - `npx -y @deepseek-ai/dsh` 在 CI 中的安裝方式與版本鎖定策略（**必須鎖版**，浮動版本會使執行不可重現）。
> - `actions/create-github-app-token@v3` 的**輸出欄位名稱**（版本號已查證為當前最新，欄位名未驗證）。
> - DSH 在 Linux runner 的沙箱行為（landlock 為 Linux 機制，本機 macOS 無法驗證）——這是 Q02-2。
>
> ✅ **已查證**：`actions/checkout@v7`、`actions/setup-node@v7` 為當前最新主版本。**v4 已被 GitHub 棄用**（其 Node 20 執行環境已被強制改跑 Node 24），本專案不使用。

### 4.2 exit code 的處置對照

| exit code | 意義（已查證） | CI 動作 |
|---|---|---|
| **0** | 最終 `turn/end` 完成 | 續行後續步驟；stdout 內容記入 run log |
| **1** | 其他情況；stderr 含錯誤代碼與訊息 | 標記 `needs-human`，附上 stderr，**不自動重試** |

**不自動重試的理由**（`02` §6）：LLM 執行具非決定性，盲目重試會放大成本且可能產生不同的錯誤產出。僅**已知的暫時性錯誤**（網路、API 限流）才適合自動重試，且應在 DSH 層（`dsh-llm-retry` 已存在）而非 CI 層處理。

> **重要提醒**：exit 0 代表「agent 的回合正常結束」，**不代表「任務正確完成」**。任務正確性由 GitHub 層的 required checks 與人類審查判定（D4）。**絕不可把 exit 0 當作品質保證**——這是本契約最容易被誤解的一點。

### 4.3 平行化與資源上限

`00` §3 Phase 2 Step 1 要求以非同步平行化避免閒置等待。在 GitHub Actions 中：

- 不同工作項的 run **天然平行**（各自獨立的 workflow run）。
- 受 GitHub Actions 的並行數上限約束（D7 的已知後果）。
- 建議以 `concurrency` 群組**避免同一 Issue 被重複觸發**：

```yaml
concurrency:
  group: factory-${{ inputs.issue_number }}
  cancel-in-progress: false   # 不取消進行中的執行，避免產生半成品
```

---

## 5. 成本控制（支柱四的執行面）

**已查證的機制**：`dsh-token-meter` 提供以 session 為單位的 token 計量（`measure(session)` 回傳請求壓力與當前表面 token 數）；`dsh-session-telemetry-otel` 提供 OTel 遙測輸出。

**工廠的成本控制策略**（三層）：

| 層 | 機制 | 作用 |
|---|---|---|
| 1. 硬性時間上限 | Actions `timeout-minutes: 30` | 最終保險，必然生效 |
| 2. Token 上限 | token-meter 讀數 | ⚠️ 中止門檻值待定（Q02-5，需先取得基線） |
| 3. 事後歸因 | OTel → 指標後端 | 供 `08` 的「每工作項成本」指標 |

> **第 2 層的誠實說明**：目前**尚無基線數據**可據以設定合理門檻。過低會頻繁誤中止，過高則形同虛設。因此第一階段**先只做量測不做中止**（第 1 層的時間上限已提供保護），累積數週數據後再設門檻。這比憑空定一個數字更負責。

---

## 6. 本平面的介面契約

| 介面 | 方向 | 契約 |
|---|---|---|
| 任務輸入 | CI → DSH | 命令列位置參數的自足任務描述（非空） |
| 結果輸出 | DSH → CI | stdout 最後一則 assistant 文字 |
| 成敗判定 | DSH → CI | exit code 0/1 |
| 錯誤細節 | DSH → CI | stderr（僅失敗時非空） |
| 版控操作 | DSH → GitHub | 透過 `gh` CLI 與 `gh stack`，使用 App token |
| SOP 來源 | repo → DSH | `.dsh/skills/`（rank 100） |

**替換性**：任何滿足「一次性呼叫 + 自足任務 + exit code + stdout」契約的執行器都可替換 DSH（`02` §5）。此契約刻意保持最小。

---

## 未決事項

| 編號 | 事項 | 影響 | 處置 |
|---|---|---|---|
| Q04-1 | `headless`/`factory` profile 的實際佈建方式（`$DSH_HOME/profiles` 目前只有 `web`） | §2.2 無法執行 | **實作第一步驗證**（= Q02-1） |
| Q04-2 | `cordis.patch.yml` 中 sandbox 與 approval 的**確切列 id 與 config 結構** | §2.3 的 guardrail 覆寫 | 以 `dsh --dump-config` 檢視實際組成後修正 |
| Q04-3 | DSH 在 Linux runner 的沙箱行為（landlock） | CI 的實際隔離強度 | 實作時在 CI 中驗證（= Q02-2） |
| Q04-4 | DSH 版本鎖定策略與 CI 安裝方式 | 執行可重現性 | **必須鎖版**；方式待定 |
| Q04-5 | token 中止門檻值 | §5 第 2 層 | 先量測數週再定（= Q02-5） |
| Q04-6 | `workspace-write` + `approval: never` 的組合是否需自訂 permission preset | §2.3 | 實作時驗證 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
