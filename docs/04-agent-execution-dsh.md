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

> ✅ **Q02-1/Q04-1 已實測解決（2026-08-16）**：**profile 目錄會自動佈建**，無須手動建立。首次執行 `dsh --profile headless "<task>"` 後，`$DSH_HOME/profiles/headless/` 隨即出現，內含 `package.json`（bundles: `dsh-base` + `dsh-headless`）與空的 `cordis.patch.yml`（內容為 `[]`，即預留給使用者的覆寫層）。
>
> **因此工廠不需要另建 `factory` profile**——直接沿用自動佈建的 `headless` profile，再以 `--patch` 施加 guardrail 即可（見 §2.3）。這比自建 profile 更簡單且更少維護面。

### 2.3 guardrail 覆寫層的內容（✅ 已實測驗證）

**實測取得的列 id 與結構**（以 `dsh --profile headless --dump-default-config` 檢視）：

| 列 id | 套件 | 預設值 |
|---|---|---|
| `sandbox-policy` | `dsh-sandbox-policy` | `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`、`workspaceRoot: process.cwd()` |
| `approval` | `dsh-user-approval` | `policy`：僅當 `DSH_PERMISSION_MODE === 'danger-full-access'` 時為 `never`，**否則為 `ask`** |
| `permission` | `dsh-permission-presets` | 內建三組 preset：`read-only`、`workspace-write`（皆 `approval: ask`）、`danger-full-access`（`approval: never`） |

> **關鍵發現**：內建 preset 中**沒有 `workspace-write` + `never` 的組合**——而這正是工廠需要的（要能寫 workspace，但 CI 中不可等待人工核准）。這解答了 Q04-6：**必須自訂 preset**。

```yaml
# 工廠的 guardrail 覆寫層（實測可用）
# 用法：dsh --profile headless --patch <此檔路徑> "<任務>"

# 沙箱：限定 workspace-write，永不使用 danger-full-access
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()

# 核准政策：CI 無人可回應，必須為 never（拒絕而非等待至逾時）
- id: approval
  config:
    policy: never

# 組合出的 workspace-write + never 不符任何內建 preset，
# 若不明確宣告，dsh-permission-presets 會在載入期直接失敗。
- id: permission
  config:
    defaultPreset: factory-ci
    presets:
      factory-ci:
        sandbox: workspace-write
        approval: never
      read-only:
        sandbox: read-only
        approval: ask
```

> **第三段是實測撞出來的**：只寫前兩段會得到載入期錯誤——
> `permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly`
>
> 這個錯誤**不會**在 `--dump-config` 中顯現（該指令只印出組成後的設定樹，不執行外掛）。**只有實跑才會發現**。這正是本專案堅持「實測而非推論」的具體理由。

**設計理由**：

1. **`mode: workspace-write` 而非 `danger-full-access`**：agent 只需改動該次 run 的 workspace。已查證 `dsh-sandbox-policy` 的預設是 `read-only`（fail-safe），三種模式為 `read-only` / `workspace-write` / `danger-full-access`。
2. **`approval/policy: never`**：CI 中無人可回應核准提示。設為 `never` 使需要核准的操作**直接被拒絕**，而不是無限等待到 job timeout。這是「快速失敗優於靜默卡死」的落實。

### 2.4 實測驗證結果（2026-08-16，macOS 本機）

以上設定已用真實任務逐項驗證，非推論：

| # | 測試 | 指令要點 | 結果 |
|---|---|---|---|
| 1 | **正常任務** | 讀取檔案並回覆內容 | ✅ **exit 0**、stdout 為檔案內容、**stderr 空白** |
| 2 | **空任務拒絕** | 任務字串為 `"   "` | ✅ **exit 1**、stderr：`error: a task is required...` |
| 3 | **profile 自動佈建** | 首次執行後檢視 `$DSH_HOME/profiles/` | ✅ `headless/` 自動出現，含空 patch 層 |
| 4 | **guardrail 生效** | 套用 §2.3 patch 後寫入 workspace 內檔案 | ✅ exit 0、檔案正確建立 |
| 5 | **preset 缺失會失敗** | 只設 sandbox+approval 不設 preset | ✅ **載入期即失敗**（快速失敗，非靜默降級） |
| 6 | **沙箱確實阻擋** | 要求寫入 `$HOME/ESCAPE-TEST.txt` | ✅ **被拒絕**，回覆 `BLOCKED`，**檔案未被建立** |

> **測試 6 的一則重要修正**：最初的逃逸測試以 `/tmp/` 為目標，結果**寫入成功**。但這**不是**沙箱失效——`workspace-write` 模式明文允許平台暫存區，`/tmp` 正在允許清單內。真正的邊界測試必須落在 workspace 與暫存區**之外**（如 `$HOME`），改測後才確認阻擋有效。

### 2.5 Linux runner 實測（2026-08-16，縮小 Q02-2/Q04-3/Q05-2）

agent 實際執行環境是 Linux runner，而非開發者的 macOS。因此以 `.github/workflows/dsh-sandbox-probe.yml` 在 `ubuntu-latest` 上實測：

**平台事實**（探測輸出）：

| 項目 | 值 |
|---|---|
| OS | `Linux 6.17.0-1022-azure x86_64` |
| Kernel | **6.17**（landlock 需 ≥ 5.13，**遠高於門檻**） |
| LSM | `lockdown,capability,**landlock**,yama,apparmor,ima,evm` |

> ✅ **關鍵確認**：**`landlock` 確實存在於 runner 的 LSM 清單中**，代表 DSH 沙箱所依賴的核心機制在 CI 環境可用。這是先前只能推測的部分。

**已在 Linux 驗證的項目**：

| 檢查 | 結果 |
|---|---|
| guardrail 覆寫層可組成 | ✅ `mode: workspace-write`、`policy: never`、`defaultPreset: factory-ci` |
| 有效設定非 `danger-full-access` | ✅ 解析組成後設定確認 |
| 缺少 preset 仍**大聲失敗** | ✅ 載入期即中止，未靜默降級 |
| 空任務回傳 exit 1 | ✅ 與 macOS 行為一致 |

**執行期逃逸測試（2026-08-17 補測，Q02-2 完全解決）**：

設定 `ANTHROPIC_API_KEY` 至 repo secrets 後，已在 Linux runner 上實測真實 agent 的逃逸嘗試：

| 觀察項 | 結果 |
|---|---|
| agent 是否確實執行 | ✅ `exit=0`、stdout 有輸出、stderr 空白 |
| agent 回覆 | `BLOCKED` |
| `$HOME/ESCAPE-TEST.txt` | ✅ **未被建立** |

> ✅ **結論：DSH 沙箱在 Linux runner 上確實阻擋 workspace 外的寫入。** 這是 agent 實際執行的環境，因此本結論適用於生產路徑，而非僅開發者本機。

> ⚠️ **這項測試第一次是「假通過」**：agent 因路徑解析失敗而未執行，但檢查只看「檔案不存在」，於是回報了它從未驗證的安全性。修正後才取得上表的真實結果。詳見 `11` §9.2.2——**綠燈必須同時代表「行為確實發生」與「結果符合預期」**。
>
> 記錄此事的理由：**一個設計得不好的安全測試會給出虛假的安心感**。若當初止於 `/tmp` 的結果，就會誤判沙箱無效（假陰性）；反過來若把允許清單內的成功寫入當作「沙箱破了」，則是假陽性。安全測試必須測在正確的邊界上。

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
          # ⚠️ 實測（2026-08-18）：DSH sandbox 會剝離 process 環境變數——
          # GH_TOKEN **不會**傳進 agent 的 env（step 層 gh 可用，agent 內 gh 看不到）。
          # 因此 token 改以 workspace 檔傳遞（`.factory/run/gh-token`，gitignored、
          # 1 小時有效），由 factory-workflow skill 指示 agent 讀取（Q04-7）。
          # ANTHROPIC_API_KEY 仍以 env 傳遞（DSH 本身在 sandbox 外讀取）。
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          set -o pipefail
          npx -y @deepseek-ai/dsh@0.1.0-rc.6 --profile headless \
            --patch config/dsh/factory-guardrail.patch.yml \
            "$(sed "s/<ISSUE>/${{ inputs.issue_number }}/" .github/factory/task-template.txt)" \
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
| ~~Q04-1~~ | ~~profile 佈建方式~~ | **已實測解決** | ✅ **自動佈建**；工廠沿用 `headless` profile + `--patch`，不需自建（§2.2） |
| ~~Q04-2~~ | ~~sandbox/approval 的列 id 與結構~~ | **已實測解決** | ✅ 列 id 為 `sandbox-policy`／`approval`／`permission`（§2.3） |
| ~~Q04-6~~ | ~~是否需自訂 permission preset~~ | **已實測解決** | ✅ **需要**——內建無 `workspace-write`+`never` 組合，不宣告則載入期失敗（§2.3） |
| Q04-3 | DSH 在 Linux runner 的沙箱行為（landlock） | CI 的實際隔離強度 | 本機 macOS 已驗證阻擋有效（§2.4 測試 6）；**Linux 仍待驗證**（= Q02-2） |
| Q04-4 | DSH 版本鎖定策略與 CI 安裝方式 | 執行可重現性 | **必須鎖版**；方式待定 |
| Q04-5 | token 中止門檻值 | §5 第 2 層 | 先量測數週再定（= Q02-5） |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
