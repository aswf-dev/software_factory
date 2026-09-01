# 10 — 未決事項總表

> **用途**：收攏全部文件的未決事項，作為實作啟動前的檢查清單與待裁決清單。
> **維護規則**：各文件的未決事項為**來源**，本表為**索引**。修改時先改來源文件，再同步本表。
>
> **統計**（更新於 2026-09-01，工項已開成 Issue）：共 **77 項**——**37 項已裁決／已驗證**、1 項為文件範圍說明、**39 項待處理**。
> 其中 **4 項需要使用者裁決**（見 §1.1）。
>
> **本次變動**：Q19-1～Q19-5 **已裁決**（2026-09-01 使用者確認：P0 全採／先做 `agent-analyze`／報告 PR＋建議下一步／ADR-014 三項全裁附重啟條件／預防行動追蹤在 docs/14）；Q20-1 **已裁決執行**——11 個工項已開成 GitHub Issue #192–#202（`docs/20-work-items.md` 追蹤）；Q20-2 **已裁決**（C1 試點 3 個：software_factory×2＋fubon in-loop×1，2026-09-01 全數完成）。
>
> 各節項數：4 + 14 + 9 + 11 + 2 + 1 + 19 + 8 = 68。部分事項在多份文件中重複出現（如 token 門檻同時見於 `02`/`04`/`05`），本表以合併列呈現並標示全部來源編號，故「列數」少於「項數」。
>
> **本次變動**：Q08-1 基線量測**部分完成**（來源 `philipz/fubon-tradingbot`，511 PR + 39 Issue）；新增 Q08-6（基線已含 agent 影響）、Q08-7（閒置比無法自動計算）。

---

## 1. 依處置方式分類

### 1.1 需要**使用者裁決**（4 項）——實作啟動前必須有答案

| 編號 | 事項 | 來源 | 阻塞什麼 |
|---|---|---|---|
| **Q01-4** | 消除清單 E1–E6 是否有組織限制導致無法消除 | `01` | 價值流改善範圍 |
| **Q08-3** | 「創新工作 vs 維護工作」的分類標準 | `08` | 最關鍵的成果型指標 |
| **Q05-3** | 稽核紀錄保存期限 | `05` | 合規要求 |
| **Q00-2** | 是否採用原文的量化預測作為 KPI 目標 | `00` | 建議**不**採用，以自身基線為準 |

> **本節原有的 Q09-2（試點 repo）與 Q01-2（前提就緒）已於 2026-08-16 裁決**，移至 §1.7。

---

### 1.2 需要**實作時驗證**（14 項）——技術事實待確認

#### DSH 相關（第 1 期首要）

| 編號 | 事項 | 來源 | 驗證方式 |
|---|---|---|---|
| **Q04-4** | DSH 版本鎖定策略與 CI 安裝方式 | `04` | **必須鎖版** |

#### Backstage 相關（全部未經連網查證）

| 編號 | 事項 | 來源 | 處置 |
|---|---|---|---|
| **Q03-1 / Q02-3** | **Backstage 版本、create-app 指令、插件名稱與設定格式全部未查證** | `03`,`02` | ✅ 已鎖版 `0.9.0`（create-app，2026-08-17，見 `backstage/versions.md`）；實際插件 API 以部署時驗證 |
| **Q03-2** | `github:actions:dispatch` scaffolder action 是否存在及其簽章 | `03` | ✅ **已驗證（2026-08-17）**：`@backstage/plugin-scaffolder-backend-module-github` 內建 action，inputs `token/repoUrl/workflowId/workflowInputs/branchOrTagName`，無輸出 schema（見 `backstage/templates/agent-add-tests/template.yaml` 註解） |
| **Q09-1** | `github:issues:create` 於鎖版 plugin 是否存在（約 v1.40 起）與其輸出欄位名 | `03`,`ADR-009` | 部署時驗證（Q03-2 模式）；缺則升版並記錄於 `backstage/versions.md`；另驗證 `FactoryWorkItemDraftField` 的 `createScaffolderFieldExtension`/`formData` 簽章與 template 表達式拼接 |
| **Q03-3** | Node v22.21.1 是否在支援範圍 | `03` | 必要時以 nvm 切版 |
| **Q03-4** | `factory.io/` annotation 命名空間是否衝突 | `03` | 實作時確認 |

#### GitHub / gh-stack 相關

| 編號 | 事項 | 來源 | 處置 |
|---|---|---|---|
| **Q07-2** | `gh stack init --numbered --prefix` 的實際命名格式 | `07` | 實作時驗證 |
| **Q07-3** | gh-stack v0.0.2 為早期版本，行為可能變動 | `07` | **鎖定版本** |
| **Q06-4 / Q05-6** | `risk-paths.yml` 與 CODEOWNERS 路徑模式須依實際 repo 結構撰寫 | `06`,`05` | 實作時確定 |
| **Q06-5** | 二次判定的實作方式（PR 事件觸發計分） | `06` | ✅ **PR 事件觸發重計分**（T3，`factory-rescore` CLI + `factory-rescore.yml`）；初始值讀 Issue 的 `oversight/*` 標籤、單向升級（docs/06 §5.3）；「成功攔截升級」實證待試跑 |
| **Q03-5** | Scoreboard 採自訂插件或既有插件 | `03` | 第一階段可用手動報表替代，**不阻塞上線** |
| **Q08-2** | 缺陷標記紀律是否具備 | `08` | 必要時先建立標記慣例 |
| **Q08-4** | OTel 指標後端未選定 | `08` | 延後（保持開放）；第一階段以 `gh` JSON 手動彙整（`factory-metrics` CLI + `scripts/weekly-metrics.sh`，T5） |

---

### 1.3 需要**累積數據後校準**（9 項）——不可憑空決定

> **共同原則**：這些數值若憑空設定，只有兩種結果——過嚴（頻繁誤擋）或過鬆（形同虛設）。**誠實地標記為「待校準」，比填一個看似精確的數字更負責。**

| 編號 | 事項 | 來源 | 校準時機 |
|---|---|---|---|
| **Q02-5 / Q04-5 / Q05-4** | **token 中止門檻值** | `02`,`04`,`05` | ✅ **接線完成**（T6）：`token_budget` input → SR7 判定（`tokensUsed > budget` → needs-human）；**實際數值待基線數據後設定**（預設 0 = 不設限） |
| **Q06-1** | `06` 計分門檻（0–1 / 2–4 / 5–6） | `06` | 第 1 期後以實際缺陷率檢視 |
| **Q06-3** | **自動合併准入門檻**（暫定 ≤ 200 行）——超過即退回人類審查 | `06` | 依自動合併缺陷率調整 |
| **Q07-1** | **拆分建議上限**（暫定 200–300 行）——撰寫指引，非閘門 | `07` | 依實際審查耗時與大小分布調整 |
| ~~Q08-1~~ | 基線量測 | `08` | ✅ **部分完成**：Lead Time／PR 大小／創新佔比已取得（`08` §4.2）；閒置比等三項仍缺（→ Q08-7） |
| **Q09-1** | 各期時程為粗估 | `09` | 確認可投入人力後修訂 |

---

### 1.4 需要**定期檢視**（11 項）——不是一次性決定

| 編號 | 事項 | 來源 | 檢視時機 |
|---|---|---|---|
| **Q01-1** | `01` §2 的痛點全為假設，未經實測 | `01` | 第 0 期工作坊後更新 |
| **Q03-6** | **Backstage 的維運負擔是否值得** | `03` | 第 1 期結束評估；可降級為純 GitHub 觸發 |
| **Q01-3** | Operate 階段何時可放寬至自動修復 | `01` | 至少一季 on-the-loop 數據後再議 |
| **Q06-6** | 三軸 annotation 的登錄品質如何確保 | `06` | 建議季度抽查 |
| **Q06-2** | 複雜度軸的自動判定粗略，依賴靜態標註 | `06` | 第一階段用靜態值 +「觸及目錄數 ≥ 3 則至少 1 分」；第 1 期後檢視準確性 |
| **Q07-5** | 三層拆分是否適用所有工作項類型 | `07` | 第 1 期後檢視實際樣態 |
| **Q09-4** | 「團隊對 agent 品質有共識信任」的判定方式 | `09` | 第 3 期進入條件 |
| **Q08-5** | 開發者滿意度問卷的題目與頻率 | `08` | 搭配同理心地圖工作坊 |
| **Q08-6** | 基線來源已含 agent 影響 | `08` | 解讀時須註明，避免誤判工廠貢獻 |
| **Q08-7** | **閒置比無法自動計算**（缺 Process Time） | `08` | 核心指標；需推估或人工回報 |
| **Q03-6** | **Backstage 的維運負擔是否值得** | `03` | ✅ **已裁決：降級**（Q03-6/Q13-1，2026-08-18）——純 GitHub 觸發，Backstage 工件凍結；Scoreboard 以 GitHub Insights + `factory-metrics` 月報替代（`09` §3 2.7）；日後公司採用增使用者時可逆轉 |
| **Q05-5** | 多 agent 協作的複合風險治理細則 | `05` | 引入多 agent 前必須先補（2026-08-24 已評估 `dsh-agent-teams` / workflow 工具：**目前不採用**，門檻與脈絡見 `05` §6.1 與 ADR-010） |

---

### 1.5 已知並接受的**殘餘風險**（2 項）

| 編號 | 事項 | 來源 | 立場 |
|---|---|---|---|
| **Q05-1** | **GitHub-hosted runner 的出向網路預設不受限** | `05` | **第一階段接受並揭露**。緩解措施為偵測與嚇阻（stop-rules、PR 審查、CODEOWNERS），非預防。若處理敏感資料，須改用 self-hosted runner + 出向白名單 |
| **Q07-4** | agent 自動合併時是否需等待上層 PR 審查完畢 | `07` | 建議：僅合併已核准的最底連續段 |

> **Q05-1 值得特別注意**：這是本設計中**最大的已知缺口**。它沒有被隱藏在樂觀敘述裡，而是明確標示為殘餘風險，因為決策者有權知道自己接受了什麼。

---

### 1.6 文件範圍說明（1 項）

| 編號 | 事項 | 來源 | 說明 |
|---|---|---|---|
| **Q00-1** | 原文 Figure 1、2、6、7、8、10 為概念示意圖，`00` 以文字轉述其結論而未逐圖描述 | `00` | 非缺陷，是刻意的取捨。若後續設計需精確引用某圖，回查原始 PDF 對應頁 |

---

### 1.7 已裁決／已驗證（19 項）

| 編號 | 事項 | 裁決結果 |
|---|---|---|
| ~~Q20-1~~ | 工項投放方式（2026-09-01） | ✅ **開成 GitHub Issue**：11 個工項 #192–#202（`20-work-items.md` 追蹤；`meta/observation` 標籤） |
| ~~Q20-2~~ | C1 試點安排（2026-09-01） | ✅ **3 個試點全數完成**：T1/T2（software_factory，報告 #231/#230）、T3（fubon in-loop 6 分，報告 #597）；衍生修正 #232/#233/#234/#236 |
| ~~Q19-1~~ | P0/P1 改善項採納範圍（2026-09-01） | ✅ **P0 六項全採，P1 六項逐項後議**；工項制定於 `20-work-items.md` |
| ~~Q19-2~~ | 新工作類型順序（2026-09-01） | ✅ **先做 `agent-analyze`**，實跑驗證後再議 write-spec（需四護欄）／refactor（需 characterization 拆分）／security-fix（需類型級限制） |
| ~~Q19-3~~ | `agent-analyze` 產出格式（2026-09-01） | ✅ **報告 PR（docs/、單層）＋建議下一步**；不產生程式碼變更 |
| ~~Q19-4~~ | ADR-014 裁掉項目（2026-09-01） | ✅ **三項全裁**（Disposal、正式 CCB、容量/DR），各附「重新檢視觸發條件」（第二位協作者、repo 轉客戶端、自架 runner） |
| ~~Q19-5~~ | 預防行動追蹤落點（2026-09-01） | ✅ **內建於 docs/14 期檢模板**；docs/08 只定義「預防行動完成率」衍生指標 |
| ~~Q02-4~~ | agent 使用哪個 GitHub 身分 | ✅ **GitHub App**（→ 決策 D6，`02` §2） |
| ~~Q09-2~~ | 試點 repo | ✅ **工廠本身**（`philipz/software_factory`，dogfooding）。循環風險防護：`agent-automerge: "false"`（`11` §1.2） |
| ~~Q01-2~~ | 非 AI 自動化前提是否具備 | ✅ **確認尚未具備** → 制定 `11-test-strategy.md`，並交付可執行測試骨架 |
| ~~Q02-6~~ | 目標 repo 是否已有測試 workflow | ✅ **已建立** `.github/workflows/test.yml`；56 則測試實跑通過 |
| ~~Q09-3~~ | 第 0 期前提是否具備 | ✅ 同 Q01-2；第 0 期為**必經階段**，不可跳過 |
| ~~Q02-1 / Q04-1~~ | headless profile 佈建方式 | ✅ **自動佈建**；工廠沿用 `headless` + `--patch`，不需自建 profile（`04` §2.2） |
| ~~Q04-2~~ | sandbox/approval 的列 id 與結構 | ✅ 列 id 為 `sandbox-policy`／`approval`／`permission`（`04` §2.3） |
| ~~Q04-6~~ | 是否需自訂 permission preset | ✅ **需要**——內建無 `workspace-write`+`never`，不宣告則**載入期失敗**（`04` §2.3） |
| ~~Q11-1~~ | E2E 假 agent 的實作方式 | ✅ **採 stub 腳本**（使用者裁決）；已實作 `test/e2e/stub-agent.ts`，16 則 E2E 測試 |
| ~~Q02-2 / Q04-3 / Q05-2~~ | Linux runner 的沙箱阻擋 | ✅ **完全解決**：kernel 6.17 含 landlock；真實 agent 逃逸嘗試**被阻擋**（`04` §2.5）。首次為假通過，已修正並複驗 |
| ~~Q04-4~~ | DSH 版本鎖定策略與 CI 安裝方式 | ✅ **已驗證**：`npm install --no-save @deepseek-ai/dsh@0.1.0-rc.6`（`factory-run.yml`） |
| ~~Q07-2~~ | `gh stack init --numbered --prefix` 的實際命名格式 | ✅ **已更正（2026-08-18 試點 #2 根因調查）**：gh-stack **v0.1.0（CI 鎖定版）不接受 `--numbered`/`--prefix`**——先前「實測 --prefix → factory/12-01-test」是在本機舊版 0.0.2 上做的，誤標為 v0.1.0。v0.1.0 正確用法是 **positional 分支名**（`gh stack init --base <trunk> factory/12-01-test factory/12-02-impl ...`，init 依序建立、slash 保留）；更新見 `07` §3.2 與 factory-pr-stacking skill |
| ~~Q07-3~~ | gh-stack 版本鎖定 | ✅ **已鎖 v0.1.0**（`gh extension install github/gh-stack --pin v0.1.0`，`factory-run.yml`） |
| ~~Q03-1~~ | Backstage 版本與 create-app 指令 | ✅ **已驗證**：`@backstage/create-app@0.9.0`（`--path` 旗標）；見 `backstage/versions.md` |
| ~~Q03-2~~ | `github:actions:dispatch` scaffolder action | ✅ **存在**（`@backstage/plugin-scaffolder-backend-module-github`），inputs：`token/repoUrl/workflowId/workflowInputs/branchOrTagName`；**無輸出 schema** |
| ~~Q03-3~~ | Node v22 支援範圍 | ✅ **22.21.1 為 Active LTS**（Backstage 官方要求 Active LTS） |
| ~~Q03-4~~ | `factory.io/` annotation 命名空間衝突 | ✅ **無衝突**（Catalog 載入正常） |
| ~~Q06-5~~ | 二次判定的實作方式 | ✅ **run 內 git diff 重計分**（`factory-judge` CLI 重用 `runWorkItem` 的 Gate 3）+ **PR 事件觸發重計分**（T3：`factory-rescore` CLI + `factory-rescore.yml`，讀 Issue 初始 `oversight/*` 標籤、單向升級） |

**新增（2026-08-18，真實試跑發現）**：

| 編號 | 事項 | 來源 | 處置 |
|---|---|---|---|
| **Q04-7** | **DSH sandbox 會剝離 process 環境變數**——GH_TOKEN 不會傳進 agent 的 env（step 層 gh 可用，agent 內 gh 看不到 token） | `04` §4.1 假設**被推翻** | ✅ **已解決**：token 寫入 workspace 檔（`.factory/run/gh-token`），skill 指示 agent 讀取 |
| **Q05-7** | **GITHUB_TOKEN 不能用 GraphQL 建立 PR**（`createPullRequest` 403）——即使 workflow 宣告 `pull-requests: write` | `02` D6 | ✅ **已解決**：改用 App token（實證 D6 必要性） |
| **Q05-8** | **actions/checkout 的 credentials includeIf**（`http.https://github.com/.extraheader` 寫在獨立檔、經 `includeIf.gitdir` 引入）會**覆蓋 URL 內嵌 App token**；`git config --unset-all` 清不掉 | 試跑 | ✅ **已解決**：移除 includeIf 項目 + URL 內嵌 App token |
| **Q04-8** | Anthropic API **429 rate limit**（平行試跑觸發帳號限額） | 試跑 | ⚠️ **外部限制**：需循序執行或換較輕模型；見 `09` §2 |
| **Q12-5** | 線上 ruleset 的 required check 只有 `test`，**缺 `quint-verify`**（repo 內 JSON 有，未套用） | `12` Q12-1 實例 | ⚠️ 待以 `gh api` 套用 |
| **Q-P2-1** | **第二試點 repo 選擇與安全約束**（2026-08-18 裁決；**2026-08-28 統一，ADR-013**） | `09` §2.2 | ✅ **已裁決並實證**：`philipz/fubon-tradingbot`；**絕不觸碰其 main**——工廠 trunk 用另開的 `software-factory` 分支；workflow 以 `base_branch` input 明確指定（T4）；非試點 repo 的 `base_branch` 不得為 main（Guard step + 對抗性測試強制）。**試點 #1–#3 全程 main SHA 前後一致**（`d01aed8d...`）。**2026-08-28 統一（ADR-013）**：機制 repo 也採 `software-factory` trunk（取消 main 特例）——`base_branch` 預設改 software-factory、Guard 改為全 repo 禁 main＋分支存在性檢查；**所有 repo 的 main 一律絕不觸碰** |
| **Q04-9** | 分支命名與 `--draft` 紀律能否在真實試跑維持 | 試跑 | ✅ **已驗證並修正**（試點 #2/#3）：試點 #2 產出 `factory-569-01-test`（dash）——根因是 **skill 教的 `--numbered/--prefix` 在 gh-stack v0.1.0 不存在**（Q07-2 更正），agent 被迫自創；修正 skill 為 positional 後，試點 #3 產出 `factory/571-01-test`（slash）**紀律維持**。`--draft` 禁令未見違反（PR 皆非 draft）|
| **Q04-10** | 依 Issue 複雜度分級路由 LLM 模型（低/中→qwen3.8-flash、高→pro、最高→opus-5（fable-5 已移除）；檢查留言含複雜度分析＋建議模型） | `ADR/011` | ✅ **已實作（2026-08-25）**：`src/issue-analysis/complexity.ts`（啟發式分析）＋`src/model-tier/resolve.ts`（解析核心）＋`src/cli/factory-model.ts`（選模 CLI）＋`config/dsh/model-tiers.yaml`（tier→chain 政策）；`factory-run.yml` 新增 Select model tier 步驟並以 chain 迭代取代固定映射；`factory-issue-check` 留言含 📊 複雜度分析＋🤖 建議模型。2026-08-28 裁決：fable-5 需額外 credit 已移除，critical 改為 claude-opus-5。`deepseek-v4-pro ≈ opus/sonnet 等級` 為待 A/B 驗證假設 |

---

### 1.8 測試與設定相關（8 項，新增自 `11`、`12`）

| 編號 | 事項 | 來源 | 處置 |
|---|---|---|---|
| **Q11-2** | 「偵測測試斷言被弱化」的判定方式 | `11` | 建議：比對測試檔 diff，斷言數減少即告警 |
| **Q11-3** | App manifest 的測試方式（設定存於 GitHub 而非 repo） | `11` | 建議：以 repo 內 manifest 檔為單一事實來源 |
| **Q11-4** | 覆蓋率門檻 80% 未經校準 | `11` | 先設定，依實際情況調整 |
| **Q11-5** | E2E 是否納入 required checks（耗時較長） | `11` | ✅ 已納入 `test` job；目前耗時僅 ~20 秒，無需拆分 |
| **Q12-1** | ruleset JSON 與實際設定可能漂移 | `12` | 建議季度以 API 比對 |
| **Q12-2** | 個人帳號私有 repo 的 classic branch protection 限制 | `12` | 已改用 Rulesets（實測可用），不阻塞 |
| ~~Q12-3~~ | 是否將管理員加入 bypass 名單 | `12` | ✅ **已裁決：不加入**——改為移除無法滿足的核准要求 |
| **Q12-4** | **單人 repo 無第二雙眼睛審查**（GitHub 禁止自我核准） | `12` | ⚠️ **實質缺口**：有第二位協作者時立即恢復核准與 CODEOWNERS 要求（`12` §2.1） |

---

## 2. 實作啟動前的最小檢查清單

依序完成，前項未決則後項無意義：

- [x] **1. 選定試點 repo** — ✅ 工廠本身（dogfooding）
- [x] **2. 確認前提就緒** — ✅ 已確認**尚未具備**，故建立測試框架（`11`）
- [x] **3. 建立測試框架與 CI** — ✅ **125 則測試**，覆蓋率門檻與對抗性測試均已驗證「確實會擋」
- [x] **4. 驗證 DSH headless 可執行** — ✅ 實機跑通，含 guardrail 與沙箱阻擋驗證（`04` §2.4）
- [x] **5. 量測基線**（Q08-1）— ✅ **部分完成**：`08` §4.2 已填（511 PR + 39 Issue，來源 `philipz/fubon-tradingbot`）；閒置比等三項因 API 限制仍缺（Q08-7）
- [ ] **6. 執行價值流工作坊**（Q01-1）— 把假設換成事實
- [ ] **7. 鎖定其餘工具版本**（Q03-1、Q04-4）— DSH、Backstage、gh-stack
      （Node/TS/Vitest 等測試工具鏈**已鎖精確版**；GitHub Actions 已升至 v7）
- [x] **8. 設定 required checks**（`11` §7.1、`12`）— ✅ ruleset `main-protection` 已啟用，required check 為 `test`，已由 PR #1 實證生效

> **第 2 項是最重要的關卡**。`00` §3 Phase 1 明示：非 AI 自動化是引入 AI 的**前提**，不是成果。若 CI 不可信任，`09` 第 0 期的放棄條件即已觸發——此時該補測試，不該導入 agent。

---

## 3. 本文件的維護

| 時機 | 動作 |
|---|---|
| 某項獲得答案 | 在**來源文件**標記為已裁決/已驗證，並同步本表 |
| 新增未決事項 | 先寫入來源文件的未決事項段，再補入本表 |
| 每期結束 | 檢視「定期檢視」類（§1.4）各項 |

> **不要讓本表成為唯一的真實來源**。它是索引；細節與脈絡在各文件的未決事項段落中。索引與來源不一致時，**以來源為準**。
