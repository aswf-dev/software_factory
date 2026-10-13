# ADR-021：N-version 平行執行——追認與修正（平行模式的採用邊界）

- **狀態**：已接受（實作與本 ADR 同一張 PR）
- **日期**：2026-10-12
- **決定者**：平台架構（使用者經 grilling 逐項裁決，Q1、Q8–Q15、Q19、Q23–Q26、Q35）
- **取代**：`ADR-020` §2 逐項裁決表中「**N-version** 平行多版本：不採用」一列（其餘裁決不變）
- **對應**：`ADR-010`、`docs/24`（多 agent 複合風險）、`ADR-001`（GitHub 為唯一事實來源）、`ADR-005`（自主性上限）、`docs/18`（G1／G2 終態守衛）、`docs/26` §3（事件冪等鍵）
- **參考**：[Google Cloud Architecture Center — 選擇代理式 AI 系統的設計模式](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system?hl=zh-tw)

## 脈絡

### 文件與程式碼互相矛盾

`ADR-020`（2026-10-09）裁決 N-version「不採用」，理由是沒有成本基線。但 2026-10-10 起
`factory-run.yml` 以 `matrix: variant: [a, b]` **在每次執行都強制**跑兩個模型（commit
`cc5cdeb`、`354951c` 等），沒有任何 ADR 記錄這次翻案。使用者已裁決成本暫不列入考量。

### 上線後發現的終態漏洞

| # | 漏洞 | 後果 |
|---|---|---|
| 1 | 兩個變體共用 `run_id`；G1 守衛以「Issue 有任何含 run id 的留言」判斷已有終態 | 一邊留言後，另一邊若在 judge／貼標籤時崩潰，守衛不補 `needs-human` |
| 2 | Scoreboard 事件冪等鍵 `sha256(run_id:issue)` 不含變體 | 兩筆事件被合併成拼湊紀錄（已由 PR #41 修正，`docs/26` §3） |
| 3 | 兩個變體各自貼終態標籤 | Issue 標籤是兩邊的**聯集**，例如 `needs-human` 與另一邊的監督標籤並存 |
| 4 | 落選變體的 PR 只能手動關閉；`factory-nversion-cleanup.yml` 以 `github.token` 執行，只對機制 repo 有效 | 目標 repo 從未清理過；write-spec 被落選 PR 卡住（`src/write-spec/phase.ts` L57–58） |

另外：G2（`factory-run-cleanup.yml`）同樣以裸 run id 判斷；write-spec 的規格階段在 agent
啟動**前**就會留下含 run id 的留言，所以 G2 在規格流程上**從未生效**。

### 代理設計模式的採用邊界（背景，供後續 ADR 引用）

以 Google Cloud 的分類對照工廠：

| 模式 | 裁決 | 理由 |
|---|---|---|
| 單一代理＋ReAct | ✅ 既有 | 每次 run 是一個 DSH headless agent |
| 依序（Sequential） | ✅ 既有／擴充中 | `factory-run.yml` 的固定步驟鏈；跨工作項的依序另見後續 ADR |
| **平行（Parallel）** | ✅ **本 ADR**：N-version | 同一任務、不同模型、彼此隔離、由人選擇 |
| 審查與評論，評論者是確定性檢查 | ✅ 既有 | crosscheck、judge、stop-rules、spec-verify |
| 審查與評論，評論者是 LLM | ⏸ 延後（Q8） | 沒有人工比對紀錄可驗證 LLM 評分；冒然加上會讓「由人選擇」名存實亡（`docs/24` §3） |
| 人機迴圈 | ✅ 既有 | 監督分級、HG0–HG7、`spec/approved`、本 ADR 的選勝者 |
| 自訂邏輯 | ✅ 既有 | 三軸計分分流、task_type 路由、模型 tier 鏈 |
| 協調器、階層式分解 | ❌ 排除 | AI 拆解與分派工作就是規劃；規劃屬人類（`ADR-005`、`docs/24` §3、`docs/29` L26） |
| Swarm | ❌ 排除 | `ADR-010` 觸發條件 1/3；`docs/24` §2.1 禁止遞迴 spawn |
| 跨 run 迴圈／自動重試 | ❌ 排除 | `docs/02` §6 失敗不自動重試；`docs/24` §2.5 不得換 agent 繼續試 |

**`compare` 不是 LLM 評論者**：它不呼叫任何模型，是平行模式的確定性彙整步驟
（`src/cli/factory-compare.ts` L7–9「不評品質」）。

## 決策

### 1. 追認 N-version，並說明它為何不觸發 `docs/24` 的複合風險

`docs/24` 管的是「agent 之間協作」：spawn、互相審查、交接。N-version 的兩個變體：

- **不互相溝通**：prompt 明文禁止閱讀、沿用、推送或評論另一變體的交付；crosscheck 以
  `variant-branch-prefix`、`variant-foreign-reuse` 機械驗證。
- **不互相審查**：沒有任何變體的輸出成為另一變體的輸入。
- **不由 agent spawn**：由 workflow 的 matrix 在**派工時**決定，CI 中沒有 agent 啟動 agent。
- **由人選擇**：勝者由人比對後指定（決策 5），兩份交付都不會自動合併。

因此 N-version 是「同一工作項的兩次獨立執行，供人比較」，不是多 agent 協作。**歸因單元不變**：
仍是一張 Issue；缺陷歸因與棘輪照舊作用在 Issue 上（`docs/24` §2.3 的精神）。

### 2. 開關：dispatch input `nversion`，預設開啟

- `workflow_dispatch` 新增布林 input `nversion`（預設 `true`），比照 `model_tier`；Backstage、
  aswf.dev、標籤觸發都不傳，一律開啟。要關閉只能從 Actions 頁面或 `gh workflow run -f nversion=false`。
- 關閉時 matrix 只跑變體 `a`（分支前綴仍是 `factory/<issue>-a-`），使用 tier 原本的模型鏈，
  prompt 不提「另一個變體」，`compare` 照跑（決策 3）但不出比對卡片與互指區塊。

### 3. 終態：`compare` job 是唯一寫入者

- `run` job 在 agent 啟動之後**不貼任何標籤**；各步驟只留細節留言（crosscheck 失敗、逾時、
  規格驗證），並把各步驟結果寫入 `.factory/steps.json` 隨 artifact 上傳。
- `compare` 以 `factory-terminal` 彙整：任一變體可審查 → `ready-for-review`；沒有 → `needs-human`；
  全部只是 `blocked-in-loop` → `blocked-in-loop`；所有變體都沒啟動 agent → 不寫入（前置閘門
  已有自己的訊號）。監督標籤取最嚴格者（單向棘輪）。N-version 時即使某一邊可自動合併，彙整後
  也只能是 `ready-for-review`。
- 先貼標籤、後留言；留言帶終態標記 `<!-- factory:terminal run=<id> -->`。
- 用量段落與技能缺口段落（`### 🧩 技能缺口回報`，`docs/25` 聚類依賴此標題）搬到這份留言。
- agent 啟動**之前**的前置閘門（分數閘門、規格階段、PBT preflight）照舊由 `run` job 自己寫，
  它們發生在兩個變體分流之前的同一份判斷上。

### 4. 守衛：G1 移到 `compare`，G1／G2 只認終態標記

- G1 移到 `compare` 最後一步，條件是「終態寫入步驟沒有成功」。G1 與 G2 都只認終態標記，
  **不認任何含 run id 的留言**——這同時修好 G2 在規格流程上從未生效的舊問題。
- 補貼時也是先貼標籤、後留言（留言帶標記），G1 補貼後 G2 會閒置，不重複。

### 5. 交付形式：變體開 draft PR，由人選勝者

- 變體的 PR 一律是 **draft**，審查佇列裡只會出現勝者。draft 也會觸發目標 repo 的 CI
  （兩個目標 repo 的 `test.yml` 皆無 draft 排除條件，已查證），所以選勝者前就有獨立 CI 結果。
- draft 狀態採**兩層**：skill 要求一開始就做對（N-version 用 `gh stack submit --auto`／
  `gh pr create --draft`；單一變體加 `--open`），機制步驟 `Normalize PR draft state` 再統一補正。
  原因：gh-stack v0.2.1 的 `--auto` 原始碼預設開 draft（`isDraft := !opts.open`），但實際觀察到
  的工廠 PR 從未是 draft，兩者對不上、原因無法從 CI 查明；而只靠機制事後補正時，正式 PR 一建立
  就會通知 CODEOWNERS，這個通知收不回來。
- 轉 draft 失敗（例如該 repo 的方案不支援 draft PR）不擋 run，比對卡片警示；**私有 repo 是否支援
  draft 尚未實測**，列為驗證項。
- 新增 `factory-nversion-pick.yml`（`workflow_dispatch`：Issue 編號、勝出變體）：勝者 draft 由底層
  往上轉正式；落選方 draft 關閉，**分支保留**——勝者若在審查時被否決，可重新開啟落選方再改選。
  與 `factory-run` 共用 concurrency group。
- **選勝者的入口在目標 repo（2026-10-13 修訂，Q39／Q48／Q50）**：專案擁有者在勝者的 PR 按
  **Ready for review**，webhook 經 aswf.dev 轉送後由 App 派工本 workflow，帶 `picked_by`＝按下
  按鈕的 GitHub 帳號。
  - **授權交給 GitHub**：只有對該 repo 有 write 權限的人或 PR 作者能改變 PR 狀態，所以按下按鈕
    就代表有權決定；不需要另一份核准名單，擁有者也不需要機制 repo 的任何權限。
  - **workflow 仍在機制 repo 執行**（Q50）：放進每個目標 repo 會重新引入 ADR-012 消除的多份副本問題；
    執行紀錄公開可讀，結果回寫到目標 repo 的 Issue 與 PR。
  - App 自己觸發的 ready 事件（選勝者轉正勝者、`nversion=false` 的 draft 補正）由轉送站排除（Q40），
    不會自我觸發。
  - **改選**（Q41）：重新開啟落選方的 PR 再按一次 Ready for review；被換下的變體已有 PR 合併時拒絕，
    並請人貼 `stage/done`——否則兩個變體各合併一部分，成為 ADR-022 的 mixed 狀態。
  - 評估過但未採用的替代方案：aswf.dev 選勝者頁面（Access 只提供 email，要另做 email 與 repo 權限的對應）、
    Backstage（Q03-6 凍結，且同樣要求機制 repo 權限）。機制 repo 的 Actions 頁手動執行保留為備援。
- **移除** `factory-nversion-cleanup.yml`：由選勝者 workflow 取代。
- 落選分支的刪除要等勝者全部合併後（合併事件發生在目標 repo，本 repo 收不到），由後續的
  aswf.dev webhook 轉送、機制 repo `factory-stage-finalize` 處理（另案）。

### 6. Scoreboard 事件以變體區分

冪等鍵 `sha256(run_id:issue:variant)`、`extra.variant`（PR #41，`docs/26` §3）。歷史資料不回填。

## 後果

### 正面

- Issue 只有一個終態寫入者，標籤不再是兩邊的聯集；G1／G2 的判斷依據單一且精確。
- G2 在規格流程上首次真正生效。
- 審查佇列只有勝者；落選方由機制關閉，目標 repo 不需部署任何清理 workflow。
- 有逃生口：除錯、試跑或不值得比對兩份的單，可以關閉 N-version。

### 負面

- `compare` 成為終態的單點：它整個崩潰時只剩 G2 兜底（G2 是 `workflow_run`，延遲數十秒）。
- 審查負擔：每張單要比對兩份交付，再多一次選勝者操作。
- 終態留言從「每個變體一則」變成「彙整一則＋各變體細節留言」，Issue 留言數不減。
- skill 的 draft 規則依 `.factory/run/nversion` 分支，agent 多一個要讀的狀態。

### 中性

- 不新增任何 LLM 呼叫、不新增信任面；選勝者 workflow 沿用既有 App token 作法。
- `apply-judge-labels` CLI 保留（不再被 workflow 呼叫；`computeJudgeLabels` 等純函式的語意仍由其測試釘住）。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| 維持強制開啟、只追認 | 連除錯與試跑都必須產生兩份，沒有出口（Q9） |
| 各變體各自標籤（`variant-a/needs-human`） | 標籤數翻倍，aswf.dev、rescore 等所有讀標籤處都要改（Q10-B） |
| 取較差者（任一 needs-human 即整張 needs-human） | 有一份可用交付卻被判交還人類，失去 N-version 的意義（Q10-C） |
| 變體只推分支、不開 PR | 目標 repo 的 CI 只對 `pull_request` 涵蓋 `factory/**`，`push` 沒有——選勝者前沒有獨立 CI 結果（已查證，Q25） |
| 兩邊都開正式 PR，靠清理處理落選方 | 審查佇列加倍；write-spec 被卡；兩邊混合合併無法判定勝者（Q23） |
| 只靠機制事後設定 draft | 正式 PR 先觸發 CODEOWNERS 審查請求，收不回（Q35） |
| 加 LLM 評論者替人打分 | 無人工比對紀錄可驗證；可能讓人照抄分數（Q8） |

## 驗證項（實作已完成，實機尚未驗證）

1. 私有 repo（fubon-tradingbot）是否支援 draft PR；不支援時卡片警示與選勝者流程是否正確。
2. `nversion=false` 的單一變體在真實 run 上的終態留言。
3. G1／G2 在 `compare` 崩潰與 job 逾時時的實機行為。

以上在沙箱 repo 以一條完整流程驗證（Q31-A）。
