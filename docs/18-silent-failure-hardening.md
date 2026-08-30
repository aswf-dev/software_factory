# 18 — Silent Failure 補強（Hermes Labs 對照審計與落地）

> **依據**：2026-08 對照 [Hermes Labs: Silent AI Failure](https://hermes-labs.ai/topics/silent-ai-failure)
> 的審計（Silent AI Failure = 產出看似可用，但證據/推理/指令/檢索路徑/任務完成度上的
> 重大問題沒有進入輸出或控制流）。本文記錄審計結論與已落地的補強（G1–G3），以及
> 尚未實作的建議（G4–G8）。
> **讀者**：審查 factory PR 的人、維護 guardrail 的平台工程師。

---

## 1. 審計結論（摘要）

工廠的「pipeline 內部」對文章建議的對齊度極高（`taskVerified: false`、SR1–SR8 決定性
閘門、單向棘輪、拒絕 agent 自評、第 1 期人類終審），但審計發現**三個實際的靜默路徑**：

| 編號 | 靜默路徑 | 位置（修改前） | 狀態 |
|---|---|---|---|
| **G1** | agent 成功但 judge/apply-labels 步驟 crash（如 report 格式錯、gh API 錯）→ Issue 無 needs-human、無終態留言，最後一則輸出還印「執行完成」 | `factory-run.yml` 只有 agent-failure 的 handler，沒有 judge-failure 的 handler | ✅ 已修 |
| **G2** | job 級 `timeout-minutes` 或取消會**直接終止 job**，job 內任何 step（含 `always()`）都不會執行 → Issue 停留在無終態狀態 | 無任何機制 | ✅ 已修 |
| **G3** | report.json 是 agent 自報；judge 的 zod 只驗證形狀、不驗證真實性——`changedPaths`/`changedLines` 造假或漏報不會被發現（SR6/SR4/重計分都建立在錯誤輸入上） | `factory-judge` 無交叉驗證 | ✅ 已修 |

未實作（P2，見 §4）：G4 紅燈證據未留存、G5 DoD 表單形式檢查、G6 無獨立測試重跑
step、G8 report 無 requirement→status evidence slot。

---

## 2. 已落地的補強

### 2.1 G1 — 終態守衛（Ensure terminal state）

**位置**：`.github/workflows/factory-run.yml`。

在 `Apply judge labels and comment` 之後新增守衛 step：

```yaml
if: always() && job.status != 'success' && steps.agent.outcome != 'skipped'
```

- agent **未啟動**（guard/issue-check/score 紅燈）→ 守衛不動作（那些失敗各有自己的大聲訊號）。
- agent 已啟動但 job 失敗（judge/apply-labels crash 等）→ 檢查 Issue 留言是否含本 run 的
  run id；無則補 `needs-human` 標籤 + 留言。
- **不重複貼**：所有終態留言（timeout handler / crosscheck / 守衛）都內含
  `github.run_id`，grep 到即代表已有交還紀錄。

同時修正 `Summary` step：不再在失敗 run 上印「工廠執行完成」，改依 `job.status` 輸出
不同訊息（`JOB_STATUS: ${{ job.status }}` 傳入）。

### 2.2 G2 — job 級逾時/取消的 cleanup workflow

**位置**：`.github/workflows/factory-run-cleanup.yml`（新檔）。

GitHub Actions 的 job timeout 與取消會終止整個 job——job 內無法自救，只能由**外部**
workflow 監看。本 workflow 以 `workflow_run` 監看 `Factory Run` 的完成事件，四條件
全成立才補 `needs-human`：

1. run 結論 ∈ {failure, cancelled, timed_out}；
2. 由 `run-name`（`Factory Run (<repo> #<issue>)`）解析出目標 repo 與 issue；
3. 該 run 已進入 agent 階段（jobs API 中「Run factory agent」step 出現）——agent
   啟動前的失敗不誤貼；
4. Issue 上無含該 run id 的終態留言。

> ⚠️ `workflow_run` 觸發要求本 workflow 位於 **default branch（main）**；合併路徑
> （ADR-013）software-factory → main 時本檔案隨之同步，監看才生效。

### 2.3 G3 — report 與實際 git diff 交叉驗證（factory-crosscheck）

**位置**：`src/cli/factory-crosscheck.ts`（新 CLI，100% branch 測試）、
`.github/workflows/factory-run.yml`（`Cross-check report vs git diff` step）。

資料來源全部為目標 repo checkout 內的**本地事實**（無網路依賴）：

- 本地分支 `factory/<issue>-*` 與 `factory/<issue>/*`（兩種命名都涵蓋，docs/07 §3.2）；
- 各分支相對 base 的三點 diff（`--name-only` / `--shortstat`）；
- 工作樹 `--porcelain`（成功執行後不應殘留未提交變更）。

mismatch 規則（雙向，任一觸發即 fail-loud → 貼 needs-human）：

| kind | 觸發條件 |
|---|---|
| `no-trace` | 宣稱變更但無分支、無 diff、無未提交變更（假完成） |
| `unreported-changes` | diff 有檔案但 report 未回報任何 changedPaths |
| `reported-not-in-diff` | 回報了未出現在實際 diff 的檔案 |
| `diff-not-reported` | 實際 diff 有未回報的檔案（隱藏變更） |
| `lines-missing` | diff 非空但 changedLines 缺席或為 0 |
| `lines-without-diff` | 宣稱有行數但 diff 為空 |
| `uncommitted-changes` | 工作樹仍有未提交變更 |

**接線順序**：agent 成功 → crosscheck →（成功才放行）judge → labels。crosscheck 失敗
時其自身貼 needs-human 並 exit 1，judge/apply-labels 因 `steps.crosscheck.outcome`
非 success/skipped 而跳過——**不讓可能造假的 report 產出看似正常的終點**。
dry_run 模式跳過 crosscheck（stub 不建分支）。

**不做**：changedLines 數值精確比對（agent 計數口徑可能不同，會誤傷）；PR 是否真的
推送（需網路；`factory-rescore` 已在 PR 層用真實 diff 獨立重計分，高風險隱藏變更仍
會被 PR 層攔截）。

---

## 3. 行為矩陣（修改後）

| 情境 | agent step | crosscheck | judge | 終態 |
|---|---|---|---|---|
| 正常完成、report 誠實 | success | success | success | 留言 + oversight/*（人類審查） |
| report 造假 / 漏報 | success | **failure**（貼 needs-human） | skipped | needs-human + 留言（含 mismatch 明細） |
| judge crash（report 格式錯等） | success | skipped/failure | failure | **守衛** 補 needs-human |
| agent 失敗 / step 逾時 | failure | skipped | skipped | timeout handler 補 needs-human |
| job 級逾時 / 取消 | （被終止） | — | — | **cleanup workflow** 補 needs-human |
| in-loop 阻斷 / guard 紅燈 | skipped | skipped | skipped | 既有大聲訊號（守衛與 cleanup 都不動作） |

---

## 4. 尚未實作（P2 建議，追蹤於此）

| 編號 | 缺口 | 建議 | 理由/風險 |
|---|---|---|---|
| **G4** | fix-bug 的「修復前紅燈」只在 agent 沙箱內驗證，`it.skip` 提交後無任何 artifact | 由 CI 在 01-test 層跑一次「skip 移除後應紅」的驗證（或在 report 增加 `redVerified` 欄位並在 crosscheck 驗證） | 紅燈是 TDD 的關鍵證據，absence 沒有成為 evidence |
| **G5** | DoD 檢查只驗證 checkbox 字面存在，內容可空洞 | issue-check 留言增加「DoD 是否具體可驗證」提示 | 形式檢查可被勾選空泛內容通過 |
| **G6** | 沒有獨立的「測試確實執行且通過」step，依賴 target repo 自身 PR CI | 在 crosscheck 之後加一步跑 target repo 測試命令（需 per-repo 測試命令設定） | 若 target repo 無 CI 覆蓋 factory 分支，「tests pass」只有 agent 自述 |
| **G8** | report.json 無 requirement→status 的 evidence slot（文章建議 #1） | report 增加 `requirements: [{id, status}]`，crosscheck 驗證 status 欄位完整性 | 把「每個要求一個明確狀態」結構化 |

---

## 5. 驗證

- `factory-crosscheck` 100% branch 覆蓋（`src/cli/**` 閘門，見 `src/cli/factory-crosscheck.test.ts`）。
- 兩個 workflow 以 js-yaml 解析驗證。
- CI 全綠：typecheck、unit/integration/adversarial/e2e、coverage（見 test.yml）。
- ⚠️ G1/G2/G3 的實機行為（真實 Actions 上的 gh/git 互動）尚未實跑驗證——dry-run
  E2E 只覆蓋 pipeline 層；建議在觀察期以一次真實 dispatch（或 dry_run + 故意壞 report）
  驗證守衛與 cleanup 的接線。
