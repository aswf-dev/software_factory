# 34 — 形式化驗證 task 操作手冊（agent-verify-*，V2 工廠端）

> 依據：`ADR-029`（§5 執行平面與揭露、§6 驗證專用接入、§7 Lean）；計畫
> `docs/superpowers/plans/2026-10-27-verify-v2-factory.md`。
> 正式入口是 aswf.dev 的 `/verify`（V3）。本手冊說明 V2 階段**手動** dispatch 的
> 方式、會產出什麼、怎麼解開，以及與一般工作項的差異。

## 1. 四個 task type

| task type | 階段 | 主要產出（目標 repo 工作區，只進密文 bundle） |
|---|---|---|
| `agent-verify-grill` | ① 唯讀分析 | `specs/quint/CODE-SUMMARY.md`（程式碼摘要、候選規則、第一輪問題，交給 G1 確認 `RULES.md`） |
| `agent-verify-quint` | ② Quint 模型 | `specs/quint/**`（讀 G1 確認後的 `RULES.md`，唯讀） |
| `agent-verify-lean` | ③ Lean 演繹驗證 | `specs/lean/**`；以 `verify_phase` 分 `statements`（可留 `sorry`，待 G3 簽核）與 `proofs`（零 `sorry`） |
| `agent-verify-tests` | ④ 反例測試 | 目標 repo 測試框架的 `todo` 測試 |

寫入白名單與停手規則以 `.github/factory/task-template-verify-*.txt` 為準。四種都
**永不自動合併**（`NO_AUTOMERGE_TASK_TYPES`）。

## 2. 前置條件

1. **GitHub App `softwarefactory-bot` 已安裝在目標 repo**（ADR-029 §6：驗證類只要求這一項；
   不需要 `software-factory` 分支、`catalog-info.yaml`、`.github/factory/risk-paths.yml`）。
2. **機制 repo（`aswf-dev/software_factory`）設有 secret `VERIFY_AGE_PUBLIC_KEY`**
   （age X25519 公鑰，`age1…`）。缺它時 `Encrypt verify artifacts (age)` 直接失敗，
   **不會**回退成明文上傳（fail closed）——那次 run 沒有任何 artifact。
   私鑰（`AGE-SECRET-KEY-1…`）只存在 aswf.dev Worker（`VERIFY_AGE_PRIVATE_KEY`）；
   本機解密需要同一把私鑰或另一組測試用 keypair（`age-keygen -o key.txt`，
   把印出的 public key 設成 secret）。
3. **目標 repo 有一張標準工廠表單格式的 Issue**（§3.1）。驗證類**沒有**格式檢查豁免：
   `Check issue format (central enforcement)` 對每次 dispatch 執行 `factory-issue-check`，
   缺 `### 任務類型`、`### 需求描述（PRD）` 或 DoD 三個勾選項任一即紅燈停派。PRD **只寫**
   repository、範圍 glob 與階段——**不寫**缺陷線索、規格內容或任何發現（ADR-029 §5）。
4. 機制 repo 的 LLM 金鑰 secrets（與一般工作項相同）。
5. **要帶階段輸入時（§3.3）**：機制 repo 設有 secret `VERIFY_RUNNER_AGE_IDENTITY`（runner
   私鑰，`AGE-SECRET-KEY-1…`）。這是**另一組** keypair：公鑰交給 aswf.dev Worker（var
   `VERIFY_RUNNER_AGE_RECIPIENT`）加密輸入，與 `VERIFY_AGE_PUBLIC_KEY`／
   `VERIFY_AGE_PRIVATE_KEY`（加密產出）分離——runner 私鑰外洩只影響進 runner 的輸入。
   有 URL 卻缺這個 secret 時 `Restore verify stage input (age)` 直接失敗（fail closed）。

## 3. 開 Issue 與手動 dispatch

### 3.1 Issue 格式

形狀與 `.github/ISSUE_TEMPLATE/factory-work-item.yml` 表單輸出、`buildIssueBody`
（`src/factory-draft/issue-body.ts`，aswf.dev 開單用同一形狀）相同：

- `### 任務類型`：本階段的 `agent-verify-*`。
- `### 需求描述（PRD）`：只有 repository、範圍 glob、階段。檢查器對驗證類只要求非空
  （另有一條：PRD 不得要求變更 PBT 測試檔）；下面的鍵名只是慣例，不被解析。
- `### 驗收標準（DoD）`：三項以 `- [x] <label>` 逐字勾選（label 與 `DOD_LABELS` 同源，
  少一項或改一個字都判 `acceptance` 缺失）。
- 其餘欄位：`目標 repo` 填 `<owner>/<name>`；`規格名稱`／`規格來源`／`前置工作項` 填
  `_No response_`（檢查器視為未填）。

範例（存成 `verify-issue.md`；`agent-verify-lean` 的 statements／proofs 由 dispatch 的
`verify_phase` 決定，不寫進 Issue）：

```markdown
### 任務類型

agent-verify-quint

### 需求描述（PRD）

repository：<owner>/<name>
範圍：
- `src/billing/**`
- `src/ledger/**`
階段：agent-verify-quint

### 驗收標準（DoD）

- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）
- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）
- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）

### 目標 repo（預設本 repo）

<owner>/<name>

### 規格名稱

_No response_

### 規格來源

_No response_

### 前置工作項（可留空）

_No response_
```

```bash
gh issue create -R <owner>/<name> \
  --title "[factory] 形式化驗證 agent-verify-quint" \
  --body-file verify-issue.md
```

標題同樣公開，只寫階段。驗證模式不貼格式卡：合規時不留言，不合規時只貼一行無內容
needs-human 狀態（§6）並停派。run log 也**看不到完整格式卡**——驗證模式只印一行
`issue format: ok=<true|false> missing=<逗號分隔的欄位 id>` 摘要（
`factory-issue-check --summary-out` 的機械可讀輸出）；完整卡片只留在 runner 的
`.factory/issue-check.txt`，不進 artifact、也不在加密 bundle 的機制檔清單內，run 結束
即消失。要診斷缺哪個欄位，看 run log 的 `missing=`（固定列舉的欄位 id）。
驗證模式不讀計分，模型 tier 與 agent 逾時預算由 Issue 文字的複雜度分析決定
（`Select model tier`）：PRD 含 `quint` 之類工具字樣即判 heavy-verify（critical tier、
逾時放寬，`src/issue-analysis/complexity.ts`）；要固定時 dispatch 加 `-f model_tier=…`。

### 3.2 dispatch

`base_branch` 必須是**目標 repo 的預設分支**（過渡期也接受 `software-factory`）；
其他值會被 guard（`factory-verify-mode`）擋下。

```bash
# ① grill／② quint／④ tests
gh workflow run factory-run.yml -R aswf-dev/software_factory \
  -f repo=<owner>/<name> -f issue_number=<N> \
  -f task_type=agent-verify-quint -f base_branch=<預設分支>

# ③ Lean：先 statements，G3 簽核後再 proofs
gh workflow run factory-run.yml -R aswf-dev/software_factory \
  -f repo=<owner>/<name> -f issue_number=<N> \
  -f task_type=agent-verify-lean -f base_branch=<預設分支> -f verify_phase=statements
gh workflow run factory-run.yml -R aswf-dev/software_factory \
  -f repo=<owner>/<name> -f issue_number=<N> \
  -f task_type=agent-verify-lean -f base_branch=<預設分支> -f verify_phase=proofs
```

- `task_type`：`auto` 會從 Issue 的 `### 任務類型` 解析（`Resolve task_type`）。顯式指定
  時請與 Issue 相同——不同時以 dispatch 為準、只留一則 `::notice::`，Issue 宣告的階段就與
  實際執行不符。
- N-version 預設開啟（兩個變體 `a`／`b`，各自一份密文 bundle）；只要一份時加
  `-f nversion=false`。
- `agent-verify-lean` 的 run 會另外安裝 Lean（見 §6）；其他三種不裝。
- 解析出的 task type（含 `auto` 從 Issue 解析的值）在 `Validate resolved task_type
  (allowlist)` 以 dispatch 的 12 個選項逐字比對，未知值直接停止（ruling R12）。

### 3.3 階段輸入（`verify_input_url`）

第 ② 階段之後的 run 需要前面階段的產出（G1 確認的 `specs/quint/RULES.md`、G2 的
`specs/quint/TRIAGE.md`、上一階段的 `specs/**`）。aswf.dev 把它們以 **runner 公鑰**加密成
與 §4 同格式的 bundle（只含 `kind: "target"` 行），dispatch 時以 URL 帶入：

```bash
gh workflow run factory-run.yml -R aswf-dev/software_factory \
  -f repo=<owner>/<name> -f issue_number=<N> \
  -f task_type=agent-verify-quint -f base_branch=<預設分支> \
  -f verify_input_url=https://aswf.dev/<bundle 路徑>
```

- dispatch input 是公開的：URL 不帶任何秘密，下載到的只是密文。
- 只在驗證模式還原；URL 必須是 `https://aswf.dev/…`（host 逐字比對，不接受 userinfo、
  port、子網域；不跟隨 redirect；上限 20 MB、120 秒）。
- 還原由 `factory-verify-input` 執行：只收 `kind: "target"`、路徑在驗證白名單或
  `specs/**` 內；任何 `mechanism` 行、絕對路徑、`..`、`.git`／`.factory`、
  `specs/**/.lake/build/**`、經 symlink 的寫入 → **整份拒絕、不寫任何檔**，run 停在
  agent 之前。空 bundle（零筆）同樣拒絕。已存在的檔案被覆寫。
- 還原成功後另寫 `.factory/verify-restored.json`
  （`{ "restored": [ { "path": "specs/…", "sha256": "<64 位 hex>" }, … ] }`，依 path
  排序；雜湊取自實際寫入的位元組）；檔案在 `target/` 外、不進加密 bundle、也不上傳
  artifact。crosscheck 以 `--restored-manifest .factory/verify-restored.json` 先從
  磁碟重算 sha256：只有**存在且雜湊相符**的還原路徑會從 agent 的實際 diff 扣除
  （否則每個串接階段都會被誤判 `diff-not-reported`）。
- 還原輸入是**唯讀**的：agent 改動或刪除任何還原檔案，crosscheck 產生
  `restored-input-modified`（hard mismatch，與 `diff-not-reported` 同級）並把該路徑
  留在 diff 裡。manifest 的雜湊只是「還原當時」的紀錄，crosscheck 一律重算、不信任
  檔案裡的數值；舊版 `{ "restored": ["specs/…"] }` 形狀直接拒絕（不自動升級）。
- run log 只印還原數量，不印路徑。

## 4. 產出：只有密文

每個變體一個 artifact `factory-run-<N>-<variant>`，內容**只有**三個檔案：

| 檔案 | 內容 |
|---|---|
| `verify-bundle.age` | age 密文；明文是 JSON lines |
| `steps.json` | 各步驟的 outcome 字串（agent／crosscheck／specverify／judge） |
| `session-diag.json` | session log 的無內容結構診斷（計數、長度、工具名） |

`target/.factory/run/` 明文、`issue.json`／`crosscheck.json`／`model.json` 等機制 JSON
都**不**以明文上傳，只在 bundle 內。

bundle 的範圍：`target/.factory/run/**`（排除 `gh-token`）、`target/specs/**`（排除
`.lake/build/`）、agent 改動或新增且落在白名單內的測試檔，以及
`$GITHUB_WORKSPACE/.factory` 下的機制 JSON（`issue.json`、`crosscheck.json`、`model.json`…）。
每行一個 JSON 物件，以 `kind` 標明來源（ruling R7）：

```json
{"kind":"target","path":"specs/lean/RULES.md","b64":"<原始位元組的 base64>"}
{"kind":"mechanism","path":"issue.json","b64":"<原始位元組的 base64>"}
```

`kind: "target"` 的 `path` 相對 `target/`；`kind: "mechanism"` 的 `path` 是機制檔名
（不帶任何前綴）。**來源只看 `kind`**，不要依路徑長相判斷。

`.factory/verify-restored.json`（階段輸入的還原清單）與 `target/` 的 `.lake/build/`
建置快取都**不在** bundle 內：前者是 runner 的工作檔，後者可由目標 repo 重建。

## 5. 本機解密與讀取

```bash
gh run download <run-id> -R aswf-dev/software_factory -n factory-run-<N>-a -D out-a
# upload-artifact 會去掉共同祖先 .factory/，三個檔案在 out-a/ 根目錄
age -d -i key.txt out-a/verify-bundle.age > out-a/bundle.jsonl

# 列出所有行的來源與路徑
jq -r '"\(.kind)\t\(.path)"' out-a/bundle.jsonl

# 讀單一 target 檔案／單一機制檔
jq -r 'select(.kind == "target" and .path == "specs/lean/RULES.md") | .b64' out-a/bundle.jsonl | base64 -d
jq -r 'select(.kind == "mechanism" and .path == "issue.json") | .b64' out-a/bundle.jsonl | base64 -d

# 全部還原：target 行到 out-a/target/，機制檔到 out-a/mechanism/（依 kind 分流）
restore() { # $1 = kind, $2 = 輸出目錄
  jq -c --arg k "$1" 'select(.kind == $k)' out-a/bundle.jsonl | while IFS= read -r line; do
    p=$(printf '%s' "$line" | jq -r .path)
    case "$p" in /*|..|../*|*/..|*/../*|'') echo "skip suspicious path: $p" >&2; continue ;; esac
    mkdir -p "$2/$(dirname "$p")"
    printf '%s' "$line" | jq -r .b64 | base64 -d > "$2/$p"
  done
}
restore target out-a/target
restore mechanism out-a/mechanism
```

`select(.kind == "target")`／`select(.kind == "mechanism")` 是唯一的分流依據；機制檔名
不帶前綴，兩類同名時也不會互相覆蓋（各自的輸出目錄）。

解出來的內容可能含未修補的缺陷——**不要**貼回 Issue、PR 或任何公開位置。

## 6. 與一般工作項的差異

| 項目 | 一般工作項 | 驗證類（`agent-verify-*`） |
|---|---|---|
| `base_branch` | 不得為 `main`（ADR-013），一律 `software-factory` | 目標 repo 預設分支（或過渡期 `software-factory`） |
| `catalog-info.yaml`／`risk-paths.yml` | 必需 | 不讀 |
| `Check issue format` | 執行，貼格式卡 | 執行（同一檢查器、無豁免）；不貼格式卡，不合規時貼一行狀態並停派 |
| 三軸計分（`Initial score`）、`Apply score labels` | 執行 | 跳過 |
| `factory-stage prereqs`（ADR-022） | 執行 | 跳過（階段順序由 aswf.dev 的 G1–G4 決定） |
| VARIANT_HEADER | 建 `factory/<N>-<v>-` 分支並開 PR | 整段替換：不建／不推分支、不開 PR、可本地 commit |
| crosscheck | 分支前綴、變體隔離、REQ 錨定 | `--verify-only`：工作區相對 base 的 diff 對白名單；有階段輸入時加 `--restored-manifest .factory/verify-restored.json`，先扣除還原的輸入（僅雜湊仍相符者；被改動／刪除 → `restored-input-modified`） |
| `Judge terminal state`、PR 標題／draft 正規化 | 執行 | 跳過 |
| compare job：終態、比對卡片、互指 PR、G1 守衛 | 執行 | 跳過 |
| `Push event to scoreboard` | 執行 | 跳過（事件帶 skillGap 自由文字與檔案清單） |
| artifact | 明文 `target/.factory/run/` 等 | 只有 §4 的三個檔案 |
| Issue 留言 | 格式卡、crosscheck 明細＋usage、逾時 handover＋usage、終態、比對卡片 | 一行無內容狀態（見下）；進入 agent 後失敗時另有 G2 cleanup 的通用 needs-human（§7 第 5 點） |
| Lean 工具鏈 | 不裝 | 只在 `agent-verify-lean` 安裝 |

**Issue 留言（ruling R6）**：驗證模式下會貼到 Issue 的只有 `factory-verify-status` 產生的
一行：

```
驗證階段 agent-verify-lean（statements）：needs-human — https://github.com/aswf-dev/software_factory/actions/runs/<id>
```

只有階段（lean 帶 phase）、結果字（`ok`／`needs-human`／`timeout`）與 run URL。會貼的
時機：格式檢查不合規（needs-human）、crosscheck 中止（needs-human）、agent 失敗（內層逾時
為 timeout，其餘 needs-human）。這一行不貼標籤；`needs-human` 標籤來自 G2 cleanup
（§7 第 5 點）。CLI 只收列舉值與固定形狀的 URL，任何自由文字都會被拒絕；
每一處 `gh issue comment` 的歸類由 `test/adversarial/verify-issue-comments.test.ts` 釘住。

**crosscheck 白名單**（`src/pipeline/verify-scope.ts`，crosscheck 與加密 bundle 共用）：

```
specs/**
**/*.test.*
**/*_test.go
**/tests/**
**/test/**
```

`dot` 只在 **`specs/**` 內**放寬，所以 `specs/lean/.gitignore`、`specs/lean/.lake/**` 合規。
`specs/` 以外的任何 `.`-開頭 segment 一律越界（即使路徑符合測試 glob 的字面形狀：
`.github/workflows/evil.test.yml`、`.github/tests/x.ts`、`.github/test/x.ts`、
`.github/factory/foo_test.go` 全部拒絕）；任何含 `.github` segment 的路徑也一律拒絕。
未列出的測試慣例（例如 `__tests__/` 下不含 `.test.` 的輔助檔、`*_spec.rb`）會被判
`verify-scope` 越界——目標 repo 的測試命名須落在上面五個 glob 內。

**不可變 diff 基準**（`--base-sha`，R19）：驗證 agent 可以在本地 `git commit`，而它就在
base 分支上；對分支名 `git diff <base>` 會在 commit 後變成空集合。workflow 在 agent
之前把 `git -C target rev-parse HEAD` 寫到 **`$GITHUB_WORKSPACE/.factory/base-sha`**
（`target/` 外，agent sandbox 寫不到），crosscheck 與 encrypt 皆以 `--base-sha <40-hex>`
使用該 commit 並忽略分支名；檔案缺失或 SHA 解析不到時 fail closed。

**clean-repo facts**（R25）：驗證模式的事實不再在 agent 工作樹裡推導。agent 之後由
`factory-verify-facts` 執行三個步驟：`git -C target archive <base-sha>`（archive
不跑 clean filter）解到 `$RUNNER_TEMP`、以 `rsync -a` 複製工作樹（排除 `.git`、
`.dsh`、`.agents`、`AGENTS.md`、`CLAUDE.md`；rsync 不讀 target 的 git config），
再在 `$RUNNER_TEMP` 的乾淨 repo 以顯式最小 config 重建 base／facts 並以
`git add -A -f` 產生 diff。輸出 `$GITHUB_WORKSPACE/.factory/verify-facts.json`
（target 外），crosscheck 與 encrypt 以 `--facts` 消費；兩者仍以 `--base-sha`
獨立驗證 `facts.baseSha`，不一致即 fail closed。target 的 clean filter／index
flags（assume-unchanged、skip-worktree）／ignore 檔因此不再被執行或相信。具
`--facts` 時 crosscheck 與 encrypt **不得**再對 target 跑任何 git 命令；缺 facts
檔或 `factory-verify-facts` 失敗時整個 run fail closed（不回退舊路徑）。舊的
`--verify-only` 無 facts 路徑只保留給相容性，workflow 永遠帶 facts。

**agent 的 token**（I3／R25）：驗證模式另 mint 一個唯讀 installation token
（contents／issues／metadata `read`），只有它寫進 `target/.factory/run/gh-token` 與
`target/.git/config`；寫入權限的 token 只留在 workflow 自己的留言／終態／crosscheck／
scoreboard 步驟。`Verify app token write access` 探針在驗證模式整個跳過。token
選擇是**顯式兩個分支**（`Resolve agent token` step）：驗證模式只取唯讀 token，
輸出為空即 `exit 1`——**沒有** `verify == true && read-only || write` 的回退；
非驗證模式取寫入 token。解析結果寫進 `$RUNNER_TEMP/agent-gh-token`（mode 600），
agent 與 `Write agent run env` 只從這個檔讀取（不經 step output——runner 會跳過
看起來含 secret 的 output），agent 步驟的 env 直接引用寫入 token 的運算式已移除；
缺檔同樣 fail closed。

**task template 與 skills**（I2／R25）：驗證模式**一律**用機制 repo 的
`.github/factory/task-template-verify-*.txt`；目標 repo 的同名模板不讀（否則受測者可以
授權自己 push／開 PR／寫發現）。agent 之前另把 `target/.dsh`（rank-100）、
`target/.agents`（rank-200）與 `AGENTS.md`／`CLAUDE.md` 全部移到
`$RUNNER_TEMP/away`（不還原；tracked 或 untracked 都移），避免目標 repo 覆寫機制端
的 SOP；`factory-verify-facts` 在 base 與 facts 兩側也排除同一批路徑，因此 tracked
`.dsh`／`.agents` 的刪除不會被誤判成驗證 agent 的越界變更。

**Lean 工具鏈**（ADR-029 §7）：`leanprover/lean4:v4.35.0`，只用 core。以下步驟只在
`agent-verify-lean` 執行，依序：

1. `Check target lean-toolchain pin`（安裝與 agent 之前）：目標 repo 已有
   `target/specs/lean/lean-toolchain` 時，內容（去頭尾空白）必須等於
   `leanprover/lean4:v4.35.0`，否則紅燈停派；檔案不存在則通過（agent 依範本建立）。
2. `Restore Lean toolchain cache (elan)`：只還原 `~/.elan`，key 固定為
   `lean-elan-${{ runner.os }}-leanprover/lean4:v4.35.0`，**沒有 restore-keys**。
3. `Install Lean toolchain (elan)`：miss 時下載固定版本（`ELAN_VERSION`）的 release asset，
   先驗 `ELAN_SHA256` 才執行 `elan-init`。hit 時快取內容沒有經過 SHA-256，改驗
   `~/.elan/bin/elan` 存在且 `elan --version` 自報為 `ELAN_VERSION`，不符即 fail closed
   （不默默改走下載）。之後 `~/.elan/bin` 經 `$GITHUB_PATH` 交給 agent，並檢查
   `lean --version` 含 `version 4.35.0`。
4. `Check Lean toolchain complete (verify only)`：只檢查 `~/.elan/bin/lean` 存在且可
   執行（部分安裝不得進快取）。此步失敗只跳過存檔，**不讓 run 失敗**。
5. `Save Lean toolchain cache (elan)`：只在 miss、安裝成功且上一步檢查通過時、**agent
   之前**存 `~/.elan`。agent 有 shell，跑完後的 `~/.elan` 不寫回（下一個 run 會執行它）；
   也因此不用合併版 `actions/cache`（它的 post-job save 在 agent 之後）。存檔是
   **best-effort**：條件以 `success()` 開頭、另加 `continue-on-error: true`；並行 run
   共用固定 key 的存檔衝突只留 warning，**不得讓 run 失敗**。

`target/` 底下**一律不快取**（`.lake/build`、`.lake/packages` 都不）：key 對所有目標 repo
相同，快取 target 產物等於把 A repo 的產物（olean 帶定理名與敘述）還原到 B repo 的
runner——跨租戶外洩；而公開 repo 的 Actions cache 對同 repo 的其他 workflow 可讀，fork 發起
的 PR workflow 也讀得到 base 分支的快取。core-only 的 Lean 沒有 Lake 套件可快取，
`.lake/build` 重建只要數秒。

**Quint 快取**：`Restore Quint toolchain` 在所有模式無條件還原 `~/.quint`；
`Save Quint toolchain` 只在 `verify == 'false'` 時執行——驗證模式**永不存檔**（guard 沒有
輸出時也不存）。存檔同樣是 **best-effort**（`success()` 開頭＋`continue-on-error: true`）：
失敗只留 warning，**不得讓 run 失敗**（對非驗證 task，快取只是優化）。

**已知殘留**：`actions/setup-node` 的 `cache: pnpm`（pnpm store，key 依機制 repo 的
`pnpm-lock.yaml`）仍是合併版快取，post-job save 在 agent 之後執行，所有模式（含驗證模式）
都一樣；只有 key 未精確命中時才會真的寫入。

## 7. 已知限制

1. **agent 手上只有唯讀憑證**（2026-10-28 修正）：驗證模式另發一把唯讀 installation token
   （`contents: read`、`issues: read`、`metadata: read`）寫進 `target/.factory/run/gh-token`
   與 origin URL；帶寫入權限的 token 只留在 workflow 自己的步驟（留言、label、crosscheck、
   terminal）。`actions/checkout` 對目標 repo 設 `persist-credentials: false`，且 agent 之前
   會刪除 `$RUNNER_TEMP` 下所有 `git-credentials-*`，避免寫入 token 留在 agent 可讀的位置；
   `Verify app token write access` 探針在驗證模式跳過。
   因此 agent 技術上無法 push、無法留言到 Issue、無法開 PR——這是機械保證，不再只靠 prompt。
   仍須人工注意的殘留：
   - crosscheck `--verify-only` 只比對本地工作區相對不可變 base SHA（`--base-sha`）的 diff，
     事實來源是 `factory-verify-facts` 在 clean repo 重建的 JSON（不含遠端）；`git
     archive` 仍會套用 base commit 內的 `export-subst` 屬性（只影響 base 內容、不執行
     任何程式），這是本設計接受的最小殘留；
   - 目標 repo 的內容（含其 `.github/**`、`.dsh/**`）在驗證模式已被忽略或隔離，但 agent 仍會
     讀到目標 repo 的程式碼，prompt injection 的防線是「模板只來自機制 repo」加上 crosscheck
     與人工審查。
2. **G3 未被機械強制**：`verify_phase=proofs` 只是 dispatch input，工廠不檢查 statements
   是否已經 G3 簽核；順序由 aswf.dev 的 BPMN 保證。
3. **階段交接是「帶入」而非自動延續**（§3.3）：每個階段仍從目標 repo 預設分支的
   checkout 開始；上一階段的 `specs/**` 由 aswf.dev 以 runner 公鑰加密成 bundle，
   dispatch 時以 `verify_input_url` 帶入，`factory-verify-input` 在 agent 之前還原
   （只收 `kind: "target"`；路徑或 symlink 檢查任一不合即整份拒絕、不寫任何檔）。
   crosscheck 另以 `--restored-manifest .factory/verify-restored.json` 扣除還原輸入：
   只有存在且 sha256 仍相符的路徑會被當成「不是 agent 的改動」；被改動或刪除會變成
   `restored-input-modified`。沒帶 `verify_input_url` 的 run 不會自動取得上一階段
   產出——③／④ 需要的 `RULES.md`／Quint 模型仍須先進目標 repo 的預設分支。
4. **公開 log 仍可能有 Issue 衍生內容（僅非驗證模式）**：非驗證模式的
   `Check issue format` 會把格式卡 `cat` 進 log，`Select model tier` 會 `cat
   .factory/model.json`（含 Issue 文字衍生的複雜度判據）。驗證模式已收斂：格式檢查只印
   `ok`／缺少的 DoD id，模型只印 tier id，agent 失敗只印 provider／stop reason／attempt；
   **不印**格式卡、`model.json`、issue body 或 agent stderr。注意：目標 repo 若是 private，
   Issue 本身不公開，但機制 repo 的 run log 是公開的——「Issue 不公開」不是把內容寫進
   log 的理由；這些內容也不含 agent 產出，crosscheck 在驗證模式只印計數與列舉標題。
5. **G2（`factory-run-cleanup.yml`）一定會補一則通用 needs-human**：Factory Run 結論為
   failure／cancelled／timed_out，且 jobs API 中 `Run factory agent` 不是 skipped（已進入
   agent）時，cleanup 查 Issue 有沒有 `<!-- factory:terminal run=<id> -->`；沒有就先貼
   `needs-human` 標籤、再留言（帶該標記）。驗證模式**從不**寫這個標記（compare job 的
   `Write terminal state` 與 G1 守衛都跳過），所以任何進入 agent 後才失敗的驗證 run 都會
   得到這則留言與標籤。內容是固定文字（run id＋「逾時或取消——agent 已啟動但未留下終態
   判定」），不含發現；措辭一律寫「逾時或取消」，即使實際原因是 crosscheck。結果：
   - crosscheck 中止或 agent 失敗：每個失敗變體一行 `factory-verify-status` 狀態＋整個 run
     一則 cleanup 留言——同一次失敗至少兩則無內容留言；
   - agent 之後的其他失敗（例如缺 `VERIFY_AGE_PUBLIC_KEY`，`Encrypt verify artifacts (age)`
     失敗）：只有 cleanup 那一則；
   - agent 之前就停下（guard、格式檢查、lean-toolchain pin）：cleanup 不處理。

   cleanup 由 `workflow_run` 觸發，只有它位於機制 repo 的預設分支（main）時才生效。
6. **compare job 的驗證判定在 matrix 部分失敗時可能失準**：取 run job 的 matrix
   output；若 run job 在 guard 之前就失敗，output 為空，compare 走一般路徑——此時
   沒有變體啟動 agent，不會寫終態。但 matrix 部分失敗（例如一個變體失敗、job output
   沒有寫出）也可能讓 `verify` 為空：`needs.run.outputs.verify != 'true'` 成立，compare
   仍以「非驗證」處理並補一則通用 needs-human，即使另一個變體其實已進入 agent。判讀時
   以 run 的 jobs 清單與 cleanup 留言交叉確認，不要把「沒有終態」當成「沒啟動」。

7. **部分錯誤訊息仍可能帶絕對路徑**：`factory-verify-encrypt` 的檔案系統呼叫
   （`readdir`／`lstat`／`readFile`／`realpath`）都經 `fsFailure` 轉成相對路徑＋errno；
   `factory-crosscheck` 則**沒有**逐一包裝每個 `readFileSync`（report、`--pr-bodies`、
   `--source-snapshot` 等），這類錯誤由共用的 `formatCliError` 印出 Node 原始的
   `err.path`／`err.message`。workflow 呼叫 crosscheck 時傳的都是相對路徑（`--target
   target`、`target/.factory/run/report.json`、`--restored-manifest
   .factory/verify-restored.json`），所以實務上不會出現 runner 的絕對路徑；只有直接以
   絕對路徑呼叫 CLI 時才可能。`git ls-files`／`git status` 等指令本身的失敗訊息仍可能含
   runner 上的絕對路徑。這是已知殘留（只影響錯誤訊息，不含檔案內容），V3 會把 verify 類
   CLI 的錯誤輸出統一改成相對路徑。
