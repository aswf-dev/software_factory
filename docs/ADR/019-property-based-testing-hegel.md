# ADR-019：目標 repo 的程式碼層驗證採 PBT（Hegel），以事後稽核工作項執行

- **狀態**：已接受（實作中；2026-10-05 依試點回饋與落地 grilling 修訂，見文末「修訂記錄」）
- **日期**：2026-10-04（修訂 2026-10-05）
- **決定者**：平台架構（使用者經 grilling 逐項裁決 Q1–Q20）
- **對應**：`ADR-008`（Quint 神諭橋）、`ADR-018`（意圖驅動 write-spec，§1 的 PBT 條款由本 ADR 落實並修訂）、`ADR-016`（產出與生效分離）、`docs/11`（測試策略）、`docs/06`（監督與評分）、`docs/research/pbt-library-survey-2026-10.md`（工具調查）
- **證據**：`docs/research/pbt-library-survey-2026-10.md`（2026-10-04 以 gh api、npm、PyPI、crates.io、Maven Central、NuGet、proxy.golang.org、hex.pm 即時查證）

## 脈絡

### 現況（2026-10-04 盤點）

- **PBT 只是一個未落地的決定**：`ADR-018` §1 寫著「函式級合約改由在真實程式上執行的 PBT 承擔」，但 repo 內沒有 fast-check、沒有 Hegel、沒有任何 PBT 程式碼。這個決定從未操作化。
- **Quint 驗的是模型，不是程式碼**：本 repo 唯一的 spec 是 `specs/scoring/score.qnt`，橋接只有 `test/quint/scoring-oracle.test.ts`，以 `--seed 0 --max-samples 1` 回放**一條** trace，只碰到 `score()` 與 `tierForTotal()`。目標 repo 的 `.qnt` 與實作之間同樣沒有回放機制，反例要等 `agent-fix-bug` 的紅燈測試才回到真實程式。
- **高風險模組多半不在 Quint 的範圍內**：`src/integration/gh-parse.ts`、`src/integration/dsh-result.ts`、`src/factory-draft/parse.ts`、`src/assertion-count/count.ts`、`src/issue-analysis/complexity.ts`、stop-rules 的路徑比對，都是「輸入空間大、狀態空間小」的純函式。用 Quint 建模不划算，用範例測試又只能覆蓋人想得到的輸入。
- **目標 repo 橫跨多語言**：`docs/09` 的設計是「機制語言無關，目標 repo 只放設定」，`factory.io/stack` 只是宣告、不被任何程式碼取用。目前已接入的有 TS/Jest（`philipz/fubon-tradingbot`，`factory.io/stack: typescript`）、TS/ava（`tradingbot-tw/node-redlock`）、Java 21 / JUnit 5（`trial/spring-modulith-orders`）。`ADR-018` §1 的重新評估觸發條件之一「出現 Java 或 Rust 的高風險模組」**已經成立**。
- **`assertionDelta` 看不懂多數語言的斷言**：`src/assertion-count/count.ts` 只認 `expect(`、獨立的 `assert`、Rust 的 `assert_eq!`／`assert_ne!`、`XCTAssert*`、Go 的 `t.Error*`。JUnit／AssertJ 的 `assertEquals(`／`assertThat(` 與 ava 的 `t.is(` 一律計為 0。

### 為什麼是「稽核」而不是「開發當下」

`ADR-008`（不得以自撰規格驗證自撰程式碼）、`ADR-018`（不變量出自意圖，不得出自實作）與 `docs/06` §4.3 共同的原則是：**不得以自撰的依據驗證自撰的產出**。開發當下寫的 property，依據只能來自 agent 自己剛讀過的 Issue 描述與自己即將寫的實作，正是 FM-Agent 實測失效的那個模式。稽核工作項面對的是已經存在、已經被人 review 過的程式碼，property 的依據才有獨立性。

### 為什麼是 Hegel 而不是各語言最成熟的工具

調查結論是：**Hegel 在任何語言都還不是最成熟的選擇**（TS 有 fast-check、Java 有 jqwik、Python 有 Hypothesis、Go 有 rapid、Rust 有 proptest），但它有三個別的工具組合給不了的性質：

1. **同一套引擎、同一套寫法**（`libhegel` 是 Rust 引擎，各語言是薄綁定）。搭配同一份 skill，agent 學一次就能跨語言使用。
2. **同一份 agent skill**（`hegeldev/hegel-skill`，MIT），含 12 點的 `hegel-review` 檢查清單。
3. **同一個維護團隊**：Antithesis 的 Hypothesis 原作者群，`hegel-rust` 每 90 天下載約 70 萬次。

反過來，代價必須明說：全系列仍是 **0.x beta**、TS 版**沒有 stateful API**、TS 版有已知的「測試卡住而非失敗」缺陷。這些由 §9 的試行期處理。

## 決策

### 1. 採用 PBT，工具統一用 Hegel（Q1、Q4、Q5、Q6、Q10）

- **PBT 是需要的，而且 `ADR-018` §1 早就決定了**。本 ADR 只是把它落實。
- **工具統一用 Hegel，不採「每種語言各用最成熟的工具」（Q10=B）**。理由是可累積性：一份 skill、一套寫法、一個引擎。不採 (a) 的理由不是 Hegel 更成熟，而是分散的工具組會讓 agent 每接一種語言就重學一次，skill 無法沉澱。
- **Hegel 沒有支援的語言（Q15）**：Python 用 Hypothesis（Hegel 本身就是 Hypothesis 引擎的移植，概念與 `hegel-skill` 的方法論可直接沿用）；Kotlin 走 JVM，用 `dev.hegel:hegel`（hegel-java）；其餘語言（Scala、.NET 等）**停止並交還人類**，由人決定要不要為該語言另立工具。**不因為某個語言沒有 Hegel 就改用別套 PBT**。

> **修訂（2026-10-05，R1）**：支援範圍收斂為 **Hegel 官方有函式庫的 6 種語言**（TS/JS、Java、Go、Rust、C++、OCaml，以 [hegel.dev](https://hegel.dev/) 為準）。**Python 與 Kotlin 不再例外**，與其他語言一樣停止並交還人類。理由：只有原生支援的語言，「同一套引擎、同一份 skill」的前提才完全成立。

**試行期結束前，本決定不涵蓋工廠自己的 `src/`（Q7=B）**：`src/integration/gh-parse.ts`、`src/integration/dsh-result.ts`、`src/factory-draft/parse.ts` 這些「agent 權限判斷依據」的 parser 仍只用範例測試加人工 mutation 測試把關，靠既有的 100% 覆蓋率要求。這是一個**已知缺口，不是「決定不做」**，見 §10。

### 2. 適用範圍：只在目標 repo，只在稽核工作項（Q4=B、Q9=C）

- **不在工廠自己的 `src/` 導入**（Q7=B）。
- **新增一種工作項類型 `agent-pbt-audit`**，PBT **只在這個類型裡出現**。開發流程（`-01-test`）不強制寫 PBT。
- 不採 Q9 的 (a)（每個 Issue 的 `-01-test` 都寫）與 (b)（write-spec 通過的 `INV_*` 自動開工單），理由見 §10。

### 3. 與 Quint、mutation 測試的分工（Q5）

寫進 `factory-workflow` skill，作為 agent 判斷「這個 Issue 該不該寫 PBT」的規則：

| 邏輯類型 | 用什麼 | 例子 |
|---|---|---|
| 狀態機、協定、權限決策、時序性質 | **Quint**（`agent-write-spec`） | 「評分 0 時不得自動合併」 |
| 輸入空間大的純函式合約 | **PBT**（`agent-pbt-audit`） | parser、序列化、數值計算、路徑比對、zod schema 邊界 |
| 定義域很小的有限組合 | **直接窮舉的範例測試** | scoring 的三軸各 3 值＝27 種組合，全部列出比抽樣更強 |
| 測試本身是否真的有效 | **人工 mutation-strength 測試**（`docs/11` §6.1） | 手動改壞原始碼，確認測試轉紅 |

- **三者互不取代**。PBT 不取代 Quint，也不取代 `docs/11` §6.1 的人工 mutation 測試。
- **`INV_*` 可以翻譯成 property**：當稽核的模組有已核准的 `INV_*`（`ADR-018` §5），該 invariant 必須一併翻譯成 property 跑在真實程式碼上，並標註 `// source: INV_xxx`。這是 Quint 與程式碼之間唯一的接點。

### 4. property 的依據（Q8）

**先有依據，才寫 property。** 每個 property 都要在註解標明出處，格式沿用 `ADR-018` §5 的慣例：

| 依據 | 何時可用 | 標註範例 |
|---|---|---|
| 已核准的 `INV_*` | 該模組跑過 write-spec 流程 | `// source: INV_lock_exclusive (specs/redlock/invariants.qnt)` |
| Issue 的驗收條件 | 稽核 Issue 內有 AC | `// source: Issue #42 AC-2` |
| 通用性質（roundtrip、不 crash、冪等、順序無關） | 隨時 | `// source: generic/roundtrip` |
| **既有程式碼的文件、簽章、assert** | **僅限本次未被修改的程式碼** | `// source: src/factory-draft/parse.ts:31` |

- **不接受「沒有依據的 property」**。`hegel-review` 的第 5 點（evidence-free properties）會被納入 `factory-self-review`。
- **依據不得來自本次產出**：稽核工作項的白名單禁止修改產品程式碼（§5），所以「既有程式碼」在稽核情境下天然滿足獨立性。這一條是 `ADR-008`「不得以自撰規格驗證自撰程式碼」的直接延伸。
- **不接受「實作等於實作」的套套邏輯**：把被測函式的邏輯重寫一份再拿來比對，不算 property。

### 5. `agent-pbt-audit` 工作項的規格（Q17、Q18、Q19）

**觸發（Q18=A）**：**由人類手動開 Issue**，貼上 `pbt/audit` 標籤，並在 Issue 內宣告**一個目標模組或一個檔案**。

- 試行期不做排程自動開單，也不在 onboarding 時自動開單。範圍限一個模組的理由：`hegel-skill` 會要求列出所有公開 API，範圍過大時 PR 無法 review，發現報告也會過長。

**白名單**：只允許修改測試檔案，**不得修改產品程式碼**；越界即標為 needs-human（沿用 `factory-crosscheck` 機制）。

**產出（Q17=A）**：

| 產出 | 內容 |
|---|---|
| **PR** | 只放**通過的** property，作為新增的防線。依 §6，只新增、不取代既有範例測試。 |
| **發現報告** | **失敗的** property **不放進 PR**。改寫成「**候選發現（未回放）**」，附最小反例、Hegel 的 reproduce blob、以及該 property 的依據標註，以留言形式貼在稽核 Issue 上。 |
| **後續** | 人類確認後才開 `agent-fix-bug` 工作項；它的 `-01-test` 層把反例寫成一般的範例紅燈測試。 |

- 這個流程**與 `ADR-018` §7 處理 Quint 反例的方式逐字一致**（違反記為「候選發現（未回放）」，由 `agent-fix-bug` 的紅燈測試回放）。兩個驗證層的發現走同一條後路，人只需要學一次。
- **不採「audit 直接修 bug」**：那會讓同一個 run 自己出題、自己修，違反 §4 的獨立性原則。
- **不採「失敗的 property 也進 PR 並標 skip」**：會讓 repo 裡堆積 skip 的測試（`hegel-review` 第 8 點）。

**合併（Q19=A）**：試行期內 **audit PR 一律交人類 review，不得自動合併**，即使它只新增測試、性質接近 `agent-add-tests`。理由是要人工檢查 property 有沒有落入 `hegel-review` 的 12 點缺陷。試行期結束後再交回 `docs/06` 的評分規則處理。

> **修訂（2026-10-05，R2–R5）**，本節以下列為準：
> - **觸發**：工作項類型由 Issue 表單的「任務類型」決定，與其他 7 種類型相同；`pbt/audit` 改為 factory-run 判定類型後**自動貼上**的標籤，只用於篩選與統計，不是觸發條件。「由人類手動開單」由「人類填表並核可（`factory/approved`）」保證。
> - **範圍**：沿用需求描述裡既有的「目標模組 / 檔案：」，不新增表單欄位；issue-check 機械檢查**恰好一個路徑、存在於目標 repo、不是測試檔**，並以該路徑的副檔名判定語言（目錄則取其下最多的 Hegel 語言副檔名）。
> - **白名單**：只允許**新增或修改**符合各語言 PBT 命名慣例的檔案（見修訂記錄 R6），**不得刪除**；其他類型的 run 若產出 PBT 檔，同樣判為 needs-human。
> - **發現報告**：TS 沒有公開的 reproduce blob API，候選發現改附「**縮減後的 draws＋`HEGEL_SEED`＋Hegel 版本＋固定輸入的紅燈測試**」。agent **不開 Issue、不自己留言**，而是寫進 `report.json` 的 `pbtAudit.findings`，由**機制**統一在稽核 Issue 上留言。Java 有 blob API，等有 Java 目標 repo 時再加回。
> - **「通過」的定義**：`CI=true`，且 **20 個隨機 seed × 每 seed 5000 cases** 全部通過，才可放進 PR。試點中曾有 property 在 20 個 seed 裡失敗 7 次，只跑一次會把間歇失敗的 property 放進 PR。

### 6. `assertionDelta`：PBT 只新增，不取代（Q11=A）

- **PBT 不得取代既有的範例測試。** 範例測試是可讀的規格，property 是額外防線，兩者並存。
- 這條規則同時讓 `assertionDelta` 的語意保持單純：**斷言數下降就是有問題**，SR6 不需要為 PBT 開特例。
- **`assertion-count` 的語言漏洞另案處理**：JUnit／AssertJ 的 `assertEquals(`／`assertThat(` 與 ava 的 `t.is(` 計為 0 是既有缺陷，與 PBT 無關，但影響所有 Java 目標 repo。列為 §10 的待辦，**不在本 ADR 的實作範圍**。

### 7. `hegel-skill` 的取用方式（Q14=A）

- **原封不動 vendor** `hegeldev/hegel-skill`，比照 `quint-lang`／`quint-modeling`（`ADR-008`、`ADR-016`）：鎖定 commit、原封不動放入 `.dsh/skills/`、記錄上游 URL 與 commit 於 `NOTICE` 與本 ADR、更新 `config/factory/skills-lock.json`、經人工 review 的 PR 合併。**保持上游不變，才能直接拉新版本。**
- **工廠規則疊加在自家 skill，不改上游**：在 `factory-workflow` 寫明「PBT 只在 `agent-pbt-audit` 使用，property 依據以 §4 為準」。`hegel-skill` 允許「從實作程式碼找證據」這一點，在稽核情境下合法（被測程式碼非本次產出），但**不得外溢到開發流程**。
- **`hegel-review` 的 12 點清單引用進 `factory-self-review`**，作為 audit PR 的自審項目。
- **vendor 檢查項**：不得含硬編碼的 model id（`factory-skills-lock --verify` 會標記）；frontmatter `name` 為 kebab-case 且與目錄同名。

> **修訂（2026-10-05，R7）**：上游 `hegeldev/hegel-skill@a60b28243199b24aeebb2c90aece34082ee4997c`（v2）拆成 **`hegel` 與 `hegel-review` 兩個 skill**，兩者都 vendor 到 `.dsh/skills/`。`hegel` 的 description 會在「write tests、add test coverage」時觸發，而這正是 add-tests、fix-bug 每張工單的內容；Quint skill 靠 description 範圍窄而沒有外溢，Hegel 沒有這個條件，且原封不動 vendor 不能改 description。因此派送步驟改為**依工作項類型篩選**：`skills-lock.json` 為這兩個 skill 標記 `onlyFor: ["agent-pbt-audit"]`，其他類型的 run 不複製它們。

### 8. 供應鏈：Hegel 是 ADR-008 原則的明文例外（Q13=A）

`ADR-008` 曾以「供應鏈最小化」為由延後採用 `quint-connect-ts`。Hegel 會引入 native binary，因此必須明文處理：

- **只限測試範圍**：`devDependencies`（TS）或 test scope（Java），**不進入任何產品的執行期相依**。
- **版本鎖死**：沿用 `docs/11` §3 的全精確釘版慣例（無 `^`、無 `~`）。升級需人工審核的 PR。
- **`.hegel/`（失敗資料庫）加入 `.gitignore`**。
- **實際組成（2026-10-05 試點實測，TS）**：`koffi` FFI，加上 libhegel 與 koffi 各平台的 optionalDependency，lockfile 共 27 筆、node_modules 約 7.8 MB；**不支援 Intel macOS**；npm 11 預設擋下 koffi 的 install script 但仍可載入，npm 10 會執行它，且離線時也能成功。
- **為什麼 Hegel 可以而 `quint-connect-ts` 不行**：維護方是 Antithesis 的 Hypothesis 原作者團隊；`hegel-rust` 每 90 天下載約 70 萬次；相對地 `@firfi/quint-connect` 每週約 60 次下載。這條例外**明確不適用於**社群維護、低採用度的套件；日後若有人援引本條要求同等待遇，應先比對「上游維護者是否為該領域的權威實作方」與採用度量級。

### 9. 試行期與 CI 強制力（Q12=C、Q20）

- **先試行，後收緊**。試行期為**一個試點 repo 的 30 個 PR，或一個月**，以先到者為準。
- **試行期內 PBT 不設為 PR 的必過檢查**；失敗只在 PR 上留言，不擋合併。
- **防護措施在試行期就要有**（不能等收緊才做）：
  - **每個 property 設 timeout**，把 Hegel-TS「卡住而非失敗」的缺陷（上游 issue #48／#49）轉成明確的失敗。
  - **稽核一律在 audit 工作項自己的 run 內跑完整案例數**（`hegel-skill` 建議的數千案例），不另做每日排程。案例數與牆鐘實測值記入試行報告，作為日後收緊成必過檢查時的預算依據。
- **收緊條件**：試行期內沒有出現「卡住」、「誤報」或「上游改版導致既有 property 失敗」三類事故，就把 audit 的 PBT 設為必過檢查。
- **否則**：維持非必過，並把事故記錄交給 §10 的重新評估。

> **修訂（2026-10-05，R8–R10）**：
> - **timeout**：Hegel-TS **沒有 per-property timeout**，`hegel.test` 是同步迴圈，runner 的 timeout 也打斷不了。防護改為：async property 靠 runner 的 `--testTimeout`，整體靠 run／job 層的 timeout；「卡住」定義為 job timeout，記入試行指標。試點中 0 次卡住，非確定性生成器會直接拋出 `EngineError`；上游 PR #49 修的是 0.3.0 前的 socket client，已過時。
> - **適用範圍**：本節的「非必過」管的是**工廠 `agent-pbt-audit` 的產出與 judge 行為**，不限制目標 repo 自己的 CI 政策。PBT 檔留在目標 repo 的預設測試 run 裡（排除在外會違反 `hegel-review` 第 8 點），CI 下以 100 cases、固定 seed 執行；試點 repo 另設每晚換 seed 的 5000 cases 探索，可作為日後收緊的候選做法。
> - **試行指標**：分成**機制實測**（agent 牆鐘、diff 中的 PBT 檔數與 property 數）與 **agent 自報**（seeds、案例數、通過／失敗、findings），由機制寫進稽核 Issue 留言並明確標示自報。**不推送 scoreboard**：agent 自填的量測值不具量測意義（`factory-push-event` 也因此不讀 report 的自報欄位）。

**試點（Q20）**：`philipz/fubon-tradingbot`（TS/Jest）。

- 理由：交易系統，價格、數量、手續費等**數值計算**正是本 ADR 的目標；同時能驗證 Hegel-TS 與 Jest 的整合，以及上游 #48／#49 在實際使用中會不會出現。
- **附帶效果**：該 repo 的 `catalog-info` 是 `business-criticality: strategic`、`risk-profile: high`、`complexity: high`（三軸滿分 6，直接 in-loop），所以 §5 的「試行期不自動合併」在它身上本來就會成立。試行期選在**最嚴格的 repo** 上，寧可一開始就人工把關，也不要先在最寬鬆的 repo 上養成習慣。
- **不選 `tradingbot-tw/node-redlock`**：核心是狀態機，而 Hegel-TS **沒有 stateful API**，能測的範圍有限。
- **不選 `trial/spring-modulith-orders`**：Java 21 需搭 `hegel-jna`，且該 repo 仍是草稿、沒有 `pom.xml`。

> **更正（2026-10-05，R11）**：上面「附帶效果」的前提是錯的。in-loop（計分 ≥ 5）在實作上的意思是 **run 根本不會啟動**（`src/cli/apply-score-labels.ts` 的閘門），不只是「不會自動合併」。為了讓試點能跑，新增 `IN_LOOP_ALLOWED_TASK_TYPES = ['agent-pbt-audit']`，與 `OUTPUT_ONLY_TASK_TYPES` 分開（audit 會開 PR，不是 output-only）。這個豁免有兩個前提，並由對抗性測試釘住：**crosscheck 只放行 PBT 測試檔**，以及**類型層級禁止自動合併**（`NO_AUTOMERGE_TASK_TYPES`）。任一前提被拿掉，測試就轉紅。tier、標籤、自動合併都不變。

### 10. `ADR-018` §1 的修訂與已知缺口（Q16=A）

- `ADR-018` §1 的「函式級合約改由在真實程式上執行的 PBT 承擔」修訂為：**函式級合約目前由 `agent-pbt-audit` 事後稽核，不在開發當下強制**。
- **已知缺口（明列，避免日後被當成「已決定不做」）**：
  1. **通過的 `INV_*` 從未在真實程式碼上驗證**。`ADR-018` 只把**被違反**的 invariant 轉成 `agent-fix-bug`；成立的 invariant 只證明「模型滿足它」，不證明程式碼。
  2. **開發當下沒有 PBT**。新寫的函式要等到有人開稽核 Issue 才會有 property。
  3. **工廠自己的 `src/` 不在範圍內**（§1）。
  4. **`assertion-count` 的語言漏洞**（§6）與本 ADR 無關但同時存在。
- **重新評估的觸發條件（任一成立）**：
  - 稽核試行期結束；
  - 出現第一個「Issue 驗收條件明確、卻是稽核事後才發現實作不符」的案例；
  - Hegel 發布 1.0，或 Hegel-TS 推出 stateful API。
- **改用 fast-check 的觸發條件（2026-10-05 新增，R12，任一成立即重新評估 TS 的工具）**：
  - Hegel 升版造成既有 property 不相容；
  - 原生函式庫在 CI 或部署環境無法載入；
  - 上游長期不修「TS 綁定無條件覆寫 `testCases`」的問題；
  - 試行期內出現卡住。
  - 對照基準：試點以 14 個情境 × 30 seeds 比較，5000 cases 下偵測率 Hegel 419/420、fast-check 365/420；fast-check 的優勢都在維運面（`docs/research/hegel-ts-pilot-fubon-2026-10.md` §1）。

## 後果

### 正面

- `ADR-018` §1 從一句未落地的話，變成有工具、有工作項類型、有依據規則、有產出格式的可執行決定。
- 函式級驗證有了獨立的依據鏈：`INV_*`／驗收條件／通用性質 → property，且每個 property 都標明出處。
- 稽核發現與 Quint 反例走**同一條後路**（候選發現 → 人類確認 → `agent-fix-bug` 紅燈測試），人只需要學一次。
- 一份 engine、一套寫法、一份 skill 跨語言累積，不必為每種語言重建知識。
- 試點選在數值計算密集的 TS repo，最貼近最初的痛點，也最容易看出工具缺陷。

### 負面

- **押在 beta 上**：Hegel 全系列 0.x，小版號之間可能不相容；TS 版有「卡住而非失敗」的已知缺陷；TS 版沒有 stateful API。試行期就是為了量測這個風險。
- **開發當下仍無 PBT**（§10 缺口 2），新程式碼的函式級合約在稽核之前沒有防線。
- **通過的 `INV_*` 依然只在模型上驗證過**（§10 缺口 1），Quint 與程式碼之間仍有一段沒有回放機制。
- **多一種工作項類型與一份 vendored skill**：現有 7 種類型（`.github/workflows/factory-run.yml` 的 `task_type` options）會變成 8 種，而且每個類型都要有一份專屬的 `task-template-*.txt`（`test/adversarial/factory-assets.test.ts` 會釘住這個對應）。`factory-run`、`factory-crosscheck`、`factory-issue-check`、judge 與 Backstage 模板都要同步，重演 `ADR-018` §11 那種「四處同步」的成本。
- **`assertion-count` 的漏洞在試行期內不會修**，Java 目標 repo 的斷言增減仍不可見；PBT 的「只新增」規則規避了誤判，但沒有修好底層計數。
- **人工成本落在人身上**：稽核發現要人分類，audit PR 要人 review（§5），試行期沒有自動合併。
- **`hegel-jna` 路線未經實測**：Java 21 需 JNA 綁定，且上游 compat 頁寫只支援 Linux／macOS，與 `docs/11` 的 CI 環境落差未驗證。

### 中性

- 統一的代價是「現在不是最成熟的選擇」，換得的是跨語言的可累積性；這個交換在試行期結束時要重新檢視（§10 觸發條件）。
- 工具調查結論（Hegel 在任何語言都還不是最成熟的預設）與本決定的選擇方向相反，這是刻意的：**選的是 skill 可累積，不是引擎最成熟**。工具對照表與數據留在 `docs/research/pbt-library-survey-2026-10.md`，供日後重新評估時直接引用。
- `jqwik` 已進入「pure maintenance mode」，是 Java 生態的長期風險；若日後 Hegel-Java 轉穩定，Java 是最可能先受益的語言。
- `hegel-skill` 的方法論（surface 盤點、Accept／Reject 雙向、失敗 ledger、12 點 review）與工具無關，即使日後換引擎，這份方法論仍可沿用。

## 替代方案

| 方案 | 未採用的理由 |
|---|---|
| **每種語言各用最成熟的工具**（TS 用 fast-check、Java 用 jqwik、Go 用 rapid、Rust 用 proptest） | 每一套的 generator、shrinking 與 property 寫法都不同，agent 每接一種語言就要重學一次；skill 無法沉澱，稽核品質無法跨語言比較。這是**唯一真正被認真考慮過**的替代方案，未採用是「可累積性優先於當下的成熟度」。 |
| 引入 fast-check 並等 Hegel 1.0 | 會產生兩次遷移成本（fast-check → Hegel），且 `hegel-skill` 這份現成的 agent skill 在遷移後才用得上。若試行期失敗，本項自動成為退路（見下）。 |
| 引進 `hegel-skill` 但工具用 fast-check | skill 內容與 Hegel API 綁定；改寫成 fast-check 版本等於另寫一份 skill，失去「上游不修改、可直接拉新版」的好處。 |
| 在 `-01-test` 就要求寫 PBT | 依據只能來自 agent 自己即將寫的實作與剛讀過的 Issue，違反 `ADR-008` 的獨立性原則。 |
| write-spec 通過的 `INV_*` 自動開稽核工單 | 會把稽核量綁在 write-spec 的使用量上，而 write-spec 只用於高風險模組；且自動開單需要跨 repo 事件（`docs/16`：收不到）。列為 §10 的重新評估項，不在此時實作。 |
| 稽核直接修 bug | 同一個 run 自己出題、自己修，違反獨立性原則。 |
| 失敗的 property 也進 PR 並標 skip | 會讓 repo 裡堆積 skip 的測試（`hegel-review` 第 8 點）。 |
| PBT 可以取代既有的範例測試 | 範例測試是可讀的規格，人一看就懂；取代後 `assertionDelta` 會顯示斷言下降，與 SR6 的語意衝突。 |
| 稽核 PR 依 `docs/06` 評分規則自動合併 | 試行期要人工檢查 property 是否落入 `hegel-review` 的 12 點缺陷；此時的自動合併等於讓未經驗證的 property 直接生效。 |
| 排程自動開稽核單 | 試行期需要人工挑選高風險且範圍適中的模組；自動挑選會在 PR 難以 review 的模組上產生大量候選發現。 |
| 把稽核發現寫成獨立 Issue 而非留言 | 候選發現需要人分類，先當留言可避免 Issue 清單被未確認的發現淹沒；`ADR-018` §7 的「候選發現（未回放）」用的也是同一個做法。 |
| 用 `junit-quickcheck` 作為 Java 退路 | 自 2020 年起未再發布，且只支援 JUnit 4、採 type-based shrinking。 |
| 工廠自己的 `src/` 一併導入 PBT | 本次範圍已由使用者裁定不擴大（Q7=B）；列為 §10 的已知缺口，不是「決定不做」。 |
| 趁這次一併修好 `assertion-count` 的 Java／ava 漏洞 | 該缺陷與 PBT 無關、影響所有 Java 目標 repo，應獨立成案並走自己的 PR 疊；混進本 ADR 會讓變更範圍失焦。 |

## 實作順序與驗收

**不在本 ADR 內實作**（使用者裁定本次只交付 ADR-019 與 `ADR-018` §1 的修訂）。以下為後續 PR 的順序草案：

1. **本 ADR**（`docs/ADR/019`）＋ `ADR-018` §1 修訂與補記＋ `docs/ADR/README.md` 索引。
2. **獨立成案（與 PBT 無關，可並行）**：`assertion-count` 補上 JUnit／AssertJ 的 `assertEquals(`／`assertThat(` 與 ava 的 `t.is(` 等寫法。
3. **Vendor `hegel-skill`**：鎖 commit、`NOTICE`、`skills-lock --update`，附不含硬編碼 model id 的檢查。
4. **新增工作項類型 `agent-pbt-audit`**：`.github/workflows/factory-run.yml` 的 `task_type` options（7 → 8）、`task-template-pbt-audit.txt`、`pbt/audit` 標籤、`backstage/templates/factory-work-item/template.yaml` 與 `.github/ISSUE_TEMPLATE/factory-work-item.yml` 的同步（`ADR-018` §11）、issue-check 的範圍欄位與標籤檢查、`factory-crosscheck` 的測試檔白名單、judge 的類型層級禁止自動合併，以及對應的對抗性測試。
5. **skill 疊加**：`factory-workflow` 寫入 §3 分工表與 §4 依據規則；`factory-self-review` 引用 `hegel-review` 12 點；`factory-stop-rules` 補上「product 程式碼被修改」與「property 沒有依據註解」兩條。
6. **試點**：在 `philipz/fubon-tradingbot` 手動開第一個 `pbt/audit` Issue，範圍限一個數值計算模組。
   - **驗收標準**：產出一份只有通過 property 的 PR，加上一份候選發現報告；報告中至少一條發現能被人類重現（~~用 Hegel 的 reproduce blob 在本地重跑出最小反例~~ **2026-10-05 修訂：人類貼上報告附的固定輸入紅燈測試，在本地重現紅燈**）。
   - **對照基準**：試點 repo 的 Issue #641–#644 是人類執行得到的反例與 property，可用來比較工作項產出的召回率、縮減品質與 `hegel-review` 缺陷數。
7. **試行報告**：累積 30 個 PR 或一個月後，記錄案例數、牆鐘、卡住次數、誤報次數、上游改版影響，據以決定是否收緊為必過檢查。

## 修訂記錄（2026-10-05）：試點回饋與落地 grilling

**輸入**：`docs/research/hegel-ts-pilot-fubon-2026-10.md`（人類在 `philipz/fubon-tradingbot` 執行的 spike 與導入，PR #645）與落地前的 grilling（使用者逐項裁決）。試點文件 §3 的 6 項修訂提案**全部採納**。各段的修訂以引言區塊標在原文旁，原文保留，以便看出決定如何演變。

| 編號 | 段落 | 修訂 | 原因 |
|---|---|---|---|
| R1 | §1 | 語言限 Hegel 官方 6 種，Python、Kotlin 停止並交還人類 | 「同一套引擎、同一份 skill」只在原生支援的語言成立 |
| R2 | §5 觸發 | 類型由表單決定；`pbt/audit` 自動貼上，只用於統計 | 類型判定機制本來只讀 Issue 內文，與其他類型一致 |
| R3 | §5 範圍 | 沿用「目標模組 / 檔案：」，機械檢查恰好一個路徑 | 新增欄位要同步 6 處（含 aswf.dev），機械檢查強度相同 |
| R4 | §5 產出 | blob 改為 draws＋seed＋版本＋紅燈測試；由機制留言 | TS 沒有公開 blob API；agent 不擁有開 Issue 的權限 |
| R5 | §5 通過 | `CI=true`＋20 seeds × 5000 cases | 試點中單次執行會放進間歇失敗的 property |
| R6 | §5 白名單 | 各語言 PBT 命名慣例（下表），只允許新增或修改 | 白名單要能精確比對；刪除測試不是 audit 的工作 |
| R7 | §7 | 兩個 skill；依類型篩選派送（`onlyFor`） | `hegel` 的 description 會在一般寫測試的工單觸發 |
| R8 | §9 timeout | runner `--testTimeout`＋job timeout | Hegel-TS 沒有 per-property timeout |
| R9 | §9 範圍 | 「非必過」只管工廠產出；PBT 檔留在預設 run | 排除在預設 run 之外違反 `hegel-review` 第 8 點 |
| R10 | §9 指標 | 分實測與自報，寫進 Issue 留言，不推 scoreboard | agent 自填的量測值不具量測意義 |
| R11 | §9 試點 | 更正 in-loop 的意義，新增 `IN_LOOP_ALLOWED_TASK_TYPES` | in-loop 實際上不會啟動 run |
| R12 | §10 | 新增改用 fast-check 的觸發條件 | 試點對照數據 |

### R6：各語言 PBT 檔命名慣例（crosscheck 白名單）

| 語言 | 副檔名（判定語言用） | PBT 檔 glob | 說明 |
|---|---|---|---|
| TS/JS | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `**/*.pbt.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` | 試點已使用 |
| Java | `.java` | `**/src/test/**/*PbtTest.java` | Surefire 自動收錄 |
| Go | `.go` | `**/*_pbt_test.go` | `go test` 自動收錄 |
| Rust | `.rs` | `**/tests/**/*pbt*.rs` | 不允許寫在 src 內的 `#[cfg(test)] mod`，那等於改產品檔；只測公開 API |
| C++ | `.cc .cpp .cxx .h .hpp` | `**/*_pbt_test.{cc,cpp,cxx}` | 需人類先建好收集這些檔案的測試 target |
| OCaml | `.ml .mli` | `**/test/**/*_pbt.ml` | 同上（dune） |

除了 TS，這些命名都是**工廠自訂的慣例**，不是上游規定；每種語言的第一張工單就是該語言的試點，結果回填 `factory-workflow` 的語言補充說明。

### 前置作業（由人類在目標 repo 先完成；agent 啟動前機械檢查，缺件即失敗）

依 SR5，agent 不得新增依賴；白名單也只放測試檔。因此依賴與設定一律由人類以一般 PR 先放進目標 repo 的 trunk。

| 語言 | 機械檢查（preflight） |
|---|---|
| TS/JS | `package.json` 的 `devDependencies` 有 `@hegeldev/hegel`，且是精確版本（無 `^`、`~`、範圍或 tag） |
| Java | `pom.xml` 有 `dev.hegel:hegel` 或 `dev.hegel:hegel-jna`、`<scope>test</scope>`、固定版本；或 Gradle 的 `testImplementation("dev.hegel:hegel[-jna]:x.y.z")` |
| Go | `go.mod` require `hegel.dev/go/hegel` |
| Rust | `Cargo.toml` 的 `[dev-dependencies]` 有 `hegeltest = "=x.y.z"` |
| C++、OCaml | 依賴寫法不統一，不做機械檢查；改由 agent 啟動後的 smoke property 驗證 |
| 全部 | `.gitignore` 含 `.hegel/` |

不易機械判讀的部分（例如 TS/Jest 的 `@hegeldev` swc transform、讀 `HEGEL_TEST_CASES`／`HEGEL_SEED` 的 settings helper、C++／OCaml 的測試 target）由 agent 第一步跑一個 smoke property 驗證，跑不起來就依 stop-rule 停下。人類操作步驟見 `docs/30-pbt-audit-runbook.md`。

### 實作順序的對應

本次落地以 stacked PR 交付：① 本修訂；② vendor `hegel`、`hegel-review` 與類型專屬派送；③ `agent-pbt-audit` 工作項機制（issue-check、preflight、in-loop 豁免、crosscheck、judge、機制留言、workflow、模板、GitHub 表單、Backstage）；④ factory skill 疊加與文件。③ 合併後，aswf.dev（`philipz/factory-scoreboard`）再以單獨 PR 把類型加入 `factory-contract.json`；它的 contract CI 會比對本 repo main 的 Issue 表單，所以必須依此順序合併。實作順序第 2 項（assertion-count）仍另案處理，第 6 項試點由使用者以實際工單進行。
