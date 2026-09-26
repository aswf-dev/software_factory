# ADR-018：`agent-write-spec` 改為規格書驅動——不變量出自意圖、模型出自程式碼

- **狀態**：已接受（實作待後續 stacked PR）
- **日期**：2026-09-26
- **決定者**：平台架構（使用者經 grilling 逐項裁決 Q1–Q21）
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
| C. 假綠燈 | 「不變量成立 ≠ 實作正確」，因此每一條不變量都需要一個 witness，證明危險狀態確實可達 |

## 決策

### 1. 不引入演繹驗證（Q1）

TypeScript 沒有可以實際投入生產的演繹驗證器；把程式轉寫成 Dafny，會讓轉寫版和真實程式之間產生漂移。函式級合約改由在真實程式上執行的 PBT 承擔。

**重新評估的觸發條件**（任一成立）：出現 Java 或 Rust 的高風險模組；或 TS 出現可以實際使用的演繹驗證器。

### 2. `agent-write-spec` 以實作為準（Q2）

保留「可執行規格」的語意。`docs/21` §2.1 改寫為這個語意，並結案 Q21-1、Q21-2。「規格／設計草稿」若日後需要，另開一個新類型。

### 3. 規格書驅動，拆成兩張工單、兩個 run（Q3、Q10、Q13）

- 維持**單一類型** `agent-write-spec`，新增必填欄位「**規格階段**」：`invariants`（不變量）或 `model`（as-is 模型）。
- **不變量工單**先執行；它的 PR 合併、取得 `spec/approved` 後，才可以派發**模型工單**。
- 這是 `docs/06` §4.3 和 ADR-008「不得以自撰規格驗證自撰程式碼」的延伸：寫不變量的人，和寫模型的人，不是同一個 run。

### 4. 使用門檻（Q8）

兩個階段都要求：Issue 宣告的目標路徑命中 `risk-paths.yml` 的 H 規則，**或**目標 repo 的 `catalog-info` 有 `factory.io/quint-spec` 標註。由 `factory-issue-check` 重用 `extractDeclaredPaths()`／`checkRiskPaths()` 機械判定，不符合就不派工。

### 5. 規格來源（Q9''、Q15、Q18）

| 工單 | 規格來源欄位 |
|---|---|
| write-spec，規格階段 = `invariants` | **必填**。缺漏就判為不合規、不派工，不產生 LLM 成本 |
| write-spec，規格階段 = `model` | 不填；改為**必填「已核准不變量路徑」**；前置 PR 沒有 `spec/approved` 就拒絕派工 |
| 其他類型 | 沒有這個欄位；意圖以既有的 PRD 欄位為準 |

- **格式檢查**：只做格式與存在性檢查，**零網路請求**。repo 內的路徑必須存在於 trunk；URL 必須是**固定版本**（permalink、帶 commit 或版號），浮動網址直接拒絕。
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
  - **成立**：必須附 witness，證明危險狀態可達。
  - **違反**：必須附反例 ITF，並**回放到真實程式**。
  - **逾時**：照實記錄。
- 工單的成敗取決於**證據是否完整**，不是不變量是否成立。在 as-is 階段，違反本身就是發現。
- 不變量階段的驗證：`invariants.qnt` 能單獨通過 typecheck，而且每個 `INV_*` 都有 source 註解。

### 8. 兩條建模規則（Q7、Q21）

寫進 `task-template-write-spec.txt` 和 `factory-workflow` skill。vendored 的 `quint-lang`、`quint-modeling` 鎖在官方 commit（ADR-008），**不修改**。

1. **設定範圍以程式實際接受的輸入為準**：`verify.yml` 的每個實例常數都要附 `domain_justification`，寫出程式碼中的檢查位置（`file:line`），或註明「程式未限制」。程式沒有限制時，必須涵蓋邊界值和奇偶兩種情況。CI 只檢查欄位是否存在，內容由人審查。
2. **每一條反例都必須回放到真實程式**，重現後才算數。

### 9. 四道護欄全部落地（Q4、Q11、Q12）

| 護欄 | 落地形式 |
|---|---|
| ① 機械限制變更範圍 | `factory-crosscheck` 新增兩個階段模式：<br>・`invariants`：只允許 `specs/<name>/invariants.qnt`、`docs/**`<br>・`model`：只允許 `model.qnt`、`instances.qnt`、`verify.yml`、`docs/**`<br>・`invariants.qnt`、`source.md` 不得修改；`source.md` 必須和 CI 快照逐字元一致；`traces/` 只能由 CI 寫入<br>・越界即標為 needs-human |
| ② 類型層級禁止自動合併 | write-spec 一律不得自動合併 |
| ③ `spec/approved` | 由 **CODEOWNERS 的人類**在合併不變量 PR 時貼上。機器人不得貼標，由 CI 驗證貼標者身分。它擋的是模型工單的派工 |
| ④ 未決事項 | `report.json` 必填 `openQuestions[]`（可以是空陣列加理由）；PR README 必須有「未決事項」章節。由 judge 做 fail-loud 檢查（沿用 `requirements` 必填欄位的先例，docs/20 B1） |

### 10. UPPAAL 不納入 CI（Q5）

時間性質（例如時鐘跳躍、多時鐘）如果 Quint 表達不了，可以由人使用 UPPAAL，作為人工例外路徑（見 ADR-008 補記）。write-spec 工單**不得**要求 agent 使用 UPPAAL。

### 11. 開單入口同步（Q22、Q23）

新增的三個欄位（**規格階段**、**規格來源**、**已核准不變量路徑**）必須在四處同步，否則會重演 #238 的漂移事件（新增 task_type 時漏改 Backstage，表單永遠開不出該類型）：

| 位置 | 改動 |
|---|---|
| `backstage/templates/factory-work-item/template.yaml` | 新增表單參數，並把欄位寫進 Issue 內文（ADR-009、ADR-012 的主要開單入口） |
| `.github/ISSUE_TEMPLATE/factory-work-item.yml` | 新增為選填欄位，說明中寫明「僅 write-spec 必填」（GitHub 原生表單不支援條件欄位） |
| `src/factory-draft/issue-body.ts`（`buildIssueBody`） | 與 Backstage 內文格式逐字對齊，並維持與 `checkIssue` 的往返測試 |
| `src/cli/factory-issue-check.ts`（`FIELD_TITLES`） | 讀取欄位並做必填與格式檢查（Q9''、Q15） |

- **表單呈現**：Backstage 用 rjsf 的 `dependencies`／`oneOf` 做**條件式欄位**：只有選 `agent-write-spec` 才出現「規格階段」；選 `invariants` 時出現「規格來源」，選 `model` 時出現「已核准不變量路徑」。模板開頭記載 rjsf 跨欄位讀取「仍待瀏覽器實測」，**如果條件渲染行不通，就退回三個欄位一律顯示為選填**。
- **必填判斷的權威在 issue-check**：表單只負責讓人容易填對；即使條件渲染失敗，正確性也不受影響。
- **新增對抗性測試**：比照現有的「Backstage enum 與 workflow options 一致」測試，釘住三個欄位的標題在上述四處逐字一致。

## 後果

### 正面

- 規格出自意圖並逐字引用，堵住「照實作寫規格」這個 FM-Agent 實測失效的模式。
- 兩個 run 分離，加上 `invariants.qnt` 不得修改，**機械式**防止為了通過而把不變量寫弱。
- 目標 repo 的 `.qnt` 第一次有 CI 驗證；牆鐘預算依項目控制，避免重蹈 Issue #7 的逾時事故。
- `docs/21` 與實作的語意分歧消除；四道護欄從「靠紀律」變成「機械強制」加上一個人工擋關點。

### 負面

- 每次都需要兩張工單，加上一次人工核准，前置時間變長。
- 不變量工單需要先設計好抽象狀態詞彙，會稍微讀到程式碼（但不變量本身只能引用規格）。
- factory-run、issue-check、crosscheck、judge 都要改，實作面廣，而且全部位於 H5 路徑，只能由人實作。
- `domain_justification` 的內容無法機械判斷，品質仍然取決於人工審查。
- 新欄位要四處同步（§11），而且 Backstage 的條件式欄位依賴尚未經瀏覽器實測的 rjsf 行為；若退回「一律顯示為選填」，其他類型的使用者會看到三個與自己無關的欄位。

### 中性

- 模型階段會觸發 heavy-verify，自動升為 critical tier、套用 110 分鐘逾時預算（ADR-011），成本較高，但這是預期中的行為。
- `quint verify` 需要 Apalache（JVM），沿用現有的 heavy-verify 前置檢查。
- 集中驗證只驗證**當下**的產出；之後修改 `specs/` 不會自動重驗。如果需要持續防護，再考慮提供目標 repo 用的 workflow 樣板。

## 替代方案

| 方案 | 未採用的理由 |
|---|---|
| 引入 Dafny，以人工轉寫的方式驗證 TS | 轉寫版和真實程式會漂移，本質上是陷阱 B；TS 沒有原生的演繹驗證器 |
| 以 `docs/21` 為準，把可執行規格類型改名 | 實作已有 enum、模板、skill、對抗性測試與使用紀錄，改名成本高於改文件 |
| 新增一個獨立的 `agent-intent-spec` 類型 | 會重複一整套接線；用「規格階段」欄位就能在單一類型內分流 |
| 同一個 run 寫不變量和模型，只靠逐字引用和人工審查 | 同一個 agent 可以同時調整兩邊，讓結果剛好一致；沒有機械上的防護 |
| 不變量以 Markdown 撰寫，再由模型工單翻譯成 `.qnt` | 翻譯步驟由寫模型的 agent 自己完成，正是要堵住的漏洞 |
| 沿用 `INV_VIOLATED_*` 前綴，由 agent 宣告預期結果 | 那是修復後回歸閘門用的慣例；在 as-is 階段讓 agent 宣告預期，等於允許把發現標成綠燈 |
| 由 CI 抓取 URL 驗證規格來源 | 結果會隨外部狀態改變，破壞 issue-check「零成本、可重現」的原則 |
| 把 UPPAAL 放進 CI | 整個工廠只用過一次，而且是人工；工具需要授權與桌面安裝；agent 做模型檢查的牆鐘時間已被證實難以控制 |

## 實作順序與驗收

1. **本 ADR**，同步更新 `docs/21` §1／§2.1／§4、`docs/10`（結案 Q21-1、Q21-2）、ADR-008 補記。
2. **Stacked PR 實作**（依序）：
   1. **開單入口與 issue-check**：依 §11 在四處同步新增「規格階段」「規格來源」「已核准不變量路徑」欄位，並加上欄位一致性的對抗性測試；issue-check 實作 Q8 門檻與 Q15 格式檢查。Backstage 的條件式欄位需在瀏覽器實測，不行就退回選填。
   2. crosscheck：新增兩個階段模式。
   3. factory-run：寫入 `source.md` 快照、檢查 `spec/approved` 與貼標者身分、依 `verify.yml` 集中驗證、類型層級禁止自動合併。
   4. judge：新增 `openQuestions` 的 fail-loud 檢查。
   5. 模板與 `factory-workflow` skill：寫入兩條建模規則和兩個階段的說明（放在最後，確保 agent 看到的說明和已經生效的機制一致）。
3. **驗收試點：重跑 node-redlock**（上游 `afe5cf9`）。
   - 第一張工單的不變量引用 redis.io 規格的 repo 內存檔。
   - 第二張工單的模型設定 `NODES ∈ {2,3,4}`。
   - **驗收標準**：找到偶數節點平票 hang，並重現 F1、F5，三者都完成回放到真實程式。
