# ADR-016：agent 撰寫技能——「產出」與「生效」分離

- **狀態**：已接受
- **日期**：2026-09-05
- **決定者**：平台架構（依使用者提問「如何讓 DSH 擁有自行設計 Skill 的能力」而制定）
- **對應**：`25-skill-authoring-loop.md`（完整流程）、`docs/research/230`（Warp 實證）、`04-agent-execution-dsh.md` §3.2（skill 探索規則）、`05-guardrails-governance.md` §1.1（核心不變量）、`06-human-oversight-policy.md` §4.3、`ADR-004`（雙層 guardrail）、`ADR-012`（guardrail 集中化）

## 脈絡

工廠目前的技能（`.dsh/skills/factory-*`）是靜態配置：只能由人類修改並經 CODEOWNERS 審查。當現有 skill 不足以處理某類工作項時，**沒有訊號告訴人類該補什麼**，擴展路徑既慢又不可見。

自然的想法是讓 agent 自行撰寫技能。但這個說法有兩種語意，風險差距是數量級的：

| 語意 | 內容 |
|---|---|
| **A. 自主生效** | agent 寫出 skill 並讓它立即對自己生效 |
| **B. 自主產出＋人類放行** | agent 撰寫草案並開 PR，人類審查合併＋promote 後才生效 |

同時，實測確認 **A 目前在機制上已不可能**（並非僅是設計意圖）：

| 路徑 | Rank | 阻擋機制 |
|---|---|---|
| 目標 repo `.dsh/skills/` | 100 | `risk-paths.yml:42` H5 → risk=2 → 強制 in-loop，agent 不會被啟動；CODEOWNERS 再擋一層 |
| `$HOME/.dsh/skills/` | 400 | `factory-guardrail.patch.yml` 為 `workspace-write` ＋ `workspaceRoot: process.cwd()`（＝`target/`）→ `$HOME` 在沙箱外 |

## 決策

### 1. 永不採用 A（自主生效）

理由（三項，任一即足以否決）：

1. `docs/06` §4.3 明訂「**agent 不得驗證自己的產出並據以放行**」——agent 自寫 skill 再自己遵循，正是此禁令的教科書案例。
2. `docs/05` §1.1 核心不變量：**agent 必須永不能鬆綁自己所受的約束**。
3. 若 A 成立，`factory-stop-rules` 可被 agent 自行覆寫——**所有停手規則同時失效**。

### 2. 採用 B，並以「提案目錄」實現雙閘門

新增任務型別 **`agent-propose-skill`**，其產出寫入 **`proposals/skills/<name>/SKILL.md`**，**不是** `.dsh/skills/`。

**為何不直接寫 `.dsh/skills/`**（這是本 ADR 的安全樞紐）：

| 若直接寫 `.dsh/skills/` | 寫 `proposals/skills/` ✅ |
|---|---|
| 觸發 H5 → risk=2 → in-loop | 不在 H5 路徑上 |
| **一旦合併立即生效**，PR 審查與生效之間無緩衝 | **不在任何 DSH 探索 rank**（100＝`.dsh/skills`、200＝`.agents/skills`）→ **誤合併也不會生效** |
| 單閘門 | **雙閘門**：PR 審查 ＋ 人工 promote |

### 3. 四道閘門

```
crosscheck 邊界 → PR 審查 → 人工 promote → CODEOWNERS
```

1. **crosscheck 邊界**：`factory-crosscheck --propose-skill-only` 只允許 `proposals/skills/**` 與 `docs/**`；任何 `src/**`／`.dsh/**`／`.github/**` 變更即 fail-loud → `needs-human`。
2. **PR 審查**：依 `docs/25` §4.2 的七項清單，**第 1 項為「與 `factory-stop-rules` 逐條比對，無弱化／繞過」**。
3. **人工 promote**：`factory-skills-lock --promote <name>` 由人類執行；agent 沙箱內必然失敗。同時是**唯一的內容閘門**，兩項皆 fail closed：frontmatter 合法性（`validateFrontmatter`，依 `docs/04` §3.2）與**不含具體 model id**（`detectModelIds`，見 §5.1）。
4. **CODEOWNERS**：`.dsh/skills/` 的變更仍需 @philipz 審查。

> **更正（2026-09-20）**：本節原將 frontmatter 校驗記在閘門 1。實際上
> `factory-crosscheck.ts:183-196` 的 `proposeSkillOnly` 分支**只比對路徑**（純
> allowlist），frontmatter 與內容校驗都在閘門 3（`factory-skills-lock.ts`）。
> 閘門 1 管「寫到哪裡」、閘門 3 管「寫了什麼」；記在同一格會讓「內容已經有人
> 查過」成為錯誤的安全感。`docs/25` §4.1 有同一處更正。

### 4. 放行方式比照 `agent-analyze`，不放寬監督層級

沿用既有機制（`apply-score-labels.ts:32` 的 `analyzeAllowed`）：in-loop 工作項可執行「僅提案不實作」，但 **tier 不變、標籤不變、`automergeAllowed` 不變**。

> 這是 `docs/06` §4「僅可產出分析與方案，不得實作」的第二個實例，**不是**新的例外。

### 5. 技能版本鎖定（`skills-lock.json`）

新增 `config/factory/skills-lock.json`：記錄每個 skill 的 `name`／`sha256`／`lastChangedPR`。CI 在既有 `cp -r` 同步後校驗 hash。

**第一階段僅發 `::warning::` 不擋 run**；觀察穩定後由人類決定是否升為紅燈。

**要解決的具體缺口**：`factory-run.yml:396` 目前是無校驗的 `cp -r "$GITHUB_WORKSPACE/.dsh/skills/." "$HOME/.dsh/skills/"`。若該 copy 不完整或機制 repo 誤刪某個 SKILL.md，**agent 會安靜地在缺少 `factory-stop-rules` 的情況下執行**——停手規則消失卻無任何紅燈。

**`sha256` 的涵蓋範圍是整個 bundle（2026-09-20 更正）。** 原實作只雜湊
`<name>/SKILL.md` 一個檔案，但技能是 directory bundle：`quint-modeling/SKILL.md`
明確指示 agent 去讀 `guidelines/*.md`（progressive disclosure）。實測
`.dsh/skills` 有 **24 個檔案而 lock 只涵蓋 6 個**——也就是說本節要解決的
「copy 不完整導致 SOP 靜默消失」，對其中 18 個檔案完全不亮：刪掉
`quint-modeling/guidelines/review.md`，`--verify` 仍回報 `ok: true`。

現在雜湊的是 bundle 內所有一般檔案的 manifest（相對路徑＋各檔位元組雜湊，
碼元順序排序）：

- **路徑也進 manifest**，否則「把 `a.md` 改名成 `b.md`」這種會讓 SKILL.md 的
  引用失效的變更會算出同一個 hash。
- **排序必須是碼元順序**（不得用 `localeCompare`）：後者依 locale 而異，同一個
  bundle 在不同 runner 上會算出不同 hash，`changed` 就變成與內容無關的隨機訊號。
- **symlink 不納入**：跟隨它會把樹外的內容算進 bundle，而 `cp -r` 對 symlink 的
  行為本身就依平台而異。
- **`--promote` 雜湊複製後的目的地**，不是提案的 SKILL.md 文字。寫入單檔 hash
  會讓下一次 `--verify` 立刻把剛放行的技能報成 `changed`——一個正常的放行動作
  就製造一筆假告警，而假告警會訓練人忽略這個訊號。
- 同理，`--verify` 的 model id 掃描也改為涵蓋整個 bundle：既然 bundle 是完整性
  的單位，它就該是內容政策的單位，否則把 model id 寫進 `guidelines/` 即可繞過 §5.1。

這次更正讓 lock 內**每一筆 `sha256` 都改變**（雜湊的輸入不同了），由一次
`--update` 重算，屬預期而非漂移。

### 5.1 內容閘門：具體 model id（2026-09-20 補入）

`skills-lock` 原則上只管傳輸完整性，`detectModelIds` 是**唯一的內容例外**，
理由與 §5 同構：這類缺陷同樣是「**沒有任何東西會變紅**」的靜默失效。

一份釘死 model id 的 SKILL.md 在該 id 退役之後，SKILL.md 仍在、hash 仍相符、
`--verify` 仍 `ok: true`，agent 只是繼續收到一條指向不存在模型的指令。實證：
兩個月內三個 id 失效（2026-08-28 `claude-fable-5`；2026-09-11 `deepseek-v4-pro`、
`deepseek-v4-flash`），而 `docs/25` §2.4 記載過同類盲區——訊號斷了三週無人察覺。

- **`--promote`**：fail closed，拋 `CliError`，不複製檔案也不寫 lock。
- **`--verify`**：回報 `modelPins`，由 `factory-run.yml` 發 `::warning::`；
  **不計入 `ok`**，因為 `ok` 為 false 要重新同步技能、`modelPins` 非空要改措辭，
  處置不同的兩件事合成一個布林就分不出該做哪一件。已生效技能與人類手改都繞過
  promote，這是它們唯一的覆蓋點。
- **字典是 id 的形狀而非現役清單**：id 退役時會被自 `config/dsh/model-tiers.yaml`
  移除，取自設定檔的字典會在**唯一需要生效的那一刻**失去它。變異測試 M6 釘住此點。
- **無覆寫旗標**：可覆寫的閘門等於沒有閘門（同 `src/stop-rules` 的 no-override 立場）。

正確的表達方式是指稱 tier 而非 id——模型選擇的單一事實來源是 `model-tiers.yaml`
（`ADR-011`），skill 裡的 id 就是第二套定義（`docs/26` §1.1 約束 1 的立場）。

> **重要澄清**：`skills-lock` 鎖的是**傳輸完整性**，不是**創作權限**。它保護的恰恰是「agent 拿到完整能力」，而非削減能力。加不加 lock，agent 的 skill 自造能力都是零（見脈絡的實測表）。

### 6. 成對設計：收與放並行

| 機制 | 方向 | 作用 |
|---|---|---|
| `skills-lock --verify` | 收 | 確保已審核技能完整送達 |
| `skillGap` 訊號 | 偵測 | agent 回報「我缺什麼技能」 |
| **`agent-propose-skill`** | **放** | **agent 據 skill-gap 撰寫草案** |
| `--promote` | 閘門 | 人類決定是否採納 |

**只收不放會僵化**；本 ADR 兩者同時採納。

## 後果

### 正面

- 工廠具備**可擴展技能**的正當路徑，且擴展需求變成**可見訊號**（`skillGap`）而非盲區
- `.dsh/skills/**` 的 H5／CODEOWNERS 保護**完全不變**——零 guardrail 鬆綁
- 技能變更可稽核、可回滾（lock 記錄 hash 與來源 PR）
- 消除 `cp -r` 的靜默缺失風險

### 負面 / 取捨

- promote 是人工動作，**擴展速度受限於人類注意力**（這是刻意的取捨）
- 人類每次修改 skill 後須執行 `--update`，否則 CI 發 warning（與 `pnpm-lock.yaml` 同性質）
- 技能數量可能膨脹並稀釋 agent 注意力 → 由 promote 的人工節流與 `docs/25` §4.2 第 4 項（要求可執行性）緩解

### 中性

- `proposals/` 目錄為新增，不影響既有建置或測試

## 替代方案

### A. 讓 agent 直接寫 `.dsh/skills/` 並經 PR 審查
**未採用**：合併即生效，PR 審查與生效之間無緩衝；一次誤點合併就讓 agent 獲得新行為準則。雙閘門的成本極低（一個目錄），收益是「誤合併不生效」。

### B. 完全不開放，維持人類手寫技能
**未採用**：擴展路徑存在但無訊號——人類不知道該補什麼。`docs/25` 的 T1–T3 偵測即為此而設。

### C. LLM 自動聚類並自主發 PR 修訂 SKILL.md（Warp 產品敘事版本）
**未採用**：實測 `defect/escape`／`defect/review` 皆 0 筆（180 顆合併 PR），輸入為空集合時 LLM 只能無中生有地「發明」問題模式。且 Warp 自身工程實作用的是 `skills-lock.json` 版本鎖定，並非自動修訂（`docs/research/230` §1.1）。

### D. 引入多代理人，由專責 agent 撰寫技能
**未採用**：`ADR-010` 觸發條件 2／3 未滿足（`docs/24`）。

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| ~~Q16-1~~ | ~~`proposals/` 不在 DSH 探索 rank 上為推論~~ | ✅ **已實機驗證（2026-09-06）**：以真實 `dsh --profile headless` 兩次獨立探測——對照組 `.dsh/skills/probe-visible` **被發現**（證明探測法有效）、`proposals/skills/probe-canary` **未被發現**。推論成立，維持 `proposals/skills/`。 |
| Q16-2 | `skills-lock` 校驗何時由 warning 升為紅燈 | 觀察穩定後由人類裁決。**2026-09-20 起涵蓋兩種 warning**：hash 不符（`ok: false`）與內含 model id（`modelPins` 非空，§5.1）。兩者可分別裁決——後者在 promote 已是紅燈，`--verify` 這一路只補既有技能與人類手改 |
| Q16-3 | 提案門檻「≥3 次」未校準 | 見 `docs/25` §3、Q23-1 |
