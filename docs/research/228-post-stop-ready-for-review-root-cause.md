# 228 — 根因分析：停手（需求變更控制）後仍出現 ready-for-review 終態留言

> **任務類型**：agent-analyze（docs/20 C1）——僅分析、不實作。
> **分析對象**：`factory-run` workflow 的終態留言流程；事件：2026-09-01 Issue #199 執行（run `33481645119`）。
> **日期**：2026-09-01 · **機制 repo HEAD**：`d9aae6a`
> **狀態**：分析報告，**不具放行效力**；「建議下一步」供人類裁決後開工作項。

---

## 1. 結論摘要（一頁）

**現象**：#199 的執行中，agent 依 factory-stop-rules **第 8 條（需求變更控制）**合規停手——
留言說明 Issue 自身矛盾（PRD 要求改 `.dsh/skills/**`，與 DoD「不觸碰高風險路徑」及 H5/SR3
guardrail 不變量衝突）、貼 `needs-human`、未做任何變更——07:24:53。29 秒後（07:25:22），
`apply-judge-labels` 又貼出「**## 工廠執行結果：ready-for-review**（計分 3 分）」。兩個終態互相
矛盾，且後者（系統格式、出現在最後）在人眼看來像「權威終態」。

**結論：這是流程缺陷（契約缺口），不是留言文案語意問題，也不是計分誤判。**

根因鏈（三層，詳見 §2.4）：

| # | 根因 | 位置 |
|---|---|---|
| **RC1** | `report.json` 契約**沒有「agent 自願停手交還人類」的資料槽**。停手事實只存在於 `invocation.stdout` 的自由文字（機器不可讀）。judge 的輸入封閉於 report＋catalog＋risk-paths，永不讀 Issue 現況 | `src/cli/factory-judge.ts:45-68`（ReportSchema）、`src/cli/factory-judge.ts:151-163`（main） |
| **RC2** | 停手規則**代碼集與 skill 集不對齊**：skill 第 8 條「需求變更控制」在 `evaluateStopRules` 中**無任何對應規則**（代碼 SR8 是 timeout，同名不同義）；無變更的 run 不可能觸發 mustStop | `src/stop-rules/stop-rules.ts:35-120` vs `.dsh/skills/factory-stop-rules/SKILL.md:17` |
| **RC3** | 終態宣告**無條件且不對帳**：`apply-judge-labels` 不看 Issue 已有哪些標籤／留言，無條件貼 label＋終態留言；pipeline 也無「若宣告空變更且停手 → needs-human」的閘門 | `src/cli/apply-judge-labels.ts:52-73`、`src/pipeline/run-work-item.ts:202-212` |

**判定鏈回放**（對該 report 的機械推演）：exit 0 → Gate 2 過（`run-work-item.ts:119`）→
`changedPaths: []` 為**明示空清單**、Gate 2.5 過（`run-work-item.ts:140`，只拦「欄位缺席」）→
Gate 3 重計分無硬規則觸發、終分 3（review 帶）→ Gate 4 `evaluateStopRules` 回傳
`mustStop: false`（輸入全是數值／路徑欄位，停手不可見）→ Gate 5 automerge 被封（非 on-loop＋
owner 否決）→ **落到 fallback 出口 `ready-for-review`**。

**重現**：已在本機以 run `33481645119` 的 artifact（`factory-run-199`）中**原始 report.json**
重播 judge，輸出與 07:25:22 留言逐字相同（§2.3）。屬**確定性重現**，不需重跑該 run。

**非孤例**：#11（2026-08-18 02:15:29 停手留言 → 02:15:59 ready-for-review）同型衝突更早即發生。
凡「agent 合規停手且如實回報空變更」的 run 都會復發此模式（§3）。

**建議**（詳見 §4/§5）：採**方案 A**——report 契約新增 `stopDeclaration` 資料槽，pipeline 以
**單向棘輪**（只可惡化終態、不可放寬）據此輸出 needs-human；方案 B（apply 層與 Issue 現況對帳）
作防深補強；**拒絕**方案 C（以非零 exit code 表達停手）與方案 D（僅改文案）。SKILL.md 範本更新屬
H5 guardrail，須由人類主導（WI-2）。

---

## 2. 證據與根因

### 2.1 事件時間軸（run `33481645119`，2026-09-01）

| 時間 (UTC) | 事件 | 證據來源 |
|---|---|---|
| 07:20:15 | Factory Run dispatch（#199，task_type=`agent-fix-bug`） | `gh run list`（run id 33481645119，conclusion **success**） |
| 07:20:55 | issue-check 留言（medium tier） | #199 留言 2 |
| 07:24:53 | **agent 停手留言**：「⛔ 依 factory-stop-rules 第 8 條停手（需求變更控制）……未做任何實作、未建分支、未開 PR」＋貼 `needs-human` | #199 留言 3（`software-factory-worker[bot]`） |
| 07:25:22 | **judge 終態留言**：「## 工廠執行結果：ready-for-review 計分 3 分，需人類審查後合併……」 | #199 留言 4；由 `Apply judge labels and comment` step 發出 |
| — | job 各步：Cross-check ✅ → Judge ✅ → Apply labels ✅ → G1 守衛 skipped（job 成功） | `gh run view 33481645119 --json jobs`（steps 22–26） |

事後狀態仍可見矛盾：#199 目前標籤為 `oversight/review` **＋** `needs-human` ＋ `meta/observation`
（apply-judge-labels 只加不減，兩套終態標籤並存）。

### 2.2 現場 `report.json`（artifact `factory-run-199`，run 33481645119）

```json
{
  "issueNumber": 199,
  "invocation": {
    "exitCode": 0,
    "stdout": "依 factory-stop-rules 第 8 條停手：Issue #199 PRD 目標清單含 … 已留言說明差異並貼 needs-human；未做任何實作、未建分支、未開 PR。",
    "stderr": ""
  },
  "changedPaths": [],
  "changedLines": 0,
  "assertionDelta": 0,
  "addedDependencies": [],
  "syncFailures": 0,
  "hasAcceptanceCriteria": true
}
```

要點：

1. 這是一份**誠實且格式正確**的 report——agent 依 skill 第 7 步範本寫出全部欄位，「已停手」只有
   `stdout` 一句自由文字承載。
2. `ReportSchema`（`src/cli/factory-judge.ts:45-68`）**沒有任何欄位**能表達「依停手規則交還人類」；
   `invocation.stdout` 不在任何判定器的解析範圍。
3. 對照 docs/18 §4 G8 的教訓（「證據要有**槽**，不是要有字」）：`requirements` 欄位因有槽才被
   crosscheck 驗證；停手訊號無槽，故對 pipeline 不存在。

### 2.3 確定性重現（本機，未重跑 run）

以 artifact 原始 report 逐字重播 judge（機制 repo HEAD `d9aae6a`）：

```bash
npm ci && npm run build
# /tmp/report199.json ← run 33481645119 artifact factory-run-199 內 target/.factory/run/report.json
node -e 'import("./dist/cli/factory-judge.js").then(async (m) => {
  const r = m.main(["/tmp/report199.json","catalog-info.yaml",".github/factory/risk-paths.yml"]).result;
  console.log(JSON.stringify({outcome:r.outcome,labels:r.labels,summary:r.summary,
    mustStop:r.stopDecision.mustStop}, null, 1));
});'
```

實際輸出（摘要）：

```json
{ "outcome": "ready-for-review",
  "labels": ["oversight/review"],
  "summary": "計分 3 分，需人類審查後合併。原因：計分 3 分不在 on-loop 範圍（需 0–1）；擁有者已透過 factory.io/agent-automerge 否決",
  "mustStop": false }
```

與 07:25:22 貼出的留言**逐字相同**——判定鏈完整重現，排除「留言組裝錯誤／發错 issue」等替代假說。

「計分 3」非誤判：`catalog-info.yaml:18,21,22`（tactical=0＋risk high=2＋complexity medium=1）
→ total 3 → `tierForTotal` 落 `review` 帶（`src/scoring/score.ts:95-100`）。計分器对它拿到的輸入
做了正確的事；**問題是輸入少了停手這個事實**。

### 2.4 根因鏈（代碼層座標）

**RC1 — 契約缺口（資料層）**

- `factory-judge` 刻意「不含任何判斷邏輯」，只把 report 重播進 `runWorkItem`
  （`src/cli/factory-judge.ts:1-16` 註解、`:151-163`）。其輸入僅三份檔案：report、catalog、
  risk-paths——**不讀 Issue 標籤／留言**，也無 env 承載停手訊號。
- `ReportSchema` 的每個欄位都被 Gate 4 消費（見 `src/pipeline/run-work-item.ts:165-174` 的
  `evaluateStopRules` 呼叫），唯獨「自願停手」無欄位可放。註 1 的防呆設計（「格式錯誤的 report 若被
  寬容地補上預設值……把壞掉的執行判成 ready-to-automerge」）防的是**惡意／壞掉的 report**；
  對**誠實但訊號不全**的 report（本例）無保護——缺口在契約層，不在驗證層。

**RC2 — 規則集不對齊（語意層）**

skill（`.dsh/skills/factory-stop-rules/SKILL.md`，行 8-17）與代碼
（`src/stop-rules/stop-rules.ts:35-120`）是兩套編號：

| skill 條目 | 代碼對應 | report 資料通道 | 停手能被 judge 看見？ |
|---|---|---|---|
| 1 sync 連續失敗 | SR1-sync-failed | `syncFailures` | ✅ |
| 2 授權／金流／敏感資料 | SR2-high-risk-domain | `changedPaths`→硬性規則 | ✅（須有變更） |
| 3 CI／branch protection／CODEOWNERS／catalog | SR3-guardrail-change | `changedPaths`→GUARDRAIL_PATTERNS | ✅（須有變更） |
| 4 驗收條件不明確 | SR4-unclear-acceptance | `hasAcceptanceCriteria:false` | ✅ |
| 5 新增未鎖套件 | SR5-new-dependency | `addedDependencies` | ✅ |
| 6 弱化斷言（絕不允許） | SR6-weakened-tests | `assertionDelta<0` | ✅ |
| 7 token 超上限 | SR7-cost-exceeded | `tokensUsed`＋`TOKEN_BUDGET` env | ✅（若自報） |
| —（無此條） | SR8-**timeout** | `timedOut`（workflow 層） | ✅ |
| **8 需求與 Issue 不符（需求變更控制）** | **無對應規則** | **無欄位** | ❌ ← 本事件 |

關鍵：**第 8 條是「無需變更即可成立」的停手**——agent 什么都沒改、沒觸發任何硬性規則，
`evaluateStopRules` 的機械訊號全部乾淨，`mustStop=false` 是「輸入如此」下的正確輸出。
另外「SR8」一名在代碼指 timeout、在 skill 指第 8 條需求變更控制（#199 停手留言引用的即後者），
命名碰撞會誘導未來修復／引用錯目標。旁證：dry-run 情境列只有
`success | blocked | guardrail`（`.github/workflows/factory-run.yml:45-50`），
**「agent 啟動後自願停手」這個狀態在流程模型裡根本不存在**。

**RC3 — 終態宣告不與現場對帳（輸出層）**

- `apply-judge-labels.main`（`src/cli/apply-judge-labels.ts:52-73`）：讀 judge.json → 無條件
  `gh issue edit --add-label` ＋ `gh issue comment`；不查 Issue 現有標籤／留言。
- `computeJudgeLabels` 算出的 `requiresHuman`（同檔 `:24-30`）在 `main` 中被解構丟棄
  （`:63` 只取 `labels`）——「需人類」語意在出口層已是死訊號，屬同一缺口的旁證。
- 工作流層唯一的一致性機制是 **G1 終態守衛**（`factory-run.yml:512-529`），但它的觸發條件是
  `job.status != 'success'`，處理的是「終態**缺席**」（docs/18 §2.1）；本例終態**存在且衝突**、
  job 成功 → 守衛 idle。docs/18 §3 行為矩陣（`:99-108`）六行情境**無一行**涵蓋
  「agent 已依規則停手＋judge 正常產出不同終態」——矩陣的遺漏象限。

### 2.5 排除的替代假說

| 假說 | 排除依據 |
|---|---|
| 留言文案語意問題（措辭易誤會） | 即便改措辭，judge.json、標籤（oversight/review）、run success 仍宣告「正常完成待審」——矛盾在狀態層不在文字層（方案 D 論證，§4） |
| 計分誤判（3 分不該是 3） | 計分由 catalog 標註決定且**先於 agent**（docs/06 §5.1 的 AGENT EXCLUSION 不變量）；3 分計算正確，缺陷不在計分 |
| report 造假瞞過 crosscheck | report 與實際狀態一致（0 變更＋0 diff → crosscheck `ok`，step 22 success）；crosscheck 雙向比對的是**變更**，空對空必然通過 |
| 併發 run 干擾（兩個 run 打架） | 07:25:22 留言由同 run（07:20:15 起）的 apply step 產出（步驟時序與 job 結論核對）；#199 該時段仅此一個 run，concurrency 群組也排他（`factory-run.yml:69-71`） |

---

## 3. 影響範圍

**受影響機制（模組）**

- `factory-judge` ＋ `run-work-item` pipeline（終態判定）：對「自願停手」盲視。
- `apply-judge-labels`（終態宣告）：與現場不對帳，製造矛盾第二留言。
- `factory-run.yml` 流程模型：無「停手」狀態；G1 守衛與 docs/18 §3 行為矩陣未覆蓋衝突象限。
- report 契約（三份事實來源须同步）：`ReportSchema`（代碼）／factory-workflow SKILL.md §7 範本
  （H5，人類主導）／`.github/factory/task-template-*.txt`（停手指令 `fix-bug.txt:15`）。
- `factory-crosscheck`：需為「停手＋空變更」定義明瞭的不變量（見 WI-1 R4）。

**受影響對象（使用者）**

- **人類審查者**：最後一則留言貌似權威終態（系統格式、計分、原因齊全），實際指向一個不存在的
  PR——「ready-for-review 卻無東西可審」；需要回溯讀前一篇自由文字才能重建真相。#199 人類
  （philipz）確實是在裁決矛盾後**重新 dispatch** 才繼續的。
- **工廠 agent 自身**：合規停手在控制流中不被承認——「依規則停手」與「正常完成但沒做東西」
  在終態上不可區分，變相懲罰誠實回報（與 docs/18 反 silent failure 的立場相反）。
- **監督統計／試點觀察**（`meta/observation`、docs/15、factory-metrics）：needs-human run 被計為
  review，oversight 路徑分布失真。

**下游與邊界**

- 本事件**未**造成安全後果：第 1 期不自動合併，且 ready-for-review 本身已封 automerge。但同一
  缺口在第 2 期（若開放 on-loop 自動合併）會惡化——judge 基於不完整輸入判定的「可續行」終態，
  將直接驅動合併動作。
- `factory-rescore`（PR 層）不受影響（本例無 PR）；`factory-run-cleanup.yml`（G2）不受影響
  （job 成功）。
- 發生頻率：現有 needs-human 標籤 Issue 全數比對中，同型衝突**兩例**——#11（2026-08-18，
  「驗收條件已滿足」停手）與 #199（2026-09-01，需求變更控制停手）。共同點：**停手原因在代碼規則集
  之外**。凡 agent 依 skill 第 8 條（或任何未來新增的判斷型停手理由）停手，100% 復發。

---

## 4. 方案比較

### 方案 A（建議）：report 契約新增「自願停手宣告」資料槽

**內容**：`ReportSchema` 增選填欄位，例如

```json
"stopDeclaration": { "rule": "SR-REQ-CHANGE", "reason": "PRD 與 DoD 矛盾（H5 目標 vs 不觸碰高風險路徑）" }
```

`runWorkItem` 於 Gate 4 前後增设閘門（Gate 4.5）：**宣告存在 → 終態必為 needs-human**，
labels 併入 `needs-human`，summary 引用 rule 與 reason。性質與 `rescore` 同構——**單向棘輪**：
宣告只能把終態往「更需人類」方向拉，永不放寬；誤用（沒事宣告停手）的最壞結果是多一次人類注視，
fail-safe 方向正確。apply-judge-labels 據此自然產出一致的 needs-human 終態留言。

- ✅ 修在根（RC1/RC2）：停手進入控制流，judge/標籤/留言/矩陣全部對齊。
- ✅ 可測試：以 #199 artifact report 的逐字 fixture 做回歸（本報告 §2.3 即其紅燈重現）。
- ✅ 與 G3/G8 哲學一致：自報欄位由 zod 收緊、方向保守、crosscheck 可加不變量。
- ⚠️ 成本／風險：動到三份事實來源（代碼＋SKILL 範本＋任務模板）；SKILL.md 屬 H5，**範本更新必須
  由人類落地**（WI-2）；舊 agent（範本未更新前）不會寫此欄位 → 行為不變（選填、缺席＝現況），
  無破窗。自報可信度限制：宣告可能被遺忘——由方案 B 兜底偵測「空變更＋無 PR 的 ready-*」。

### 方案 B（輔助，不單獨成立）：終態宣告前與 Issue 現況對帳

apply-judge-labels（或 workflow 一步）先讀 Issue：若已有 `needs-human` 標籤或含本 run id 的機器
可讀停手標記（如 agent 停手留言末行 `terminal: needs-human (run: <id>)`），則改貼一致性留言而非
ready-*。

- ✅ 不動 report 契約，可先於 A 落地、縮短暴露窗口；同時補上 G1「不重複貼」_marker 的缺口。
- ❌ 單用不夠：**judge.json 仍記錄錯終態**（artifacts／日誌／未來 consumer 仍拿到矛盾的機器
  輸出）；依賴可變遠端狀態＋文字 marker 契約，脆弱且有競態；違反「終態由決定性 pipeline 單一產出」
  的治理模型（docs/06）——把判定權散給現場掃描。
- **定位**：作 A 的防深（belt-and-suspenders）與守門，攔「agent 忘了宣告」的殘差案例。

### 方案 C（拒絕）：停手時要求 agent 以非零 exit code 結束

讓 Gate 2（`run-work-item.ts:119-129`）把「停手」當失敗捕獲 → needs-human。

- ❌ 語意錯誤：合規停手不是執行失敗，留言會變成「DSH 執行失敗：…」，規則名與差異說明遺失。
- ❌ 破壞既有契約：task-template／factory-workflow 明訂「report.json 寫完即工作項終點」且 DSH 正常
  退出 0；改非零會誤觸 fallback `write-report`（`factory-run.yml:418-421`）與 provider-failure 判定
  邏輯（同檔 `:406-413`），把控制流搅得更渾——範圍擴大且動到未受此 bug 影響的路徑。
- ❌ 丟失可審計結構：停手以「錯誤」入檔，監督統計反而更失真。
- **拒絕理由**：用錯誤的通道傳正確的訊號；A 是同一訊號的正確建模。

### 方案 D（拒絕）：僅修改留言文案（如 ready-for-review 改為中性措辭，或空變更時改口「待確認」）

- ❌ 矛盾在**狀態層**：judge.json 的 outcome、標籤（oversight/review vs needs-human 並存）、
  run success——文案修飾全部保留錯誤狀態，還把不一致藏得更深（更難 grep）。
- ❌ 「changedPaths 空 ⇒ 一定是停手」是誤推論：#11（無需再做）與停手（不該做）語意不同；未來
  analyze／docs 型也有不同交付形態。以措辭分岔等於制造第二套與 pipeline 分歧的規則——正是
  factory-judge 註解警告的反模式（「兩者一旦分歧，寬鬆的那一套就會成為實際生效的規則」，
  `src/cli/factory-judge.ts:7-10`）。
- **拒絕理由**：治標且引入分歧規則源。

### 附帶修正（併入 WI-1／WI-2，非獨立方案）

規則 ID 對齊：為 skill 第 8 條定名（建議 `SR-REQ-CHANGE` 或代碼新增 SR9，避免與代碼
SR8-timeout 的編號碰撞），並在三份事實來源中使用同一穩定 ID；docs/18 §3 行為矩陣新增
「agent 停手宣告」列。

---

## 5. 建議下一步（可直接開成工作項）

### WI-1（機制 repo，可派 agent-fix-bug／小重構）
**標題**：report 契約新增 `stopDeclaration` 槽並由 pipeline 單向承認 needs-human 終態（G9）

**描述**：依 §4 方案 A 實作：(1) `ReportSchema` 增選填 `stopDeclaration:{rule,reason}`（zod
fail-loud 收緊）；(2) `runWorkItem` 新增閘門：宣告存在 → outcome=needs-human、labels 併入
`needs-human`、summary 引用宣告（單向棘輪，不可被任何其他條件放寬）；(3) `apply-judge-labels`
對該終態產出一致性留言（並可於空變更的 ready-* 情形加 B 式警語）；(4) docs/18 新增 G9 節與行為
矩陣列。附帶：`computeJudgeLabels.requiresHuman` 死訊號一併處理（使用或移除）。

**驗收條件草案（DoD）**：
- R1（重現轉正）：以 run 33481645119 artifact 的逐字 report＋`stopDeclaration` 為 fixture 的回歸
  測試——修復前紅（ready-for-review），修復後綠（needs-human）。命令：
  `npx vitest run src/pipeline test/adversarial`。
- R2（不可放寬）：對抗性測試——宣告停手的 run 無論分數／automerge 條件如何，終態必為
  needs-human，labels 必含 `needs-human`；`stopDeclaration` 欄位格式錯誤時 zod fail-loud
  （exit 非 0），不得靜默降級。
- R3（向後兼容）：無 `stopDeclaration` 的既有 report 判定結果與 HEAD（`d9aae6a`）逐欄位一致
  （純函數對拍測試）。
- R4（crosscheck 不變量）：`stopDeclaration` 存在時，空 diff 合法（不判 no-trace／異常）；
  宣稱停手**卻**有未回報變更 → 既有一貫 mismatch 規則仍 fail-loud。
- R5（出口一致）：`apply-judge-labels` 單元測試斷言該情境留言以「## 工廠執行結果：needs-human」
  開頭且含 `needs-human` 標籤；`npx vitest run src/cli` 綠。
- R6（全量）：`npm run typecheck && npm run test:unit && npm run test:integration &&
  npm run test:adversarial` 全綠；`src/pipeline/**`、`src/cli/**`、`src/stop-rules/**` 維持
  100% branch 覆蓋閘門。
- R7（不觸碰 H1–H5）：變更不含 `.github/workflows/**`、`.dsh/skills/**`、`CODEOWNERS`、
  `catalog-info.yaml`（SKILL 範本另走 WI-2）。

### WI-2（人類主導——H5 guardrail，agent 不得執行）
**標題**：同步 guardrail 文案：factory-workflow SKILL.md §7 範本增 `stopDeclaration`；
factory-stop-rules SKILL.md 第 8 條補「停手時必須在 report.json 寫 stopDeclaration（rule=…）」
並採用 WI-1 定稿的規則 ID。
**驗收條件草案**：(a) 範本與 `ReportSchema` 欄位逐字對齊（review 比對 PR diff）；(b) 更新後以一次
dry_run dispatch 驗證寫入／判定接線；(c) 在 changelog／docs/18 G9 節引用。

### WI-3（觀察期，meta/observation）
**標題**：歷史盤點＋實機驗證：掃描所有 factory run 的「停手留言→系統終態留言」序列，統計同型
衝突是否超過已知兩例（#11、#199）；WI-1 合併後以一次真實 dispatch（故意可停手的 Issue）驗證
needs-human 終態單一且一致。
**驗收條件草案**：(a) 清單（run id／issue／衝突與否）回填 #228 留言；(b) 實機 run 的 Issue 上
「工廠執行結果」留言恰有一則且為 needs-human。

---

## 附錄：證據清單

| 證據 | 取得方式 |
|---|---|
| #199 留言時間軸（07:24:53／07:25:22） | `gh api repos/philipz/software_factory/issues/199/comments` |
| run 33481645119 step 結論（crosscheck/judge/apply success、guard skipped） | `gh run view … --json jobs` |
| 原始 report.json | `gh api repos/…/actions/artifacts/9790291955/zip`（factory-run-199） |
| 確定性重現輸出 | 本機 HEAD `d9aae6a` 重播（§2.3 命令逐字可執行） |
| #199 現行標籤並存（oversight/review＋needs-human） | `gh issue view 199 --json labels` |
| 同型前例 #11（02:15:29→02:15:59） | `gh api repos/…/issues/11/comments` |
| 代碼座標 | 本文各 § 內聯（`src/pipeline/run-work-item.ts`、`src/cli/factory-judge.ts`、`src/cli/apply-judge-labels.ts`、`src/stop-rules/stop-rules.ts`、`src/scoring/score.ts`、`.github/workflows/factory-run.yml`、`catalog-info.yaml`、`.dsh/skills/factory-stop-rules/SKILL.md`、`docs/18-silent-failure-hardening.md`、`.github/factory/task-template-fix-bug.txt`） |

> 本報告為 agent-analyze 產出：無任何 src/、測試或設定檔變更；變更僅此檔。
> 報告不具放行效力（docs/06 §4），後續以人類裁決為準。
