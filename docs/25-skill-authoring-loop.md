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
        │  提案 PR ─► 人類依 §4.2 六項清單審查 ─► 合併            │
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

### 2.1 T1：即時（每次 run，零額外操作）

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
- 額外校驗 frontmatter 合法（`name` kebab-case、`description` 必填，依 `docs/04` §3.2 的 DSH 規格）

**放行方式**：比照 `agent-analyze`（`apply-score-labels.ts:32` 的 `analyzeAllowed`）——in-loop 工作項可執行「僅提案不實作」，但**tier 不變、標籤不變、`automergeAllowed` 不變**。這不是放寬監督層級。

### 4.2 promote 審查清單（六項，任一不過即不 promote）

| # | 檢查 | 不通過的後果 |
|---|---|---|
| 1 | 與 `factory-stop-rules` **逐條**比對，無弱化／繞過 | **停手機制失效——最嚴重** |
| 2 | 與既有四個 factory skill 無矛盾指令 | agent 收到衝突指引，行為不可預測 |
| 3 | frontmatter 合法（kebab-case `name`、`description` 必填） | DSH **靜默丟棄**該 skill（`docs/04` §3.2 fail closed） |
| 4 | 內容為**可執行步驟**，非泛泛原則 | 佔用 context 卻不改變行為 |
| 5 | 不含憑證／token／repo 專屬機密 | 安全事故 |
| 6 | 回查 T2：原始 gap 確實重複出現 | 為單一特例增加全域負擔 |

> **第 1 項不可外包**。這是人類判斷的核心——agent 寫的 skill 可能無意間鼓勵繞過停手（例如「若測試難以通過，可調整斷言範圍」這類看似合理實則危險的措辭）。

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
| 提案 PR | 依 §4.2 六項清單審查 | 你（CODEOWNERS） |
| 合併後 | `--promote` ＋ §5 驗證 | 你 |

**刻意不自動化的兩點**：
- **開提案**不自動觸發——避免 gap 一到 3 次就自動燒 token
- **promote** 永遠人工——這是 agent 獲得新能力的唯一入口，必須有人負責

---

## 7. 已知風險（誠實記載）

| 風險 | 說明 | 緩解 |
|---|---|---|
| **紀律失效**（最高） | 本迴圈可能重蹈 `defect/*` 覆轍——機制建好、紀律不執行、訊號恆為空（實測：180 顆合併 PR 累計 0 筆 defect 標記） | T1 掛在必看留言上（非主動查詢）；T3 不依賴人工標記；Scoreboard 永久累積可隨時補查。**但若無人查看，T2 仍會失效——本文件不宣稱免疫** |
| `category` 同義異名 | agent 自訂分類可能分散計數（`monorepo-test-path` vs `pnpm-workspace-test`） | Scoreboard 列「相似 category」提示由人合併；**不做自動語意合併**（需 LLM，違背確定性原則） |
| 門檻未校準 | 3 次可能過鬆或過嚴 | Q23-1 標為待校準 |
| 技能膨脹 | 技能數量增加稀釋 agent 注意力 | promote 需明確人工動作，天然節流；§4.2 第 4 項要求可執行性 |
| agent 寫出危險 SOP | 提案可能鼓勵繞過停手 | §4.2 第 1 項為不可外包的人類判斷 |

---

## 8. 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q25-1 | `proposals/` 不在 DSH 探索 rank 上為推論（依 `docs/04` §3.2 五個 rank） | 實作第一步以實機驗證；不成立則改用 `.factory/proposals/` |
| Q25-2 | 提案門檻 3 次未校準 | 同 Q23-1，累積數據後調整 |
| Q25-3 | 技能總數上限（何時該合併或淘汰舊 skill） | 待技能數 >10 時再議 |

---

## 修訂記錄

| 日期 | 變動 |
|---|---|
| 2026-09-05 | 建立：定義 A/B 語意分離、T1–T3 三層偵測、四項提案門檻、六項 promote 清單、生效驗證與回退；記載 artifacts 90 天過期／Issue 留言永久的實測依據 |
