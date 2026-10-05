# Hegel-TS 試點回饋：`philipz/fubon-tradingbot`（2026-10-05）

> 對象：`ADR-019`（PBT／Hegel）。這是一份**輸入**，給 ADR-019 落地 PR ①（記錄偏離原 ADR 的修訂）使用，本身不修改 ADR。
> 性質：由人類在試點 repo 手動執行的 spike 與導入，**不是** `agent-pbt-audit` 工作項的 run。工作項類型、白名單、judge 等工廠機制都還沒實作，這裡的數據可以當作試行報告（ADR-019 §9、實作順序 7）的第 0 筆基準。

## 證據

全部位於 `philipz/fubon-tradingbot`：

- PR #645（已合併，`1fdc029d`）：`test: 導入 Hegel property-based testing（CI + nightly）`
- `docs/research/hegel-pbt-spike-2026-10-05.md`：載入方式實測、生成器設計、5000 cases 稽核、候選發現 ledger、`hegel-review` 自審
- `docs/research/hegel-vs-fast-check-2026-10-05.md`：與 fast-check 的對照（14 個情境 × 30 seeds × 100／5000 cases）
- Issue #641–#644：候選發現，每份附 Hegel 縮減的反例、固定輸入的紅燈 repro，以及修正時要加回的 property
- 每晚 workflow 首次執行：Actions run `37303534685`（`HEGEL_SEED=37303534685`，5000 cases，16 passed）

版本：`@hegeldev/hegel` 0.4.7、`hegeldev/hegel-skill@a60b282`；Jest 30.5.2 + `@swc/jest`（CJS 專案）；Node 22。

## 1. 結論

- **Hegel-TS 能在試點 repo 使用，前置作業成本低**：1 個精確釘版的 devDependency、`jest.common.config.js` 加 2 行、`.gitignore` 加 `.hegel/`、1 個 settings helper。
- **PBT 的價值已經得到證實**：在 2 個小模組上，hegel skill 的流程找出 9 個候選缺陷（F1–F7、S-F1、S-F2），其中 F2（合法價格被 floor/ceil 移動一個 tick，≤ 10000 元的合法價格中 floor 有 10.7%）會影響損益兩平價的計算。原本 26 個範例測試沒有抓到它。
- **和 fast-check 的對照支持 ADR-019 選 Hegel**：在 5000 cases 下偵測率 **419/420 vs 365/420**；檔位邊界的 off-by-one 在均勻生成器下是 **29/30 vs 0/30**；縮減品質也是 Hegel 較佳。fast-check 的優勢都在維運面（零設定、純 JS、會印出 seed 和 path），而這些缺點在試點中都已經有解法。
- **ADR-019 有 5 處寫法與 TS 的實際情況不符**，需要修訂，見 §3。

## 2. 新事實（依影響的 ADR 段落排列）

### 2.1 載入方式（影響：前置作業清單、§8）

| 方案 | 結果 |
|---|---|
| 預設 CJS、CJS 內動態 `import()` | ❌ 套件只有 ESM 版本 |
| **swc 轉換 `node_modules/@hegeldev/*.js` 為 CJS** | ✅ 採用。`import.meta.url` 由 swc 正確處理，可以沿用既有的 `setup.ts`，不需要額外旗標 |
| Jest ESM 模式（`--experimental-vm-modules`） | ❌ 目標 repo 有 103 個 `export =` 模組無法以 ESM 編譯，`setup.ts` 用到的 `jest` 全域在 ESM 下也不存在 |
| Node ≥ 24.9 的 require(esm) + 旗標 | ✅ 可用，但 CI 和 `engines` 是 Node 22 |

```js
// jest.common.config.js
transform: {
    '/node_modules/@hegeldev/.+\\.js$': ['@swc/jest', { module: { type: 'commonjs' } }], // 必須排在通用的 .js 規則前面
    ...
},
transformIgnorePatterns: ['/node_modules/(?!@hegeldev/)'],
```

在這個方案下，property 測試**不需要**獨立的 Jest project，技術上也可以寫進既有的測試檔。

### 2.2 供應鏈（影響：§8）

- 原生依賴的實際組成：`koffi` FFI，加上 libhegel 與 koffi 各平台的 optionalDependency，lockfile 共 **27 筆**，node_modules 約 7.8 MB。**不支援 Intel macOS**。
- npm 11 預設會擋下 install script（`koffi` 的 `cnoke.cjs`），但 koffi 照樣能載入；npm 10（CI）會執行這個 script。在網路被阻斷時這個 script 也能成功，因為 `--prebuild` 直接採用平台套件內的 binary。

### 2.3 沒有 reproduce blob（影響：§5 產出、實作順序 6 的驗收標準）

- Hegel-TS **沒有公開的 reproduce API**，blob 只在內部使用。失敗時會在 stderr 印出縮減後的 draws（`var draw_N = …;`），然後拋出原始錯誤。
- 可行的替代方案已在試點驗證過：**縮減後的 draws + seed + 版本 + 固定輸入的紅燈測試**。12 個 repro 都實際執行並確認紅燈。
- **seed 只有在明確指定時才拿得到**：本機的隨機模式不會印出 seed。

### 2.4 案例數與 seed 的設定（影響：§9、TS 補充說明）

- TS 綁定 0.4.7 會**無條件**呼叫 `setTestCases(s.testCases)`（預設 100），覆寫 libhegel 原生的 `HEGEL_TEST_CASES` 和 `hegel.toml` profile。所以要用 helper 讀同名的環境變數再明確傳入。這可以當作向上游回報的候選 issue。
- 在 CI 環境下 Hegel 會自動 derandomize、停用資料庫；**明確指定的 seed 會覆蓋 derandomize**（已驗證）。
- 本機的 `.hegel/` 會以 `testFn.toString()` 為 key 重播舊的失敗。spike 中曾因此誤判「100 cases 就抓到了植入的 bug」，所以評估或重現前必須先 `rm -rf .hegel`。

### 2.5 timeout 與卡住（影響：§9 防護措施）

- Hegel-TS **沒有 per-property 的 timeout 設定**。`hegel.test` 是同步迴圈，Jest 的 `testTimeout` 打斷不了；`hegel.testAsync` 則受 `testTimeout`（試點預設 10 秒）限制，所以稽核時需要 `--testTimeout=600000`。
- 試點中**沒有觀察到卡住**（hegel-typescript#48）。另外，生成器有非確定性時，Hegel 0.4.7 會直接拋出 `EngineError: Your data generation is non-deterministic…`，不會卡住。PR #49 修的是 0.3.0 之前的 socket client，已經過時。

### 2.6 生成器設計比案例數更關鍵（影響：TS 補充說明、`factory-self-review`）

| 情境 | 100 cases（CI） | 5000 cases |
|---|---|---|
| 植入 `<`→`<=` 的檔位邊界 bug，均勻生成器 | 漏抓 | 抓到，縮減為 `1000` 分 |
| 同上，加入邊界導向的生成器（`oneOf` 直接建構邊界 ±3 tick） | 抓到 | 抓到 |
| NaN 成交量，只用 `gs.floats()` | 漏抓 | 抓到 |
| 同上，加入 `sampledFrom` 特殊值 | 抓到 | 抓到 |

### 2.7 「通過」要用多個 seed 判定（影響：§5「PR 只放通過的 property」）

CI 每次跑的是同一組 100 個輸入。如果只用一次執行判定「通過」，就會把間歇失敗的 property 放進 PR。試點以 **20 個隨機 seed × 5000 cases** 判定，發現一個 property 在 20 個 seed 中失敗 7 次（F6），已改移到 Issue。

### 2.8 其他實務陷阱

- `jest --selectProjects unit <pattern>`：`--selectProjects` 可以接多個值，會把 pattern 也當成 project 名稱吃掉，結果跑了整個 suite。pattern 必須放在 `--selectProjects` 前面。
- `hegel.test` 必須包在 `() =>` 裡（hegel.dev 官網的文件仍是舊的寫法）。

## 3. ADR-019 修訂提案

| 段落 | 現行寫法 | 試點事實 | 建議修訂 |
|---|---|---|---|
| §5 產出、實作順序 6 驗收 | 候選發現附「Hegel 的 reproduce blob」；驗收是「用 reproduce blob 在本地重跑」 | TS 沒有公開的 blob API（§2.3） | 改為「**縮減後的 draws + `HEGEL_SEED` + 版本 + 固定輸入的紅燈測試**」；驗收改為「人類貼上紅燈測試就能在本地重現紅燈」。Java 有 blob API，等有 Java 目標 repo 時再加回 |
| §5「PR 只放通過的 property」 | 沒有定義「通過」 | 間歇失敗（§2.7） | 「通過」定義為：**`CI=true` 加上至少 N 個隨機 seed × 稽核案例數都通過**（試點用 N=20，記入試行指標） |
| §9 防護「每個 property 設 timeout」 | 預設有 per-property timeout | TS 沒有這個設定，同步迴圈也無法中斷（§2.5） | 改為：async property 靠 runner 的 `--testTimeout`，整體靠 run／job 層的 timeout（例如 workflow 的 `timeout-minutes`）；把「卡住」定義為 job timeout，記入試行指標 |
| §9「試行期內 PBT 不設為必過檢查」「不另做每日排程」 | 範圍沒有限定 | 試點 repo 的**人類決策**是：成立的 property 隨每個 PR 執行（等於必過），而且另外設了每晚 5000 cases 的換 seed 探索 | 釐清 §9 的範圍：**它管的是工廠 `agent-pbt-audit` 的產出與 judge 行為，不限制目標 repo 自己的 CI 政策**。另外記錄：試點的做法（只收錄成立的契約、每晚換 seed 探索）可以當作日後收緊的候選方案 |
| §8 供應鏈 | 「Hegel 會引入 native binary」 | 實際組成見 §2.2 | 補上：koffi FFI、lockfile 27 筆、不支援 Intel Mac、npm 11 的 install script 行為；前置作業清單加入 swc transform（§2.1） |
| §10 重新評估觸發條件 | 試行期結束、Hegel 1.0／stateful API | 對照數據（§1） | 新增**改用 fast-check 的觸發條件**：Hegel 升版造成不相容；原生函式庫在 CI 或部署環境無法載入；上游長期不修 `testCases` 覆寫問題；試行期內出現卡住 |

不需要修訂、試點已經證實的部分：
- §4 property 的依據：每個檔頭都列出證據來源，oracle 是獨立實作。
- §5 失敗的 property 不進 PR、不用 skip：試點改成移到 Issue，由修正 PR 加回。
- §6 只新增、不取代。
- §7 `hegel-review` 12 點：自審時抓到 1 項 #4（一個測試多個 property），另有 1 項 #12 例外，附理由保留。

## 4. 給 `factory-workflow` 的 TS/Jest 補充說明

這是工廠 grilling Q10 決定的內容，寫在 `agent-pbt-audit` 段落，不改上游 skill：

1. 前置作業的檢查項目：devDependency 精確釘版、`.gitignore` 有 `.hegel/`、`jest` 的 `@hegeldev` transform（§2.1）。缺任何一項就依 stop-rule 停下。
2. `test('…', () => hegel.test(…))`；async 版本用 `hegel.testAsync`。
3. 案例數和 seed 一律經由 settings helper 傳入（§2.4），不要依賴 `hegel.toml`。
4. 稽核執行的指令：`rm -rf .hegel && HEGEL_SEED=<n> HEGEL_TEST_CASES=5000 npx jest '<pattern>' --selectProjects unit --testTimeout=600000`（注意 §2.8 的參數順序）。
5. 生成器：除了全域範圍，**必須另外直接建構邊界值和特殊值**（`oneOf` 加上邊界 ±k、`sampledFrom([NaN, ±Infinity, …])`），讓 CI 的 100 cases 也能守住（§2.6）。
6. 判定「通過」：`CI=true` 加上多個隨機 seed（§2.7）。
7. 候選發現的格式：見 §3 第一列。

## 5. 試行指標（第 0 筆，人類執行，非工作項 run）

| 指標 | 值 |
|---|---|
| 模組 | 2（TickSizeCalculator、SettlementPositionBuilder） |
| 設計的 property | 33（最後進 CI 的 16 個，移到 Issue 的 17 個） |
| 候選發現 | 9（F1–F7、S-F1、S-F2）；測試本身的錯 1 個（T1） |
| 誤報 | 0（9 個都已用固定輸入的 repro 確認是真實缺陷） |
| 卡住 | 0 |
| 牆鐘時間 | 5000 cases × 33 properties 共 9.2 秒；CI 100 cases × 16 properties 約 1.3 秒；每晚 5000 × 16 在 GitHub Actions 上，SPB 檔 13.7 秒 |
| 上游改版造成的影響 | 0（尚未升版） |

## 6. 待人類決定

1. §3 的修訂要不要全部採納，併入 ADR-019 落地 PR ①。
2. 是否向 hegel-typescript 回報「`testCases` 覆寫原生 env／profile」，以及「hegel.dev 的 TS 文件仍是沒有包 `() =>` 的舊寫法」。


已定（使用者，2026-10-05）：`agent-pbt-audit` 落地後，會以試點 repo 的實際工單來實驗。#641–#644 已經附上人類執行得到的反例和 property，可以當作工作項產出的對照基準（召回率、縮減品質、`hegel-review` 缺陷數）。
