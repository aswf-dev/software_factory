# 12 — GitHub Repo 設定指引（人工操作）

> **依據**：`05-guardrails-governance.md` §2.2（GitHub 層 guardrail）、`11-test-strategy.md` §7.1（required checks）、`02-architecture.md` D4、D6
> **讀者**：repo 管理者（目前為 `philipz`）
>
> **為何需要這份文件**：D4 的雙層防護中，**GitHub 層完全由 repo 設定構成**，而設定無法由程式碼自動完成——這正是刻意的（`05` §1.1：agent 不得擁有修改 guardrail 的權限）。因此本文件列出必須**由人手動執行**的步驟。

---

## 0. 目前狀態（更新於 2026-08-16，設定已完成）

| 項目 | 現況 |
|---|---|
| Repo | `philipz/software_factory`，**私有**，擁有者為**個人帳號** |
| 預設分支 | `main` |
| 分支保護 | ✅ **已啟用**：ruleset `main-protection`（id `20911877`）。核准要求因單人 repo 限制暫設為 0，其餘保護全存（見 §2.1） |
| CI 檢查名稱 | ✅ **`test`**（注意：是 **job id**，不是 workflow 名稱 `Test`） |
| Secrets | 尚未設定任何項目 |

> ⚠️ **最容易踩的坑**：required check 要填的是 **job id**（`test`），不是 workflow 的 `name:`（`Test`）。填錯會導致 GitHub 永遠等待一個不存在的檢查，PR 將無法合併。
>
> 查詢實際名稱的指令：
> ```bash
> gh api repos/philipz/software_factory/commits/main/check-runs \
>   --jq '.check_runs[].name'
> ```

---

> ✅ **本節設定已於 2026-08-16 完成並實證生效**：PR #1 顯示 `mergeStateStatus: BLOCKED`、`reviewDecision: REVIEW_REQUIRED`——`test` 檢查通過後**仍需人類核准**才能合併。以下步驟保留作為重建與稽核依據。
>
> ⚠️ **一則過程記錄**：建立 ruleset 的 `gh api --method POST` **沒有 dry-run**，一執行即生效。若想先檢視現況，請用 `gh api repos/philipz/software_factory/rulesets`（GET），不要期待 POST 有預覽行為。

---

## 1. 設定 required status checks

有兩種做法，擇一即可。**建議用方法 A（Rulesets）**——它是 GitHub 目前主推的機制，且在個人帳號的私有 repo 上**已實測可建立成功**。

### 方法 A：Rulesets（建議）

#### A-1. 網頁介面操作

1. 前往 `https://github.com/philipz/software_factory/settings/rules`
2. 點 **New ruleset** → **New branch ruleset**
3. 依下表填寫：

| 欄位 | 值 |
|---|---|
| Ruleset Name | `main-protection` |
| Enforcement status | **Active** |
| Target branches | Add target → **Include default branch** |

4. 勾選以下 **Rules**：

| 規則 | 說明 |
|---|---|
| ☑️ **Require a pull request before merging** | 禁止直接推送 `main`（`05` §2.2） |
| &nbsp;&nbsp;└ Required approvals: **1** | 對應 `06` 的人類審查閘門 |
| &nbsp;&nbsp;└ ☑️ Require review from Code Owners | 啟用 `CODEOWNERS`（D4 的關鍵） |
| ☑️ **Require status checks to pass** | 見下方檢查清單 |
| &nbsp;&nbsp;└ ☑️ Require branches to be up to date | 確保檢查跑在最新程式碼上 |
| ☑️ **Block force pushes** | 防止改寫歷程（稽核完整性） |

5. 在 **Require status checks to pass** 下方點 **Add checks**，輸入：

```
test
```

> 目前所有測試都在單一 job `test` 中執行（typecheck → unit → integration → adversarial → e2e）。**只需加入這一個檢查即可涵蓋全部五道關卡**。
>
> 若未來把測試拆成多個 job（例如讓失敗訊息更精確），則需把每個 job id 逐一加入。

6. 點 **Create**

#### A-2. 用 CLI 完成（等效，且可版控）

```bash
gh api --method POST repos/philipz/software_factory/rulesets \
  --input config/github/main-ruleset.json
```

設定檔已備妥於 `config/github/main-ruleset.json`（見 §4）。

**驗證是否生效**：

```bash
gh api repos/philipz/software_factory/rulesets --jq '.[] | {name, enforcement}'
```

---

### 方法 B：Classic branch protection

若你偏好舊介面：

1. 前往 `https://github.com/philipz/software_factory/settings/branches`
2. **Add branch protection rule**
3. Branch name pattern：`main`
4. 勾選：
   - ☑️ Require a pull request before merging（Required approvals: 1）
   - ☑️ Require review from Code Owners
   - ☑️ Require status checks to pass before merging
     - ☑️ Require branches to be up to date
     - 搜尋並加入 **`test`**
   - ☑️ Do not allow bypassing the above settings

> ⚠️ **個人帳號的私有 repo 對 classic branch protection 有方案限制**（通常需 GitHub Pro）。若介面顯示需升級，請改用方法 A。

---

## 2. 關於 dogfooding 的一個重要取捨

啟用「Require a pull request before merging」之後，**你自己也不能再直接推送 `main`**。

| 影響 | 說明 |
|---|---|
| 現行工作流程 | 目前是直接 `git push origin main`，啟用後會被拒絕 |
| 改為 | 建立分支 → 開 PR → 自我核准 → 合併 |
| 好處 | 這正是工廠要求 agent 遵循的流程，**dogfooding 才名副其實** |

> **建議**：接受這個不便。若人類可以繞過而 agent 不行，那條規則就不是真的規則，只是對 agent 的限制。`05` §1.1 的不變量應對所有行為者一致。

**若暫時不想受限**，可在 ruleset 的 **Bypass list** 中加入 Repository admin——但這會削弱防護，且應在文件中留下理由。

---

## 2.1 單人 repo 的核准限制（實測撞到的問題）

**問題**：GitHub **在 API 層禁止作者核准自己的 PR**：

```
GraphQL: Review Can not approve your own pull request (addPullRequestReview)
```

本 repo 目前只有 `philipz` 一位協作者，因此 `required_approving_review_count: 1` **永遠無法被滿足**——所有 PR 都會卡在 `REVIEW_REQUIRED`，包括第一個。

**已採行的解法**：把核准數改為 `0`、`require_code_owner_review` 改為 `false`，**其餘保護全部保留**。

| 保護項目 | 狀態 | 說明 |
|---|---|---|
| 必須走 PR（禁止直推 `main`） | ✅ **仍生效** | 已實測：直推被 `repository rule violations` 拒絕 |
| required check `test` 必須綠燈 | ✅ **仍生效** | 這是真正會攔下問題的機制 |
| 禁止 force push | ✅ 仍生效 | 稽核歷程完整性 |
| 禁止刪除分支 | ✅ 仍生效 | — |
| 人類核准 | ⚠️ **暫時移除** | 單人 repo 下無法滿足 |
| CODEOWNERS 審查 | ⚠️ **暫時移除** | 單人時等同自我核准 |

**為何這個取捨可以接受**：

單人 repo 中的「1 人核准」本來就只能靠自己點頭，那是**形式上的儀式而非實質審查**。真正在把關的是自動化檢查——138 則測試、100% 分支覆蓋、對抗性 guardrail 測試、Linux 沙箱驗證。移除一個無法滿足的條件，不等於降低防護。

> ⚠️ **但這確實是防護的缺口**，必須誠實記錄：目前**沒有第二雙眼睛**看過任何變更。`docs/07` §6.3 說「若你沒有實際讀懂這顆 PR，就不要核准它」——在單人狀態下，這條紀律只能靠自律，沒有機制強制。

**何時該恢復**：

一旦有第二位協作者，**立即**把兩項改回：

```bash
# 編輯 config/github/main-ruleset.json：
#   required_approving_review_count: 1
#   require_code_owner_review: true
gh api --method PUT repos/philipz/software_factory/rulesets/20911877 \
  --input config/github/main-ruleset.json
```

> **為何不選 bypass 名單**：把自己加入 bypass 會讓 required check 也一併被跳過——那才是真正削弱防護。移除一個做不到的核准要求、保留做得到的自動化閘門，是比較誠實的取捨。

---

## 2.2 一次 `main` 未被 CI 驗證的事件（原因未明）

**觀察**：PR #1 於 `02:22:33Z` squash 合併後，合併 commit `548cdb21` 的 check-runs 數量為 **0**：

```bash
gh api repos/philipz/software_factory/commits/548cdb21/check-runs --jq '.total_count'
# → 0
```

**後續反證**：PR #2 以**完全相同的方式**（squash + delete branch）合併後，`a1d54427` **正常觸發了 push 事件的 Test workflow**。

因此**「squash 合併不會觸發 push」這個推論是錯的**——我最初這樣記錄，但被下一次合併直接推翻。

| 事件 | commit | push run |
|---|---|---|
| PR #1 合併（02:22:33Z） | `548cdb21` | ❌ **未產生** |
| PR #2 合併 | `a1d54427` | ✅ 正常產生 `test` |

**目前的結論**：這是**一次性的異常**，原因未明。可能與當時正在修改 ruleset 有關（合併前數分鐘曾以 `PUT` 更新 ruleset），但**無證據支持**，不宜當作定論。

**為什麼仍要記錄**：

> `docs/09` 第 0 期的放棄條件寫著「工廠的安全性完全建立在『CI 綠燈代表沒有明顯破壞』這個假設上」。若 `main` 上的 commit 可能沒有 CI 紀錄，這個假設在 `main` 這一層就可能是空的——即使只發生一次，也值得知道它會發生。

**已採行的緩解**：

1. `test.yml` 已加入 `workflow_dispatch`，可在合併後手動補驗證紀錄。
2. **合併後應檢查 `main` 是否有 check-run**：

```bash
gh api repos/philipz/software_factory/commits/$(git rev-parse origin/main)/check-runs \
  --jq '.total_count'
# 若為 0，手動補跑：
gh workflow run test.yml --ref main
```

> **這是緩解而非根治**。真正的解法是 merge queue，但對單人 repo 過重。列為 Q12-5 追蹤。

---

## 3. GitHub App 設定（D6，第 1 期才需要）

**現在還不需要做**，待第 1 期實作 agent 執行時再進行。屆時步驟為：

1. `https://github.com/settings/apps` → **New GitHub App**
2. 權限依 `02` §2 的 D6 表格設定，**特別注意**：
   - Contents: Read & write
   - Pull requests: Read & write
   - Issues: Read & write
   - Actions: Read
   - **Administration：不授予**
   - **Workflows：不授予**
3. 產生 private key，存入 repo secrets：

```bash
gh secret set FACTORY_APP_ID --body "<app-id>"
gh secret set FACTORY_APP_PRIVATE_KEY < path/to/private-key.pem
```

> **後兩項不授予是機制層的核心**：`test/adversarial/guardrails.test.ts` 有測試斷言文件中記載了這兩項排除。若未來授予了，等於 D4 的雙層防護同時失效（`05` §1.1）。

---

## 4. 版控的設定檔

為使設定可追溯、可重建，ruleset 定義存於：

```
config/github/main-ruleset.json
```

> **注意**：這個檔案是**期望狀態的紀錄**，GitHub 不會自動套用它。修改後需重新執行 §1 A-2 的指令。這是已知的手動落差（Q12-1）。

---

## 4.1 `factory/approved` label（半自動觸發的前提）

`factory-issue-check.yml` 的半自動觸發是「格式合規的 Issue 貼上 `factory/approved` → 自動 dispatch factory-run」。

**這個 label 必須由人手動建立，工廠無法自舉**：`factory-run.yml` 的「Ensure factory labels exist」只在 factory-run **已經被觸發之後**才執行，而 `factory/approved` 正是觸發它的條件——先有雞後有蛋。它也不屬於 `src/labels.ts` 的 `FACTORY_LABELS`（那是**工廠會貼出去**的 label；`factory/approved` 相反，是人類貼給工廠的核准信號）。

```bash
gh label create "factory/approved" --repo philipz/software_factory \
  --color "0e8a16" --description "人類核准：自動 dispatch factory-run"
```

> **2026-09-13 實測發現**：這個 label 在 repo 中**從未被建立**，因此半自動觸發路徑自實作以來一次都沒有被走到。連帶讓另一個缺陷長期潛伏——該步驟漏設 `GH_TOKEN`（`gh` 在 Actions 不會自動撿 `GITHUB_TOKEN`），因為沒被執行過，所以沒有症狀。
>
> **沒有症狀不等於沒有缺陷。** 現已補上 `GH_TOKEN`，並由 `test/adversarial/factory-assets.test.ts` 斷言「每個呼叫 `gh` 的 step 都必須設 `GH_TOKEN`」。

驗證：

```bash
gh label list --repo philipz/software_factory --json name --jq '.[].name' \
  | grep -x "factory/approved"
```

---

## 5. 完成後的驗證清單

設定完成後逐項確認（每項都應可實測）：

```bash
# 1. Ruleset 已啟用
gh api repos/philipz/software_factory/rulesets --jq '.[] | {name, enforcement}'

# 2. 直接推送 main 應被拒絕（在測試分支上驗證，勿真的推壞）
#    預期看到 protected branch 相關錯誤

# 3. CI 檢查名稱與 required check 設定一致
gh api repos/philipz/software_factory/commits/main/check-runs --jq '.check_runs[].name'
```

- [x] Ruleset `main-protection` 狀態為 **Active**
- [x] required check 包含 **`test`**（名稱完全相符）
- [x] Block force pushes 已勾選
- [x] **直接推送 `main` 確實被拒絕**（已實測：`repository rule violations`）
- [x] 開一個測試 PR，確認 CI 檢查出現且必須通過才能合併（PR #1）
- [ ] Require review from **Code Owners**：⚠️ **暫時關閉**，待第二位協作者加入後恢復（§2.1）

> **最後一項最重要**：**設定完就實際開一個 PR 驗證**。未經驗證的防護設定與沒有設定的差別，往往只在出事時才會發現。

---

## 未決事項

| 編號 | 事項 | 影響 | 處置 |
|---|---|---|---|
| **Q12-1** | `config/github/main-ruleset.json` 與實際設定可能漂移（GitHub 不自動套用） | 設定可追溯性 | 建議：季度以 API 比對；或未來導入 IaC 工具 |
| **Q12-2** | 個人帳號私有 repo 對 classic branch protection 的方案限制未實測 | 方法 B 是否可用 | 已提供方法 A 作為主要路徑，不阻塞 |
| ~~Q12-3~~ | ~~是否將 Repository admin 加入 bypass list~~ | ✅ **已裁決：不加入**——改為移除無法滿足的核准要求，保留自動化閘門（§2.1） |
| **Q12-4** | **單人 repo 無第二雙眼睛審查** | 這是目前防護的實質缺口 | 有第二位協作者時**立即**恢復核准與 CODEOWNERS 要求（§2.1） |
| **Q12-5** | **曾有一次合併後 `main` 無 CI 紀錄**（PR #2 未重現） | `main` 可能存在無 CI 憑據的 commit | 合併後檢查 check-run 數；為 0 則手動補跑（§2.2）。根因未明 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
