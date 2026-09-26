# 28 — agent-write-spec 操作手冊（可執行規格與模型檢查）

> **依據**：`ADR/018`（一張 Issue、兩個 run）、`ADR/008`（Quint 採用與 UPPAAL 例外）、`ADR/012`（集中執行）、`ADR/013`（trunk 統一）、`06-human-oversight-policy.md` §4.3（不得以自撰規格驗證自撰程式碼）
> **讀者**：要用工廠為某個模組建立 Quint 可執行規格、並以模型檢查找出程式缺陷的人
> **狀態**：2026-09-26 首次端到端驗收通過（`tradingbot-tw/node-redlock` Issue #1 → PR #2、#3；回放工單 #4–#6）

---

## 1. 這個流程做什麼、什麼時候用

`agent-write-spec` 把一份規格書（或 Issue 的 PRD）翻成 Quint 可執行規格，再依**現有程式碼**寫出 as-is 模型，由 CI 執行模型檢查。找到的反例是**候選發現**，要另開 `agent-fix-bug` 工單以紅燈測試回放到真實程式，重現了才算確認的缺陷。

**適合**：並行、時序、分散式協議、quorum、重試、狀態機這類單元測試難以穩定重現的缺陷。
**不適合**：一般 CRUD、業務規則、UI。這些用紅燈測試加審查即可，模型檢查投入大、效益低。

**使用門檻**（ADR-018 §4，由 issue-check 與階段判定機械檢查）：Issue 宣告的目標路徑命中目標 repo 的 `risk-paths.yml` H 規則，**或**目標 repo 的 `catalog-info.yaml` 有 `factory.io/quint-spec` 標註。兩者皆無時不派工。

**核心原則**：寫不變量和寫模型是**兩個不同的 run**，中間隔著一次**人工核准**。不變量只能出自規格書，不能出自程式碼——照著實作寫的不變量會把實作的缺陷一起當成「正確」。

---

## 2. 流程總覽

```
0. 目標 repo 前置設定                       ← 人工（一次性）
1. 開單（agent-write-spec）                 ← 人工（Backstage）
2. 第一次派工 → 不變量階段                  ← 自動（Backstage 送出即派工）
3. 審查並合併不變量 PR，回覆未決事項         ← 人工
4. 在 Issue 貼 spec/approved                ← 人工（CODEOWNERS 本人）
5. 補充 Issue 內文的模型階段須知（視需要）   ← 人工
6. 第二次派工 → 模型階段                    ← 人工觸發
7. 審查並合併模型 PR，手動關閉 Issue         ← 人工
8. 候選發現 → 開 agent-fix-bug 回放          ← 人工開單、自動執行
```

同一張 Issue 的 Issue 標籤會依序變化：

```
（開單）→ spec/phase-invariants → ＋spec/approved（人貼）→ spec/phase-model → （人工關閉）
```

---

## 3. 步驟 0：目標 repo 前置設定（一次性）

先完成 `27-repo-onboarding.md` 的一般納管，再確認下列各項。以 `tradingbot-tw/node-redlock` 為例，試點時用一支 `setup.sh` 以 repo 擁有者身分一次做完。

| 項目 | 要求 | 沒做會怎樣 |
|---|---|---|
| GitHub App | `software-factory-worker` 已安裝到目標 repo 的擁有者 | 派工在「Mint app token」失敗 |
| Issues | repo 的 Issues 已開啟（fork 預設關閉） | Backstage 開單失敗 |
| `software-factory` 分支 | 已從 main 建立；main 絕不觸碰（ADR-013） | 「Verify trunk branch exists」失敗 |
| `catalog-info.yaml` | 三軸已裁定；加上 `factory.io/quint-spec: specs/` | 未命中 H 規則時，使用門檻不通過 |
| `.github/factory/risk-paths.yml` | H 規則已裁定 | 計分與門檻判定失準 |
| `CODEOWNERS` | 列出**個人帳號**（`@user`）；位置為 `.github/CODEOWNERS`、`CODEOWNERS` 或 `docs/CODEOWNERS` | `spec/approved` 永遠不被承認（團隊 `@org/team` 不解析，一律 fail-closed） |
| 規格書 | 存檔於 trunk 上的 repo 路徑，例如 `docs/specs/redlock.md`；**不接受 URL** | issue-check 判不合規 |
| `.prettierignore`（建議） | 若目標 repo 的 lint 會格式化 `md/yml/json`，排除 `specs/` 與 `docs/specs/` | 規格產物須逐字保留，目標 repo 的 `yarn lint` 會紅燈 |

**Backstage 設定（非 philipz 擁有的 repo）**：Backstage 以 GitHub App 代表特定擁有者開 Issue，名單在 `backstage-app/app-config.yaml` 的 `integrations.github[].apps[].allowedInstallationOwners`。不在名單內的擁有者會退回 philipz 的 fine-grained PAT，開單時出現 `Resource not accessible by personal access token`。把擁有者加入名單後，執行 `./stop.sh && ./start.sh` 重啟（`start.sh` 發現 Backstage 已在執行時會略過，新設定不會載入）。

**規格書存檔**：網頁原文要先轉成 Markdown 存進 repo，並在檔頭以 HTML 註解記錄出處、擷取的 commit 與授權。注意授權條款，例如 redis.io 文件為 CC BY-NC-SA 4.0（禁止商業使用）。

---

## 4. 步驟 1：開單

在 Backstage「開立 Factory 工作項」選 `agent-write-spec`，表單才會出現「規格名稱」與「規格來源」兩個必填欄位。

| 欄位 | 填法 | 範例 |
|---|---|---|
| 一句話需求 | Issue 標題（自動加 `[factory] `） | 依 redis.io Redlock 規格為 node-redlock 建立 Quint 可執行規格 |
| 任務類型 | `agent-write-spec` | |
| 目標 repo | 目標 repo | `tradingbot-tw/node-redlock` |
| factory trunk 分支 | 預設 `software-factory` | |
| 規格名稱 | kebab-case 小寫英數，最長 64 字元；決定 `specs/<name>/` | `redlock` |
| 規格來源 | trunk 上的 repo 路徑，或 `issue`（以本 Issue 的 PRD 為規格） | `docs/specs/redlock.md` |
| 需求描述（PRD） | 見下方 | |

**PRD 寫法**（參考試點 Issue #1）：

```
目標模組 / 檔案：src/index.ts（規格產出於 specs/redlock/，不修改 src/）
做什麼：依 docs/specs/redlock.md 為 src/index.ts 建立 Quint 可執行規格——先寫不變量，經核准後再寫描述程式現況的 as-is 模型並執行模型檢查。
為什麼：分散式鎖的缺陷多半來自時序交錯與邊界條件，單元測試難以穩定重現；可執行規格能窮盡探索狀態空間，以反例指出實作與規格不符之處。
範圍：
- 不變量涵蓋規格中的……各節所述的性質
- as-is 模型涵蓋……（列出要建模的公開 API 與腳本）
- 不修改 src/；找到的反例另開 agent-fix-bug 工單，由紅燈測試回放
驗證方式：
- `npx quint typecheck specs/redlock/invariants.qnt` 退出碼為 0（不變量階段）
- factory-run 依 `specs/redlock/verify.yml` 執行模型檢查，每條 INV_* 都有明確結果：成立且 witness 可達、違反並附 ITF，或逾時（模型階段）
- 單次模型檢查牆鐘 ≤ 600 秒；超過依停手規則交還人類，並回報已量測的秒數
```

- **不要在 PRD 列出已知缺陷**。列了等於告訴 agent 答案，模型會被引導去「找到」它們，驗證失去意義。
- **驗證方式要可觀察**：寫「≤ 600 秒」而非「10 分鐘內」——issue-check 只認得可量測的寫法。
- issue-check 的留言會建議 critical tier；這是開單當下尚未判定階段的結果。實際派工時，不變量階段不套用 heavy-verify，模型階段才升為 critical。

---

## 5. 步驟 2：第一次派工（不變量階段）

Backstage 送出後自動建立 Issue 並派工，無需額外操作。factory-run 在任何 LLM 成本發生前依序執行：

1. **Check issue format**：欄位、使用門檻、規格來源存在於 trunk。
2. **Resolve write-spec phase**：依 §12 判定表得出 `invariants`，貼上 `spec/phase-invariants`，在 Issue 留言「📐 規格流程……→ 不變量階段」。
3. **寫入 `specs/<name>/source.md` 快照**：規格來源原文加上兩行 CI 標頭（來源路徑、commit、擷取時間）。
4. **agent 撰寫 `specs/<name>/invariants.qnt`**：每個 `val INV_*` 上方以 `// source: source.md §<節>` 逐字引用原文。**不定義** `WIT_*`（witness 由模型階段定義，見 §9）。
5. **crosscheck**：
   - 白名單：只允許 `specs/<name>/invariants.qnt`、`specs/<name>/source.md`、`docs/**`
   - `source.md` 與 CI 快照逐字元一致
   - PR 描述用 `Refs #N`，**不得**用 `Closes`／`Fixes`／`Resolves`
   - PR 描述有 `## 未決事項`，`report.json` 有 `openQuestions`
6. **judge**：write-spec 一律不自動合併，終態為 `ready-for-review`。

**產出**：一個 PR（`factory/<N>-01-invariants` → `software-factory`），包含 `invariants.qnt` 與 `source.md`。

---

## 6. 步驟 3：審查並合併不變量 PR

這是整個流程**最重要的人工關卡**。不變量一經核准就凍結，模型階段不得修改。

**審查清單**：

- [ ] 每條 `INV_*` 的 `// source:` 引用確實出自 `source.md`，且不變量的語意與引文相符
- [ ] 沒有從程式碼推導出來的不變量（程式碼只能用來取得狀態變數的名稱與型別）
- [ ] 規格中重要的安全性、活性性質都有對應；缺漏的在未決事項中說明
- [ ] `source.md` 只有 CI 標頭與規格原文，沒有被改寫
- [ ] 逐條回覆 `## 未決事項`：接受、否決或指定解讀

**回覆未決事項並核准**（以 CODEOWNERS 身分）：

```bash
gh pr review <PR> -R <owner>/<repo> --approve --body-file review.md
gh pr merge <PR> -R <owner>/<repo> --merge
```

`review.md` 逐條寫明裁定（試點範例：「1. 接受：鎖過期就不算持有」「3. 不納入：時鐘漂移走 UPPAAL 人工例外路徑」）。

---

## 7. 步驟 4：貼 `spec/approved`

不變量 PR 合併之後，由 **CODEOWNERS 列出的人類本人**在 **Issue**（不是 PR）上貼 `spec/approved`：

```bash
gh issue edit <N> -R <owner>/<repo> --add-label spec/approved
```

- factory-run 以 Issue timeline 查驗**最後一次**貼上 `spec/approved` 的人：必須是 `User` 型別、不是 `[bot]`、且列在 CODEOWNERS。人貼過之後若又被機器人重貼，視為未核准。
- **順序不可顛倒**：先合併不變量 PR，再貼標籤。trunk 上沒有 `invariants.qnt` 就貼標籤，下次派工會被拒絕。
- 貼標籤本身**不會觸發派工**（跨 repo 事件收不到），要執行步驟 6。

---

## 8. 步驟 5：補充 Issue 內文的模型階段須知（視需要）

**agent 只讀 Issue 內文**（`gh issue view` 不含留言），PR 審查意見與 Issue 留言它都看不到。不變量審查時做出、會影響建模的裁定，要寫進 Issue 內文，否則模型階段不會照做。

做法：編輯 Issue，在 PRD「範圍：」清單末尾追加條目，其餘內容不動。每次派工都會重跑 issue-check，改完可在本機先驗證格式（見 `27-repo-onboarding.md` §6.4）。

試點追加的三條：

```
- 模型使用單一邏輯時鐘，不建模時鐘漂移與牆鐘跳躍
- 節點可建模為不可用（崩潰、網路分割），但重啟後不遺失 key：規格要求崩潰的實例至少 max TTL 不可用，屬於部署前提，不作為發現
- acquire／extend／release 依程式行為支援多個 resources；不變量仍逐資源檢查，跨資源原子性不在範圍內
```

第二條防止「規格本身允許的情境」被模型當成缺陷回報。規格來源若是 repo 路徑，修改 Issue 內文不影響 `source.md`。

---

## 9. 步驟 6：第二次派工（模型階段）

由對 `philipz/software_factory` 有 `actions:write` 權限的人觸發：

```bash
gh workflow run factory-run.yml -R philipz/software_factory --ref main \
  -f issue_number=<N> -f repo=<owner>/<repo> \
  -f base_branch=software-factory -f task_type=agent-write-spec
```

也可在 GitHub Actions 頁面「Run workflow」填入相同的 input。**不需要也無法指定階段**——階段由狀態推導。

factory-run 依序：

1. 階段判定得出 `model`：貼上 `spec/phase-model`，移除 `spec/phase-invariants`。
2. 模型 tier 強制 heavy-verify（critical tier，agent 逾時預算放寬）。
3. agent 撰寫：
   - `model.qnt`：依**程式碼現況**建模（包含缺陷），開頭必須是 `import invariants.* from "./invariants"` 與 `export invariants.*`（少了 `export` 會 `QNT404`）
   - `instances.qnt`：每個實例一個模組
   - `verify.yml`：實例 × 不變量 × 步數 × 逾時 × witness（格式見下）
4. crosscheck：白名單只允許 `model.qnt`、`instances.qnt`、`verify.yml`、`docs/**`；`invariants.qnt`、`source.md` 已凍結；`traces/` 只能由 CI 寫入。
5. **CI 集中驗證**（`Verify write-spec artifacts`，最長 35 分鐘）：依 `verify.yml` 以 Quint 重新執行每項檢查，把違反的反例 ITF 寫入 `specs/<name>/traces/` 並推回 PR 分支，在 Issue 留言結果表。
6. judge：一律 `ready-for-review`。

**`verify.yml` 格式**（不得宣告預期結果，未知欄位一律拒絕）：

```yaml
instances:
  - module: n2
    constants:
      N: { value: "2", domain_justification: "src/index.ts:207-211 未限制節點數；取偶數 2 以涵蓋平票" }
checks:
  - { instance: n2, invariant: INV_quorumSettles, mode: run, max_steps: 24,
      max_samples: 10000, timeout_seconds: 90, witnesses: [WIT_allVotesReturned] }
```

- 每個實例常數都要附 `domain_justification`：程式碼中的檢查位置（`file:line`），或「程式未限制」。**程式沒有限制時，必須涵蓋邊界值與奇偶**（試點：節點數取 1、2、3、4）。
- 每條 `INV_*` 至少一項檢查、每項至少一個 witness；全部逾時總和 ≤ 1800 秒。
- `mode: run` 為隨機抽樣；`mode: verify` 以 Apalache 窮盡到 `max_steps`（較慢，成立時 CI 另以 `quint run` 量測 witness）。

**情境 witness**（ADR-018 Q34）：witness 定義在 `model.qnt`，以**正面敘述**描述「不變量要保護的情境確實發生」，例如「所有節點的票都已回來」「兩個 client 同時爭取同一資源」。

- **不得**是不變量的否定：那描述的是違反本身，不變量成立時必然不可達，CI 會把正確的不變量判為假綠燈。
- **不得**在初始狀態就成立：那證明不了任何動作真的發生過。
- `verify.yml` 引用 `invariants.qnt` 裡的 `WIT_*` 會被 CI 判為不合規。

---

## 10. 步驟 7：審查模型 PR 與驗證結果

CI 在 Issue 留下結果表，例如：

| 不變量 | 結果 | 反例 |
|---|---|---|
| `INV_mutualExclusion` | ✅ 成立（witness 可達） | |
| `INV_quorumSettles` | 🔴 違反（候選發現，未回放） | `specs/redlock/traces/n2.INV_quorumSettles.itf.json` |

**結果判讀**（每條不變量彙總所有實例，優先序：違反 > 錯誤 > 逾時 > 成立／假綠燈）：

| 結果 | 意義 | 處置 |
|---|---|---|
| ✅ 成立 | 抽樣中未找到反例，且至少一個實例的 witness 可達 | 記錄。`mode: run` 是抽樣，**不是證明** |
| 🔴 違反 | 找到反例，ITF 已寫入 `traces/` | **候選發現**：開 fix-bug 回放（步驟 8） |
| ⚠️ 成立但 witness 皆不可達 | 假綠燈嫌疑：模型到不了要保護的情境 | 交還人類：檢查模型或 witness |
| ⏱ 逾時 | 超過該項 `timeout_seconds` | 記錄；需要時縮小常數或步數重跑 |
| ❌ 錯誤 | typecheck 失敗、名稱找不到等 | 交還人類 |

工單的成敗取決於**證據是否完整**，不是不變量是否成立。as-is 階段找到違反本身就是成果。

**審查清單**：

- [ ] `domain_justification` 的 `file:line` 確實是程式中的檢查位置；程式未限制的常數有涵蓋邊界與奇偶
- [ ] 模型沒有寫程式本身沒有的 `assume`／限制來縮小範圍
- [ ] **模型與程式的保真度**：關鍵行為（重試、token、計票、到期計算）與程式一致。試點中模型重試時換新 token，程式實際沿用同一個 value，因此結構上抓不到「被自己上次留下的 key 擋住」這類缺陷
- [ ] witness 是正面敘述的情境
- [ ] 抽查反例 ITF 的最後狀態，確認與程式行為相符而非模型假象
- [ ] 逐條回覆 `## 未決事項`

合併後**手動關閉 Issue**（見 §14「`Closes` 不生效」）：

```bash
gh issue close <N> -R <owner>/<repo> -c "模型 PR #<M> 已合併至 software-factory；手動關閉。"
```

模型 PR 合併後，`traces/` 與模型成為「修復前」的紀錄；後續修好程式不會自動更新模型。

---

## 11. 步驟 8：候選發現回放（agent-fix-bug）

每個違反的不變量開一張 `agent-fix-bug` 工單（Q31）。它的 `01-test` 層寫出重現反例的紅燈測試，這就是回放；重現成功才是確認的缺陷，重現不了就標為模型假象。

**PRD 範本**（試點 Issue #4）：

```
目標模組 / 檔案：src/index.ts 的 _attemptOperation（計票與 resolve，約 L496-545）
做什麼：當所有節點的票都已回來、但贊成與反對都未達 quorum 時，本次嘗試必須以「反對」結束……
為什麼：Issue #1 的 as-is 模型對 INV_quorumSettles 找到違反情境（specs/redlock/traces/n2.INV_quorumSettles.*）：N=2 時 1:1 平票後停在 pending……
範圍：
- 01-test：新增不需真實 Redis 的測試，以 stub client（實作 evalsha／eval）建立 2 個節點各投 1 票的情境，斷言 acquire 在限時內以 ExecutionError 失敗
- 02-impl：只修改 _attemptOperation 的判定邏輯；既有行為不變
驗證方式：
- 新測試檔可單獨執行：`yarn build && cd dist/esm && npx ava --verbose <新測試檔>.test.js`，不需 Redis
- 修復前該測試以逾時失敗（紅燈，測試內以 2000 毫秒限時），修復後通過（綠燈）
```

注意事項：

- **避開 heavy-verify 觸發詞**：fix-bug 不跑模型檢查，但 PRD 出現 `itf`、`quint`、`模型檢查`，或「反例」與「規格／spec」同時出現，issue-check 會誤判為 heavy-verify 並升到 critical tier。以「違反情境」取代「反例」，反例檔名寫到 `n2.INV_quorumSettles.*` 為止。
- **測試不依賴外部服務**：工廠 CI 沒有 Redis 等外部服務，要求以 stub 重現。
- 多張回放工單可同時開：試點三張都改 `src/index.ts` 的不同函式，合併無衝突。
- 修復合併後同樣要手動關閉 Issue。

---

## 12. 階段判定表（每次派工，LLM 成本發生前）

依 `src/write-spec/phase.ts` 的 `decidePhase`，由上而下第一個成立的條件決定結果：

| # | 狀態 | 結果 | 標籤變化 |
|---|---|---|---|
| 1 | Issue 已關閉 | ⛔ 拒絕 | — |
| 2 | 有 `spec/model-declined` | ⛔ 拒絕 | — |
| 3 | 本工作項有尚未合併的 factory PR | ⛔ 拒絕（避免重複產出） | — |
| 4 | 有 `spec/approved`，但最後貼標者不是 CODEOWNERS 人類 | ⛔ 拒絕 | — |
| 5 | 有 `spec/approved`，但 trunk 上沒有 `invariants.qnt` | ⛔ 拒絕 | — |
| 6 | 有 `spec/approved`，trunk 上也有 `invariants.qnt` | ▶ **模型階段** | ＋`spec/phase-model`；－`spec/phase-invariants`、`spec/model-outdated` |
| 7 | 沒有 `spec/approved`，也沒有 `spec/phase-model` | ▶ **不變量階段** | ＋`spec/phase-invariants` |
| 8 | 沒有 `spec/approved`，但有 `spec/phase-model`（不變量重做） | ▶ **不變量階段** | ＋`spec/phase-invariants`、`spec/model-outdated`；－`spec/phase-model` |

拒絕時 Issue 會出現「🛑 規格流程停止派工」留言並附原因；agent 未啟動，不產生 LLM 成本。同一張 Issue 的 run 以 concurrency group 排隊，不會同時執行。

## 13. 標籤一覽

| 標籤 | 誰貼 | 意義 |
|---|---|---|
| `spec/phase-invariants` | factory-run | 目前（或最近一次）跑的是不變量階段 |
| `spec/approved` | **CODEOWNERS 人類** | 不變量已核准，下次派工進入模型階段 |
| `spec/phase-model` | factory-run | 模型階段已執行過 |
| `spec/model-declined` | 人 | 刻意放棄模型階段（請留言說明理由） |
| `spec/model-outdated` | factory-run | 模型跑完後不變量又重做，舊模型結果已過期 |

**例外操作**（一律用標籤，不提供指定階段的 input，調整會留在 Issue timeline 可稽核）：

- **重做不變量**：重新打開 Issue（如已關閉）→ 移除 `spec/approved` → 派工。若曾跑過模型，會自動貼上 `spec/model-outdated`。
- **放棄模型階段**：貼 `spec/model-declined` 並留言理由，以區分「刻意不做」與「忘了做」。
- **`spec/approved` 被拒**：由 CODEOWNERS 本人移除後重新貼上。
- **查詢待辦**：`is:open label:spec/approved -label:spec/phase-model -label:spec/model-declined`。

---

## 14. 已知限制與注意事項

| 項目 | 說明 | 因應 |
|---|---|---|
| `Closes #N` 不生效 | GitHub 只在 PR 合併進預設分支（main）時處理關閉關鍵字；工廠 PR 一律合進 `software-factory` | 模型 PR 與回放 PR 合併後**手動關閉 Issue** |
| 抽樣不是證明 | `mode: run` 的「成立」只代表抽樣中沒找到反例 | 關鍵不變量補 `mode: verify`，並接受其牆鐘成本 |
| 模型保真度 | 流程全綠不代表模型忠於程式 | 模型 PR 審查必查（§10 清單）；落差另開 write-spec 修正 |
| 時間性質 | 時鐘跳躍、多時鐘等 Quint 表達不了 | 依 ADR-008 由人使用 UPPAAL（人工例外，不納入 CI） |
| 目標 repo lint | prettier 等格式化工具會掃到逐字保留的規格產物 | 目標 repo 加 `.prettierignore` 排除 `specs/`、`docs/specs/` |
| 沙箱中的 yarn | 目標 repo 位於機制 repo 之下，yarn 1.x 會讀到父層 `packageManager` 而拒絕執行 | agent 以 `npx tsc` 等價驗證；已回報為 skill-gap |
| 模型路由 | 2026-09-26 發現：DSH 升級到 0.1.7-rc.1（2026-09-24）後，`agent-default-model` 未被採用，所有 run 實際都用 DSH 內建的 `deepseek-official/deepseek-flash`，critical tier 未生效 | 修復前，以 Issue 留言的「Token 用量」段落確認實際模型 |
| 不自動重新驗證 | 程式修改後，模型不會自動重建或重跑 | 受 `quint-spec` 標註的模組被修改後，另開 write-spec 工單重跑模型階段 |
| 合併到 main | 工廠只讀寫 `software-factory`；是否合併到 main 由人決定 | 合併前確認目標 repo 的 CI（含外部服務的整合測試）通過，並評估規格書授權 |

---

## 15. 試點紀錄（2026-09-26，tradingbot-tw/node-redlock）

| 項目 | 內容 |
|---|---|
| 規格來源 | `docs/specs/redlock.md`（redis/docs@4000d4b 的 Redlock 規格原文） |
| 不變量階段 | Issue #1 → PR #2：7 條 `INV_*`，5 條未決事項；約 USD $0.11 |
| 機制修正 | witness 由「危險狀態」改為模型階段定義的情境（ADR-018 Q34，philipz/software_factory#321） |
| 模型階段 | PR #3：7 個實例（N=1–4、多資源、duration=1、using）；3 條違反、4 條成立；約 USD $0.15 |
| 候選發現 | 偶數節點平票 acquire 永久 pending；acquire 交出已過期的鎖；extend 交出已過期的鎖 |
| 回放 | Issue #4–#6（PR #7–#9、#11–#13、#15–#17）：三者皆紅燈重現並修復；本機重跑確認紅燈→綠燈 |
| 未抓到 | 重試被自己上次留下的 key 擋住——模型重試換新 token，程式實際沿用同一個 value |
| 總成本 | 約 USD $0.56（全部實際由 deepseek-flash 執行，見 §14「模型路由」） |
