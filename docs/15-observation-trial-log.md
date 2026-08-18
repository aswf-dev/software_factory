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
