# 15 — 觀察期試跑紀錄

> **依據**：`14-observation-period.md` §2（觀察期試跑）、`11-test-strategy.md` §6（mutation-strength tests）。
> **目的**：逐條記錄 `meta/observation` 試跑工作項的**產出與誠實停手結論**，讓 docs/14 §2.2 的期檢有實質數據。
> **讀者**：審查 factory PR 的人、每期結束做檢視的人

---

## 1. 試跑紀錄

| # | 工作項 | 方法 | 產出 | 備註 |
|---|---|---|---|---|
| 45 | `factory-judge loadReport` mutation 掃描 | mutation-strength tests（型別契約） | 見 Issue #59 留言 | 4 個存活變異（M1–M4）補釘 |
| 48 | `apply-judge-labels` 純函式 mutation 掃描 | mutation-strength tests（純函式契約） | 見 Issue #72 留言 | 3 個存活變異（M1–M3）補釘 |
| 52 | `runCli` 成功輸出格式 mutation 掃描 | mutation-strength tests（輸出格式契約） | 見 Issue #83 留言 | 3 個存活變異（M1–M3）補釘 |
| 49 | `buildHandoverReport` 格式 mutation 掃描 | mutation-strength tests（手動報告格式契約） | 見 Issue #80 留言 | 4 個存活變異（M1–M4）補釘 |
| 82 | `factory-score` zod 強制轉型 mutation 掃描 | mutation-strength tests（zod 強制轉型契約） | 見 Issue #82 留言 | 3 組存活變異（M1/M2/M3+4）補釘 |
| 50 | `dry-run-agent` 情境報告 mutation 掃描 | mutation-strength tests（情境契約） | 見 Issue #81 留言 | 3 個存活變異（M1–M3）補釘 |

### 1.1 #45 — factory-judge loadReport（觀察點）

- **目標**：mutation 驗證 `loadReport`（`docs/02 §4`、`docs/06 §5.1`）——證明對 agent 自報 `report.json` 的 zod 型別看守有「牙齒」。
- **發現**：既有 `factory-judge.test.ts`（24 則）只測「欄位缺席」與「欄位完全錯型別」（如 `changedPaths: 'str'`），從未傳過「欄位換型別」的含糊值。對四條**選填欄位**的型別契約（元素型別、數值/布林型別）是完全未覆蓋的——下列每個變異在既有套件下都存活（全綠）：
  - M1 `changedPaths` 元素 `string` → `string|number`
  - M2 `changedLines` `number` → `number|string`
  - M3 `invocation.timedOut` `boolean` → `boolean|string`
  - M4 `hasAcceptanceCriteria` `boolean` → `boolean|string`
- **實作**：新增 `src/cli/factory-judge-mutation.test.ts`（8 則，每變異配 1 反例 + 1 錨定），四變異皆實測「變異→紅、還原→綠」。
- **價值**：這四條選填欄位各自對應一個**許可決策路徑**（`changedLines`/`assertionDelta` 影響計分、`timedOut` 影響 needs-human 判讀、`hasAcceptanceCriteria` 觸發 SR4）。過去放寬其中任何一條都不會讓任何既有測試變紅；補釘後這類回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下，不能再悄悄溜進。

### 1.2 #48 — apply-judge-labels 純函式（觀察點）

- **目標**：mutation 驗證 `apply-judge-labels` 的純函式 `computeJudgeLabels`/`buildJudgeComment`（`docs/02`、`docs/06 §5.1`）——證明套件對這顆標籤貼附決策有「牙齒」，並落實 Issue「純函式」的無副作用契約。
- **發現**：既有 `apply-judge-labels.test.ts`（10 則）對純函式只用 `toContain(..)`，有三條隱性契約完全未釘住，下列變異在既有套件下都存活（全綠）：
  - M1 去除 needs-human 去重守衛（一律 push）→ 重複 `needs-human` 標籤不被抓
  - M2 `const labels = [...judge.labels]` 改成直接參考 `judge.labels`（push 污染輸入陣列）→ 純函式無副作用契約失效不被抓
  - M3 留言標頭 `## 工廠執行結果：` 被改寫 → 判讀標頭格式不被抓
- **實作**：新增 `src/cli/apply-judge-labels-mutation.test.ts`（5 則），三變異皆實測「變異→紅、還原→綠」，且既有套件下皆存活（Before GREEN / After RED）。
- **價值**：標籤貼附是**監督決策的輸出載體**（`needs-human`/`oversight/*` 決定誰審、審不審）。過去誤刪去重守衛、把純函式改成有副作用、或抽換留言標頭，都不會讓既有測試變紅；補釘後這三類回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下。

### 1.3 #52 — runCli 成功輸出格式（觀察點）

- **目標**：mutation 驗證統一外殼 `runCli` 的**成功輸出格式**契約（`docs/02`、`docs/06 §5.1`；phase1 plan §Task2 定明輸出為 `JSON.stringify(main(...), null, 2) + '\n'`）——它是 Task 2–7 所有 factory CLI 共享的 stdout 進入點，證明套件對「成功輸出必須是 2-space 漂亮列印 + 行尾換行」這條介面契約有「牙齒」。
- **發現**：既有 `run-cli.test.ts`（10 則）對成功輸出一律用 `JSON.parse(io.out.join(''))` 驗證，而 `JSON.parse` 會**容忍縮排與行尾換行差異** —— 因此三種輸出格式變異在既有套件下全部存活（全綠）：
  - M1 移除 `null, 2` 縮排 → 輸出被壓成單行，`JSON.parse` 仍可解析
  - M2 省略成功輸出的行尾 `\n` → 仍可解析
  - M3 縮排 `2` → `4`（或改為 tab）→ 仍可解析
- **實作**：新增 `src/cli/run-cli-output-mutation.test.ts`（6 則），三變異皆實測「變異→紅、還原→綠」，且既有套件下皆存活（Before GREEN / After RED）。
- **價值**：輸出格式是 CI 與下游工具讀取 CLI 結果的**行式介面契約**（shell 命令替換、尾隨工具、逐行解析皆依賴）。過去抽換縮排或行尾換行不會讓任何既有測試變紅；補釘後這類輸出格式回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下。

### 1.4 #49 — buildHandoverReport 格式（觀察點）

- **目標**：mutation 驗證 `buildHandoverReport`（`docs/07 §4.2`）——證明這份停手交還報告的**格式結構**有「牙齒」。
- **發現**：既有 `stop-rules.test.ts`（45 則）對報告的所有斷言都只用 `toContain(..)`，只驗證子字串存在，對「格式」完全沒有牙齒。下列四個格式結構變異在既有套件下都存活（全綠）：
  - M1 去除每條違規的圓點前綴 `- `（Markdown list → 純文字段落）
  - M2 去除 rule 識別碼的加粗 `**`（`**SRn-*` → `SRn-*`）
  - M3 全形冒號分隔 `：` 改 ASCII `:`（`**rule**：` → `**rule**: `）
  - M4 一行一條被破壞（`join('\n')` 改空白，全部黏成一行）
- **實作**：新增 `src/stop-rules/stop-rules-mutation.test.ts`（10 則，每變異配反例 + 錨定，另附整份格式快照），四變異皆實測「變異→紅、還原→綠」。
- **價值**：這份交還是人類接手停手工作項的人手入口，靠開頭標頭、逐條圓點清單、加粗識別碼、一行一條來辨識與瀏覽。這四類格式退化過去不會讓任何既有測試變紅；補釘後在 CI gate（`src/stop-rules/**` 100% branch）就會被攔下。

### 1.5 #82 — factory-score zod 強制轉型（觀察點）

- **目標**：mutation 驗證 `factory-score` 的 zod 強制轉型（`docs/02`、`docs/06 §5.1`）——證明 `loadScoreInput` 對 catalog 的 `factory.io/*` annotation 從「string/number/boolean 純量」強制轉成字串的契約有「牙齒」。
- **發現**：既有 `factory-score.test.ts`（28 則）只測到 `agent-automerge: false`（boolean → 'false'，否決）與 `risk-profile: 3`（integer → '3'，fail-safe 2），從未傳過「非否決值的 boolean」、非整數的 number、或 number/boolean 的技術棧欄位。下列變異在既有套件下全部存活（全綠）：
  - M1 把 boolean 一律轉成 `'false'`（丟失 true 的極性）→ `agent-automerge: true` 這個「明確允許」的宣告會被誤判成否決
  - M2 把 number 一律 `Math.trunc` 取整（丟失小數）→ `complexity: 1.5` 會被悄悄截成 `'1'`
  - M3/M4 技術棧欄位（stack/test-framework）繞過轉型直接取原始值 → `test-framework: true` / `stack: 2024` 退回 undefined，技術棧宣告悄悄失效
- **實作**：新增 `src/cli/factory-score-mutation.test.ts`（6 則），M1、M2、M3/M4 三組變異皆實測「變異→紅、還原→綠」，且既有套件下皆存活（Before GREEN / After RED）。
- **價值**：`factory-score` 是 agent 之前的初始計分 gate（`docs/06 §5.1`），強制轉型的目的是讓 score() 的 `agentAutomerge?.trim()` 與 resolveAxis 永遠看到字串，不會因未加引號的 YAML 純量而當掉或悄悄改變分數。過去若有人把 boolean/number 轉型做成失真、或讓技術棧欄位繞過轉型，都不會讓任何既有測試變紅；補釘後這三類回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下。

### 1.6 #50 — dry-run-agent 情境（觀察點）

- **目標**：mutation 驗證 `dryRunReport`（`src/cli/dry-run-agent.ts`，docs/11 §4.3 的 stub 情境報告）——證明套件對三種情境報告的形狀契約有「牙齒」，而非只是行覆蓋。
- **發現**：既有 `dry-run-agent.test.ts`（9 則）對 `success`/`guardrail`/`blocked` 各只釘住一、兩個欄位（如 changedPaths 內容、assertionDelta > 0、scenario === 'blocked'），下列三條隱性契約完全未覆蓋，變異後仍全綠（存活）：
  - M1 `success` 把 `changedLines` 從 40 誤改成 0（宣稱改檔卻 0 行）→ 自相矛盾行數主張不被抓
  - M2 `guardrail` 把 `hasAcceptanceCriteria` 誤設成 false（被當成缺驗收）→ SR4 許可判讀不被抓
  - M3 `blocked` 誤帶 changedPaths（宣稱改檔）→ 污染計分/終點判定不被抓
- **實作**：新增 `src/cli/dry-run-agent-mutation.test.ts`（4 則），三變異皆實測「變異→紅、還原→綠」，且既有套件下皆存活（Before GREEN / After RED）。
- **價值**：情境報告是 `factory-run.yml` 流程接線的終點契約（`hasAcceptanceCriteria` 觸發 SR4、changedPaths/changedLines 影響計分）。過去誤改 success 行數主張、放寬 guardrail 驗收判讀、或讓 blocked 宣稱改檔，都不會讓既有測試變紅；補釘後這三類回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下。

每次試跑結果在對應 Issue 留言回報 PR 編號；缺陷標記依 `14` §1 紀律。

---

## 2. fubon-tradingbot 試點紀錄（Phase 2 T8）

> **依據**：`docs/superpowers/plans/2026-08-18-phase2-expansion.md` Task 8、docs/09 §3 2.2/2.3。
> **目的**：驗證工廠移植到第二 repo（真實交易 bot）時，計分閘門、App 認證、Guard 與「main 絕不觸碰」約束在目標 repo 上正確運作。

### 2.1 前置（人類 + 草稿）

- `software-factory` 分支已於 fubon-tradingbot 建立（**main 未觸碰**，SHA 前後一致 `d01aed8d`）。
- App `software-factory-worker` 已安裝至 fubon-tradingbot（權限同 D6）。
- 設定已登錄至 `software-factory` 分支（commit `98d4e3d`）：catalog（strategic/high/high）、risk-paths（H1–H7 依實際結構）、5 個 task-template、4 個 factory skill、CODEOWNERS、`options-seller.qnt`（人類撰寫的 Quint 模型）。
- 草稿來源：`trial/fubon-tradingbot/`（PR #107）。

### 2.2 試點 #1 — 高風險計分閘門（2026-08-18，run 32155833121）

| 驗證點 | 結果 |
|---|---|
| Guard：`repo=fubon-tradingbot` + `base_branch=software-factory`（非 main）| ✅ 通過 |
| App token mint（`repositories: philipz/fubon-tradingbot` 最小權限）| ✅ 成功（App 已安裝）|
| 目標 repo checkout（App token 認證）| ✅ fubon-tradingbot@software-factory |
| 標籤在目標 repo 建立（GH_REPO）| ✅ oversight/*、needs-human、ready |
| App token 寫入權限探針（push 到 fubon-tradingbot）| ✅ 成功，探針分支已刪除 |
| 計分讀目標 repo 的 catalog/risk-paths | ✅ **total=6 → tier=in-loop → label=oversight/in-loop** |
| 阻斷鏈路 | ✅ Apply score labels exit 1 → Stop when in-loop → **agent 從未啟動** |
| Issue 標籤/留言（App 身分）| ✅ #567 貼 `oversight/in-loop` + 留言「工廠執行未啟動：初始計分 6 分屬 human-in-the-loop（docs/06 §4.3）。設計與實作須由人類主導。」 |
| **main 未被觸碰** | ✅ SHA 前後一致（`d01aed8d...`）|

**結論**：高風險 repo 的計分/標籤/阻斷鏈路移植成功——catalog 三軸（strategic/high/high = 6 分）在目標 repo 正確映射為 in-loop 阻斷，且全程未觸碰 main。docs/09 §3 2.2/2.3 的移植驗證完成。

**後續**：若要讓 agent 在 fubon-tradingbot 實際執行動作型工作項，需另行裁決是否調降 catalog 某軸（目前全高風險 → 一律 in-loop）——那屬於「低風險工作項」試點範疇，與本次「高風險計分驗證」目的不同。

### 2.3 試點 #2 — 跨 repo agent 動作（2026-08-18，run 32158763565）

**前置**：裁決 #568 通過（complexity high→low，total 6→4 → review tier）；catalog 已更新至 software-factory 分支（commit e33a128a；期間誤刪 options-seller.qnt 已於 cc2ddeff 恢復）。

| 驗證點 | 結果 |
|---|---|
| 初始計分（complexity: low 生效）| ✅ total=4 → **review**（不再 in-loop 阻斷）|
| Issue #569 標籤 | ✅ `oversight/review` |
| **agent 跨 repo 執行**（讀碼→npm ci→寫測試→跑測試→建 PR）| ✅ **成功**：產出 PR #570（+33 行，`test/jest/TimeUtils.test.ts`，base=**software-factory**）|
| agent 驗證 | ✅ `npm run test:jest:unit`：190 suites / 4820 tests 全綠；未改 src 行為、未碰 H1–H3 |
| judge 終態 | ✅ ready-for-review（計分 4 分需人類審查）|
| Issue 留言 | ✅ agent 完成回報 + factory 判定留言 |
| **main 未被觸碰** | ✅ SHA 前後一致（`d01aed8d...`）|

**發現 1（紀律偏差，Q04-9 驗證點）→ 根因已查明並修正（PR #113）**：分支命名為 `factory-569-01-test`（dash）而非規範的 `factory/569-01-test`（slash）。功能無礙（PR body 含 `Closes #569`，rescore 仍能找到 Issue），但**根因不是 agent 不守紀律**——CI 鎖定的 gh-stack **v0.1.0 不接受 skill 教的 `--numbered`/`--prefix`**（先前 docs/07 Q07-2 的「實測」在本機舊版 0.0.2 上做、誤標 v0.1.0），agent 被迫自創分支名。修正：skill/docs 改用 v0.1.0 的 positional 用法（`gh stack init --base $BASE_BRANCH factory/<issue>-01-test ...`，本機交叉驗證 slash 保留）；對抗性測試釘住不含舊旗標；fubon-tradingbot 分支的 skills 已同步（951137ff）。

**發現 2（隱藏 bug）**：手動 rescore PR #570 首次失敗——`.factory/` 被 gitignore、fresh checkout 不存在，`> .factory/rescore.json` redirect 失敗。**舊 workflow 的 Rescore 步驟從未被 factory/* PR 真實執行過**（先前 PR 皆非 factory 分支 → 步驟 skipped → 顯示 SUCCESS）。已修（PR #111：`mkdir -p .factory`）並重新驗證：rescore 對 PR #570 正確執行（total=4、before=after=review、不升級、無誤留言）。

**待辦（人類）**：審查 PR #570（`test/jest/TimeUtils.test.ts`）後合併至 software-factory 分支（單一 PR，直接 `gh pr merge --squash --delete-branch`）。

### 2.4 試點 #3 — 跨 repo 多層 stacked PR + 命名修正驗證（2026-08-18，run 32163540668）

**工作項**：#571（agent-fix-bug：`TimeUtils.isWithinTimeRange` 不支援跨午夜範圍——數學可證的缺陷，與同 repo `SessionHelpers` 的跨午夜語義不一致）。

| 驗證點 | 結果 |
|---|---|
| **命名修正（Q07-2）** | ✅ 分支為 `factory/571-01-test` / `-02-impl` / `-03-docs`（**slash 分隔**）——新 skill 的 positional init 指令生效（PR #113 修正驗證）|
| **三層 stacked PR** | ✅ PR #572（test +20 行）/ #573（impl +4 行）/ #574（docs +3 行），base 全為 software-factory，每層獨立綠燈 |
| agent 驗證 | ✅ `npm run test:jest:unit` 全綠；測試先紅後綠 |
| judge 終態 | ✅ ready-for-review（計分 4 分）|
| **main 未被觸碰** | ✅ SHA 前後一致（`d01aed8d...`）|

**價值案例（兩次誠實停手，SR4 真實運作）**：
1. 第一次執行：agent 抓到我寫的驗收條件筆誤（`22:30 → true` 數學上不可能——22:30 在 23:00 之前、屬範圍外；正確案例應是 `23:30 → true`）。agent **未猜測、未硬寫必紅測試、未動程式**，依 SR4 停手等裁決。
2. 人類修正 Issue 時第一次 sed 替換**沒生效**（markdown 反引號使模式未匹配），agent 第二次執行讀到仍是矛盾的 body → **再次正確停手**。第三次（body 真正修正後）才執行。
3. 教訓：人類側的「已修正」須驗證生效（grep 確認），不能假設 edit 成功。

**小瑕疵**：Issue 標籤 `needs-human`（第一次停手 run 貼的）在第三次 run 後未被移除（apply-judge-labels 為 add-only）——標籤殘留不影響判定，記錄待後續改進。

**待辦（人類）**：審查並依 stack 順序合併 PR #572 → #573 → #574（stacked PR 需逐層；合併被擋時先 `gh stack checkout <PR>` + `gh stack unstack`）。

### 2.5 試點 #3 補記 — CI 缺口與 TDD×stacked PR 張力（2026-08-18）

**發現 3（CI 缺口）**：用戶指出 fubon-tradingbot 的 Actions 頁面「沒有 CI」。調查發現 repo **有** `test.yml` 但其觸發條件 `branches: [main, develop]` 排除 software-factory——試點 #2/#3 的 factory/* PR **只有 agent 自報測試、無獨立 CI 驗證**（違背「GitHub Actions runs tests」）。且串聯 stacked PR 的中間層 base 是前一層分支（如 `base=factory/571-01-test`），僅加 software-factory 仍只觸發最底層。修正（commit 32e766f2）：
- `push: [main, develop, software-factory]`
- `pull_request: [main, develop, software-factory, 'factory/**']`

**發現 4（TDD「先紅」× stacked PR「每層獨立綠燈」張力）**：CI 啟用後 PR #572（01-test 層）**test FAILURE**——agent 的跨午夜「先紅」測試（普通 `it()`）在 01-test 單獨層（不含 02-impl 修復）必然紅。agent 沒做錯，是流程規格缺口。修正（PR #116）：
- 紅燈驗證在 agent 沙箱內完成（寫測試→跑紅→實作→跑綠）
- 01-test 層以 `it.skip` 提交（斷言保留、CI 綠）
- 02-impl 層 un-skip（`it`）並含修復，CI 以已修復的測試驗證
- 已寫入 docs/07 §2.2 + factory-workflow skill + fubon 分支同步（64c8125f）

**驗證**：修正後三層 PR #572/#573/#574 **全部獨立綠燈**（test SUCCESS）——CI 獨立驗證（對比 agent 自報）完整生效。**教訓**：agent 自報「測試全綠」≠ CI 綠燈；目標 repo 的 CI 觸發條件必須涵蓋 factory 分支與串聯 base。

### 2.6 試點 #3 合併流程實錄（2026-08-18，stack 合併教訓）

試點 #3 的三層 PR（#572/#573/#574）合併過程的實際操作與教訓：

1. **stack 限制**：`gh pr merge` 被擋「part of a stack, use the asynchronous merge REST API」→ 依 docs/07 §3.5 `gh stack checkout <PR>` + `gh stack unstack`（**一次解除整疊**——一個 stack 物件涵蓋全部三層，unstack 後各 PR 變普通 PR）。
2. **底層合併刪除 base → 上層自動關閉**：#572（base=software-factory）合併後刪除 `factory/571-01-test` → #573（base=該分支）**自動 CLOSED**；`gh pr reopen` 失敗（「Could not open the pull request」，base 分支已刪）。
3. **重建為 trunk-based 新 PR**（docs/07 §3.5 精神）：head 分支（`factory/571-02-impl`、`factory/571-03-docs`）仍在 → `gh pr create --base software-factory --head <同一分支>` → 新 PR #576/#577。diff 自動只剩該層變更（下層內容已在 trunk）。
4. **squash 合併的 SHA 分歧 → DIRTY**：#576 重建後 CONFLICTING（02-impl 分支含原始 commit，trunk 是 squash commit → 同檔兩版）→ GitHub `update-branch` 無法自動解（`Cannot update PR branch due to conflicts`）→ **本地解決**：`git merge origin/software-factory` → 衝突在 `TimeUtils.test.ts`（skip vs un-skip 版）→ `git checkout --ours` 保留 impl 層的 un-skip 版 → push。
5. **結果**：#572 → #576（impl）→ #577（docs）全合併；`factory/*` 分支全清理；**main 未觸碰**。

**教訓**：gh-stack 串聯 PR 的合併摩擦（base 分支連鎖刪除 + squash SHA 分歧）是**程序性成本**——docs/07 §3.5 已記錄、觀察期指標追蹤（審查等待時間）。本次實作驗證了重建流程可行（head 分支保留 + trunk-based 新 PR + 本地解衝突）。

---

## 3. Java/Spring Boot 試點（spring-modulith-orders，語言無關性驗證）

> **依據**：docs/09 §3 2.2「2–3 個 repo」延伸——驗證 factory 的 config-only 移植在**不同語言**（Java/Spring Boot）repo 照常運作。機制不變（software_factory 集中），目標 repo 只放設定。

### 3.1 前置（2026-08-18）

- `software-factory` 分支已建立（gh api 建 ref，**main 未動**，SHA `5107180e` 前後一致）。
- App `software-factory-worker` 已安裝至 spring-modulith-orders（mint token 實測成功）。
- 設定已登錄（commit `5d767cf`）：catalog（strategic/high/high）、risk-paths（H1–H7 依 Java 結構）、CODEOWNERS、**新建 CI（test.yml——該 repo 原本無任何 workflow，觸發涵蓋 software-factory/factory/**，試點 #3 教訓）**、task-template × 5、factory skills × 4。
- 草稿來源：`trial/spring-modulith-orders/`（PR #121）。

### 3.2 試點 #1 — 高風險計分閘門（2026-08-18，run 32208975486）

| 驗證點 | 結果 |
|---|---|
| Guard（base=software-factory）| ✅ |
| App token mint（repositories 限定目標 repo）| ✅（App 已安裝）|
| 目標 repo checkout + 寫入探針 push | ✅ |
| 計分讀 Java repo 的 catalog/risk-paths | ✅ **total=6 → in-loop → agent 未啟動** |
| Issue #1 標籤/留言 | ✅ `oversight/in-loop` + 阻斷說明 |
| **main 未被觸碰** | ✅ SHA 前後一致（`5107180e...`）|

**結論**：高風險 Java repo 的計分/標籤/阻斷鏈路移植成功——與 fubon 試點 #1 完全同行為，**計分機制語言無關**獲實證。裁決 Issue #2（complexity high→low）後進行動作型工作項實跑驗證。

### 3.3 試點 #2 — Java 動作型工作項（2026-08-18，run 32210313050）

**前置**：裁決 #2 通過（complexity high→low，total 6→4 → review tier）；catalog 已更新（commit 20e5696，main 未動）。

| 驗證點 | 結果 |
|---|---|
| 初始計分（complexity: low 生效）| ✅ total=4 → **review**（agent 啟動）|
| Issue #3 標籤 | ✅ `oversight/review` |
| **agent 跨語言執行**（讀 Java 碼→寫 JUnit→跑 mvn→建 PR）| ✅ 產出 PR #4（+394 行，`CacheErrorHandlerTests.java`，base=**software-factory**）|
| agent 驗證 | ✅ `./mvnw test -Dtest=CacheErrorHandlerTests`（JDK 21）：**15 tests 全綠**；無參數 constructor 直測、不需 Spring context |
| 分支命名（Q07-2 修正持續生效）| ✅ `factory/3-01-test`（slash）|
| judge 終態 | ✅ ready-for-review（計分 4 分）|
| **新建 CI 對 factory/* PR 獨立驗證** | ✅ test.yml（該 repo 原本無 CI）對 PR #4 跑 `./mvnw test` → **SUCCESS**——CI 移植 + 語言無關性完整驗證 |
| **main 未被觸碰** | ✅ SHA 前後一致（`5107180e...`）|

**結論**：agent 在 Java/Spring Boot repo 完整工作（讀碼、寫 JUnit、跑 Maven、建 PR）——**語言無關性獲實證**（與 fubon TS 試點同行為）。Java 特定環境（JDK 21、mvnw、測試耗時）在真實執行中自然處理。

**待辦（人類）**：審查 PR #4 後合併至 software-factory 分支。

---

## 4. 教訓補記（meta/observation，不動 §1–§3 既有紀錄）

### 4.1 跨 session/turn 的 git 狀態必須重查（2026-09-01，SWEBOK 討論）

**背景**：2026-09-01 SWEBOK 討論中，兩個 agent session 皆在分支歸屬上用舊資訊宣稱（deepseek/Opus5 分支），而 `git branch --show-current` 一次就能查清。這是「看起來太顯然，沒人重查」的靜默失敗模式。

**教訓**：跨 session/turn 協作時，git 分支與工作樹狀態可能已變；宣稱任何狀態前以 `git branch --show-current` / `git cat-file -e HEAD:<path>` 重查；「上輪查過」不算數。
