# ADR-029：aswf.dev 形式化驗證服務——以 BPMN 串起 grill → Quint → Lean → 反例測試

- **狀態**：已接受（2026-10-27，使用者經 grilling 逐題裁決 Q1–Q30 並確認共識摘要；PoC 依 §9 驗收）
- **日期**：2026-10-27
- **決定者**：使用者
- **修訂**：`ADR-018` §1（允許 Lean 4 演繹驗證，限本服務）、`ADR-013`（驗證專用 repo 豁免 `software-factory` trunk）
- **對應**：`ADR-027`／`ADR-028`（BPMN 編排與執行核心）、`ADR-001`（GitHub 為事實來源）、`ADR-006`（GitHub App 身分）、`ADR-015`（Scoreboard 平台）、`ADR-018`（`agent-write-spec` 的 Quint 驗證機制）

## 脈絡

兩次在本機 agent session 中完成的分析，證明「先訪談規則、再用 Quint 找反例、再用 Lean 獨立證明、最後寫成反例測試」能找出人工審查與規則式工具都找不到的缺陷：

- **CamundaSagaPatternExample**：Quint 在 8 條業務規則中找到 7 條的反例（5 類），Lean 證明整張 6×8 矩陣並逐條重播 22 條 Quint trace；對抗式審查另外找到 Quint 漏掉的 CE-6（parallel join 衝突導致重複訂位）；29 個反例測試先以 `todo` 落地，修正後全部轉綠。
- **keycloak**：在 OAuth2/OIDC token 生命週期找到 F1（任何 client 用偽造 code 拆掉別的 client 的 session，可重複觸發的定向 DoS）與 F2（session 被拆後 1 秒內 SSO 重新登入，舊 token 復活），兩者都在真實伺服器上以 integration test 重現。依該專案 `SECURITY.md`，這類發現必須私下通報。

這兩次都靠人在 session 中逐輪回答問題，成本高、無法交給外部使用者。本 ADR 把這套流程產品化為 aswf.dev 上的獨立功能，並以 `ADR-027`／`ADR-028` 的 BPMN 執行核心控制流程。

與既有決策的衝突：

- `ADR-018` §1 明文「不引入演繹驗證」（其重評觸發條件「出現 Java 或 Rust 的高風險模組」已於 2026-10-04 成立，見 `ADR-019` 補記）。
- `ADR-013` 規定所有 repo 的 factory trunk 一律為 `software-factory` 分支、`main` 絕不觸碰；對外部使用者，「先建分支、放 `catalog-info.yaml` 與 `risk-paths.yml`」的接入門檻過高。
- 機制 repo 是公開的：factory-run 會把 `target/.factory/run/`（含 agent stdout 與 `report.json`）上傳為保存 90 天的 artifact，任何登入 GitHub 的人都能下載；agent 也會把產出推到目標 repo 的分支。資安相關的反例因此會在人判斷之前就公開。

## 決策

### 1. 範圍（Q2、Q3、Q6）

- **找的是狀態、協定與業務邏輯的缺陷，包括有資安影響的**（時序、重送、冪等、session 與 token 生命週期、授權檢查順序、資金或數量守恆）。注入、XSS、相依套件 CVE 等規則式漏洞不在範圍內，交給 `security-scan.yml`、Dependabot 等既有工具。對外用詞為「狀態與邏輯缺陷（含資安影響）」，不稱「漏洞掃描」。
- **對象**：任何 GitHub 使用者自助使用；不限程式語言。

### 2. 流程（Q4、Q15、Q16'）

```
① grill(agent 讀碼) → G1 規則確認（aswf.dev 多輪表單，問到沒有未確認的問題為止）
② quint(agent) → G2 結果分類 → publish-quint
   → [白名單？] ─否→ 結束
③ lean-statements(agent) → G3 定理敘述簽核 → lean-proofs(agent)
④ tests(agent) → publish-tests → G4 PR 審查（合併即完成）
```

| 階段 | 產出 | 人工關卡 |
|---|---|---|
| ① grill | 程式碼摘要、候選規則、第一輪問題；G1 後產出經確認的 `RULES.md` | **G1**：規則與假設確認 |
| ② quint | `specs/quint/`（模型、instances、測試、`REPORT.md`、ITF traces） | **G2**：每個反例判定為真缺陷／模型假象／設計取捨；是否送 Lean；**是否涉及資安**。結果寫入 `specs/quint/TRIAGE.md`（含判定者與時間） |
| ③ lean | `specs/lean/`（`RULES.md` 由 `TRIAGE.md`＋Quint `REPORT.md` 轉錄、模型、定理、證明、`MODEL-MAP.md`、`REPORT.md`） | **G3**：定理敘述的業務語言版本簽核（lean-formal-verification 的 Phase 2 閘門） |
| ④ tests | 以專案語言撰寫、標為 `todo`／`skip` 的反例測試 | **G4**：使用者在 GitHub 上審查 PR |

- **G1 的追問方式**（Q9）：只有第一次由 agent 讀碼；之後每一輪由 Worker LLM 帶著 agent 產出的程式碼摘要追問，**不設輪數上限**，問到沒有未確認的問題為止。每輪一次給出所有可問的題目並附建議答案（與 grilling skill 相同）。
- **輸入表單**（Q26）：目標 repo（使用者有 write 權限且已安裝 App 者）、分析範圍 glob（可留空，由 agent 在 G1 提出建議）、想找的缺陷（自由文字＋常見類別）、已知規格文件（選填，作為規則出處）。
- **G2 傳給 Lean 的資料**（Q27）：`TRIAGE.md`。Lean 階段直接轉錄，不重新訪談（符合 lean-formal-verification「已確認的規則檔直接轉錄並記錄出處」）。
- **Lean 拆兩次執行**：先寫定理敘述（`sorry` 證明），經 G3 簽核後才證明。
- **測試**（Q18）：一律產出且標為 `todo`／`skip`，CI 照常通過；agent 只實際執行不需要外部服務的測試，其餘在 PR 中附上手動執行步驟。

### 3. 兩級權限（Q14、Q15）

| | 一般使用者 | 白名單使用者 |
|---|---|---|
| ① grill → G1 | ✅ | ✅ |
| ② Quint → G2，交付 `specs/quint` | ✅ | ✅ |
| ③ Lean → G3 | ❌ | ✅ |
| ④ 反例測試 → G4 | ❌ | ✅ |

白名單以 GitHub login 為鍵，存於 D1；初始名單至少包含 `philipz`。

### 4. 身分與授權（Q20）

- `/verify` 一律以 GitHub 登入（`softwarefactory-bot` 的 user-to-server OAuth）。Cloudflare Access 只提供 email，不足以判斷 repo 權限。
- **發起人對目標 repo 必須有 admin 或 write 權限，且 App 已安裝於該 repo**。這防止有人用本服務替別人的公開 repo 找漏洞。

### 5. 執行平面與揭露（Q10、Q17、Q8、Q25）

- **沿用 factory-run，在公開的機制 repo 執行**。新增 task type `agent-verify-grill`、`agent-verify-quint`、`agent-verify-lean`（以 phase 區分 statements／proofs）、`agent-verify-tests`。第二階段的模型驗證沿用 `ADR-018` 的 CI 機制（CI 依 instance 清單跑 `quint run`、收集違反的 ITF trace）。
- **保密的三個做法**：
  1. 驗證類 task 的 `target/.factory/run/` 在上傳前以 aswf.dev 的公鑰加密（`age`）；私鑰只存在 Worker（`VERIFY_AGE_PRIVATE_KEY`）。Actions log 本來就不含 agent 內容（stdout 導向檔案），不需改動。
  2. 驗證類 agent **不推分支、不開 PR**；產出只進加密的 artifact，由 aswf.dev 取回解密後存放（R2＋D1），只有發起人看得到。
  3. G2 之後由機制端的 service task `factory.verify.publish` 開 PR，**只發佈判定為不涉及資安的產出**；涉及資安的產出只在 aswf.dev 上提供發起人下載，由使用者自行決定通報與修補方式。
- **Issue 開在使用者的 repo**（延續 `ADR-001`），body 只寫範圍與階段，**不寫任何發現**；完成訊號沿用 `stage/done`。

### 6. 驗證專用接入（Q11；修訂 `ADR-013`）

- 只要求安裝 `softwarefactory-bot`；不需要 `software-factory` 分支、`catalog-info.yaml`、`risk-paths.yml`，也不做三軸計分。
- 理由：agent 只能寫 `specs/**` 與測試檔，不碰正式程式碼；所有 PR 由 `factory.verify.publish` 對 repo 的**預設分支**開出，**永遠不自動合併**，一律由使用者審查。
- `factory-run.yml` 的 base-branch guard 對驗證類 task type 豁免；其他 task type 的 `ADR-013` 規則不變。

### 7. Lean 演繹驗證（修訂 `ADR-018` §1）

- 本服務允許 Lean 4 演繹驗證，限 `agent-verify-lean`；`agent-write-spec` 的決策不變。
- 依 lean-formal-verification skill 的九條規則執行：Lean 證明的是**模型**，不是程式碼；模型與程式碼的對應寫在 `MODEL-MAP.md`；禁用 `sorry`、新 axiom、`native_decide`；以 `verify-lean.sh` 作為閘門。
- 工具鏈（Q28）：`leanprover/lean4:v4.35.0`，**只用 core、不用 Mathlib**；runner 以 elan 安裝並快取 `~/.elan` 與 `specs/lean/.lake`。Quint 沿用 `@informalsystems/quint@0.33.0` 與 `~/.quint` 快取，只用 `quint run`（不需 Java）。專案語言環境由 agent 依 repo 判斷。

### 8. 平台（Q23、Q24）

- 入口為新頁面 **`/verify`**，不在 `/scoreboard` 底下、不經 Cloudflare Access。
- **BPMN 實例狀態 PoC 先存在 D1**：每個請求依 journal 重建 `ADR-028` 的 runtime，以「實例 id＋seq」為唯一鍵做樂觀並行控制；`ADR-028` 的 Durable Object 留待 M2。即時監控在 PoC 中以輪詢取代 WebSocket。
- M1 runtime 的 effect type 由三種擴充為四種（新增 `factory.verify.publish`），linter 與啟動檢查同步更新。

### 9. PoC 驗收（Q7、Q30）

1. 以 `philipz/uber_payment_poc` 跑完四個階段：經 G1 確認的 `RULES.md`、能通過 typecheck 的 Quint、至少一個經 G2 判定為真缺陷的反例、零 `sorry` 的 Lean、帶 `todo` 的測試 PR。
2. 與該 repo 既有的人工審查報告 `analysis_results.md` 逐項對照：哪些風險被涵蓋、哪些沒有，是否找到報告沒寫的缺陷。
3. 一般使用者帳號跑到 G2 即停止，看不到第三、四階段。
4. 被判定為涉及資安的反例，不出現在任何公開的 PR、Issue、artifact 明文或分支上。
5. 第三、四階段完成後，重播整個 BPMN 實例的 journal，結果一致。

## 後果

### 正面

- 把已驗證有效的人機協作流程產品化，外部使用者不需要本機 agent 環境。
- 人工判斷集中在 G1–G4 四個關卡，正是兩次先例中最有價值的判斷點。
- 揭露政策讓資安相關的發現不會因為執行在公開 repo 而外洩。
- 為 BPMN 執行核心提供第一個真實流程。

### 負面

- 新增 4 個 task type、加密上傳、發佈步驟、GitHub OAuth、白名單等多個元件。
- Lean 階段成本高：CamundaSaga 一次從零 build 約 3.5 分鐘、完整 `verify-lean.sh` 約 7 分鐘，證明本身的 token 量未有紀錄。
- 驗證專用接入繞過三軸計分與 `software-factory` trunk，形成第二套接入規則。

### 已知風險（使用者已接受）

- **不設成本上限**（Q14、Q22）：所有使用者都不限次數與 token。重評觸發條件（Q29）：月度 LLM 成本超過 **100 美元**，或單一使用者一個月分析超過 **20 次**；觸發時只告警，不自動封鎖。
- **使用公開 runner**（Q17）：執行時間、token 用量、Issue 標題等 metadata 仍然公開，內容則由加密保護。
- **模型與程式碼的對應是人工審查的結果**：Quint 與 Lean 都只證明模型；誤報由 G2 過濾。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| 在私有 runner repo 執行（Q17=a） | 使用者選擇公開執行；以加密 artifact＋延後發佈取代。 |
| 全自動、不經人工關卡（Q4=b） | 沒有人確認規則，反例只是 agent 的推測，誤報率高。 |
| 每輪 grill 都跑一次 agent（Q9=b） | 每輪數分鐘與大量 token；讀碼一次、之後由 Worker 追問即可。 |
| 改造 `agent-write-spec` 承接第二階段（Q10=b） | 其 `specs/<name>/` 結構與 CODEOWNERS 的 `spec/approved` 流程，與「規則在 aswf.dev 上確認」的模型互相牽制。 |
| 照現有流程完整接入（Q11=b） | 外部使用者的門檻過高。 |
| 一律開 PR（Q8=b） | 公開 repo 會直接公開資安漏洞，違反常見的 `SECURITY.md` 私下通報政策。 |
| PoC 先做最小 DO（Q24=b） | M2 已暫停；M1 runtime 不綁定 journal 存放位置，D1 唯一鍵即可處理並行寫入。 |
| 使用 Mathlib | 下載與 build 動輒數十分鐘；兩次先例都只用 core 完成。 |

## 重評觸發條件

1. §「已知風險」的成本或用量門檻觸發。
2. 任一被判定為涉及資安的內容出現在公開位置（驗收 #4 失敗）。
3. G2 判定為模型假象的比例持續偏高，代表 grill 或 Quint 階段的規則品質不足。
4. M2 Durable Object 完成 → 實例狀態由 D1 搬到 DO。
