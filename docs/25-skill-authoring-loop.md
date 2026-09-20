# 25 — 技能撰寫迴圈（skill-gap 偵測 → 提案 → 放行）

> **依據**：`docs/research/230`（Warp DeepWiki 實證）、`ADR-016`（產出 vs 生效分離）、`ADR-015`（Scoreboard 平台）、`04-agent-execution-dsh.md` §3.2（DSH skill 探索規則）
> **用途**：定義「工廠如何擴展自己的技能」的完整流程——從偵測技能不足、到 agent 撰寫草案、到人類放行生效、到效果驗證。
> **讀者**：決定是否 promote 一個技能提案的人（目前即 philipz）。
>
> **本文件的核心主張**：**agent 可以「撰寫」技能，但不能讓它「生效」。** 兩者分離是本設計的全部安全性所在。

---

## 0. 先界定：什麼是「DSH 自行設計 Skill 的能力」

這個說法有兩種語意，風險差距是數量級的：

| 語意 | 內容 | 立場 |
|---|---|---|
| **A. 自主生效** | agent 寫出 skill 並讓它立即對自己生效 | ❌ **永不採用** |
| **B. 自主產出＋人類放行** | agent 撰寫草案並開 PR，人類審查合併＋promote 後才生效 | ✅ **本文件採此路** |

**為何 A 永不採用**：
- `docs/06` §4.3 明訂：「**agent 不得驗證自己的產出並據以放行**」——agent 自寫 skill 再自己遵循，正是此禁令的教科書案例
- `docs/05` §1.1 核心不變量：agent 必須永不能鬆綁自己所受的約束
- 若 A 成立，`factory-stop-rules` 可被 agent 自行覆寫——**所有停手規則同時失效**

**A 目前在機制上已不可能**（實測，非設計意圖而已）：

| 路徑 | Rank | 阻擋機制 |
|---|---|---|
| 寫入目標 repo `.dsh/skills/` | 100 | `risk-paths.yml:42` H5 → risk=2 → 強制 in-loop，**agent 不會被啟動**；CODEOWNERS 再擋一層 |
| 寫入 `$HOME/.dsh/skills/` | 400 | `factory-guardrail.patch.yml` 為 `workspace-write` ＋ `workspaceRoot: process.cwd()`（＝`target/`）→ `$HOME` 在沙箱外 |

> 以下「技能撰寫」一律指 **B**。

---

## 1. 完整流程總覽

```
        ┌──────────── 迴圈 A：偵測（每次 run，自動）────────────┐
        │                                                      │
  factory-run #1 ─► agent 遇技能不足 ─► report.json.skillGap
        │                                   │
        │                                   ▼
        │                    apply-judge-labels
        │                      ├─ 貼標籤 skill-gap
        │                      └─ 終態留言附「🧩 技能缺口」段（永久留存）
        │                                   │
        │                      factory-push-event ─► Scoreboard（永久事件）
        │                                   │
  factory-run #2…#N ──────────────────────┤
        └────────────────────────────────────┘
                                            │
        ┌──────────── 迴圈 B：聚類（隨時／每週）────────────────┐
        │                                   ▼                  │
        │  Scoreboard /skill-gaps（主）或 weekly-metrics.sh（輔）│
        │    └─► 「monorepo-test-path ×4（#201 #205 #211 #219）」│
        └───────────────────────────────────┬──────────────────┘
                                            │ ≥3 次且符合 §3 門檻
        ┌──────────── 迴圈 C：提案與放行（人類主導）─────────────┐
        │                                   ▼                  │
        │  人類開 agent-propose-skill 工作項                     │
        │        ▼                                             │
        │  agent 寫 proposals/skills/<name>/SKILL.md            │
        │  crosscheck --propose-skill-only 強制邊界              │
        │        ▼                                             │
        │  提案 PR ─► 人類依 §4.2 七項清單審查 ─► 合併            │
        │        ▼  （合併後仍未生效——不在 DSH 探索路徑上）       │
        │  人類執行 factory-skills-lock --promote <name>         │
        │        ▼                                             │
        │  .dsh/skills/<name>/ ＋ lock 更新 ─► CODEOWNERS 審查   │
        │        ▼                                             │
        │  §5 生效驗證 ─► 有效？ 留下 ／ 無效？ 回退              │
        └──────────────────────────────────────────────────────┘
```

**四道閘門**：crosscheck 邊界 → PR 審查 → 人工 promote → CODEOWNERS。

---

## 2. 迴圈 A：偵測（三層）

### 2.1 T1：即時（每次 run，零額外操作） ✅ **已落地（2026-09-06，E4）**

> **實作狀態**：`ReportSchema.skillGap`（`src/cli/factory-judge.ts`）、
> `renderSkillGapMarkdown`（`src/skill-gap/render.ts`）、`skill-gap` 標籤與留言段落
> （`src/cli/apply-judge-labels.ts`）、SKILL 指示（`.dsh/skills/factory-workflow/SKILL.md`）
> 均已完成，並以 dist/ 實機驗證全鏈。`category` 的 kebab-case 為 **fail-loud 強制**
> （見 §7「同義異名」風險的緩解）。
>
> **2026-09-17 更正：填寫紀律是模型相依的，不是普遍成立的。** 見 §2.4。

### 2.1.1 三個不依賴自報的補強（2026-09-17）

T1 的原始設計把「缺口是否被記下」完全交給 agent 自覺。§2.4 的盤點顯示那不成立，
因此加了三道**不改變終態語意**的補強：

| 機制 | 位置 | 作用 |
|---|---|---|
| **未回報 advisory** | `src/skill-gap/unreported.ts`（由 `factory-crosscheck` 與 `factory-judge` 呼叫） | run 異常收場卻無 `skillGap` 時留下一條 advisory；經 `extra.skill_gap_unreported` 送進 Scoreboard |
| **逾時自動登記** | `src/cli/write-report.ts` | 逾時 run 由 CI 登記 `category: agent-timeout`（見 §2.5） |
| **停手時顯式表態** | `factory-workflow` SKILL | 停手／無法完成時 `skillGap` 不可省略：有就填，沒有則明寫 `null` |

**三者都不擋 run、不改終態、不改標籤**，且**不代擬缺口內容**——虛構的缺口比沒有
缺口更糟，它會污染 §3 的「同 category ≥3 次」門檻。

> **advisory 解決的是一個歧義，不是一個錯誤**：`skillGap` 缺席同時代表「確實沒有
> 缺口」（正常且預期）與「遇到了但沒想到回報」，而兩者在資料上**完全一樣**。
> advisory 只是把「這次 run 屬於後者的可能情境」標出來，判斷仍由人類做。

**agent 端**：在**已經要停手或繞路**時額外填一個欄位——不新增決策負擔。

```json
"skillGap": {
  "category": "monorepo-test-path",
  "needed": "pnpm workspace 下 vitest 設定分散於各 package 的路徑解析 SOP",
  "context": "issue #201 要為 packages/core 補測試，但既有 skill 未說明如何定位子套件的 vitest.config"
}
```

`category` 為**聚類鍵**（kebab-case）。`factory-workflow` SKILL 會提供建議分類清單；無合適分類時自創，但須為描述性 kebab-case。

**CI 端**：`apply-judge-labels` 沿用既有 `usageMarkdown` 選用段落的**完全相同模式**——

- `skillGap` 存在 → 終態留言附加段落 ＋ 貼 `skill-gap` 標籤
- `skillGap` 缺席 → 留言與現況**逐字相同**（容錯，不擋終態）

**留言格式（聚類器的解析錨點，格式為契約）**：

```markdown
---
### 🧩 技能缺口回報
- **分類**：`monorepo-test-path`
- **需要**：pnpm workspace 下 vitest 設定分散於各 package 的路徑解析 SOP
- **情境**：issue #201 要為 packages/core 補測試…
```

> **為何掛在終態留言**：這是人類**本來就會讀**的介面，不需主動查詢。相較之下，需要主動查詢的儀表板容易被遺忘——`defect/*` 標籤的失效正是此模式（見 §7 風險）。

### 2.2 T2：聚類（跨 run）

**主要介面：Scoreboard `/skill-gaps`**（`ADR-015`）——事件永久儲存，跨 repo 彙整，隨時可查。

**離線輔助：`scripts/weekly-metrics.sh`**（Q22-6：保留為輔助，非退場方案）：

```
== 技能缺口聚類 ==
🔴 達提案門檻（≥3 次）
  monorepo-test-path        4 次  #201 #205 #211 #219   2026-09-02→10-14
🟡 觀察中（<3 次）
  java-multimodule-mvn      1 次  #207
  gh-stack-conflict-detail  2 次  #203 #209
```

**為何需要 T2**：單次 gap 可能偶發；**重複出現才代表真缺口**。這是 Warp Self-Improvement「聚類失敗模式」的**確定性版本**——用計數取代 LLM 判斷。

**資料保存的實測依據**（決定聚類的資料源選擇）：

| 資料源 | 保存期 | 實測 |
|---|---|---|
| Run artifacts | **會過期（~90 天）** | run 33891806331 的 `factory-run-23`，`expires_at: 2026-12-03` |
| Issue 留言／標籤 | **永久** | issue #199 留言完整可讀 |
| Scoreboard 事件 | **永久**（D1） | `ADR-015` |

→ **聚類以 Issue 留言與 Scoreboard 事件為主源，artifacts 僅作近期補充。**

### 2.3 T3：被動訊號（不依賴 agent 自報）

`skillGap` 是 agent 自報，可能漏報。以下訊號**不依賴自報**，且**現在就有資料**：

| 訊號 | 資料源 | 暗示 |
|---|---|---|
| 同類停手原因重複 | `needs-human` 留言分類（實測 6 筆） | 該情境缺 SOP |
| crosscheck 同類 mismatch 重複 | `crosscheck.json` 的 `mismatches[].kind` | agent 反覆誤解某規則 |
| Gate 2.5 截斷率上升 | judge 終態分布 | 輸出紀律指引不足 |
| **未回報 advisory 重複** | `extra.skill_gap_unreported`（2026-09-17 起） | 該模型或該類任務的自報紀律不足 |

### 2.4 填寫紀律是**模型相依**的（2026-09-17 盤點）

**這一節推翻了本文件先前的一項結論。** §7 原本記載「以真實 DSH 呼叫實測，agent
主動且格式合法地填寫了 `skillGap`——T1 的填寫者是 agent 而非人類，故**不依賴人工
紀律**」。該證據來自**單一一次 qwen run**，被誤推為普遍性質。

盤點 2026-09-09 至 09-17 共 13 次 factory run 後的實際分布：

| 模型 | 「該回報」的情境數 | 實際回報 |
|---|---|---|
| `deepseek-v4-pro` | 3 | **3** |
| `qwen3.8-flash` | 2 | **2** |
| `claude-sonnet-5` | 2 | 0 |
| `claude-opus-5` | 2 | 0 |
| `deepseek-flash` | 0（兩次皆乾淨完成，缺席正確） | — |

**Scoreboard 上全部 5 筆缺口，只來自 `deepseek-v4-pro`（3）與 `qwen3.8-flash`（2）。**
claude 家族在 4 次可回報情境中 0 次填寫；其中 `claude-opus-5` 兩次還**自創 report
欄位**（`evidence`／`issueComment`／`labelsAdded`／`pullRequests`／`stopped`）並
**漏填 `requirements`**，一次因此觸發 crosscheck `requirements-missing` 而失敗
（run 35098422118）。SKILL 模板對它的約束力明顯弱於 deepseek/qwen。

**訊號為何會「突然」斷掉**——路由政策的正當變更，連帶把訊號源關掉了：

| 日期 | 事件 | 對訊號的影響 |
|---|---|---|
| 2026-09-11 | `deepseek-v4-pro` 因官方退役被移出 tier 設定（`b3a0a95`→`1cd665e`） | 貢獻 3/5 缺口的模型**從此不在任何 chain** |
| 2026-09-13 起 | 四次 run 全數判為 high／critical | `qwen3.8-flash` 只剩 chain 末位 fallback，**未再實際執行** |

→ **自 2026-09-13 起，每一次 run 都由「從未回報過缺口的模型」執行。** 這不是機制
故障（推送鏈路實測正常：事件照送、`skill_gap: null` 忠實反映 report），而是
**把可見性寄託在模型自覺上的必然後果——模型換了，訊號就沒了，而且沒有任何紅燈**。

> **可推廣的教訓**：凡是「靠 agent 自覺產生」的訊號，其可靠度都是模型的函數，
> 因此**不得**作為單一來源。模型路由是會因成本、退役、供應商政策而改變的外部變數。

### 2.5 逾時 run 的結構性盲點（2026-09-17 修補）

`skillGap` 只能由 agent 寫進 `report.json`，而逾時的 agent **來不及寫**；CI 補的
fallback report（`write-report.ts`）先前也沒有這個欄位——**逾時 run 在結構上不可能
回報缺口**，偏偏逾時正是最可能藏著缺口的情境。

實證 run 34735315950（`agent-playground/node-redlock#7`）：50 分鐘、19.4M token、
USD $0.306 全損。它的 stdout 裡有一個成品級的缺口——agent 自行發現「Quint 模型的
map 更新用 `fold` 會讓 Apalache 狀態空間爆炸，改用 `mapBy` 後從 2.5 分鐘/步降到
1 分鐘跑完 7 步」。**那段發現連同整場產出一起消失。**

現行處置：`write-report` 在逾時時登記 `category: agent-timeout`，`needed` 明寫
「需人類從 run log 判讀」——**只登記 CI 觀測到的客觀事實，不代 agent 推論缺什麼
SOP**。非逾時的失敗一律不登記（否則每次 `agent-error` 都會變成一筆假缺口）。

> `agent-timeout` 會累積計數，這是刻意的：**重複逾時本身就是能力／預算與任務
> 類型之間的系統性落差**，正是 §3 要偵測的東西（2026-09-13 的 heavy-verify 升 tier
> 就是這類修正）。

**偏差方向必須記住**：越崎嶇的 run 越可能有缺口，也越可能連 report 都寫不出來。
留在 Issue 上的缺口因此**系統性偏向順利完成的 run**——這是倖存者偏差的一個實例。

---

## 3. 提案門檻（何時該開 agent-propose-skill）

**全部滿足**才開提案工作項：

| # | 門檻 | 說明 |
|---|---|---|
| 1 | **重複性** | 同 `category` ≥ **3 次**，或人類判定必然重複 |
| 2 | **可泛化** | 是該類任務的通用 SOP，**不是**單一 issue 的特例解法 |
| 3 | **不與停手規則衝突** | 特別是不得弱化 `factory-stop-rules` 任何一條 |
| 4 | **不涉及 guardrail 鬆綁** | 不觸碰計分、停手、PR 拆分規則的語意 |

> **為何門檻是 3 次**：低於此數，撰寫 skill 的成本高於收益，且容易把偶發情境固化成錯誤通則。**此數值待校準**（Q23-1，比照 Q07-1 的處理方式）。

**Warp 的對應實證**：`review-pr-local` 把重複踩到的坑固化為具體阻斷規則——例如「UI 變更無截圖 → `Request changes`」（DeepWiki 行 5640）。**這就是自我改進的可落地形態**：人把每次事故固化成一條可機械檢查的規則。

---

## 4. 迴圈 C：提案與放行

### 4.1 為何提案不直接寫 `.dsh/skills/`

| 若直接寫 `.dsh/skills/` | 寫 `proposals/skills/` ✅ |
|---|---|
| 觸發 H5 → risk=2 → in-loop | 不在 H5 路徑上 |
| **一旦合併立即生效**，PR 審查與生效間無緩衝 | **不在任何 DSH 探索 rank**（100＝`.dsh/skills`、200＝`.agents/skills`）→ **誤合併也不生效** |
| 單閘門 | **雙閘門**：PR 審查 ＋ 人工 promote |

**agent 端邊界**（`factory-crosscheck --propose-skill-only`）：
- 只允許 `proposals/skills/**` 與 `docs/**` 的變更
- 任何 `src/**`、`.dsh/**`、`.github/**` 變更 → fail-loud → `needs-human`

> **更正（2026-09-20）**：本節原記載 crosscheck「額外校驗 frontmatter 合法」。
> 實際上 `factory-crosscheck.ts` 的 `proposeSkillOnly` 分支**只比對路徑**
> （`:183-196` 是純 allowlist），frontmatter 與內容校驗都在 **promote（閘門 3）**：
> `factory-skills-lock.ts` 的 `validateFrontmatter` 與 `detectModelIds`。
> 閘門 1 管「寫到哪裡」，閘門 3 管「寫了什麼」——兩者的職責不同，記在同一格會讓
> 「已經有人查過內容了」成為錯誤的安全感。

**放行方式**：比照 `agent-analyze`（`apply-score-labels.ts:32` 的 `analyzeAllowed`）——in-loop 工作項可執行「僅提案不實作」，但**tier 不變、標籤不變、`automergeAllowed` 不變**。這不是放寬監督層級。

### 4.2 promote 審查清單（七項，任一不過即不 promote）

| # | 檢查 | 不通過的後果 | 機械化？ |
|---|---|---|---|
| 1 | 與 `factory-stop-rules` **逐條**比對，無弱化／繞過 | **停手機制失效——最嚴重** | 人類 |
| 2 | 與既有 factory skill 無矛盾指令 | agent 收到衝突指引，行為不可預測 | 人類 |
| 3 | frontmatter 合法（kebab-case `name`、`description` 必填） | DSH **靜默丟棄**該 skill（`docs/04` §3.2 fail closed） | ✅ `validateFrontmatter` |
| 4 | 內容為**可執行步驟**，非泛泛原則 | 佔用 context 卻不改變行為 | 人類 |
| 5 | 不含憑證／token／repo 專屬機密 | 安全事故 | 人類 |
| 6 | 回查 T2：原始 gap 確實重複出現 | 為單一特例增加全域負擔 | 人類 |
| 7 | **不含具體 model id**（`claude-*`／`deepseek-*`／`qwen*`…） | 該 id 退役後 skill **靜默地繼續指導 agent** | ✅ `detectModelIds` |

> **第 1 項不可外包**。這是人類判斷的核心——agent 寫的 skill 可能無意間鼓勵繞過停手（例如「若測試難以通過，可調整斷言範圍」這類看似合理實則危險的措辭）。

**第 7 項（2026-09-20 新增）**。`factory-skills-lock --promote` 為 fail closed：
提案內含具體 model id 即拋 `CliError`，不複製檔案也不寫 lock。

- **為什麼是硬性檢查而非審查要點**：model id 會退役，而退役**不會讓任何東西變紅**
  ——SKILL.md 仍在、hash 仍相符、`--verify` 仍 `ok: true`，agent 只是繼續收到一條
  指向不存在模型的指令。這與 §7「自報紀律模型相依」是同一類盲區：訊號斷了三週
  無人察覺（§2.4）。實證：兩個月內三個 id 失效（2026-08-28 `claude-fable-5`；
  2026-09-11 `deepseek-v4-pro`、`deepseek-v4-flash`）。
- **怎麼改才會過**：指稱 tier（`low`／`medium`／`high`／`critical`），不指稱 id。
  模型選擇的單一事實來源是 `config/dsh/model-tiers.yaml`（`ADR-011`）；skill 裡的
  id 就是第二套定義，一旦與設定檔分歧，先被 agent 讀到的那一套會成為實際生效的規則
  （同 `docs/26` §1.1 約束 1 的立場）。
- **字典刻意不取自設定檔**：id 退役時會被自設定檔移除，取自設定檔的字典會在
  **唯一需要生效的那一刻**失去它。因此比對的是 id 的**形狀**（廠商字首＋型號尾綴），
  不是成員資格。此推理由變異測試 M6 釘住（`factory-skills-lock-mutation.test.ts`）。
- **刻意不提供覆寫旗標**：可覆寫的閘門等於沒有閘門（同 `src/stop-rules` 的
  no-override 立場）。真有例外，改程式並經 PR。
- **已生效技能同樣會被查**：promote 只擋新提案，既有技能與人類手改都繞過它，
  因此 `--verify` 另行回報 `modelPins`，由 `factory-run.yml` 發 `::warning::`。
  它**不計入 `ok`**——`ok` 為 false 要重新同步技能，`modelPins` 非空要改措辭，
  處置不同的兩件事合成一個布林就分不出該做哪一件。

### 4.3 promote 指令（人類執行，agent 永遠無法執行）

```bash
node dist/cli/factory-skills-lock.js --promote monorepo-test-path
# 1. 讀 proposals/skills/monorepo-test-path/SKILL.md
# 2. 驗 frontmatter
# 3. 複製到 .dsh/skills/
# 4. 更新 skills-lock.json（hash ＋ 來源 PR）
# 5. 提示：需 commit 並經 CODEOWNERS 審查
```

**agent 無法執行的機制依據**：`.dsh/skills/` 受 H5 ＋ CODEOWNERS 保護；且沙箱 `workspaceRoot` 為 `target/`，機制 repo 路徑在其外。

---

## 5. 生效驗證（不驗證等於未放行）

1. 執行 `factory-skills-lock --update` 更新 hash
2. 以**產生該 gap 的原 issue 類型**重跑一次（真實或 dry_run）
3. 確認 `skills synced:` 一行含新 skill 名稱（`factory-run.yml:397` 既有輸出）
4. 確認該類 gap **不再出現**（Scoreboard 可比對 `skills_digest` 前後）
5. **無改善 → 回退**：移除 `.dsh/skills/<name>/`、更新 lock、在提案 PR 記錄結論

> 呼應 `docs/08` §2.4：驗證為「完成但無效」的行動**不計入分子**。放行後不驗證，等於把 PDCA 停在 Check。

---

## 6. 責任與節奏

| 節奏 | 動作 | 執行者 |
|---|---|---|
| 每次 run | 讀終態留言的 skill-gap 段落 | 審查者 |
| 隨時 | Scoreboard `/skill-gaps` 查聚類 | 你 |
| 每週（輔助） | `weekly-metrics.sh` | 你 |
| 達門檻時 | 開 `agent-propose-skill` 工作項 | 你 |
| 提案 PR | 依 §4.2 七項清單審查 | 你（CODEOWNERS） |
| 合併後 | `--promote` ＋ §5 驗證 | 你 |

**刻意不自動化的兩點**：
- **開提案**不自動觸發——避免 gap 一到 3 次就自動燒 token
- **promote** 永遠人工——這是 agent 獲得新能力的唯一入口，必須有人負責

---

## 7. 已知風險（誠實記載）

| 風險 | 說明 | 緩解 |
|---|---|---|
| **紀律失效**（最高） | 本迴圈可能重蹈 `defect/*` 覆轍——機制建好、紀律不執行、訊號恆為空（實測：180 顆合併 PR 累計 0 筆 defect 標記） | T1 掛在必看留言上（非主動查詢）；T3 不依賴人工標記；Scoreboard 永久累積可隨時補查。**但若無人查看，T2 仍會失效——本文件不宣稱免疫**。<br>~~**2026-09-06 部分緩解證據**：agent 主動且格式合法地填寫了 `skillGap`，故 T1 **不依賴人工紀律**~~ → ⚠️ **2026-09-17 更正，見下一列**。**T2（人類查看聚類）仍純靠紀律，風險不變。** |
| **自報紀律模型相依**（2026-09-17 新增） | 上一列的緩解證據來自**單一一次 qwen run**，被誤推為普遍性質。13 次 run 的盤點顯示：5 筆缺口全部只來自 `deepseek-v4-pro`（3）與 `qwen3.8-flash`（2），claude 家族在 4 次可回報情境中 **0 次**填寫。而這兩個模型因 2026-09-11 的退役汰換與 tier 判定，自 09-13 起**都不再實際執行**——訊號斷了三週且無任何紅燈（§2.4） | 三道不依賴自報的補強（§2.1.1）：未回報 advisory、逾時自動登記、停手時顯式表態。**但三者都只讓「可能漏報」變得可見，不能代為產生缺口內容**——真正的內容仍只有 agent 寫得出來，故本風險**降級而未消除**。更換模型或調整 tier 時應一併確認訊號是否仍在 |
| `category` 同義異名 | agent 自訂分類可能分散計數（`monorepo-test-path` vs `pnpm-workspace-test`） | Scoreboard 列「相似 category」提示由人合併；**不做自動語意合併**（需 LLM，違背確定性原則） |
| 門檻未校準 | 3 次可能過鬆或過嚴 | Q23-1 標為待校準 |
| 技能膨脹 | 技能數量增加稀釋 agent 注意力 | promote 需明確人工動作，天然節流；§4.2 第 4 項要求可執行性 |
| agent 寫出危險 SOP | 提案可能鼓勵繞過停手 | §4.2 第 1 項為不可外包的人類判斷 |

---

## 8. 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| ~~Q25-1~~ | ~~`proposals/` 不在 DSH 探索 rank 上為推論~~ | ✅ **已實機驗證（2026-09-06）**：真實 `dsh` 探測——`.dsh/skills/` 對照組被發現、`proposals/` 探針未被發現。見 ADR-016 Q16-1。 |
| Q25-2 | 提案門檻 3 次未校準 | 同 Q23-1，累積數據後調整 |
| Q25-3 | 技能總數上限（何時該合併或淘汰舊 skill） | 待技能數 >10 時再議 |
| Q25-4 | `agent-timeout` 是否該計入 §3 的提案門檻 | 目前**計入**（重複逾時＝系統性落差）。但它與一般缺口的性質不同：`needed` 是佔位而非具體 SOP，達 3 次時該開的可能是路由／預算調整而非技能提案。累積後裁決 |
| Q25-5 | 未回報 advisory 的觀察期與後續 | 第一階段僅記錄（`extra.skill_gap_unreported`）。若某模型的比率持續偏高，選項有二：換模型，或把該模型的 report 模板要求寫得更硬。**不建議**升為紅燈——那會給 agent 為過關而虛構缺口的動機 |
| Q25-6 | `skills_digest` 未接線（一律為 `null`） | §5 生效驗證第 4 步「Scoreboard 可比對 `skills_digest` 前後」**目前做不到**。見 `docs/26` Q26-1 |

---

## 修訂記錄

| 日期 | 變動 |
|---|---|
| 2026-09-05 | 建立：定義 A/B 語意分離、T1–T3 三層偵測、四項提案門檻、六項 promote 清單、生效驗證與回退；記載 artifacts 90 天過期／Issue 留言永久的實測依據 |
| 2026-09-06 | **T1 落地（E4）**：`skillGap` schema／留言段落／標籤／SKILL 指示完成；`category` 改為 kebab-case fail-loud（§7 同義異名風險的機械緩解）；補記 `skillGap` 不進入 pipeline 判定的設計決策 |
| 2026-09-17 | **更正「不依賴人工紀律」的結論**：13 次 run 盤點顯示填寫紀律**模型相依**（5 筆缺口全來自 `deepseek-v4-pro` 與 `qwen3.8-flash`；claude 家族 0/4），而這兩個模型自 09-13 起不再執行（§2.4）。新增 §2.1.1 三道不依賴自報的補強、§2.5 逾時盲點與其修補；§7 風險表更正並新增「自報紀律模型相依」一列；新增 Q25-4〜Q25-6 |
| 2026-09-20 | **§4.2 第 7 項落地：promote 拒絕具體 model id**（`factory-skills-lock.ts` 的 `detectModelIds`，fail closed，不複製檔案也不寫 lock）；`--verify` 新增 `modelPins` 回報，由 `factory-run.yml` 發 `::warning::` 且**不計入 `ok`**。**更正 §4.1**：frontmatter 校驗在閘門 3 而非閘門 1（`ADR-016` §3 有同一處更正）。字典刻意採 id 的**形狀**而非現役清單——取自設定檔的字典會在 id 退役那一刻失效，正是最需要它的時候；此推理由變異測試 M6 釘住 |
| 2026-09-06 | **迴圈 C 落地（E5＋E6）**：`factory-skills-lock`（verify/update/promote，verify 恆 exit 0）＋`agent-propose-skill` 型別（crosscheck `--propose-skill-only` 白名單）。**Q25-1 實機驗證通過**（`proposals/` 確實不在探索 rank 上）。**紀律實證**：真實 DSH 呼叫確認 agent 會主動且格式合法地填寫 `skillGap`（§7 風險欄已更新） |
