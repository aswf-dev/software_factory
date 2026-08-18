# 11 — 測試框架與測試計畫

> **依據**：`00-source-summary.md` §3 Phase 1 Step 1（非 AI 自動化是引入 AI 的**前提**）、`09-roadmap.md` 第 0 期（前提就緒）、`02-architecture.md` D7
> **讀者**：實作工廠程式碼的工程師
>
> **決策脈絡**：使用者已裁決 — 試點對象為**工廠本身**（dogfooding）、實作語言為 **TypeScript/Node**、測試範圍為**完整金字塔**。

---

## 1. 為什麼工廠自己必須先有測試

這不是形式要求，而是 `09-roadmap.md` 第 0 期**放棄條件**的直接對象：

> 若目標 repo 的測試覆蓋薄弱到**無法信任 CI 綠燈**，且團隊無意補強——**停止整個工廠專案**。
> 理由：工廠的安全性完全建立在「CI 綠燈代表沒有明顯破壞」這個假設上。

**試點對象即工廠本身**，因此這條放棄條件現在指向我們自己。工廠的計分邏輯、停手規則、guardrail 若沒有測試，整個安全模型就只是文件上的宣稱。

### 1.1 dogfooding 的三個好處

| 好處 | 說明 |
|---|---|
| **回饋最快** | 工廠的缺陷立刻由自己承受，不會先傷到別的專案 |
| **風險最低** | 本 repo 為文件與工具，`06` 三軸計分本身就低（非客戶端、無金流授權） |
| **驗證真實** | 若工廠連自己的 repo 都改不好，就沒有資格去改別人的 |

### 1.2 但有一個必須警覺的循環風險

> **工廠測試自己的變更，等於 agent 驗證自己的產出。**

這正是 `06` §4.3 明確禁止的模式（「agent 不得驗證自己的產出並據以放行」）。

**因應**：本 repo 的 `catalog-info.yaml` 將 `factory.io/agent-automerge` 設為 **`"false"`**——**工廠對自己的 repo 永不自動合併**，所有變更一律人類審查。dogfooding 只用於驗證流程可運作，不用於證明產出正確。

---

## 2. 測試金字塔與範圍

```
        ╱╲          E2E（少量、慢、貴）
       ╱  ╲         一條完整工廠流程
      ╱────╲
     ╱      ╲       整合（中量）
    ╱        ╲      workflow 步驟、gh CLI 互動、DSH 呼叫
   ╱──────────╲
  ╱            ╲    單元（大量、快、便宜）
 ╱______________╲   計分邏輯、路徑比對、規則判定
```

| 層 | 測什麼 | 執行時機 | 目標耗時 |
|---|---|---|---|
| **單元** | 純函式邏輯：三軸計分、H1–H7 路徑比對、停手規則判定、PR 拆分規則 | 每次 commit | < 5 秒 |
| **整合** | 與外部介面的互動：`gh` CLI 解析、DSH exit code 判讀、YAML 設定載入 | 每次 PR | < 60 秒 |
| **E2E** | 一條完整流程：Issue → 計分 → agent → PR → 閘門 | 每次 PR（或 nightly） | < 10 分鐘 |
| **對抗性** | guardrail 是否真的擋得住（見 §5） | 每次 PR | < 30 秒 |

### 2.1 刻意不測的東西

誠實界定範圍，避免測試變成負擔：

| 不測 | 理由 |
|---|---|
| **LLM 的輸出內容品質** | 非決定性，無法穩定斷言。品質由 `06` 的人類審查與 `08` 的缺陷逃逸率把關 |
| **GitHub API 本身** | 是外部服務，不是我們的程式碼 |
| **DSH 內部行為** | 上游套件的責任；我們只測**我們對它的契約假設**（§4.2） |
| **Backstage UI** | 第 1 期不含；且屬展示層，故障不影響工廠執行（`02` §6） |

---

## 3. 工具鏈（版本已實測查證）

| 工具 | 版本 | 用途 | 查證 |
|---|---|---|---|
| **Node** | v22.21.1 | 執行環境 | ✅ 本機實測 |
| **TypeScript** | 7.0.2 | 型別 | ✅ npm registry |
| **Vitest** | 4.1.10 | 測試框架 | ✅ engines 明列支援 `^22.0.0` |
| **@vitest/coverage-v8** | 4.1.10 | 覆蓋率 | ✅ npm registry |
| **zod** | 4.4.3 | 設定 schema 驗證 | ✅ npm registry |
| **js-yaml** | 5.3.0 | 讀取 `risk-paths.yml` 等 | ✅ npm registry |
| **minimatch** | 10.2.6 | 路徑模式比對（H1–H7） | ✅ npm registry |
| **@actions/core** | 3.0.1 | Actions 輸入輸出 | ✅ npm registry |

### 3.1 為何選 Vitest 而非 Jest

| 考量 | 判斷 |
|---|---|
| 與 Backstage 技術棧一致 | 兩者皆可；Backstage 生態近年偏向 Vitest |
| 原生 TypeScript 支援 | Vitest 免額外 transform 設定 |
| 速度 | Vitest 明顯較快，符合「單元測試 < 5 秒」目標 |
| ESM 支援 | Vitest 原生；Jest 需額外設定 |

> ⚠️ **版本鎖定原則**（呼應 Q04-4、Q07-3）：所有版本以**精確版號**寫入 `package.json`，不使用 `^` 或 `~`。理由：工廠的可重現性是安全前提，浮動版本會讓「上週還好好的」變成常態。

---

## 4. 各層測試的具體內容

### 4.1 單元測試（最大宗）

#### A. 三軸計分邏輯（`06` §3）

這是工廠**最關鍵的單一邏輯**——它決定 agent 能做什麼。

```typescript
// src/scoring/score.test.ts
describe('三軸計分', () => {
  it('內部工具補測試 → 0 分 → on-loop', ...)
  it('客戶端服務改金流 → 5 分 → in-loop', ...)

  // 硬性規則：碰到即滿分，無裁量空間
  describe('風險硬性規則 H1–H7', () => {
    it('觸及 src/auth/** → risk=2，即使其他軸為 0', ...)
    it('觸及 .github/** → risk=2（H5 guardrail 自身）', ...)
    it('觸及 migrations/** → risk=2（H6 不可逆）', ...)
  })

  // fail-safe：缺資訊時必須偏保守
  it('缺少三軸 annotation → 一律採最高風險值', ...)   // 03 §7
})
```

**必測的邊界情況**：

| 情況 | 期望行為 | 依據 |
|---|---|---|
| annotation 缺失 | 採最嚴格值（strategic/high/high） | `03` §7 fail-safe |
| annotation 值非法（打錯字） | **視同缺失，採最嚴格值**，不可當作 0 分 | 同上原則 |
| 分數恰在門檻邊界（1 vs 2、4 vs 5） | 依 `06` §4 表格 | `06` §4 |
| `agent-automerge: "false"` 且分數 0 | **仍不得自動合併** | `06` §4.1 否決權 |

> **「非法值視同缺失」值得特別測**：若打錯字被當成 0 分，等於**打錯字就能降低監督層級**——這是安全漏洞而非小瑕疵。

#### B. 二次判定（`06` §5.3）

```typescript
describe('二次判定：只升不降', () => {
  it('初次 0 分，diff 觸及 auth → 升級為 ≥2，撤銷自動合併', ...)
  it('初次 3 分，實際 diff 風險較低 → 維持 3 分，不得降級', ...)  // 單向規則
})
```

#### C. 停手規則（`04` §3.3）

```typescript
describe('停手規則', () => {
  it('連續兩次 gh stack sync 失敗 → needs-human', ...)
  it('第一次失敗 → 允許重試一次', ...)
  it('偵測到測試斷言被弱化 → 停手', ...)   // 最危險的失敗模式
})
```

### 4.2 整合測試

**原則**：測「我們對外部的契約假設」，不測外部本身。

| 測試對象 | 測什麼 | 不測什麼 |
|---|---|---|
| **DSH 呼叫** | exit code 0/1 的**判讀邏輯**是否正確分派 | DSH 內部如何產生該 code |
| **`gh` CLI** | JSON 輸出的**解析**是否正確 | GitHub API 是否正確回應 |
| **`gh stack`** | `sync` 失敗時是否走停手路徑 | gh-stack 的 rebase 演算法 |
| **YAML 設定** | `risk-paths.yml` schema 驗證與載入 | js-yaml 的解析正確性 |

```typescript
// 以 fixture 取代真實外部呼叫
describe('DSH exit code 判讀', () => {
  it('exit 0 → 續行後續步驟', ...)
  it('exit 1 → 標記 needs-human 並附上 stderr', ...)
  it('exit 1 但 stderr 為空 → 仍須標記，訊息註明無詳情', ...)
  it('逾時（無 exit code）→ 視同失敗', ...)
})
```

> **關鍵測試**：必須有一則測試明確斷言「**exit 0 不等於任務正確完成**」的下游行為——即 exit 0 後**仍須**經過 required checks 與審查閘門，不可直接放行（`04` §4.2 的重要提醒）。
> **逾時與 exit code 優先權的邊界（mutation-verified）**：`dsh-contract.test.ts` 另以 3 則故意變異驗證的邊界案例，釘住 `interpretDshResult()` 的決策順序與字面契約：
> - 逾時無 stderr 時 `errorDetail` 使用預設訊息「執行超過時間上限，已中止」；
> - 逾時對非零 exit code 優先（被殺的程序可能帶誤導碼）；
> - exit 0 即使帶 stderr 仍為 `completed`（成功時忽略 stderr）。
> 三者皆在相應原始碼被 mutate 時轉紅、還原後轉綠（見該測試檔）。


**`gh` json 解析的 mutation-verified 邊界測試**（`gh-parse.test.ts`）：除了 §4.2 的契約表格，metrics（`08` §2.1）的兩條管子——`leadTimeHours` 與 `idleRatio`——另以 3 則「變異後紅燈、還原後綠燈」的測試釘住既有測試沒蓋到的行為：

- `mergedAt` 欄位整個**缺席（undefined）**時 `leadTimeHours` 仍須回傳 `null`（與 `null` 同義，守住對 undefined 的判斷）；
- `leadTimeHours` 對**非整數小時**須原樣回傳、不四捨五入（守住精度）；
- process time 為**負**（資料異常）時 `idleRatio` 原始比值逾 1，須由上界 clamp 夾回 `1`（守住上界）。

### 4.3 E2E 測試

**一條完整流程，用假的 agent**：

```
建立測試 Issue（含三軸標註）
   → 觸發計分 → 驗證標籤正確
   → 呼叫「假 agent」（回傳預設的變更，不呼叫真 LLM）
   → 驗證產生 stacked PR
   → 驗證閘門行為（低分可合併 / 高分被擋）
```

> **為何用假 agent**：真 LLM 非決定性、慢、有成本。E2E 要驗證的是**流程接線正確**，不是 LLM 品質。以可預測的假 agent 替代，測試才能穩定。真 agent 的驗證屬於第 1 期的實跑（`09` 出場條件「完成 ≥ 10 個工作項」）。

---

## 5. 對抗性測試（本計畫的特色）

一般測試問「功能正常嗎」；**guardrail 必須問「擋得住嗎」**。

`05` §8 的治理檢查清單目前是人工勾選——本節把其中可自動化的部分變成測試。

```typescript
describe('guardrail 對抗性測試', () => {
  // 對應 05 §1.1 的核心不變量
  it('agent 嘗試修改 .github/workflows/ → 計分 risk=2 且被 CODEOWNERS 攔截', ...)
  it('agent 嘗試修改 CODEOWNERS 自身 → 同上', ...)
  it('agent 嘗試修改 catalog-info.yaml 降低風險等級 → 被攔截', ...)
  it('agent 嘗試修改 .dsh/skills/ 自身的 SOP → 被攔截', ...)

  // 對應 04 §3.3 停手規則
  it('agent 刪除測試斷言使測試通過 → 應被偵測', ...)

  // 對應 02 §7 / 05 §2.1
  it('CI 設定中 sandbox 模式不得為 danger-full-access', ...)
  it('approval policy 必須為 never（CI 中不等待）', ...)
})
```

### 5.1 設定即測試

部分 guardrail 是**設定**而非程式碼，同樣要測：

```typescript
describe('GitHub App 權限最小化（D6）', () => {
  it('App manifest 不含 Administration 權限', ...)
  it('App manifest 不含 Workflows 權限', ...)
})
```

> **理由**：D6 的權限排除是 `05` 核心不變量的**機制執行**。若某次設定調整意外加回這兩項權限，雙層防護會**同時**失效。這種錯誤不會有任何功能異常症狀——**只有測試會發現**。

---

## 6. 覆蓋率要求

| 範圍 | 門檻 | 理由 |
|---|---|---|
| **計分邏輯**（`src/scoring/`） | **100% 分支** | 決定 agent 權限，任一分支未測即為安全缺口 |
| **停手規則**（`src/stop-rules/`） | **100% 分支** | 同上 |
| 其他工廠程式碼 | 80% 行 | 一般標準 |
| 整體 | 80% 行 | — |

> **為何前兩者要求 100% 分支**：這兩處的每一個分支都對應「agent 能不能做某件事」的判定。未測的分支等於未驗證的權限路徑。其餘程式碼出錯會造成故障（可見），這兩處出錯會造成**越權**（不可見）。

> **覆蓋率的正確用法**：它是**尋找未測程式碼的工具**，不是品質分數。100% 覆蓋率不代表沒有 bug；但計分邏輯有未覆蓋分支，就一定有未驗證的權限路徑。

> **Mutation-strength 測試**：100% 覆蓋率只證明「每一行都跑過」，不能證明「改壞會被抓到」。對 `formatCliError`（`src/cli/run-cli.ts`，CI gate 的錯誤輸出）以變異測試驗證套件有牙齒：誤改 ENOENT 判定、path fallback、最終 `String()` 分支，或放寬 `isErrnoException` 的 `instanceof Error` 守衛，都會使測試轉紅。詳細變異清單與 GREEN/RED 記錄見 `src/cli/run-cli-mutation.test.ts` 標頭（比照 `src/scoring/rescore-mutation.test.ts` 的做法）。
### 6.1 mutation-strength 測試（覆蓋率的互補）

覆蓋率只說「這行被跑過」，不能證明「這行寫錯時測試會變紅」。對**容易在重構中悄悄引入權限偏誤**的關鍵函式，另以「mutation-strength」測試補強：把一個具體的變異套進被測函式，斷言它必須讓測試變紅。既有慣例：

| 檔案 | 被測函式 | 覆蓋的變異 |
|---|---|---|
| `src/scoring/rescore-mutation.test.ts` | `rescore` | 持平放寬降級、blocker 聯集被截、automerge 阻擋失效、單向不降級守衛 |
| `src/cli/parse-args-mutation.test.ts` | `parseArgs` | 重複旗標「後出現者勝」、旗標判定 `--` 被放寬成 `-`、處理旗標誤重設另一欄 |

每個變異都經「手改原始碼 → 測試變紅 → 還原 → 變綠」驗證，並在檔頭記錄 mutation log。這是對 §6 覆蓋率門檻的質性補強，不是取代。

---

## 7. CI 整合（D7）

```yaml
# .github/workflows/test.yml
name: Test
on:
  push: { branches: [main] }
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22.21.1'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:adversarial
      - run: npm run coverage
```

**這個 workflow 就是 `09` 第 0 期出場條件的實體**：它一旦穩定綠燈，`00` §3 Phase 1 要求的「非 AI 自動化前提」即成立，工廠才有資格上線。

### 7.1 required checks 設定

依 `05` §2.2，以下必須設為 required：

- `typecheck`
- `test:unit`
- `test:integration`
- `test:adversarial`

> **`test:adversarial` 必須是 required**——它驗證的是 guardrail 本身。若它可被跳過，D4 的雙層防護就成了可選項。

---

## 8. 測試計畫的執行順序

對應 `09-roadmap.md` 第 0 期：

| 階段 | 工作 | 出場條件 |
|---|---|---|
| ✅ **T1** | 建立專案骨架、tsconfig、vitest 設定、CI workflow | **已完成**：CI 實跑綠燈 |
| ✅ **T2** | 計分邏輯 + 100% 分支測試 | **已完成**：35 則測試，100% 分支 |
| ✅ **T3** | 停手規則 + 100% 分支測試 | **已完成**：39 則測試，100% 分支 |
| ✅ **T4** | 整合測試（DSH 契約、gh CLI 解析） | **已完成**：27 則測試，100% 分支 |
| ✅ **T5** | 對抗性測試 + 設定檢查 | **已完成**：21 則測試，已設為獨立 CI 步驟 |
| ⬜ **T6** | E2E（假 agent） | 待辦：一條完整流程可跑通 |

> **T1 必須最先完成且獨立驗證**。若骨架本身跑不起來，後面所有測試都是空談。這也是為何本次交付**同時附上可執行的骨架**（見 §9）。

---

## 9. 本次已交付的可執行骨架（✅ 已實跑驗證）

為避免本文件停留在紙上，已建立骨架並**實際執行驗證**：

```
package.json                          # 精確鎖版（無 ^ ~）
tsconfig.json                         # strict + noUncheckedIndexedAccess
vitest.config.ts                      # 覆蓋率門檻（scoring/stop-rules 100% 分支）
src/scoring/
  ├── types.ts                        # 三軸型別、監督層級、H1–H7
  ├── score.ts                        # 計分邏輯（fail-safe + 二次判定）
  └── score.test.ts                   # 35 則單元測試
src/stop-rules/                       # T3
  ├── types.ts                        # SR1–SR8 規則型別
  ├── stop-rules.ts                   # 停手判定（無 override 機制）
  └── stop-rules.test.ts              # 45 則單元測試（含 mutation 驗證用例）
src/integration/                      # T4
  ├── dsh-result.ts                   # exit code 判讀（taskVerified 恆為 false）
  └── gh-parse.ts                     # gh JSON 解析、lead time、閒置比
test/integration/
  ├── dsh-contract.test.ts            # 11 則（fixture 取自真實實測輸出）
  └── gh-parse.test.ts                # 19 則（含 3 則 mutation-verified 邊界）
test/adversarial/
  └── guardrails.test.ts              # 21 則對抗性測試
.github/workflows/test.yml            # CI（= 第 0 期出場條件的實體）
.github/factory/risk-paths.yml        # H1–H7 路徑模式
catalog-info.yaml                     # 三軸標註 + automerge 否決
CODEOWNERS                            # GitHub 層 guardrail
```

### 9.1 實跑結果（T1–T5 完成後）

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | ✅ 通過（strict 模式無錯誤） |
| `npm run test:unit` | ✅ **216 則**（計分 53 + 停手規則 45 + CLI 118） |
| `npm run test:integration` | ✅ **48 則**（DSH 契約 14 + gh 解析 23 + CLI 實機 6 + mutation 5） |
| `npm run test:adversarial` | ✅ **50 則**（guardrails 31 + factory-assets 19） |
| **合計** | ✅ **335 則全數通過**（含 e2e 17 + quint 神諭 4） |
| `npm run coverage` | ✅ `scoring`、`stop-rules`、`integration` **全部 100% 分支/行/函式/敘述** |

### 9.2 兩項「閘門是否真的有效」的驗證

寫了測試不代表測試會擋。因此額外做了**故意破壞驗證**：

| 驗證 | 做法 | 結果 |
|---|---|---|
| **覆蓋率門檻真的會擋** | 暫時移除「非法值」那則測試 | ✅ 覆蓋率降至 96.66%，**CI 失敗**並精確指出未覆蓋的第 69 行 |
| **對抗性測試真的會擋** | 暫時從 `risk-paths.yml` 移除 `.dsh/skills/**` | ✅ **2 則測試立即失敗**，指出 guardrail 保護出現缺口 |

> **為何要做這個驗證**：`05` §8 的治理檢查清單若只是人工勾選，很容易變成形式。第二項驗證證明——**若有人（或 agent）弱化了 guardrail 設定，CI 會擋下來**，而不是靜默通過。這是把「宣稱的防護」變成「可驗證的防護」的關鍵一步。

### 9.2.1 一次真實的假陽性（值得記取）

Linux 沙箱探測**首次執行即失敗**，但那是測試本身的缺陷，不是設定有問題：

| 項目 | 內容 |
|---|---|
| **原始檢查** | `grep -q 'danger-full-access' config/dsh/factory-guardrail.patch.yml` |
| **失敗原因** | 該字串只出現在**註解**裡（「danger-full-access is never used in CI, since...」），並非實際設定值 |
| **修正** | 改為解析 `--dump-config` 的**組成後有效設定**：比對 `sandbox-policy` 的 `mode`、`defaultPreset`、以及 `factory-ci` preset 的 `sandbox` |
| **修正後驗證** | 以**竄改過的設定**測試，確認確實會擋（而非只確認「能通過」） |

> **教訓**：**會對註解文字誤報的 guardrail 測試，比沒有測試更糟**——它教團隊忽略警報。安全檢查必須測「實際生效的設定」，而非「原始檔的文字」。

### 9.2.2 第二次假象：測試「通過」但其實什麼都沒測到

執行期逃逸測試首次在 Linux 上跑出**綠燈**，但檢查日誌後發現它是**假通過**：

| 觀察 | 意義 |
|---|---|
| `exit=1`、agent stdout **空白** | agent **根本沒執行成功** |
| `$HOME/ESCAPE-TEST.txt` 不存在 | 但這只是因為**沒人去寫**，不是沙箱擋下 |
| 檢查邏輯只判斷「檔案不存在 → 通過」 | 於是回報了它從未驗證過的安全性 |

**根因**：該步驟先 `cd /tmp/probe-ws`（agent 需要可寫的工作目錄），但 DSH 安裝在 `$GITHUB_WORKSPACE/node_modules`，因此 `npx dsh` 在該目錄下無法解析。改為以絕對路徑呼叫即修復。

**兩項補強**：

1. 印出 **stderr**——原本只印 stdout，導致失敗時無從診斷。
2. 加入**假通過防護**：若 `exit != 0` 且 stdout 為空，直接判定失敗並說明「agent 未執行，因此本測試未能證明任何事」。

> **教訓**：安全測試的綠燈必須同時滿足兩件事——**受測行為確實發生**，且**結果符合預期**。只驗證後者，會得到一個「宣稱安全但從未驗證」的測試，而這種測試的危害大於沒有測試，因為它會讓人停止追問。
>
> 這是本專案第三次遇到同類問題（前兩次見 §9.2、§9.2.1）。三次都是靠「檢查日誌／刻意破壞」才發現，**不是靠測試自己報告**。
>
> 這與 §9.2 最初把 `/tmp` 當作逃逸目標是同一類錯誤：**測在錯的東西上，得到的安心感是假的**。兩次都是靠「刻意破壞後確認會擋」才發現，這個習慣值得保留。

### 9.3 尚未涵蓋

**T1–T5 已完成**，仍待展開：

- **T6 E2E**（假 agent 的完整流程）——待 Q11-1 決定假 agent 的實作方式
- **CI required checks 設定**——需在 GitHub repo 設定中將四項標為必要（§7.1），此為**人工操作**
- **Backstage 相關**（`03`）——第 1 期後段

### 9.4 T3/T4 的兩項設計要點

**T3 停手規則：刻意不提供 override 參數**

`evaluateStopRules()` 只回答「是否必須停手」，**沒有任何可關閉規則的參數**。理由：若存在繞過機制，卡住的 agent 就有動機去使用它——而那正是最不該放行的時刻。測試中有一則專門斷言回傳物件的鍵只有四個，確保未來不會悄悄加入 override。

**T3 停手規則：以 mutation 驗證測試是否有檢出力**

除了分支/行覆蓋率，`stop-rules.test.ts` 也用「mutation 驗證」來確認測試真的守得住行為：逐一對來源實作引入會改變語義的變異（例如把斷言閾值從 `< 0` 收緊成 `< -1`、把 guardrail 從精確 glob 匹配改成子字串比對、在 SR2 理由裡洩漏被排除的 H5），**變異後對應測試必須變紅，還原後必須變綠**。這補足了覆蓋率數字看不出來、但恰好是停手規則最怕的那種「測試存在卻偵測不到錯誤」的盲點。此類驗證用例會隨實作一起審查。

**T4 DSH 契約：`taskVerified` 恆為 `false`**

`interpretDshResult()` 的回傳型別把 `taskVerified` 宣告為字面值 `false`。這不是佔位，而是把 `04` §4.2 的警告**寫進型別系統**：exit 0 只代表「回合正常結束」，不代表任務正確。呼叫端若想拿它當品質保證，型別檢查就會擋下來。

---

## 未決事項

| 編號 | 事項 | 影響 | 處置 |
|---|---|---|---|
| **Q11-1** | E2E 的「假 agent」實作方式（stub 腳本 vs 錄製回放） | §4.3 | 建議先用最簡單的 stub 腳本 |
| **Q11-2** | 「偵測測試斷言被弱化」的判定方式（§4.1 C） | 停手規則的可測性 | 建議：比對測試檔的 diff，斷言數減少即告警 |
| **Q11-3** | App manifest 的測試方式（§5.1）——設定存於 GitHub 而非 repo | 對抗性測試可行性 | 建議：以 repo 內的 manifest 檔為單一事實來源 |
| **Q11-4** | 覆蓋率門檻 80% 未經校準 | §6 | 先設定，依實際情況調整 |
| **Q11-5** | E2E 是否納入 required checks（耗時較長） | §7.1 | 建議：PR 上跑，但 nightly 才跑完整版 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
