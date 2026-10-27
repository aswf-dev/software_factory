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
3. **目標 repo 有一張 Issue**，body 只寫範圍與階段，**不寫任何發現**（ADR-029 §5）。
   集中式格式檢查（`Check issue format`）仍會執行；不合規時停派。
4. 機制 repo 的 LLM 金鑰 secrets（與一般工作項相同）。

## 3. 手動 dispatch

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

- `task_type` 請顯式指定：`auto` 依 Issue 宣告解析，但驗證類的 Issue 未必有工廠表單的
  任務類型欄位。
- N-version 預設開啟（兩個變體 `a`／`b`，各自一份密文 bundle）；只要一份時加
  `-f nversion=false`。
- `agent-verify-lean` 的 run 會另外安裝 Lean（見 §6）；其他三種不裝。

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
`.lake/build/`）、agent 改動或新增且落在白名單內的測試檔，以及 `mechanism/<name>`
（`$GITHUB_WORKSPACE/.factory` 下的機制 JSON）。每行格式：

```json
{"path":"specs/lean/RULES.md","b64":"<原始位元組的 base64>"}
```

`path` 是相對 `target/` 的路徑（機制檔是 `mechanism/<name>`）。Task 6 會再加一個
結構欄位 `kind`（`target`／`mechanism`，ruling R7），讀取端不要假設只有這兩個欄位。

## 5. 本機解密與讀取

```bash
gh run download <run-id> -R aswf-dev/software_factory -n factory-run-<N>-a -D out-a
# upload-artifact 會去掉共同祖先 .factory/，三個檔案在 out-a/ 根目錄
age -d -i key.txt out-a/verify-bundle.age > out-a/bundle.jsonl

# 列出所有路徑
jq -r .path out-a/bundle.jsonl

# 讀單一檔案
jq -r 'select(.path == "specs/lean/RULES.md") | .b64' out-a/bundle.jsonl | base64 -d

# 全部還原到 out-a/files/（mechanism/* 也會落在 out-a/files/mechanism/）
jq -c . out-a/bundle.jsonl | while IFS= read -r line; do
  p=$(printf '%s' "$line" | jq -r .path)
  case "$p" in /*|*..*) echo "skip suspicious path: $p" >&2; continue ;; esac
  mkdir -p "out-a/files/$(dirname "$p")"
  printf '%s' "$line" | jq -r .b64 | base64 -d > "out-a/files/$p"
done
```

解出來的內容可能含未修補的缺陷——**不要**貼回 Issue、PR 或任何公開位置。

## 6. 與一般工作項的差異

| 項目 | 一般工作項 | 驗證類（`agent-verify-*`） |
|---|---|---|
| `base_branch` | 不得為 `main`（ADR-013），一律 `software-factory` | 目標 repo 預設分支（或過渡期 `software-factory`） |
| `catalog-info.yaml`／`risk-paths.yml` | 必需 | 不讀 |
| 三軸計分（`Initial score`）、`Apply score labels` | 執行 | 跳過 |
| `factory-stage prereqs`（ADR-022） | 執行 | 跳過（階段順序由 aswf.dev 的 G1–G4 決定） |
| VARIANT_HEADER | 建 `factory/<N>-<v>-` 分支並開 PR | 整段替換：不建／不推分支、不開 PR、可本地 commit |
| crosscheck | 分支前綴、變體隔離、REQ 錨定 | `--verify-only`：工作區相對 base 的 diff 對白名單 |
| `Judge terminal state`、PR 標題／draft 正規化 | 執行 | 跳過 |
| compare job：終態、比對卡片、互指 PR、G1 守衛 | 執行 | 跳過 |
| `Push event to scoreboard` | 執行 | 跳過（事件帶 skillGap 自由文字與檔案清單） |
| artifact | 明文 `target/.factory/run/` 等 | 只有 §4 的三個檔案 |
| Issue 留言 | 格式卡、crosscheck 明細＋usage、逾時 handover＋usage、終態、比對卡片 | 只有一行無內容狀態（見下） |
| Lean 工具鏈 | 不裝 | 只在 `agent-verify-lean` 安裝 |

**Issue 留言（ruling R6）**：驗證模式下會貼到 Issue 的只有 `factory-verify-status` 產生的
一行：

```
驗證階段 agent-verify-lean（statements）：needs-human — https://github.com/aswf-dev/software_factory/actions/runs/<id>
```

只有階段（lean 帶 phase）、結果字（`ok`／`needs-human`／`timeout`）與 run URL。會貼的
時機：格式檢查不合規（needs-human）、crosscheck 中止（needs-human）、agent 失敗（內層逾時
為 timeout，其餘 needs-human）。CLI 只收列舉值與固定形狀的 URL，任何自由文字都會被拒絕；
每一處 `gh issue comment` 的歸類由 `test/adversarial/verify-issue-comments.test.ts` 釘住。

**crosscheck 白名單**（`src/pipeline/verify-scope.ts`，crosscheck 與加密 bundle 共用）：

```
specs/**
**/*.test.*
**/*_test.go
**/tests/**
**/test/**
```

`dot: true`，所以 `specs/lean/.gitignore`、`specs/lean/.lake/**` 合規；`specs/` 以外的
隱藏路徑（`.github/**`、根目錄 `.gitignore`）仍越界。未列出的測試慣例（例如
`__tests__/` 下不含 `.test.` 的輔助檔、`*_spec.rb`）會被判 `verify-scope` 越界——目標 repo
的測試命名須落在上面五個 glob 內。

**Lean 工具鏈**（ADR-029 §7）：`leanprover/lean4:v4.35.0`，只用 core。elan 以固定版本
（`ELAN_VERSION`）的 release asset 下載、先驗 `ELAN_SHA256` 才執行，`~/.elan/bin` 經
`$GITHUB_PATH` 交給 agent。快取 `~/.elan` 與 `target/specs/lean/.lake/packages`，key 為
`lean-<os>-<toolchain>-<hashFiles(target/specs/lean/lake-manifest.json)>`，fallback 只到
toolchain。**不快取 `.lake/build`**：那是使用者 specs 的編譯產物，而 key 對所有目標 repo
相同，快取它會把 A repo 的產物還原到 B repo 的 runner；公開 repo 的 Actions cache 對同 repo
的其他 workflow 可讀。core-only 時重建只要數秒。

## 7. 已知限制

1. **不 push 只靠 prompt＋crosscheck**：agent 仍拿到有 `contents: write` 的 App token
   （`target/.factory/run/gh-token` 與 origin URL），`Verify app token write access` 探針也
   照常推送再刪除一個 `_factory-auth-probe-*` 分支。agent 若違規 push，crosscheck 不會知道
   遠端狀態——機械阻止需在驗證模式移除寫入憑證，留待後續。
2. **G3 未被機械強制**：`verify_phase=proofs` 只是 dispatch input，工廠不檢查 statements
   是否已經 G3 簽核；順序由 aswf.dev 的 BPMN 保證。
3. **階段之間沒有交接（Task 6）**：V2 的每個階段都從目標 repo 預設分支的 checkout 開始，
   看不到上一階段 bundle 的內容。Task 6 會加入 `verify_input_bundle` input 與解包 CLI；
   在那之前，③／④ 需要的 `RULES.md`／Quint 模型必須已在目標 repo 的預設分支上。
4. **公開 log 仍有少量 Issue 衍生內容**：`Check issue format` 會把格式卡 `cat` 進 log，
   `Select model tier` 會 `cat .factory/model.json`（含 Issue 文字的複雜度判據）。這些只來自
   Issue body（本就公開且只寫範圍），不含 agent 產出；crosscheck 在驗證模式只印計數與
   列舉標題。
5. **G2（`factory-run-cleanup.yml`）**：失敗／取消的驗證 run 若沒有終態標記，G2 仍可能貼
   一則通用 needs-human（不含發現）。
6. **compare job 的驗證判定**：取 run job 的 matrix output；若 run job 在 guard 之前就失敗，
   output 為空，compare 走一般路徑——此時沒有變體啟動 agent，不會寫終態。
