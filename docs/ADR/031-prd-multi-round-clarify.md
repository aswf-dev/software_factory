# ADR-031：S 流程 P0 的需求取得——同步 LLM 的多輪 PRD 釐清

- **狀態**：已接受（2026-11-07，使用者經 grilling 逐題裁決 Q1–Q17、Q30、Q33 並確認決策摘要）
- **日期**：2026-11-07
- **決定者**：使用者
- **修訂**：`ADR-030` 的 S 流程 P0 步驟表（S1 之後新增 S2-prd 人工步驟）
- **對應**：`ADR-009`（工作項草稿助手：LLM 只產草稿、最終決定權在人）、`ADR-029`（多輪 grill 的先例；本 ADR 不影響 `/verify` 的 G1）、`ADR-025`／`ADR-027`／`ADR-030`（模板與 S 流程）、`ADR-015`（Scoreboard 平台）、`ADR-023`（process spec／編輯器）
- **實作規格**：factory-scoreboard `docs/superpowers/specs/2026-11-05-prd-multi-round-grill.md`（2026-11-07 改寫版）

## 脈絡

S 流程的需求取得是**一次到位**：S2 的 `fill-form` 請人寫一段需求描述，接著就開 `agent-onboard` Issue 派工。實跑（實例 `dacf44f6`）顯示兩個問題：

1. **一次填不完整**：人寫的需求通常缺目標模組、範圍、已知問題、可驗證的驗收條件；agent 只能猜，猜錯要到 P1（S5 盤點、HG2）才被打回，返工成本高。
2. **有價值的追問沒有去處**：「這個 repo 的核心模組是哪三個？」「失效語義要不要涵蓋 clock skew？」這類問題只能靠人在自由文字裡自己想到；沒有「先問、人再答」的回合，問答也不會被保存。

`/scoreboard/submit` 的「🔍 釐清（最多 3 輪）」證明**同步 LLM 追問**在操作上順手：每次幾秒到幾十秒、留在同一頁、不用等背景工作。但它有三個缺點：問題只是一段純文字＋單一回答框、重新整理就全部消失（只存在前端 JS 記憶體）、看不到 repo。

`/verify` 的 G1 已有多輪 grill（選項化、每輪皆有紀錄），但那是**驗證**流程：每輪是一次 factory-run，實測 6–18 分鐘；直接搬到 S 流程會讓使用者在 P0 面對 30–60 分鐘的空窗。

初版設計（2026-11-05）打算新增機制任務型別 `agent-write-prd`，每輪派一次 factory-run。使用者在 2026-11-07 的 grilling 中裁決**撤回**：等待時間本身就是介面問題，而「問一輪問題」不需要讀完整個 repo。

## 決策

### 1. 每輪同步呼叫 LLM，不派 factory-run

- S2-prd 的每一輪由 **aswf.dev 的 Worker 同步呼叫 LLM**（沿用 `/submit` 釐清所用的 `draft-service`／`callDeepSeek`：`DRAFT_MODEL`、逾時 90 秒、`onUsage` 記錄用量）。
- **撤回** `agent-write-prd` 任務型別：不新增 issue 表單選項、不新增 workflow 分支、不新增 prompt 模板、不新增 model tier 路由。
- 使用者的等待是一輪 LLM 呼叫（幾秒～幾十秒），不是一次 CI run。

### 2. 一題一張卡、每輪寫 D1

- 問題是**結構化 JSON**：`{questions:[{id,text,options[],recommended}], done}`，≤4 題；`done:true` 表示資訊足夠。
- 回答 UI 一題一張卡（選項＋「其他」＋預選建議），不用單一大回答框。
- **每輪送出即寫 D1**（`process_prd_sessions`／`process_prd_rounds`）；重整、隔天回來都能從同一輪接續。前端不再持有唯一一份狀態。
- CAS（帶輪次號）防舊分頁覆蓋；JSON 解析失敗重試一次，再失敗退回「純文字問題＋單一回答框」——寧可醜，不可卡住。

### 3. BPMN 只有一個人工步驟

- S2-prd 在 S 的 BPMN 裡是**一個 `human` 步驟**：多輪問答是頁面與 D1 的事，**不進 journal**；按「確認 PRD」才 `completeHuman`。
- 不新增 effect 型別、不新增 ingest。重播安全大幅簡化：流程只會停在「等人」，題目狀態由 D1 重建，不會出現 journal 與 D1 不一致。
- 確認後由服務**自動以 PRD 完成 S2 `fill-form`**，直接開 `agent-onboard` Issue——使用者不必把同一份需求貼第二次。

### 4. 私有問答、公開 PRD

- 初始需求與問答**只存在 D1**；PRD 定稿後才寫進 S2 Issue body（公開）。
- 「私有」＝不公開到 GitHub，**不是**不經過 LLM 供應商：問答會送到 LLM API（與 `/submit` 釐清相同），這件事在規格與 ADR 都明講。
- 確認 PRD 的按鈕旁明示「以下內容將公開在 S2 Issue」；不做自動私有內容掃描——人親自確認完整內容就是那道關卡。

### 5. 問題要有一點 repo 根據

- 送 LLM 前以 App installation token 抓**有上限的 repo 摘要**：README 前段、最上層檔案樹、`catalog-info.yaml`，總量約 ≤20 KB。
- 任何一項抓不到就略過，只用需求文字——摘要失敗不得讓整輪失敗。
- 這是刻意的取捨：問題的根據程度介於「只讀需求文字」與「讀完整 repo 的 agent」之間；換來的是秒級回應。

### 6. owner 與入口

- 頁面 `/scoreboard/process/s/<id>/prd`，在 Cloudflare Access 內。**只有實例 owner**（Access email）能看與操作；非 owner 一律 404（不透露存在）。
- 舊實例的 owner 可能是 `operator`／`access-user` 這類非 email 值：限平台管理者（`TENANT_ACCESS.admins`）操作，避免舊實例無人能動。
- 既有的 `/human`、`/gate`、`/cancel` **一起補上 owner 比對**（原本只驗 Access，任何 Access 使用者都能操作任何實例）。

### 7. 成本、止血與用量

- 每輪 LLM 呼叫都寫 `llm_usage`（kind `prd-clarify`／`prd-generate`），出現在 `/scoreboard/usage` 的「同步 LLM」欄。
- 緊急開關 `FACTORY_SPEND_ENABLED` 關閉時，PRD 的 LLM 端點回 503；「自己貼 PRD」與「確認 PRD」不呼叫 LLM，仍可用。
- 最多 3 輪是流程設計；PRD 重新產生不限次數，也不設每人限流（`ADR-029` 補記：不設上限，改記錄用量）。

### 8. grilling 技能不進機制 repo

- 使用者原本把 `grilling` skill 複製到 `.dsh/skills/`。改成同步 LLM 後，runner 用不到它；而且它的描述會在所有工單觸發，可能讓 agent 誤用。
- 它的規則（先列決策樹、每輪只問前提已確定的題目、編號＋建議答案、「是」＝採用建議、問完回 `done:true`）改寫進 **PRD 釐清的 prompt**。`/submit` 的現有 prompt 本來就是「grill-me 收斂版」，兩者一致。
- 已移除 `.dsh/skills/grilling/`（未進版控）；`skills-lock` 不受影響。

## 後果

### 正面

- **等待從分鐘級降到秒級**：一輪 6–18 分鐘 → 幾秒～幾十秒；使用者不必離開頁面，也不必設計「關頁後再回來」的通知機制。
- **問答不再消失**：每輪寫 D1，重整可續；`/submit` 的舊缺陷（只存前端記憶體）不會被複製到 S 流程。
- **流程與資料都變簡單**：BPMN 只多一個人工步驟，沒有新 effect、沒有新 ingest、沒有 journal／D1 雙來源問題。
- **沒有新任務型別**：不必動 8+1 處接線、contract CI、adversarial 清單與 model tier 路由。
- **需求品質提前收斂**：P1 少一輪返工；問答有紀錄可稽核（實例完成後保留）。
- owner 檢查順手補上：S 流程的頁面與 mutation 不再只有 Access 一道門。

### 負面

- **問題無法引用程式碼細節**：只看 repo 摘要與使用者描述，抓不到「某個函式在某個分支的時序」這類只有讀碼才知道的問題；需要讀碼的追問留給 P1 之後的既有步驟。
- **Worker 同步承擔 LLM 延遲**：一輪最多等 90 秒（逾時），需要「已等待 N 秒＋取消／重試」的 UI（已納入規格）；Workers 的請求時間限制與 LLM 串流不支援，也限制了更長的推理。
- **問答在 D1 而非 journal**：取消／完成的清理要自己寫（規格已列），不能靠重播自動處理。
- **owner 檢查是新行為**：舊實例若 owner 是 `operator`／`access-user`，只有平台管理者能操作——對「多人共用一個實例」的使用方式是限制。

### 中性

- `ADR-030` 的 S 流程圖與步驟表要同步；`docs/29` §9.1 的 S2 說明改成「填初始需求 → 多輪釐清 → PRD」。
- `/verify` 的 G1 不動（它真的需要讀碼與多輪，且已有非同步設計）。

## 替代方案

| 替代 | 為何不採用 |
|---|---|
| 初版：新任務型別 `agent-write-prd`，每輪派 factory-run | 每輪 6–18 分鐘、最多 3 輪＝30–60 分鐘空窗；使用者要離開再回來，介面無法順暢。且「問一輪問題」不需要完整 repo 分析。 |
| Worker 直接呼叫 LLM 並串流輸出（SSE） | Workers 不支援長時間串流到瀏覽器；90 秒的單次呼叫配上「已等待秒數＋取消」已足夠。串流是複雜度，不是價值。 |
| 在 `/submit` 的釐清上加 repo 摘要與多輪紀錄（共用同一支端點） | `/submit` 是「送單」流程、沒有實例、沒有 owner 與 PRD 定稿的語義；硬共用會讓兩邊的狀態機互相牽扯。共用的是**呼叫層**（`callDeepSeek`、定價、用量、緊急開關），prompt 與狀態各自維護。 |
| 每模組各做一次釐清 | 成本×模組數，且系統層的需求（範圍、模組清單）本來就該先收斂；模組級細問留給 S5／S7。 |
| 不加 repo 摘要，只依需求文字追問 | 問題會退回「問使用者已經寫過的東西」；有上限的摘要是低成本、可接受的折衷。 |
| 用 `done` 以外的人工「夠了，產 PRD」按鈕 | agent 的 `done:true` 加上「跳過釐清」的按鈕已覆蓋兩種路徑；多一顆按鈕只增加決策負擔。 |
| 把 grilling skill 留在 `.dsh/skills/` 給 agent 用 | 同步 LLM 不走 runner；skill 會對所有工單觸發，反而讓一般任務誤用 grill 流程。 |

## 重評觸發條件

- 使用者反映「問題問得不夠深、需要讀碼才知道」成為常態：考慮把**部分**追問改回 agent（例如只有畫面需要「深度問題」時才派一次 run），而不是整輪回來。
- LLM 呼叫延遲成為痛點（例如超過 60 秒的比例變高）：評估換模型、降低摘要大小或把 prompt 拆段。
- `/submit` 的釐清要改版時：先把「每輪寫 D1」與「一題一張卡」抽成共用元件，再回頭合併 prompt。
- 需要對外開放 S 流程給非 Access 使用者時：owner 與入口的假設要一起重新決定（與 `ADR-029` 補記一致）。
