# ADR-018：`agent-write-spec` 改為規格書驅動——不變量出自意圖、模型出自程式碼

- **狀態**：已接受；實作完成於 stacked PR #315（開單入口）→ #316（crosscheck）→ #317（階段判定）→ #318（集中驗證）→ #319（未決事項）→ #320（作業規則），試點補修 #321（情境 witness，Q34）。驗收試點 2026-09-26 通過（tradingbot-tw/node-redlock，見 `docs/28` §15）
- **日期**：2026-09-26
- **決定者**：平台架構（使用者經 grilling 逐項裁決 Q1–Q30；實作期間補裁 Q31–Q33；試點補裁 Q34）
- **操作手冊**：`docs/28-write-spec-runbook.md`（逐步操作、`spec/approved` 流程、標籤與判定表、試點紀錄）
- **對應**：`ADR-008`（Quint 神諭橋）、`ADR-009`（Backstage 統一入口）、`ADR-011`（heavy-verify 升級）、`ADR-012`（集中執行）、`ADR-016`（產出與生效分離）、`docs/06` §4.3、`docs/21` §2.1、`docs/10` Q21-1／Q21-2

## 脈絡

### 現況（2026-09-26 盤點）

- **演繹驗證**（Dafny、Verus、OpenJML、Frama-C WP）：除 `docs/research/` 外，repo 內 0 次出現。
- **`agent-write-spec`**：於 `5b9e2d8`（2026-09-13，heavy-verify 事故修正）**順帶加入**。
  - 已有 enum、`task-template-write-spec.txt`、`factory-workflow` skill 的說明，以及對抗性測試。
  - 語意為「可執行規格（`.qnt`），**依 Issue 描述程式現況**」。
  - 唯一一張工單是 node-redlock #7，以 50 分鐘逾時收場，產出為零。
- **同名不同義**：`docs/21` §2.1 將 `agent-write-spec` 定義為「規格／設計**草稿**，不產程式碼」，並列出四道護欄。但 Q21-1、Q21-2 至今未裁決，四道護欄也**都沒有落地**：
  - 沒有 `spec/approved` 標籤。
  - `factory-crosscheck` 沒有 write-spec 模式，「不改 `src/`」只寫在 prompt 裡。
  - 計分邏輯不看工單類型，因此沒有「類型層級禁止自動合併」。
- **沒有「規格書 → 不變量」這一步**：目前的輸入只有 Issue 內文。
- **目標 repo 的 `.qnt` 沒有 CI 驗證**：`quint-verify.yml` 只在本 repo 生效，範圍寫死為 `specs/scoring/score.qnt`。
- **UPPAAL**：repo 內 0 次出現；只在 agent-playground/node-redlock 分支上由人工使用（F9）。

### 實證

**FM-Agent 實測**（2026-09-25 本機評估，報告未入庫；上游 `afe5cf9`，deepseek-flash／qwen3.8-flash／Opus 5.5）：三個模型都漏掉 node-redlock 的 F1、F5（Redlock 有效期檢查）。根因是：公開 API 在函式庫內沒有呼叫端，所以**規格只能照實作寫**，推理器自然判為一致。這說明**規格必須出自意圖，不能出自實作**。

**node-redlock 的 Quint＋UPPAAL 路線**確認了 F1–F5、F7–F9，但暴露出三個會讓結論失效的陷阱：

| 陷阱 | 實證 |
|---|---|
| A. 建模時的假設把 bug 排除掉 | 所有實例都是 `NODES = Set(1,2,3)`，而且 `redlockAssumptions` 斷言 `NODES.size() % 2 == 1`。程式本身接受任意 N，所以**偶數節點平票時 `acquire()` 永久 pending** 被漏掉。FM-Agent（Opus 5.5、qwen）後來各自獨立找到這個 bug |
| B. 模型保真度不足 | as-is 的 F7 反例是**模型假象**（README 自行更正） |
| C. 假綠燈 | 「不變量成立 ≠ 實作正確」，因此每一條不變量都需要一個 witness，證明它要保護的情境確實可達 |

## 決策

### 1. 不引入演繹驗證（Q1）

TypeScript 沒有可以實際投入生產的演繹驗證器；把程式轉寫成 Dafny，會讓轉寫版和真實程式之間產生漂移。函式級合約改由在真實程式上執行的 PBT 承擔。

**重新評估的觸發條件**（任一成立）：出現 Java 或 Rust 的高風險模組；或 TS 出現可以實際使用的演繹驗證器。

> **修訂（ADR-019，2026-10-04）**：本段的「PBT 承擔」已由 `ADR-019` 落實並收斂為：**函式級合約目前由 `agent-pbt-audit` 工作項事後稽核，不在開發當下強制**。詳細內容與已知缺口見文末補記。

### 2. `agent-write-spec` 以實作為準（Q2）

保留「可執行規格」的語意。`docs/21` §2.1 改寫為這個語意，並結案 Q21-1、Q21-2。「規格／設計草稿」若日後需要，另開一個新類型。

### 3. 規格書驅動：一張 Issue、兩個 run（Q3、Q10'、Q24、Q29）

- 維持**單一類型** `agent-write-spec`。同一張 Issue 依序派工兩次：
  1. **不變量階段**：從規格書萃取不變量。
  2. **模型階段**：依程式碼撰寫 as-is 模型，並執行模型檢查。
- **階段由 factory-run 依狀態推導**，開單時不填、派工時也不能指定（判定規則見 §12）。
- 兩個階段之間**必須經過人工核准**：人合併不變量 PR 之後，在 **Issue** 上貼 `spec/approved`，才能跑模型階段。
- 這是 `docs/06` §4.3 和 ADR-008「不得以自撰規格驗證自撰程式碼」的延伸：寫不變量和寫模型的是兩個不同的 run，中間隔著一次人工核准。
- **只保證「不會被遺忘」，不保證自動執行**：模型階段會被升為 critical tier，是整座工廠最貴的 run，何時執行由人決定；不變量也可能直接暴露設計問題，讓人決定不做模型。另外，跨 repo 事件收不到（docs/16），核准後自動派工在技術上也做不到。
- **狀態以 Issue 標籤表示**：`spec/phase-invariants` → `spec/approved`（由人貼上）→ `spec/phase-model` → 完成時關閉；另有 `spec/model-declined`（放棄）與 `spec/model-outdated`（過期）。

### 4. 使用門檻（Q8）

兩個階段都要求：Issue 宣告的目標路徑命中 `risk-paths.yml` 的 H 規則，**或**目標 repo 的 `catalog-info` 有 `factory.io/quint-spec` 標註。由 `factory-issue-check` 重用 `extractDeclaredPaths()`／`checkRiskPaths()` 機械判定，不符合就不派工。

### 5. 規格來源（Q9''、Q15、Q18）

write-spec 新增**兩個必填欄位**，缺漏就判為不合規、不派工，不產生 LLM 成本：

| 欄位 | 內容 |
|---|---|
| **規格名稱** | 決定 `specs/<name>/` 的目錄名稱，也因此固定了 `invariants.qnt` 的路徑 |
| **規格來源** | repo 內的檔案路徑，或 `issue`。**不接受 URL**（Q32） |

其他類型沒有這兩個欄位；意圖以既有的 PRD 欄位為準。

- **格式檢查**：只做格式與存在性檢查，**零網路請求**。repo 內的路徑必須存在於 trunk；不得是絕對路徑或以 `..` 指向 repo 外。
- **不接受 URL**（Q32，實作期間補裁）：網頁原文多為 HTML，夾雜導覽與樣式，「逐字引用」在實務上難以對齊；有版本的網頁可以先存檔進 repo 再引用，多一種來源只會多一條不好驗證的路徑。issue-check 對 URL 一律判不合規，並提示先存檔進 repo。
- **沒有規格書時**：填 `issue`。run 開始時由 **CI**（不是 agent）把當下的 PRD 欄位原文寫入 `specs/<name>/source.md`，附上 Issue 編號與擷取時間。

### 6. 產出形式（Q14、Q19）

```
specs/<name>/
  source.md        ← CI 寫入的快照（使用外部規格書時放引用出處）
  invariants.qnt   ← 不變量階段：抽象狀態詞彙＋INV_*，每條附 `// source: <出處> §<節>` 逐字引用
  model.qnt        ← 模型階段：as-is 模型，必須 import invariants.qnt
  instances.qnt    ← 具體設定的實例模組
  verify.yml       ← 驗證清單：實例 × 不變量 × max-steps × 牆鐘預算 × witness
  traces/          ← 只能由 CI 寫入：反例 ITF
```

### 7. 驗證結果由 CI 判定（Q6、Q20）

- 由 **factory-run 集中驗證**（呼應 ADR-012）；目標 repo 不放 workflow。
- `verify.yml` 只宣告「**要跑什麼**」，**不得宣告預期結果**。每條不變量的結果一律由 CI 計算：
  - **成立**：必須附 witness，證明不變量要保護的情境可達（Q34：情境 witness 定義在 `model.qnt`）。
  - **違反**：必須附反例 ITF，記為「**候選發現（未回放）**」；回放方式見 §8 規則 2。
  - **逾時**：照實記錄。
- 工單的成敗取決於**證據是否完整**，不是不變量是否成立。在 as-is 階段，違反本身就是發現。
- 不變量階段的驗證：`invariants.qnt` 能單獨通過 typecheck，而且每個 `INV_*` 都有 source 註解。

**`verify.yml` 格式與判定細節**（2.3b 實作時依 Quint 0.32.0 實測確定）：

```yaml
instances:          # 每個常數都要附 domain_justification（Q21），否則不合規
  - { module: even, constants: { N: { value: "2", domain_justification: "src/index.ts 未限制節點數" } } }
checks:             # schema 拒絕任何未知欄位，因此無法宣告預期結果
  - { instance: even, invariant: INV_settles, mode: run, max_steps: 12,
      max_samples: 10000, timeout_seconds: 600, witnesses: [WIT_allVotesIn] }
```

- **每條不變量都必須至少有一項檢查**；全部檢查的逾時總和上限 1800 秒。
- `mode: run` 以 `quint run --witnesses` 一次取得違反與 witness 次數；`mode: verify`（Apalache）不回報 witness，成立時 CI 另以 `quint run` 量測可達性。
- **witness 可達性以「每條不變量」彙總**，不逐項判定：同一條不變量要保護的情境，在某個實例上可能本來就不會發生，只要**至少一個實例**可達即可；全部不可達才算假綠燈嫌疑。
- 判定優先序：違反 > 執行錯誤 > 逾時 > 成立／假綠燈。錯誤與假綠燈交還人類；違反與逾時只記錄。
- `traces/` 由 CI 在每次模型階段開始時清空，只保留本次違反的 ITF，並以 CI 身分提交回分支。
- **witness 是情境，只能定義在 `model.qnt`**（Q34，2026-09-26 試點補裁）：witness 以正面敘述描述不變量要保護的情境確實發生（例如「所有節點的票都已回來」），**不得**是不變量的否定。試點 tradingbot-tw/node-redlock#1 的不變量階段依原規則「定義危險狀態的 `WIT_*`」，7 條全部寫成 `¬INV`：這種 witness 在不變量成立時必然不可達（Quint 0.32.0 實測：`INV_settles` 成立時 `WIT_tie` 0/200 條軌跡，情境 witness `WIT_allVotesIn` 200/200），正確的不變量會一律被判為假綠燈。情境是否可達取決於程式行為，因此由模型階段定義；`verify.yml` 引用 `invariants.qnt` 的 `WIT_*` 時 CI 判為不合規。不變量階段不再定義 `WIT_*`。
- **`model.qnt` 必須 `export invariants.*`**：只 `import` 的話，`instances.qnt` 的實例模組看不到不變量（`QNT404`）。這條要寫進 2.5 的模板規則。
- factory-run 的 job 逾時由 150 分調為 **185 分**：模型階段的 agent（上限 115 分）與集中驗證（上限 35 分）可能在同一個 run 內都用滿。

### 8. 兩條建模規則（Q7、Q21）

寫進 `task-template-write-spec.txt` 和 `factory-workflow` skill。vendored 的 `quint-lang`、`quint-modeling` 鎖在官方 commit（ADR-008），**不修改**。

1. **設定範圍以程式實際接受的輸入為準**：`verify.yml` 的每個實例常數都要附 `domain_justification`，寫出程式碼中的檢查位置（`file:line`），或註明「程式未限制」。程式沒有限制時，必須涵蓋邊界值和奇偶兩種情況。CI 只檢查欄位是否存在，內容由人審查。
2. **每一條反例都必須回放到真實程式**，重現後才算數。**回放由後續的 `agent-fix-bug` 工單完成**（Q31，實作期間補裁）：它的 `01-test` 層寫出重現反例的**紅燈測試**，這就是回放；重現成功才是確認的 bug，重現不了就標為模型假象。理由：模型階段的白名單不允許寫測試程式，而回放方式隨專案而異，CI 做不出通用機制；紅燈測試本身就是最可靠的回放證據，也直接沿用 docs/07「01-test 必須先紅燈」的紀律。

### 9. 四道護欄全部落地（Q4、Q11、Q12）

| 護欄 | 落地形式 |
|---|---|
| ① 機械限制變更範圍 | `factory-crosscheck` 依 factory-run 推導出的階段套用白名單：<br>・`invariants`：只允許 `specs/<name>/invariants.qnt`、`specs/<name>/source.md`（CI 寫入、由 agent 原封不動提交）、`docs/**`<br>・`model`：只允許 `model.qnt`、`instances.qnt`、`verify.yml`、`docs/**`<br>・`invariants.qnt`、`source.md` 不得修改；`source.md` 必須和 CI 快照逐字元一致；`traces/` 只能由 CI 寫入<br>・**關閉關鍵字**：不變量階段的 PR 必須寫 `Refs #N`（寫 `Closes #N` 會在第一階段就關掉 Issue），模型階段的 PR 才寫 `Closes #N`<br>・越界即標為 needs-human |
| ② 類型層級禁止自動合併 | write-spec 一律不得自動合併 |
| ③ `spec/approved` | 由 **CODEOWNERS 的人類**在合併不變量 PR 之後，貼在 **Issue** 上。factory-run 以 Issue timeline API 驗證貼標者；機器人或 App 貼的一律視為未核准。它擋的是模型階段的派工 |
| ④ 未決事項 | `report.json` 必填 `openQuestions`：至少一條未決事項的字串陣列，或確實沒有時寫 `{ "none": "<理由>" }`（空陣列不算回答）；PR 描述必須有「未決事項」章節（`##`–`####` 標題）。由 **crosscheck** 的 write-spec 模式做 fail-loud 檢查——`requirements` 必填欄位的先例（docs/20 B1）本來就在 crosscheck，而 PR 描述也只有 crosscheck 拿得到；crosscheck 失敗時 judge 不執行並交還人類，效果與原先寫的「由 judge 檢查」相同（2.4 實作時更正） |

### 10. UPPAAL 不納入 CI（Q5）

時間性質（例如時鐘跳躍、多時鐘）如果 Quint 表達不了，可以由人使用 UPPAAL，作為人工例外路徑（見 ADR-008 補記）。write-spec 工單**不得**要求 agent 使用 UPPAAL。

### 11. 開單入口同步（Q22、Q23）

新增的兩個欄位（**規格名稱**、**規格來源**）必須在四處同步，否則會重演 #238 的漂移事件（新增 task_type 時漏改 Backstage，表單永遠開不出該類型）：

| 位置 | 改動 |
|---|---|
| `backstage/templates/factory-work-item/template.yaml` | 新增表單參數，並把欄位寫進 Issue 內文（ADR-009、ADR-012 的主要開單入口） |
| `.github/ISSUE_TEMPLATE/factory-work-item.yml` | 新增為選填欄位，說明中寫明「僅 write-spec 必填」（GitHub 原生表單不支援條件欄位） |
| `src/factory-draft/issue-body.ts`（`buildIssueBody`） | 與 Backstage 內文格式逐字對齊，並維持與 `checkIssue` 的往返測試 |
| `src/cli/factory-issue-check.ts`（`FIELD_TITLES`） | 讀取欄位並做必填與格式檢查（Q9''、Q15） |

- **表單呈現**：Backstage 用 rjsf 的 `dependencies`／`oneOf` 做**條件式欄位**：只有選 `agent-write-spec` 才出現這兩個欄位。模板開頭記載 rjsf 跨欄位讀取「仍待瀏覽器實測」，**如果條件渲染行不通，就退回兩個欄位一律顯示為選填**。
- **必填判斷的權威在 issue-check**：表單只負責讓人容易填對；即使條件渲染失敗，正確性也不受影響。
- **新增對抗性測試**：比照現有的「Backstage enum 與 workflow options 一致」測試，釘住兩個欄位的標題在上述四處逐字一致。

### 12. 順序保證與追蹤（Q26'''、Q27、Q28、Q30）

**階段判定表**：每次派工時，factory-run 在任何 LLM 成本發生前，依 Issue 標籤與 trunk 上的檔案決定本次的動作：

| 狀態 | 本次派工 |
|---|---|
| 沒有 `spec/approved`，也沒有尚未合併的不變量 PR | ▶ 跑**不變量階段** |
| 不變量 PR 已開、還沒合併 | ⛔ 拒絕（避免重複產出） |
| 有 `spec/approved`，但 trunk 上沒有 `specs/<name>/invariants.qnt` | ⛔ 拒絕（狀態不一致） |
| 有 `spec/approved`，trunk 上也有 `invariants.qnt` | ▶ 跑**模型階段**，自動套用 heavy-verify tier |
| 有 `spec/model-declined`，或 Issue 已關閉 | ⛔ 拒絕 |

**其餘三層保證**：

- **同一張 Issue 不會有兩個 run 同時執行**：沿用現有的 concurrency group `factory-<repo>-<issue>`（`cancel-in-progress: false`），第二次派工會排隊，開始時重新判斷狀態。
- **`spec/approved` 必須是人貼的**（§9 護欄③）。
- **agent 無法越過自己的階段**：階段由 CI 寫進任務描述，crosscheck 依階段套用白名單（§9 護欄①）。

**人工例外一律用標籤處理，不提供強制指定階段的 input**（Q30）。強制指定的 input 等於留下「跳過第一階段」的後門；調整標籤則會留在 Issue timeline，可以稽核：

- **重做不變量**：重新打開 Issue（如已關閉）、移除 `spec/approved`，再派工。
- **放棄模型階段**（Q27）：貼上 `spec/model-declined`，並留言說明理由，以區分「刻意不做」和「忘了做」。

**過期偵測在事件發生當下進行，不靠排程**（Q28）：不變量只有「重跑不變量階段」這一條正規修改路徑。factory-run 跑不變量階段時，如果這張 Issue 有 `spec/phase-model` 的紀錄，就當場貼上 `spec/model-outdated`。繞過工廠直接手動修改 `invariants.qnt` 不在偵測範圍內，但那屬於人的刻意行為，會經過 PR 審查。

**待辦與停滯**（Q26'''）：

- **待辦就是一直開著的 Issue**：不變量 PR 寫的是 `Refs`，所以 Issue 會一直開到模型階段完成。
- **查詢方式**：用一條跨 repo 的固定搜尋，例如 `is:open label:spec/approved -label:spec/phase-model -label:spec/model-declined user:philipz org:agent-playground`。
- **不做排程**：write-spec 只用於高風險模組（§4），使用量極低，不值得為它建立排程、納管 repo 清單和看板。
- **升級條件**：一旦出現第一筆「已核准超過 14 天仍未派工模型」的工單，就新增每日排程掃描。

**終態標籤**：judge 的 `state/*` 標籤一律以**最新一次 run** 為準（直接覆蓋）；目前在哪個階段，由 `spec/phase-*` 表示。

## 後果

### 正面

- 規格出自意圖並逐字引用，堵住「照實作寫規格」這個 FM-Agent 實測失效的模式。
- 兩個 run 分離，加上 `invariants.qnt` 不得修改，**機械式**防止為了通過而把不變量寫弱。
- 目標 repo 的 `.qnt` 第一次有 CI 驗證；牆鐘預算依項目控制，避免重蹈 Issue #7 的逾時事故。
- `docs/21` 與實作的語意分歧消除；四道護欄從「靠紀律」變成「機械強制」加上一個人工擋關點。

### 負面

- 同一張 Issue 需要派工兩次，中間加上一次人工核准，前置時間變長。
- 不變量工單需要先設計好抽象狀態詞彙，會稍微讀到程式碼（但不變量本身只能引用規格）。
- factory-run、issue-check、crosscheck、judge 都要改，實作面廣，而且全部位於 H5 路徑，只能由人實作。
- `domain_justification` 的內容無法機械判斷，品質仍然取決於人工審查。
- 新欄位要四處同步（§11），而且 Backstage 的條件式欄位依賴尚未經瀏覽器實測的 rjsf 行為；若退回「一律顯示為選填」，其他類型的使用者會看到兩個與自己無關的欄位。
- 停滯仍要靠人發現，直到觸發 §12 的升級條件為止。
- `factory-pr-stacking` skill 目前一律要求 `Closes #N`，需要依階段區分，並由 crosscheck 機械檢查。

### 中性

- 模型階段會觸發 heavy-verify，自動升為 critical tier、套用 110 分鐘逾時預算（ADR-011），成本較高，但這是預期中的行為。
- `quint verify` 需要 Apalache（JVM），沿用現有的 heavy-verify 前置檢查。
- 集中驗證只驗證**當下**的產出；之後修改 `specs/` 不會自動重驗。如果需要持續防護，再考慮提供目標 repo 用的 workflow 樣板。

## 替代方案

| 方案 | 未採用的理由 |
|---|---|
| 引入 Dafny，以人工轉寫的方式驗證 TS | 轉寫版和真實程式會漂移，本質上是陷阱 B；TS 沒有原生的演繹驗證器 |
| 以 `docs/21` 為準，把可執行規格類型改名 | 實作已有 enum、模板、skill、對抗性測試與使用紀錄，改名成本高於改文件 |
| 新增一個獨立的 `agent-intent-spec` 類型 | 會重複一整套接線；在單一類型內依狀態推導階段即可分流 |
| 兩張子 Issue 加一個父 Issue（GitHub sub-issues） | 要建立 3 張 Issue 並設定子 Issue 關係，Backstage 模板變複雜；三個核心保障（獨立性、人工核准、tier 分開）要求的是兩個 run，不是兩張 Issue |
| 以「規格階段」欄位由人指定階段 | 人可能選錯，也等於提供跳過第一階段的途徑；階段可以完全由狀態推導 |
| 不變量核准後自動派工模型階段 | 收不到跨 repo 事件，技術上做不到；而且模型階段是最貴的 run，應由人決定何時執行 |
| 提供強制指定階段的 input | 會成為跳過第一階段的後門，讓 §12 的判定表失效 |
| 每日排程掃描加看板 Issue | 需要第一個 cron workflow、掃描 CLI 與一份會漂移的納管 repo 清單；以目前的使用量不划算。保留為升級選項 |
| 同一個 run 寫不變量和模型，只靠逐字引用和人工審查 | 同一個 agent 可以同時調整兩邊，讓結果剛好一致；沒有機械上的防護 |
| 不變量以 Markdown 撰寫，再由模型工單翻譯成 `.qnt` | 翻譯步驟由寫模型的 agent 自己完成，正是要堵住的漏洞 |
| 沿用 `INV_VIOLATED_*` 前綴，由 agent 宣告預期結果 | 那是修復後回歸閘門用的慣例；在 as-is 階段讓 agent 宣告預期，等於允許把發現標成綠燈 |
| 由 CI 抓取 URL 驗證規格來源 | 結果會隨外部狀態改變，破壞 issue-check「零成本、可重現」的原則 |
| 支援 URL 來源，由 CI 在 factory-run 下載原文寫入快照 | 網頁 HTML 夾雜導覽與樣式，逐字引用難以對齊；先存檔進 repo 即可（Q32） |
| 放寬模型階段白名單，讓 agent 寫回放測試 | 回放方式隨專案而異，會把專案專屬的測試混進規格工單；由 fix-bug 工單的紅燈測試回放更可靠（Q31） |
| 在 `src/scoring` 依工單類型禁止自動合併 | 計分以 Quint 規格驗證（ADR-008），只讀客觀來源；工單類型不是計分輸入。改在 judge 取得計分結果之後套用 |
| 把 UPPAAL 放進 CI | 整個工廠只用過一次，而且是人工；工具需要授權與桌面安裝；agent 做模型檢查的牆鐘時間已被證實難以控制 |

## 實作順序與驗收

1. **本 ADR**，同步更新 `docs/21` §1／§2.1／§4、`docs/10`（結案 Q21-1、Q21-2）、ADR-008 補記。
2. **Stacked PR 實作**（依序）：
   1. **開單入口與 issue-check**：依 §11 在四處同步新增「規格名稱」「規格來源」欄位，並加上欄位一致性的對抗性測試；issue-check 實作 Q8 門檻與 Q15 格式檢查。Backstage 的條件式欄位需在瀏覽器實測，不行就退回選填。
   2. crosscheck：依階段套用白名單，並檢查關閉關鍵字（不變量階段 `Refs`、模型階段 `Closes`）。
   3. factory-run（Q33：拆成兩個 PR）：
      - **3a**：§12 的階段判定表與標籤轉換（`factory-spec-phase` CLI）、寫入 `source.md` 快照、驗證 `spec/approved` 的貼標者、事件驅動的過期偵測、依階段選 tier（不變量階段不套用 heavy-verify、模型階段強制套用）、類型層級禁止自動合併（judge 在計分之後套用）、帶參數呼叫 crosscheck。
      - **3b**：`verify.yml` 的 schema 與集中驗證執行器（Quint／Apalache、逐項逾時、witness 可達性、反例 ITF 寫回分支）。
   4. crosscheck：新增 `openQuestions` 與 PR「未決事項」章節的 fail-loud 檢查（原寫 judge，實作時更正，理由見 §9 護欄④）。
   5. 模板與 skill：`task-template-write-spec.txt` 與 `factory-workflow` skill 寫入兩條建模規則和兩個階段的說明；`factory-pr-stacking` skill 依階段區分 `Refs`／`Closes`。放在最後，確保 agent 看到的說明和已經生效的機制一致。
3. **驗收試點：重跑 node-redlock**（上游 `afe5cf9`）。
   - 第一次派工（不變量階段）：不變量引用 redis.io 規格的 repo 內存檔。
   - 核准後第二次派工（模型階段）：模型設定 `NODES ∈ {2,3,4}`。
   - **驗收標準**：找到偶數節點平票 hang，並重現 F1、F5；三者再各開一張 fix-bug 工單，由紅燈測試完成回放到真實程式（Q31）。

## 補記（2026-10-04）：§1 的 PBT 條款由 ADR-019 落實

§1 的「函式級合約改由在真實程式上執行的 PBT 承擔」原本只是一句未落地的話——repo 內沒有任何 PBT 工具或程式碼。`ADR-019` 把它落實為可執行的決定：

- **收斂為事後稽核**：函式級合約**目前由 `agent-pbt-audit` 工作項事後稽核，不在開發當下強制**（`ADR-019` §2）。本 ADR 的 write-spec 流程本身不產生 property。
- **工具統一用 Hegel**，適用範圍限**目標 repo**；工廠自己的 `src/` 不在本次範圍（`ADR-019` §1）。
- **`INV_*` 的接點**：稽核的模組若有已核准的 `INV_*`，該 invariant 必須翻譯成 property 跑在真實程式碼上，並標註 `// source: INV_xxx`（`ADR-019` §3）。
- **§1 的重新評估條件已成立**：「出現 Java 或 Rust 的高風險模組」於 2026-10-04 盤點時成立（已接入 Java 21 / JUnit 5 的 `trial/spring-modulith-orders`）。

**已知缺口（明列，避免日後被當成「已決定不做」）**：

1. **成立的 `INV_*` 從未在真實程式碼上驗證過**。本 ADR §7 只把**被違反**的 invariant 轉成「候選發現（未回放）」並由 `agent-fix-bug` 回放；成立的 invariant 只證明「模型滿足它」，不證明程式碼滿足它。`ADR-019` §10 已列此缺口與重新評估條件。
2. **開發當下沒有 PBT**：新寫的函式要等到有人開稽核 Issue 才會有 property。
3. 工廠自己的 `src/` 不在 PBT 範圍內。

`ADR-019` §8 處理了本 ADR 未及的一項原則衝突：`ADR-008` 的「供應鏈最小化」與 PBT 工具引入 native binary 之間的張力。
