# 27 — 新 repo 納管流程（factory onboarding）

> **依據**：`05-guardrails-governance.md` §1.1（核心不變量）、`06-human-oversight-policy.md` §3（三軸）、`16-rescore-multirepo.md` §5（已納管 repo 與驗證方法）、`ADR/013`（trunk 統一）、`ADR/016`（propose-only 模式）
> **讀者**：要把一個新 repo 納入軟體工廠的人
> **狀態**：2026-09-07 首次真實執行成功（`philipz/camunda_hazelcast`，run `34131170174`，PR #6）

---

## 1. 為什麼需要這份文件

納管一個新 repo 需要兩個設定檔：

| 檔案                             | 作用                                    |
| -------------------------------- | --------------------------------------- |
| `catalog-info.yaml`              | 三軸風險標註（監督層級的計分輸入）      |
| `.github/factory/risk-paths.yml` | H1–H7 硬規則路徑（命中即強制 `risk=2`） |

過去這兩份都由人手寫，門檻不在「打字」，而在**不知道要寫什麼、寫完不知道對不對**——三軸的判準散在 docs/06，risk-paths 的陷阱藏在 docs/16 的事後檢討裡。

本流程讓 agent 承擔掃描與草擬（省掉絕大部分功夫），**三軸的裁定權留在人類手上**。

---

## 2. 一個不能繞過的約束

**agent 不會、也不能把這兩個檔案直接寫到正位。**

`docs/05` §1.1 的核心不變量標示為「無例外」：

> **agent 不得擁有修改 guardrail 本身的權限。**

納管情境的賭注特別高：此時**還沒有任何人審過這個 repo 的風險評級**。若 agent 能直接落檔，它就是在自己宣告自己的監督等級，之後所有工作項的計分都建立在這份未經裁定的自我宣告上。

「有人類審 PR」不足以補償——審查者面對一份填好的 YAML，預設反應是按 merge，真正需要動腦的三軸裁定會被包裝成一個看起來已完成的東西。

### 四道獨立防線

即使有人想繞過，實務上也會被擋下：

| 機制              | 位置                                   | 行為                                                    |
| ----------------- | -------------------------------------- | ------------------------------------------------------- |
| SR3 停止規則      | `src/stop-rules/stop-rules.ts`         | 觸碰即停手、貼 `needs-human`                            |
| H5 硬規則         | `risk-paths.yml`                       | 強制 `risk=2`                                           |
| crosscheck 白名單 | `factory-crosscheck.ts --onboard-only` | 越界即 exit 1                                           |
| **App 權限**      | GitHub App（D6）                       | **無 Workflows 權限，寫 `.github/` 直接被 GitHub 拒絕** |

最後一項不是本專案的程式碼能決定的。

### 為什麼 `proposals/onboarding/` 是安全的

它**不是任何機制的讀取路徑**：`factory-score` 讀 `catalog-info.yaml`、`factory-run` 讀 `.github/factory/risk-paths.yml`，兩者都不看 `proposals/`。因此**誤合併也不會改變任何評級**——三軸必須由人類親手搬檔才生效，而搬檔的人必然看過內容。

---

## 3. 流程總覽

```
1. 安裝 GitHub App 到目標 repo          ← 人工（GitHub 限制）
2. 建立 software-factory 分支            ← 人工（一行指令）
3. 開 issue → dispatch → agent 唯讀分析  ← 自動
4. 審核 PR、裁定三軸、搬檔、合併          ← 人工（不可省略）
5. 雙向探測驗證                          ← 人工（必做）
```

---

## 4. 步驟 1：安裝 GitHub App

到目標 repo 安裝 factory 的 GitHub App。**無法自動化**——GitHub 強制人工授權。

未安裝時，workflow 會在 mint token 階段失敗。

## 5. 步驟 2：建立 `software-factory` 分支

ADR-013 統一規定：**所有 repo 的 factory trunk 一律為 `software-factory`，main 絕不觸碰**。

```bash
REPO="philipz/your-repo"

DEF=$(gh api repos/$REPO --jq '.default_branch')
SHA=$(gh api repos/$REPO/git/ref/heads/$DEF --jq '.object.sha')
gh api repos/$REPO/git/refs -f ref='refs/heads/software-factory' -f sha="$SHA"
```

確認：

```bash
gh api repos/$REPO/git/ref/heads/software-factory --jq '.object.sha' \
  || echo "分支不存在——workflow 會 fast-fail"
```

## 6. 步驟 3：開 issue 並觸發

### 6.1 網頁 UI

到目標 repo 開 issue → 選 **Factory Onboard Repo（納管新 repo）**。

```
### 任務類型

agent-onboard

### 需求描述（PRD）

目標模組 / 檔案：proposals/onboarding/catalog-info.yaml、proposals/onboarding/risk-paths.yml
做什麼（一句話）：分析本 repo 結構，產出工廠設定的建議草稿供人類裁定。
範圍（不碰什麼）：唯讀分析；不修改任何既有檔案，不寫入 catalog-info.yaml 與 .github/。

用途：<這個 repo 做什麼>
使用者是誰（內部團隊／外部客戶）：<誰在用>
壞掉的話會怎樣：<影響範圍>

### 驗收標準（DoD）

- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）
- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）
- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）
```

### 6.2 gh CLI

> ⚠️ `gh issue create` **不會渲染 issue form**（YAML 範本只在網頁 UI 生效），
> 因此 body 必須自己寫成 `factory-issue-check` 要求的格式。

```bash
REPO="philipz/your-repo"

gh issue create --repo "$REPO" \
  --title "[factory-onboard] $REPO" \
  --body "$(cat <<'EOF'
### 任務類型

agent-onboard

### 需求描述（PRD）

目標模組 / 檔案：proposals/onboarding/catalog-info.yaml、proposals/onboarding/risk-paths.yml
做什麼（一句話）：分析本 repo 結構，產出工廠設定的建議草稿供人類裁定。
範圍（不碰什麼）：唯讀分析；不修改任何既有檔案，不寫入 catalog-info.yaml 與 .github/。

用途：<這個 repo 做什麼>
使用者是誰（內部團隊／外部客戶）：<誰在用>
壞掉的話會怎樣：<影響範圍>

### 驗收標準（DoD）

- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）
- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）
- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）
EOF
)"
```

**三個必須逐字照抄的地方**（改了就紅燈停派）：

| 項目                                                         | 要求                           | 契約來源                               |
| ------------------------------------------------------------ | ------------------------------ | -------------------------------------- |
| `### 任務類型`、`### 需求描述（PRD）`、`### 驗收標準（DoD）` | 標題逐字一致                   | `FIELD_TITLES`                         |
| 三行 DoD                                                     | **逐字一致**且三項全勾 `- [x]` | `DOD_LABELS`、`hasCheckedAcceptance`   |
| heredoc                                                      | 用 `<<'EOF'`（**加引號**）     | 否則 shell 會展開 `<這個 repo 做什麼>` |

> ⚠️ **不要加 `--label`**：全新 repo 還沒有 `meta/observation` 等工廠標籤
> （它們由 workflow 執行時才建立），會得到 `could not add label: not found`。
> 標籤對流程無功能作用；workflow 會自動補建。

### 6.3 觸發 CI

```bash
gh workflow run factory-onboard.yml --repo philipz/software_factory \
  -f issue_number=<N> -f repo="$REPO"
```

串起來（避免手抄 issue 編號）：

```bash
URL=$(gh issue create --repo "$REPO" --title "[factory-onboard] $REPO" --body "...")
N="${URL##*/}"
gh workflow run factory-onboard.yml --repo philipz/software_factory \
  -f issue_number="$N" -f repo="$REPO"

gh run list --repo philipz/software_factory --workflow=factory-onboard.yml --limit 3
```

### 6.4 開單前先驗證 body（可選）

```bash
node -e "
const {checkIssue}=require('./dist/cli/factory-issue-check.js');
const r=checkIssue(require('fs').readFileSync('/tmp/body.md','utf8'));
console.log(r.ok ? 'OK' : 'FAIL: '+r.missing.join(','));
"
```

## 7. 步驟 4：審核、裁定、搬檔

Agent 產出 PR（base 為 `software-factory`），含三個檔案：

```
proposals/onboarding/catalog-info.yaml   # 三軸留 TODO + 建議值與證據
proposals/onboarding/risk-paths.yml      # 依實際結構撰寫的硬規則
proposals/onboarding/README.md           # 給審核者的一頁說明
```

### 7.1 審查重點

**① risk-paths 的每條 glob 是否誤中無關檔案**

這是最容易出事的地方。實際列出目錄比對：

```bash
gh api repos/$REPO/contents/<glob 所在目錄>?ref=software-factory --jq '.[].name'
```

> **`docs/16` §5.3 的實證教訓**：factory-scoreboard 初版 H3 沿用 `**/*token*`，
> 誤中 `src/styles/tokens.css`（設計 tokens，與憑證無關）——每次改樣式都被強制人類審查。
>
> **硬規則若經常誤報，會訓練審查者略過警訊，反而削弱防護。**

**② 三軸的建議理由是否有證據**

理由應引用**實際檔案**，而非通則。建議值只是建議，裁定權在你。

**③ agent 的宣稱是否屬實**

不要採信自我回報，抽查原始檔：

```bash
gh api repos/$REPO/contents/<檔案>?ref=software-factory --jq '.content' | base64 -d
```

### 7.2 三軸的合法值（**重要**）

| 軸                                | 合法值                                   | 分數      |
| --------------------------------- | ---------------------------------------- | --------- |
| `factory.io/business-criticality` | `tactical` / `operational` / `strategic` | 0 / 1 / 2 |
| `factory.io/risk-profile`         | `low` / `medium` / `high`                | 0 / 1 / 2 |
| `factory.io/complexity`           | `low` / `medium` / `high`                | 0 / 1 / 2 |

> ⚠️ **fail-safe 行為**：值缺席**或非法**一律計為 **2**（最高風險）。
> 這是刻意的——若無法辨識的字串計 0，寫錯 annotation 就會悄悄降低監督。
>
> **實測案例（2026-09-07）**：camunda_hazelcast 的提案建議
> `business-criticality: supporting`——**`supporting` 不是合法值**
> （`BUSINESS_CRITICALITY = ['tactical','operational','strategic']`）。
> 實測 `supporting/medium/low` 得到 **total 3 → review**，
> 而非提案預期的 total 1 → on-loop。
>
> **審查時務必逐一核對三軸值是否在上表之內。**

### 7.3 搬檔（人類親手執行）

```bash
git mv proposals/onboarding/catalog-info.yaml .
mkdir -p .github/factory
git mv proposals/onboarding/risk-paths.yml .github/factory/risk-paths.yml
git rm -r proposals/onboarding
```

搬檔前把 3 個 `TODO` 換成實際值。合併進 `software-factory`。

## 8. 步驟 5：雙向探測驗證（必做）

設定檔在 `proposals/` 時**工廠讀不到它**（這正是它安全的原因），因此「設定寫對了」與「工廠讀得到」在合併前無法區分。

開一個 `factory/*` 探測 PR，實測**兩個方向**：

```bash
gh workflow run factory-rescore.yml --repo philipz/software_factory \
  -f repo=$REPO -f base_branch=software-factory -f pr_number=<PR>
```

| 探測內容         | 預期                                                 |
| ---------------- | ---------------------------------------------------- |
| 只改一般檔案     | 基準分、`triggeredHardRules: []`、`escalated: false` |
| 改一個硬規則路徑 | 分數上升、對應規則出現、`escalated: true`            |

> **兩個方向都要驗**：只驗前者無法區分「硬規則正確」與「硬規則根本沒載入」（`docs/16` §5.2）。

完成後把該 repo 補進 `docs/16` §5 的已納管清單。

---

## 9. 常見失敗

| 現象                                                | 原因                     | 解法                               |
| --------------------------------------------------- | ------------------------ | ---------------------------------- |
| `could not add label: 'meta/observation' not found` | 新 repo 尚無工廠標籤     | 拿掉 `--label`（§6.2）             |
| 留言「Issue 格式不合規」                            | DoD 三行或標題非逐字一致 | 對照 §6.2 表格                     |
| `目標 repo 不存在分支 software-factory`             | 漏做步驟 2               | 執行 §5                            |
| `已有 catalog-info.yaml（已納管）`                  | 重複納管                 | 納管為一次性；改三軸請直接編輯該檔 |
| mint token 失敗                                     | App 未安裝於目標 repo    | 執行步驟 1                         |
| crosscheck `onboard-scope`                          | agent 試圖寫入正位       | 已被擋下；檢視 PR 後交還人類判斷   |

---

## 10. 為什麼納管不走 `factory-run.yml`

`factory-run.yml` 的 Initial score 與 Judge 都硬性讀取那兩個檔案，缺檔即 exit 1（實測）：

```
error: file not found: .github/factory/risk-paths.yml   EXIT=1
error: file not found: catalog-info.yaml                EXIT=1
```

而納管的**前提就是這兩個檔案不存在**。要讓 `factory-run` 支援納管，得在計分與判定各加一個 skip 條件——那兩個條件一旦存在，就成了「合法跳過計分」的常駐路徑，日後可能被誤用或濫用。

故獨立一支 `factory-onboard.yml`：**納管的安全性不靠計分，而靠更硬的輸出白名單**（§2）。

---

## 11. 相關檔案

| 檔案                                         | 作用                    |
| -------------------------------------------- | ----------------------- |
| `.github/workflows/factory-onboard.yml`      | 納管 workflow           |
| `.github/ISSUE_TEMPLATE/factory-onboard.yml` | 網頁 UI 表單            |
| `.github/factory/task-template-onboard.txt`  | agent 指令              |
| `src/cli/factory-crosscheck.ts`              | `--onboard-only` 白名單 |

## 12. 已知缺口

- **Backstage 模板尚未建立**：`backstage/templates/` 下無 `factory-onboard`，
  Backstage 的 Create 頁面看不到納管表單。目前入口為網頁 issue 表單與 gh CLI。
- **`supporting` 誤用風險**：agent 可能建議非法軸值（§7.2 實測）。
  task-template 尚未列出合法值清單，待補強。
