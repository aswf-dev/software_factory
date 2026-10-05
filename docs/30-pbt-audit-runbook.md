# 30 — agent-pbt-audit 操作手冊（以 Hegel 事後稽核既有模組）

> **依據**：`ADR/019`（PBT 採 Hegel、以事後稽核執行，含 2026-10-05 修訂 R1–R12）、`ADR/018` §7（候選發現的處理）、`06-human-oversight-policy.md` §4（監督層級）
> **讀者**：要用工廠為目標 repo 的某個模組補上 property-based test 的人
> **狀態**：2026-10-05 接線完成，尚未有工作項 run。人類手動執行的第 0 筆基準見 `research/hegel-ts-pilot-fubon-2026-10.md`

---

## 1. 這個流程做什麼、什麼時候用

`agent-pbt-audit` 對**一個已經存在、已經被人 review 過**的模組寫 property-based test。通過的 property 開成 PR，作為新增的防線；失敗的 property 不進 PR，由機制以「候選發現（未回放）」貼在稽核 Issue，人類確認後再開 `agent-fix-bug` 修。

**適合**：輸入空間大的純函式合約——parser、序列化、數值計算（價格、數量、手續費）、路徑比對、schema 邊界。
**不適合**：狀態機、協定、時序性質（用 `agent-write-spec`，見 `28`）；定義域很小的有限組合（直接窮舉成範例測試）。

**為什麼是事後稽核**：開發當下寫的 property，依據只能來自 agent 剛讀的 Issue 與它即將寫的實作，正是「以自撰依據驗證自撰產出」。稽核面對的是已存在的程式碼，property 的依據才有獨立性。所以其他工作項類型**不得**產出 PBT 檔，也拿不到 `hegel` skill。

**支援語言**：Hegel 官方有函式庫的 6 種——TS/JS、Java、Go、Rust、C++、OCaml。Python、Kotlin 等其他語言在開單檢查就會被退回，交還人類決定。目前只有 TS/Jest 實測過；其他語言的第一張工單就是該語言的試點。

---

## 2. 流程總覽

```
0. 目標 repo 前置作業                 ← 人工（每個 repo 一次）
1. 開單（agent-pbt-audit）           ← 人工（Backstage／aswf.dev／GitHub 表單）
2. 派工 → issue-check → preflight    ← 自動（不合格即停，不啟動 agent）
3. agent 稽核 → audit PR             ← 自動
4. 機制貼出稽核摘要與候選發現         ← 自動
5. 審查 audit PR（hegel-review 12 點） ← 人工（一律人工合併）
6. 確認候選發現 → 開 agent-fix-bug    ← 人工
```

---

## 3. 前置作業（人工，每個目標 repo 一次）

agent 依 SR5 不得新增依賴，crosscheck 也只放行 PBT 測試檔，所以下面這些由人類以**一般 PR** 放進目標 repo 的 trunk（`software-factory` 分支）。缺任何一項，派工時 preflight 會直接失敗並留言列出缺項。

### 3.1 機械檢查的項目（preflight 會擋）

| 語言 | 依賴（一律精確釘版，無 `^`、`~`、範圍） |
|---|---|
| TS/JS | `package.json` 的 `devDependencies`：`"@hegeldev/hegel": "0.4.7"` |
| Java | `pom.xml`：`dev.hegel:hegel`（Java 22+）或 `dev.hegel:hegel-jna`（Java 17–21），`<scope>test</scope>`、固定版本；Gradle 用 `testImplementation("dev.hegel:hegel-jna:0.10.0")` |
| Go | `go.mod`：`require hegel.dev/go/hegel vX.Y.Z` |
| Rust | `Cargo.toml` 的 `[dev-dependencies]`：`hegeltest = "=X.Y.Z"` |
| C++、OCaml | 不做機械檢查（依賴寫法不統一），改由 agent 的 smoke property 驗證 |
| 全部 | `.gitignore` 有一行 `.hegel/`（Hegel 的本機失敗資料庫） |

### 3.2 agent 的 smoke property 會驗證的項目

這些不易從設定檔機械判讀，agent 第一步會跑一個最簡單的 property；跑不起來就停手交還人類。

**TS/Jest（以試點 `philipz/fubon-tradingbot` PR #645 為範本）**：

1. `@hegeldev/hegel` 只有 ESM 版本。CJS 的 Jest 專案要讓 swc 把它轉成 CJS，在 `jest.common.config.js`（或對應設定）加兩處：
   ```js
   transform: {
       '/node_modules/@hegeldev/.+\\.js$': ['@swc/jest', { module: { type: 'commonjs' } }], // 必須排在通用 .js 規則前面
       // ...既有規則
   },
   transformIgnorePatterns: ['/node_modules/(?!@hegeldev/)'],
   ```
2. 一個 settings helper（例如 `test/jest/utils/pbtSettings.ts`），讀 `HEGEL_TEST_CASES`（預設 100）與 `HEGEL_SEED` 後明確傳給 `hegel.test(fn, settings)`。`@hegeldev/hegel` 0.4.7 會無條件覆寫原生的環境變數與 `hegel.toml`，所以不能只靠環境變數。
3. 建議加一個 `test:pbt` script（`jest '\\.pbt\\.test\\.ts$' --selectProjects unit`）。PBT 檔**留在預設的測試 run 裡**（CI 下 100 cases、固定 seed），不要排除——排除在外會違反 `hegel-review` 第 8 點。
4. 選用：每晚一次、換 seed、5000 cases 的探索 workflow（試點的 `pbt-nightly.yml`）。

**C++／OCaml**：先建好用 glob 收集 `*_pbt_test.{cc,cpp,cxx}`（CMake）或 `test/**/*_pbt.ml`（dune）的測試 target，agent 新增檔案時才不需要改建置檔。

---

## 4. 開單

入口三擇一，內容相同：Backstage「開立 Factory 工作項」、aswf.dev 的送單頁、GitHub Issue 表單 `factory-work-item.yml`。任務類型選 **`agent-pbt-audit`**。

**需求描述（PRD）的「目標模組 / 檔案：」必須恰好一個路徑**——一個檔案或一個模組目錄。`hegel` skill 會盤點目標的全部公開 API，範圍過大時 PR 無法 review、發現報告也會過長。多個模組請拆成多張工單。

```
目標模組 / 檔案：src/options/TickSizeCalculator.ts
做什麼（一句話）：以 property 稽核價格檔位換算的合約
為什麼：價格、數量的換算錯誤會直接影響損益兩平價
範圍（不碰什麼）：不修改產品程式碼
```

驗收條件可以寫成具體的合約（例如「AC-1：合法價格經 roundToTick 不變」），agent 會把它當作 property 的依據（`// source: Issue #N AC-1`）。

開單檢查（`factory-issue-check`）會機械判定：恰好一個路徑、不是測試檔、副檔名是受支援的語言；派工時再確認路徑存在於目標 repo。目錄則取其下非測試原始檔最多的語言，同票時退回。

---

## 5. 派工後會發生什麼

| 步驟 | 結果 |
|---|---|
| 計分 | 監督層級照常計算。**in-loop（5–6 分）的 repo 也能跑 audit**——因為 crosscheck 只放行 PBT 測試檔，且 audit 一律不自動合併。tier 與標籤不變 |
| `pbt/audit` 標籤 | 自動貼上，只用於篩選與試行統計 |
| preflight | 重判稽核目標＋檢查 §3.1；不合格就留言、貼 `needs-human`，agent 不啟動 |
| skill 派送 | 只有這個類型會拿到 `hegel`、`hegel-review` |
| agent | smoke property → 寫 property（每個標 `// source:`）→ `CI=true`＋20 seeds × 5000 cases 判定通過 → 單層 PR |
| crosscheck | diff 只能是 PBT 檔的新增或修改；碰產品程式碼、設定、依賴或刪除任何檔案 → `needs-human` |
| judge | 即使計分允許，也降為 ready-for-review |
| 稽核摘要 | 機制在 Issue 留言：**機制實測**（agent 牆鐘、PBT 檔數與 property 數）與 **agent 自報**（seeds、案例數、通過／失敗、候選發現）分段列出 |

---

## 6. 審查 audit PR

audit PR 一律人工合併。審查時逐條對照 `.dsh/skills/hegel-review/SKILL.md` 的 12 點，特別是：

- **第 1 點 Narrowed generators**：generator 的範圍有沒有比合約窄（為了避開失敗而縮小範圍）。
- **第 5 點 Evidence-free properties**：每個 property 的 `// source:` 是否真的支持它；把實作重寫一份再比對不算。
- **第 8 點 ignored tests**：有沒有 skip、有沒有被排除在預設 run 之外。

另外確認 PR 只新增測試、沒有取代既有範例測試（ADR-019 §6）。

---

## 7. 處理候選發現

每條候選發現附：依據、縮減後的 draws、`HEGEL_SEED`、Hegel 版本、**固定輸入的紅燈測試**，以及修正後要加回的 property（選填）。

1. 把紅燈測試貼進目標 repo 本地執行，確認是紅燈（TS 版沒有公開的 reproduce blob API，這是重現的方式）。重現 property 本身時先 `rm -rf .hegel`，否則本機資料庫會重播舊的失敗。
2. 判斷是真實缺陷、測試錯誤，還是合約本來就允許的行為。
3. 確認是缺陷 → 開 `agent-fix-bug`，把紅燈測試與「修正後要加回的 property」放進 Issue；它的 01-test 層會把紅燈寫進 repo。

這條後路與 `agent-write-spec` 的 Quint 反例相同（ADR-018 §7），人只需要學一次。

---

## 8. 試行期與指標

試行期為一個試點 repo 的 30 個 PR 或一個月，以先到者為準（ADR-019 §9）。指標從稽核 Issue 的摘要留言彙整（留言永久保存；run artifact 90 天過期）：案例數、牆鐘、卡住（job timeout）次數、誤報次數、上游改版影響。試行期內沒有卡住、誤報、上游改版導致既有 property 失敗三類事故，才考慮收緊為必過檢查並解除「禁止自動合併」（`10` Q19-PBT-1）。

改用 fast-check 的觸發條件見 ADR-019 §10（R12）。
