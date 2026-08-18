# Software Factory Phase 2（擴大與治理）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1 打通的最窄路徑擴大成「多任務類型 × 多 repo」的穩定運作：≥3 種任務類型、二次判定（PR 事件重計分）、產出型指標自動化，並累積 ≥50 工作項樣本為第 3 期的自動合併決策提供數據。

**Architecture:** 沿用四平面（docs/02）——GitHub 為唯一事實來源；Backstage 已裁決**降級**（Q03-6/Q13-1，純 GitHub 觸發，工件凍結）。Phase 2 全部工作落在 GitHub + CI 層：擴充 `factory-run.yml`（task_type + repo 輸入）、新增 `factory-rescore.yml`（PR 事件觸發二次判定）、新增 `factory-metrics` CLI（產出型指標自動化）。判定邏輯全部重用 Phase 1 已 100% 測試的 `src/scoring`/`src/pipeline`/`src/stop-rules`。

**Tech Stack:** 同 Phase 1（TS strict / vitest / GitHub Actions / gh CLI / 多 provider DSH）；新增：無第三方依賴（指標 CLI 用 `gh` JSON + 既有 zod）。

---

## 執行狀態（2026-08-18 更新）

| Task | 狀態 | 合併 |
|---|---|---|
| T1 task_type 路由 + 三模板 | ✅ | PR #101（與 T2/T3 同 PR） |
| T2 skill 任務型別/命名/--draft 紀律 | ✅ | PR #101 |
| T3 factory-rescore 二次判定 | ✅ | PR #101 |
| T4 多 repo 支援 + base_branch Guard | ✅ | PR #102 |
| T5 factory-metrics CLI + 週檢腳本 | ✅ | PR #103 |
| T6 token 門檻 SR7 接線 | ✅ | PR #104 |
| T7 對抗性測試擴充 | ✅ | PR #105 |
| T8 fubon-tradingbot 試跑 | ⏳ **待人類步驟**（① 開 `software-factory` 分支 ② App 安裝 ③ catalog/risk-paths/skills） | — |
| T9 文件同步 | ✅ | 本 PR |

---

## 0. 範圍、前提與設計決策

### 0.1 範圍（docs/09 §3 工作項 2.1–2.8）

| 路線圖工作項 | 本計畫 Task | 性質 |
|---|---|---|
| 2.1 擴充至 agent-fix-bug / agent-update-deps / agent-write-docs | T1–T2 | 新建（task_type 路由 + skills）|
| 2.2 擴大至 2–3 個 repo | T4 | 新建（repo 輸入 + 多 repo 驗證）|
| 2.3 計分在高風險 repo 驗證 | T8 | 驗證 |
| 2.4 二次判定（PR 事件重計分）| T3 | 新建 |
| 2.5 OTel 指標後端 + 自動化產出型指標 | T5 | 新建（務實版：gh CLI + 月報；OTel 延後，docs/08 §7）|
| 2.6 token 中止門檻 | T6 | 新建（SR7 接線 + 基線後設定）|
| 2.7 TechDocs + Scoreboard | **調整**：Backstage 已降級 → Scoreboard 以 GitHub Insights + factory-metrics 報表替代 | T5、T9 |
| 2.8 第二次價值流工作坊 | T9（人類）| 驗證 |

### 0.2 設計決策（先讀）

1. **task_type 路由**：`factory-run.yml` 新增 `task_type` input（`agent-add-tests`（預設）/`agent-fix-bug`/`agent-update-deps`/`agent-write-docs`）。每型對應一個 task-template 檔（`.github/factory/task-template-<type>.txt`），skill 依型別分支。任務型別是**工作項的分類**，計分/停手規則不變。
2. **二次判定（Q06-5 第二部分）**：新增 `factory-rescore.yml`（`pull_request: opened/synchronize`，僅 `factory/*` 分支）→ `factory-rescore` CLI 讀 PR 變更檔 → 重計分 → 比較初始（Issue 上的 `oversight/*` 標籤）→ **單向升級** → 更新標籤/留言。重用 `rescore()`（docs/06 §5.3 已實作於 `src/scoring`）。
3. **多 repo**：`factory-run.yml` 新增 `repo` input（`owner/name`）。checkout 目標 repo；`catalog-info.yaml` 與 `risk-paths.yml` 從目標 repo 讀取；App token 依 repo 換發（App 需安裝於目標 repo）。計分 CLI 已接受路徑參數（`--catalog`/`--risk-paths`），僅需傳目標 repo 的檔。
4. **指標（務實版，docs/08 §7）**：`factory-metrics` CLI 讀 `gh` JSON（PR/Issue），計算：lead time、PR 大小、缺陷率（`defect/*` 標籤）、執行成功率。輸出 JSON + Markdown 月報。OTel/token-meter 延後（Q08-4 保持開放）。
5. **token 門檻（Q02-5/Q04-5）**：`report.json` 增加 `tokensUsed`/`tokenBudget` 欄位（agent 自報 + CI 設門檻），SR7 已有判定（`src/stop-rules`）——僅需接線 + 基線數據後設定實際值。
6. **Backstage 降級影響（2.7）**：Scoreboard 以 GitHub Insights + factory-metrics 月報替代；TechDocs 凍結（工件保留）。roadmap 2.7 改為「Scoreboard 以 GitHub Insights 替代」。
7. **試點 repo 選擇（2.2）——已裁決（Q-P2-1，2026-08-18）**：第二 repo 為 **`philipz/fubon-tradingbot`**（實碼庫、基線來源）。
   **⚠️ 安全約束（使用者裁決）**：**絕不觸碰 fubon-tradingbot 的 `main` 分支**——工廠 trunk 使用另開的 **`software-factory`** 分支：
   - 所有 factory 分支以 `software-factory` 為 base；PR 合併目標是 `software-factory`，**不是 main**；
   - 工廠對任何 repo 的唯一寫入：factory/* 功能分支 + PR + Issue 留言/標籤——**永不 push 到 main 或任何 base 分支**（人類合併）；
   - workflow 以 `base_branch` input 明確指定（fubon-tradingbot 為 `software-factory`），skill 明寫 `gh stack init --base $BASE_BRANCH`；
   - **防護**：對非試點 repo，`base_branch` 不得為 `main`（workflow 或對抗性測試強制）；App 無 admin 權限（無法改 fubon-tradingbot 的 main 保護，且 factory 本就不 push main）。
8. **命名/--draft 紀律（Q04-9）**：延續強化——新 task-type 的 skills 與 workflow 內建檢查（探針或報告驗證分支命名）。

### 0.3 檔案結構

| 檔案 | 職責 | Task |
|---|---|---|
| `.github/factory/task-template-fix-bug.txt` 等 3 檔 | 各任務型別的自足任務描述 | 1 |
| `.github/workflows/factory-run.yml` | **修改**：task_type + repo 輸入、依型別選模板 | 1,4 |
| `.dsh/skills/factory-workflow/SKILL.md` | **修改**：依 task_type 分支、命名/--draft 紀律強化 | 2 |
| `src/cli/factory-rescore.ts` + test | 二次判定 CLI（PR diff → 重計分 → 單向升級）| 3 |
| `.github/workflows/factory-rescore.yml` | PR 事件觸發的二次判定 workflow | 3 |
| `src/cli/factory-metrics.ts` + test | 產出型指標 CLI（gh JSON → 報表）| 5 |
| `scripts/weekly-metrics.sh` | 週檢/月檢一鍵指令 | 5 |
| `src/pipeline/run-work-item.ts` 等 | **修改**：report 契約加入 tokensUsed（SR7 接線）| 6 |
| `test/adversarial/factory-assets.test.ts` | **修改**：新增 task-type/rescore/metrics 資產斷言 | 7 |
| `docs/09-roadmap.md`、`docs/10-open-questions.md` | 文件同步 | 9 |

---

## Task 1: task_type 路由 + 各型別任務模板

**Files:**
- Create: `.github/factory/task-template-fix-bug.txt`、`.github/factory/task-template-update-deps.txt`、`.github/factory/task-template-write-docs.txt`
- Modify: `.github/workflows/factory-run.yml`（`task_type` input + 依型別選模板）

- [ ] **Step 1: 修改 workflow inputs**

在 `factory-run.yml` 的 `on.workflow_dispatch.inputs` 新增：

```yaml
      task_type:
        description: 任務類型（決定 task-template 與 skill 分支）
        required: false
        type: choice
        options: [agent-add-tests, agent-fix-bug, agent-update-deps, agent-write-docs]
        default: agent-add-tests
```

- [ ] **Step 2: agent 步驟依 task_type 選模板**

把 `"$(sed "s/<ISSUE>/${{ inputs.issue_number }}/" .github/factory/task-template.txt)"` 改為：

```bash
TEMPLATE=".github/factory/task-template-${TASK_TYPE}.txt"
[ -f "$TEMPLATE" ] || TEMPLATE=".github/factory/task-template.txt"
... "$(sed "s/<ISSUE>/${{ inputs.issue_number }}/" "$TEMPLATE")" ...
```

（`TASK_TYPE` 由 step env 帶入：`TASK_TYPE: ${{ inputs.task_type }}`。fallback 到預設模板。）

- [ ] **Step 3: 建立三個任務模板**

`.github/factory/task-template-fix-bug.txt`：

```
處理 GitHub Issue #<ISSUE>（repo: 目前 workspace 的 repo）。

1. 先載入並遵循 .dsh/skills/ 中的 factory-workflow 與 factory-stop-rules。
2. 若環境變數 GH_TOKEN 不存在，先執行：export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)
3. 讀取該 Issue 的內容與驗收條件；若缺可驗證的驗收條件，依 factory-stop-rules 停手。
4. 依 factory-pr-stacking 拆分：01-test（重現失敗的測試）→ 02-impl（修復）→ 03-docs。
5. 修復後確認新增測試在修復前紅燈、修復後綠燈。
6. 完成後在 Issue 留言回報 PR 編號，並依 factory-workflow 寫出 .factory/run/report.json。

若觸發任何停手規則，依該規則處理後結束。
```

`.github/factory/task-template-update-deps.txt`（注意：相依更新多為單一 PR——docs/07 §2.3「純機械式全域替換用單一 PR」）：

```
處理 GitHub Issue #<ISSUE>（repo: 目前 workspace 的 repo）。

1. 先載入並遵循 .dsh/skills/ 中的 factory-workflow 與 factory-stop-rules。
2. 若環境變數 GH_TOKEN 不存在，先執行：export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)
3. 讀取該 Issue：目標套件、目標版本、驗收條件。缺驗收條件依 factory-stop-rules 停手。
4. 此類任務通常是單一 PR（docs/07 §2.3：機械式全域替換不拆疊）——除非變更跨風險層級才拆。
5. 更新後執行測試確認無回歸；**未經人類核可不得新增未在鎖定清單的新套件**（SR5）。
6. 完成後在 Issue 留言回報 PR 編號，並依 factory-workflow 寫出 .factory/run/report.json。

若觸發任何停手規則，依該規則處理後結束。
```

`.github/factory/task-template-write-docs.txt`：

```
處理 GitHub Issue #<ISSUE>（repo: 目前 workspace 的 repo）。

1. 先載入並遵循 .dsh/skills/ 中的 factory-workflow 與 factory-stop-rules。
2. 若環境變數 GH_TOKEN 不存在，先執行：export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)
3. 讀取該 Issue：範圍與驗收條件。缺驗收條件依 factory-stop-rules 停手。
4. 依 factory-pr-stacking 拆分：01-docs 通常單層；若文件涉及多個獨立主題才拆。
5. 文件必須與實作一致（不得描述不存在的行為）；繁體中文（repo 語言慣例）。
6. 完成後在 Issue 留言回報 PR 編號，並依 factory-workflow 寫出 .factory/run/report.json。

若觸發任何停手規則，依該規則處理後結束。
```

- [ ] **Step 4: 對抗性測試**（T7 一併加，先在此寫紅）

`test/adversarial/factory-assets.test.ts` 新增：三個 task-template 檔存在且含 `<ISSUE>`；`factory-run.yml` 含 `task_type` 與 fallback 邏輯（grep `task-template-${TASK_TYPE}`）。

- [ ] **Step 5: Commit**

```bash
git add .github/factory/task-template-*.txt .github/workflows/factory-run.yml
git commit -m "feat(ci): task-type routing with per-type task templates"
```

---

## Task 2: factory-workflow skill 依任務型別分支

**Files:**
- Modify: `.dsh/skills/factory-workflow/SKILL.md`

- [ ] **Step 1: skill 加入型別分支**

在「## 步驟」後新增：

```markdown
## 任務型別

任務描述會指明型別（agent-add-tests / agent-fix-bug / agent-update-deps / agent-write-docs）。依型別調整：

- **agent-add-tests**：01-test 層是主體；若既有測試已充分覆蓋，依 factory-stop-rules 誠實停手（不為交差而製造無意義測試）。
- **agent-fix-bug**：先寫「重現失敗」的測試（紅），再實作修復（綠）。不刪除/弱化既有斷言。
- **agent-update-deps**：通常是單一 PR（docs/07 §2.3）；不得未經核可新增未鎖定的新套件（SR5）；更新後全量測試。
- **agent-write-docs**：文件與實作一致；繁體中文；單層 PR 為主。
```

- [ ] **Step 2: 強化命名/--draft 紀律**

在「## 原則」追加（對照 Q04-9 與觀察期發現）：

```markdown
- **分支命名**：`gh stack init --prefix "factory/<issue編號>" --numbered` 產生的格式（`factory/<issue>-<nn>-<layer>`）為唯一允許；不得自行命名。
- **PR 一律非 draft**：`gh stack submit --auto` 或 `gh pr create` 皆不可加 `--draft`（draft 無法合併，擋住審查流程）。
```

- [ ] **Step 3: 對抗性測試**（T7 一併）：skill 含「任務型別」與「不可加 `--draft`」字樣。

- [ ] **Step 4: Commit**

```bash
git add .dsh/skills/factory-workflow/SKILL.md
git commit -m "feat(skills): task-type branching and naming/draft discipline"
```

---

## Task 3: 二次判定（factory-rescore CLI + PR 事件 workflow）

**Files:**
- Create: `src/cli/factory-rescore.ts` + `src/cli/factory-rescore.test.ts`
- Create: `.github/workflows/factory-rescore.yml`

背景（Q06-5 第二部分）：Phase 1 的 `factory-judge` 在**單次 run 內**做 run 後重計分（Gate 3）；Phase 2 增加 **PR 事件觸發**的二次判定——PR 更新時獨立重計分，攔截「描述低風險但實際改高風險」的升級（docs/06 §5.3 的單向升級）。

- [ ] **Step 1: 寫失敗測試 `src/cli/factory-rescore.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildRescoreComment } from './factory-rescore.js'

describe('buildRescoreComment', () => {
  it('升級時列出觸發的硬性規則並警告', () => {
    const c = buildRescoreComment({ before: 'oversight/on-loop', after: 'oversight/review', triggeredHardRules: ['H1'] })
    expect(c).toContain('oversight/on-loop')
    expect(c).toContain('oversight/review')
    expect(c).toContain('H1')
    expect(c).toContain('升級')
  })
  it('未升級時不警告', () => {
    const c = buildRescoreComment({ before: 'oversight/review', after: 'oversight/review', triggeredHardRules: [] })
    expect(c).not.toContain('升級')
  })
})
```

- [ ] **Step 2: 實作 `src/cli/factory-rescore.ts`**

```ts
/**
 * factory-rescore — PR 事件觸發的二次判定（docs/06 §5.3, Q06-5）。
 *
 * 輸入：PR 的 changed paths（`gh pr view <n> --json files`）+ catalog + risk-paths。
 * 流程：score({ changedPaths }) → 與 Issue 上的初始標籤比較 → 單向升級（rescore）。
 * 輸出：判定 JSON + 留言內容。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { rescore, score } from '../scoring/score.js'
import { loadScoreInput } from './factory-score.js'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

const FileSchema = z.array(z.object({ path: z.string() }))

export interface RescoreInput {
  prNumber: number
  catalogPath: string
  riskPathsPath: string
  changedPaths: string[]
}

export interface RescoreOutput {
  before: string
  after: string
  triggeredHardRules: string[]
  escalated: boolean
}

/** 從 `gh pr view <n> --json files` 讀變更檔。 */
export function getChangedPaths(prNumber: number): string[] {
  const json = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'files'], { encoding: 'utf8' })
  const parsed = JSON.parse(json) as { files: unknown }
  const files = FileSchema.safeParse(parsed.files)
  if (!files.success) throw new CliError(`pr files invalid: ${files.error.message}`)
  return files.data.map((f) => f.path)
}

export function buildRescoreComment(o: RescoreOutput): string {
  const lines = [`## 二次判定：${o.before} → ${o.after}`]
  if (o.escalated) {
    lines.push('', `**監督層級升級**（docs/06 §5.3 單向升級）。觸發硬性規則：${o.triggeredHardRules.join('、') || '（計分上升）'}`)
  } else {
    lines.push('', '監督層級未變。')
  }
  return lines.join('\n')
}

export function main(argv: string[]): RescoreOutput {
  const [prNumber, catalogPath = 'catalog-info.yaml', riskPathsPath = '.github/factory/risk-paths.yml'] = argv
  if (prNumber === undefined) throw new CliError('prNumber is required')
  const changedPaths = getChangedPaths(Number(prNumber))
  const { annotations, hardRulePatterns } = loadScoreInput(catalogPath, riskPathsPath)
  const updated = score({ annotations, hardRulePatterns, changedPaths })
  // before：讀 Issue 上的初始標籤（省略——以 PR 目標 Issue 的 oversight/* 標籤為準）
  const before = updated.tier // Phase 2 簡化：以重計分結果為準；完整版讀 Issue 標籤
  return {
    before,
    after: updated.tier,
    triggeredHardRules: updated.triggeredHardRules,
    escalated: updated.total > 0, // 簡化版升級判定；完整版比較初始 total
  }
}

/* v8 ignore start -- 副作用區塊 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
```

> ⚠️ **實作時須修正**：`main()` 的 before/升級判定為簡化版——完整版應從 PR 關聯 Issue 的 `oversight/*` 標籤讀初始值，與 `score({changedPaths})` 比較並經 `rescore()` 單向合併。以測試驅動補齊（`getChangedPaths` 以注入的 gh runner 測試，避免真實 gh 呼叫）。

- [ ] **Step 3: `factory-rescore.yml`**

```yaml
# 二次判定（docs/06 §5.3）：PR 更新時獨立重計分，攔截升級。
name: Factory Rescore
on:
  pull_request:
    types: [opened, synchronize]
    branches: [main]
permissions:
  contents: read
  issues: write
jobs:
  rescore:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: '22.21.1', cache: npm }
      - name: Install and build
        run: |
          npm ci
          npm run build
      - name: Rescore (only factory/* branches)
        if: startsWith(github.event.pull_request.head.ref, 'factory/')
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node dist/cli/factory-rescore.js "${{ github.event.pull_request.number }}" \
            > .factory/rescore.json 2>&1 || exit 0
          node -e '
            const r = require("./.factory/rescore.json")
            if (r.escalated) {
              // 以 gh 留言（此 workflow 無 App token；GITHUB_TOKEN 足夠留言）
            }
          '
```

> ⚠️ 留言與標籤更新需 App token（同 factory-run 的模式）——實作時比照 mint app token + includeIf 移除。

- [ ] **Step 4: Commit**

```bash
git add src/cli/factory-rescore.ts src/cli/factory-rescore.test.ts .github/workflows/factory-rescore.yml
git commit -m "feat(cli): PR-event rescore for secondary judgment (Q06-5)"
```

---

## Task 4: 多 repo 支援

**Files:**
- Modify: `.github/workflows/factory-run.yml`（`repo` input + 目標 repo checkout）

- [ ] **Step 1: workflow 新增 `repo` 與 `base_branch` input**

```yaml
      repo:
        description: 目標 repo（owner/name）；預設本 repo
        required: false
        type: string
        default: philipz/software_factory
      base_branch:
        description: 工廠 trunk 分支（PR 合併目標）。⚠️ 非試點 repo 不得為 main（安全約束）
        required: false
        type: string
        default: main
```

- [ ] **Step 2: 安全約束守衛（對抗性測試可測）**

在 agent 步驟前加一步：

```yaml
      - name: Guard: base_branch safety
        run: |
          if [ "${{ inputs.repo }}" != "philipz/software_factory" ] && [ "${{ inputs.base_branch }}" == "main" ]; then
            echo "::error::非試點 repo 的 base_branch 不得為 main（安全約束，Q-P2-1）"
            exit 1
          fi
          echo "base_branch=${{ inputs.base_branch }} 安全"
```

- [ ] **Step 3: checkout 與計分依目標 repo + base branch**

checkout step 改為 `repository: ${{ inputs.repo }}` + `ref: ${{ inputs.base_branch }}`；`factory-score`/`factory-judge` 的 catalog/risk-paths 路徑參數為目標 repo 根。App token mint 依 `inputs.repo`。

- [ ] **Step 4: skill/template 使用 base branch**

`factory-pr-stacking` skill 與 task-template 的 `gh stack init --base main` 改為 `--base "$BASE_BRANCH"`（workflow 以 env 傳入 `BASE_BRANCH`）。

- [ ] **Step 5: 對抗性測試**：`factory-run.yml` 含 `repo`/`base_branch` input、Guard step、`repository:` 引用。

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/factory-run.yml .dsh/skills/factory-pr-stacking/SKILL.md .github/factory/task-template-*.txt
git commit -m "feat(ci): multi-repo support with base_branch safety guard (Q-P2-1)"
```

---

## Task 5: factory-metrics CLI（產出型指標自動化）

**Files:**
- Create: `src/cli/factory-metrics.ts` + `src/cli/factory-metrics.test.ts`
- Create: `scripts/weekly-metrics.sh`

背景（docs/08 §2/§7）：低難度組先做——lead time、PR 大小、缺陷率（`defect/*`）、執行成功率。資料源 `gh` JSON。

- [ ] **Step 1: 寫失敗測試**

```ts
import { describe, expect, it } from 'vitest'
import { computeMetrics } from './factory-metrics.js'

const PRS = [
  { number: 1, createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-01T02:00:00Z', additions: 100, deletions: 20 },
  { number: 2, createdAt: '2026-08-02T00:00:00Z', mergedAt: '2026-08-02T01:00:00Z', additions: 300, deletions: 0 },
]

describe('computeMetrics', () => {
  it('計算 lead time 與 PR 大小', () => {
    const m = computeMetrics(PRS)
    expect(m.leadTimeHours).toBeCloseTo(1.5, 5)
    expect(m.avgAdditions).toBe(200)
  })
  it('超過自動合併上限的 PR 被標記', () => {
    const m = computeMetrics(PRS)
    expect(m.overLimitCount).toBe(1) // 320 行 > 200
  })
})
```

- [ ] **Step 2: 實作 `factory-metrics.ts`**（純函式 + gh 呼叫隔離，模式同 factory-rescore）

```ts
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { AUTOMERGE_MAX_LINES } from '../scoring/score.js'

export const PrSchema = z.object({
  number: z.number(),
  createdAt: z.string(),
  mergedAt: z.string().nullable().optional(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
})
export type PrData = z.infer<typeof PrSchema>

export interface Metrics {
  leadTimeHours: number
  avgAdditions: number
  overLimitCount: number
  mergedCount: number
  defectEscapeCount: number
}

export function computeMetrics(prs: PrData[]): Metrics {
  const merged = prs.filter((p) => p.mergedAt != null)
  const leads = merged.map((p) => (Date.parse(p.mergedAt as string) - Date.parse(p.createdAt)) / 3_600_000)
  const leadTimeHours = leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : 0
  const sizes = merged.map((p) => p.additions + p.deletions)
  const avgAdditions = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0
  return {
    leadTimeHours,
    avgAdditions,
    overLimitCount: sizes.filter((s) => s > AUTOMERGE_MAX_LINES).length,
    mergedCount: merged.length,
    defectEscapeCount: 0, // 由缺陷標籤（docs/14）另行統計
  }
}

export function renderMarkdown(m: Metrics): string {
  return [
    '## 產出型指標月報',
    '',
    `- 合併 PR：${m.mergedCount}`,
    `- 平均 Lead Time：${m.leadTimeHours.toFixed(1)} 小時`,
    `- 平均 PR 大小：${m.avgAdditions.toFixed(0)} 行`,
    `- 超過自動合併上限（${AUTOMERGE_MAX_LINES} 行）PR 數：${m.overLimitCount}`,
    '',
  ].join('\n')
}

export function main(argv: string[]): { metrics: Metrics; markdown: string } {
  // 實作時：以 `gh pr list --state merged --json ...` 取得資料（注入式測試）
  const prs: PrData[] = []
  const metrics = computeMetrics(prs)
  return { metrics, markdown: renderMarkdown(metrics) }
}

/* v8 ignore start -- 副作用區塊 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
```

- [ ] **Step 3: `scripts/weekly-metrics.sh`**

```bash
#!/usr/bin/env bash
# 週檢：缺陷標籤 + 產出型指標（docs/14 §2.1）
set -euo pipefail
echo "== 缺陷標籤 =="
gh issue list --label defect/escape --state all --json number,title --limit 20
gh issue list --label defect/review --state all --json number,title --limit 20
echo "== 產出型指標 =="
npm run build >/dev/null
node dist/cli/factory-metrics.js
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/factory-metrics.ts src/cli/factory-metrics.test.ts scripts/weekly-metrics.sh
git commit -m "feat(cli): factory-metrics CLI and weekly script (docs/08 output metrics)"
```

---

## Task 6: token 中止門檻接線（SR7）

**Files:**
- Modify: `src/pipeline/run-work-item.ts`（report 契約）+ `src/cli/factory-judge.ts`（schema）
- Modify: `src/cli/dry-run-agent.ts`、`test/e2e/stub-agent.ts`（tokensUsed 欄位）
- Modify: `.github/workflows/factory-run.yml`（tokenBudget input）

- [ ] **Step 1: report.json 加入 `tokensUsed`**

`factory-judge.ts` 的 `ReportSchema` 增加 `tokensUsed: z.number().optional()`；`AgentRun` 增加 `tokensUsed`；`runWorkItem` Gate 4 傳入 `evaluateStopRules({ ..., tokensUsed, tokenBudget })`（SR7 已有判定）。

- [ ] **Step 2: workflow 增加 `token_budget` input**

```yaml
      token_budget:
        description: 單一工作項 token 上限（0 = 不設限，Q02-5 待基線校準）
        required: false
        type: number
        default: 0
```

agent step 的 env 帶 `TOKEN_BUDGET`；`write-report` 後以 `node dist/cli/factory-judge.js ...` 時把 budget 併入（實作細節：judge 讀環境變數或額外參數）。

- [ ] **Step 3: 測試**

新增：`tokensUsed > tokenBudget` 時 outcome 為 `needs-human` 且 violation 含 `SR7-cost-exceeded`（e2e + judge 測試）。

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/run-work-item.ts src/cli/factory-judge.ts src/cli/dry-run-agent.ts test/e2e/stub-agent.ts .github/workflows/factory-run.yml
git commit -m "feat(ci): thread token budget through SR7 (Q02-5 wiring)"
```

---

## Task 7: 對抗性測試擴充

**Files:**
- Modify: `test/adversarial/factory-assets.test.ts`

- [ ] **Step 1: 新增斷言**

```ts
describe('Phase 2 資產', () => {
  it('三種 task-template 存在且含 <ISSUE> 與 skills 指示', () => {
    for (const t of ['fix-bug', 'update-deps', 'write-docs']) {
      const c = read(`.github/factory/task-template-${t}.txt`)
      expect(c).toContain('<ISSUE>')
      expect(c).toContain('.dsh/skills')
    }
  })
  it('factory-run.yml 含 task_type 路由與 repo input', () => {
    const c = read('.github/workflows/factory-run.yml')
    expect(c).toContain('task_type')
    expect(c).toContain('task-template-${TASK_TYPE}')
    expect(c).toContain('inputs.repo')
  })
  it('factory-workflow skill 含型別分支與 --draft 禁令', () => {
    const s = read('.dsh/skills/factory-workflow/SKILL.md')
    expect(s).toContain('任務型別')
    expect(s).toContain('--draft')
  })
  it('factory-rescore.yml 存在且僅 factory/* 分支觸發', () => {
    const w = read('.github/workflows/factory-rescore.yml')
    expect(w).toContain("startsWith(github.event.pull_request.head.ref, 'factory/')")
  })
})
```

- [ ] **Step 2: 全量驗證**

Run: `npm run typecheck && npm test && npm run coverage`
Expected: 全綠（新增檔案需 100% 覆蓋——以注入 gh runner 的方式測 `getChangedPaths`/`main`）。

- [ ] **Step 3: Commit**

```bash
git add test/adversarial/factory-assets.test.ts
git commit -m "test(adversarial): pin Phase 2 factory assets"
```

---

## Task 8: 第二 repo 試跑（人類裁決後）

**Files:**
- 無新增；在目標 repo 執行

- [ ] **Step 1: 建立 fubon-tradingbot 的 software-factory 分支（人類）**

在 `philipz/fubon-tradingbot` 上開 `software-factory` 分支（從 main 分出，作為工廠 trunk）。**main 保持原樣、不觸碰**。建議（可選）對 `software-factory` 設基本分支保護（required checks 視該 repo 既有 CI 而定）。

- [ ] **Step 2: App 安裝至 fubon-tradingbot（人類）**

software-factory-worker App 安裝至 `philipz/fubon-tradingbot`（權限同 D6：contents/PRs/Issues write、Actions/Metadata read，無 Administration/Workflows）。

- [ ] **Step 3: 建立該 repo 的設定檔（人類登錄）**

在 fubon-tradingbot 的 `software-factory` 分支建立：
- `catalog-info.yaml`（三軸 + 技術棧 annotation——依該 repo 實際風險輪廓登錄）
- `.github/factory/risk-paths.yml`（H1–H7 路徑依該 repo 結構撰寫——Q06-4/Q05-6）
- `.github/factory/task-template-*.txt` 與 `.dsh/skills/`（複製試點版；**驗證其通用性**——無本 repo 特定假設）
- `CODEOWNERS`（高風險路徑指定人類審查者）

- [ ] **Step 4: 建立工作項並 dispatch（驗證 2.3）**

在 fubon-tradingbot 開 3–5 個工作項，dispatch `factory-run` 帶：
`repo: philipz/fubon-tradingbot`、`base_branch: software-factory`、`task_type: <選定類型>`。

- [ ] **Step 5: 驗證移植成功**

- [ ] 計分在該 repo 風險輪廓下正確（高風險路徑觸發 H 規則、fail-safe 生效）
- [ ] guardrail 遷移後仍擋得住（重寫的 risk-paths + CODEOWNERS 生效）
- [ ] agent 在不同結構 repo 照常工作（讀碼、寫測試、建 PR——不改 factory 邏輯）
- [ ] **main 未被觸碰**（`git ls-remote origin main` 的 SHA 前後一致）

- [ ] **Step 6: 記錄結果**

結果寫入 `docs/15-observation-trial-log.md`（新增 fubon-tradingbot section）。

---

## Task 9: 文件同步與出場條件

**Files:**
- Modify: `docs/09-roadmap.md`（Phase 2 狀態、2.7 調整為 GitHub Insights）
- Modify: `docs/10-open-questions.md`（Q06-5 二次判定完成、Q02-5 token 門檻依基線設定、Q04-9 命名紀律驗證）
- Modify: `docs/08-metrics-kpi.md`（Q08-7 閒置比以 Actions run 時長推估的註記）

- [ ] **Step 1: 更新 roadmap**

第 2 期工作項 2.1–2.8 標註狀態；**2.7 調整**：Backstage 降級後 Scoreboard 以 GitHub Insights + `factory-metrics` 月報替代（記錄在決策）。

- [ ] **Step 2: 更新未決事項**

Q06-5（二次判定完整版完成）、Q02-5/Q04-5（token 門檻依基線設實際值）、Q04-9（命名/--draft 紀律在 Phase 2 試跑的驗證結果）、Q08-4（OTel 延後）。

- [ ] **Step 3: 出場條件檢查**

- [ ] ≥3 種任務類型穩定運作（T1–T2 + T8 試跑）
- [ ] 二次判定攔截過升級情況（T3 試跑驗證）
- [ ] 產出型指標自動化（T5 月報）
- [ ] 閒置比下降且缺陷逃逸率未上升（依 T5 + docs/14 數據）
- [ ] ≥50 工作項樣本（持續累積）

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: Phase 2 status and exit-criteria tracking"
```

---

## 自我檢視

### Spec 覆蓋（docs/09 §3 → Task）

| 工作項 | Task |
|---|---|
| 2.1 多任務類型 | 1–2 |
| 2.2 多 repo | 4, 8 |
| 2.3 高風險 repo 計分驗證 | 8 |
| 2.4 二次判定 | 3 |
| 2.5 產出型指標自動化 | 5 |
| 2.6 token 中止門檻 | 6 |
| 2.7 TechDocs/Scoreboard | 5, 9（調整：GitHub Insights 替代）|
| 2.8 價值流工作坊 | 9（人類）|

### 已考量

1. **Backstage 降級（Q03-6/Q13-1）**：2.7 改為 GitHub Insights + metrics 月報——roadmap 需同步。
2. **重用以避免重寫**：rescore/metrics 全部呼叫既有 `src/scoring`（100% 測試）；gh 呼叫以注入隔離（Phase 1 模式）。
3. **人類決策點**：~~第二 repo 選擇~~（**已裁決：fubon-tradingbot**）、token 門檻實際值（依基線）。
4. **安全約束（Q-P2-1）**：fubon-tradingbot 的 **main 絕不觸碰**——工廠 trunk 用 `software-factory` 分支；非試點 repo 的 `base_branch` 不得為 `main`（Guard step + 對抗性測試強制）。
4. **觀察期機制延續**：Phase 2 工作項繼續 `meta/observation` 標籤，缺陷數據累積。

### 型別一致性

- `tokensUsed`/`tokenBudget` 在 Task 6 加入後，`AgentRun`/`ReportSchema`/`StopRuleContext`（已有欄位）/stub 四處一致。
- `RescoreOutput`/`Metrics` 介面在 Task 3/5 定義並被對應測試引用。

---

## 執行交接

計畫已儲存於 `docs/superpowers/plans/2026-08-18-phase2-expansion.md`。執行方式（沿用 Phase 1 選擇）：
1. **Subagent-Driven**（建議）
2. **Inline Execution**

**前置裁決（已完成）**：第二 repo 已裁決為 `philipz/fubon-tradingbot`，**安全約束：main 絕不觸碰，工廠 trunk 用 `software-factory` 分支**（Q-P2-1，2026-08-18）。

**T8 前人類步驟**：① 在 fubon-tradingbot 開 `software-factory` 分支；② App 安裝至該 repo；③ 建立該 repo 的 catalog/risk-paths/skills。
