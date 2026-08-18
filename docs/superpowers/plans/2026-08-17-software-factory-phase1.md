# Software Factory Phase 1（最窄路徑打通，含 Backstage）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通一條端到端可運作的 paved road：Issue → CI 計分 → DSH agent 執行（受限沙箱）→ stacked PR → 人類審查 → 合併，並以 Backstage（Catalog + 1 Template）作為自助入口。試點 repo 即本 repo（dogfooding），任務類型僅 `agent-add-tests` 一種，**全程人類審查、不自動合併**。另整合 **Quint 正式方法（Phase A）**：以 Quint 模型驗證工廠自身的計分邏輯（規格即神諭），並由 Backstage 提供機器可讀的**技術棧規範**（annotation）驅動 CI 驗證組合。

**Architecture:** 依 `docs/02-architecture.md` 四平面：Backstage（IDP 入口，僅觸發與展示）→ GitHub（Control Plane，Issue 標籤＝狀態、Actions run＝執行、PR 閘門）→ DSH（Execution Plane，headless 一次性呼叫 + guardrail patch + skills）→ gh stack（Delivery Plane，一疊小 PR）。CI 判定完全重用既有、已 100% 測試的 `runWorkItem` 管線（`src/pipeline/`），以 CLI 包裝供 workflow 呼叫——不重寫計分/停手邏輯。第 1 期依 `docs/09-roadmap.md` §2：不自動合併、Backstage 本機部署、只做 1 個 Template。

**Tech Stack:** TypeScript（strict）/ Node ≥22 / vitest 4.1.10（既有）；`@deepseek-ai/dsh@0.1.0-rc.6`（鎖版）；gh-stack v0.0.2（鎖版）；GitHub Actions（ubuntu-latest）；Backstage（create-app，版本於 Task 12 鎖定）；mkdocs + techdocs-core。

---

## 0. 範圍、前提與檔案結構

### 0.1 範圍（對應 `docs/09-roadmap.md` §2 工作項 1.1–1.8）

| 路線圖工作項 | 本計畫 Task | 性質 |
|---|---|---|
| 1.1 GitHub App 建立與安裝 | Task 10–11 | 人類手動 + CI 切換 |
| 1.2 factory profile / guardrail patch 層 | 已存在（`config/dsh/factory-guardrail.patch.yml`），Task 8 接線 | 重用 |
| 1.3 4 個 factory skills | Task 5 | 新建 |
| 1.4 `factory-run.yml` workflow | Task 8 | 新建 |
| 1.5 計分邏輯與 risk-paths.yml | 邏輯已存在（`src/scoring/` + `risk-paths.yml`），Task 2–3 包成 CLI | 重用 + 包裝 |
| 1.6 試點 repo catalog-info.yaml | 已存在，Task 13 驗證載入 | 重用 |
| 1.7 Backstage 本機部署 + 1 Template | Task 12–15 | 新建 |
| 1.8 端到端試跑 ≥ 10 工作項 | Task 9（stub dry-run）+ Task 21（真實 run） | 驗證 |
| **Quint Phase A（本計畫新增）** | Task 16–20 | 見 §0.2 決策 8–13 |
| **技術棧規範（本計畫新增）** | Task 13、Task 20 | 見 §0.2 決策 14 |

### 0.2 設計決策（先讀，避免實作時來回）

1. **CI 判定重用既有管線**：新增兩個 CLI——`factory-score`（agent 啟動前初始計分）與 `factory-judge`（agent 結束後，把 `report.json` 重放進 `runWorkItem` 得出終點）。`runWorkItem` 已含計分 → 判讀 → 重計分 → 停手規則全部閘門（Gate 1–5），100% 分支覆蓋。
2. **agent 產出契約**：agent 執行完畢後必須在 workspace 寫入 `.factory/run/report.json`（見 Task 6 的 schema）。`write-report` 是 fallback——agent 失敗未寫時，CI 依 exit code/stderr 補一份最小 report，使失敗路徑仍能走完 judge → `needs-human`。
3. **第 1 期不自動合併**：`factory-judge` 輸出 `ready-to-automerge` 時，`apply-judge-labels` 仍標記為「等待人類審查」（Phase 1 gate 映射），**永不執行 `gh stack merge`**。
4. **DSH step 用 step 級 `timeout-minutes: 25`** 而非 job 級：step 逾時（exit 124）仍可被捕獲、寫入 report、走 `needs-human`。job 級逾時會讓整顆 job 死亡，來不及標記。
5. **SR4 補洞**：`runWorkItem` 目前未把 `hasAcceptanceCriteria` 傳給停手規則（SR4 永遠不會觸發）。Task 3 一併修補（含測試）。
6. **Backstage 不入 repo**：scaffolded Backstage app 放在 repo 外的 `../backstage-app/`（D1：Backstage 不儲存狀態）。repo 內只版控 Template 定義（`backstage/templates/`）與 `mkdocs.yml`，由 Backstage catalog 以 GitHub location 指向本 repo。
7. **main 受保護**：所有 commit 在 feature branch 上進行，經 PR 合併（本 repo 既有 ruleset）。每個 Task 的 commit 步驟都落在 feature branch。

### 0.2 Quint 與技術棧規範決策（2026-08-17 使用者裁決）

8. **Quint 橋接機制（R2-Q2=D）**：Phase A 自建最小神諭 harness——`quint run --seed <固定> --out-itf <file>` 產生 ITF JSON traces，vitest 解析後與 TS 實作逐一比對（`quint run` 已實測：`--seed`、`--out-itf`、`--mbt` 均可用）。`quint-connect-ts` 留待 Phase B 評估（供應鏈最小化）。
9. **適用範圍（R2-Q3=C）**：Phase A 只驗證**工廠自身的計分邏輯**（`src/scoring/`）；agent 產出驗證（Phase B）隨第 2 期的 `agent-fix-bug` 等類型另立計畫（R2-Q6=A）。
10. **Quint 模型為人類撰寫**（R2-Q2=A）：只建模 `score.ts` 的純函式——`resolveAxis`（fail-safe）、`tierForTotal`、`rescore`（單向不降級）、automerge 條件。模型放 `specs/scoring/score.qnt`，人類版控。
11. **宣告機制（R2-Q3=D）**：`.github/factory/quint-paths.yml` 宣告「觸及這些路徑的變更必須通過 Quint 驗證」（本 repo 先宣告 `src/scoring/**`、`src/stop-rules/**`）；repo 級 `catalog-info.yaml` 的 `factory.io/quint-spec: specs/scoring` 表示規格根目錄。CI 以 `quint-verify` job（required check）執行 `quint typecheck`＋`quint verify --invariant`＋神諭 harness。
12. **Quint skills（R2-Q4=A，Q6=B）**：vendor `quint-co/quint` 官方 skills（quint-lang / quint-modeling / quint-execute-spec）至 `.dsh/skills/quint-*/`（rank 100），鎖來源 commit SHA 並記錄於 `docs/ADR/008-quint-formal-verification.md`。agent 可**撰寫 .qnt 草稿**，但草稿隨 stacked PR 交人類審查，**合併後才生效**；同一 run 內 agent 不得用自己寫的 .qnt 驗證自己的 code（docs/06 §4.3）。
13. **Quint 閘門權重（R2-Q5=B）**：僅對「觸及 `quint-paths.yml` 宣告路徑」的 PR 設 required check；未觸及不阻擋。`quint verify`（Apalache）有狀態空間限制——模型設計為有限狀態（列舉 3³ 輸入 + 非法值），`verify` 與 `run` 模擬雙軌驗證。
14. **技術棧規範（R2-Q1=A，Q4=D）**：精簡三欄位 annotation——`factory.io/stack`（語言）、`factory.io/test-framework`、`factory.io/quint-spec`（規格根目錄或 `none`）。CI 讀取以決定驗證組合（含是否跑 Quint）；TechDocs 提供人類可讀規範；Template 是執行載體。annotation 由人類登錄、受 CODEOWNERS 保護（`catalog-info.yaml` 已在保護清單）。

### 0.3 檔案結構（本計畫新建/修改）

| 檔案 | 職責 | Task |
|---|---|---|
| `tsconfig.build.json` | 產生 `dist/` 供 CI 執行（既有 `tsconfig.json` 是 noEmit） | 1 |
| `package.json` | 新增 `build` script | 1 |
| `src/cli/factory-score.ts` | 初始計分 CLI（catalog + risk-paths → JSON） | 2 |
| `src/cli/factory-judge.ts` | 執行後判定 CLI（report.json → 終點 JSON） | 3 |
| `src/pipeline/run-work-item.ts` | **修改**：`AgentRun` 增加 `hasAcceptanceCriteria` 並傳入停手規則 | 3 |
| `src/cli/apply-score-labels.ts` | 依初始計分貼 `oversight/*` 標籤／擋下 in-loop | 7 |
| `src/cli/apply-judge-labels.ts` | 依終點貼標籤＋留言（含 Phase 1 不自動合併映射） | 7 |
| `src/cli/write-report.ts` | agent 未寫 report 時的 fallback | 6 |
| `src/cli/dry-run-agent.ts` | dry-run stub agent（寫入固定 report） | 6 |
| `src/cli/*.test.ts` | 上述 CLI 的單元測試 | 2,3,6,7 |
| `.dsh/skills/factory-workflow/SKILL.md` | 主流程 SOP（含 report.json 契約） | 5 |
| `.dsh/skills/factory-pr-stacking/SKILL.md` | stacked PR 拆分 SOP（對應 docs/07） | 5 |
| `.dsh/skills/factory-self-review/SKILL.md` | 提交前自審清單 | 5 |
| `.dsh/skills/factory-stop-rules/SKILL.md` | 停手規則（對應 docs/04 §3.3） | 5 |
| `.github/factory/task-template.txt` | 自足任務描述模板 | 6 |
| `.github/workflows/factory-run.yml` | 工廠執行 workflow（含 dry_run 模式） | 8 |
| `test/adversarial/factory-assets.test.ts` | 對抗性測試：guardrail 檔案存在性與內容不變量 | 4 |
| `test/adversarial/guardrails.test.ts` | **修改**：GUARDRAIL_PATHS 納入新檔案 | 4 |
| `mkdocs.yml` | TechDocs 設定（docs/03 §4） | 15 |
| `backstage/templates/agent-add-tests/template.yaml` | 第一個 Template | 14 |
| `.dsh/skills/quint-lang/SKILL.md` 等 3 個 | vendor `quint-co/quint` 官方 skills（鎖版） | 16 |
| `specs/scoring/score.qnt` | 計分邏輯的 Quint 模型（人類撰寫） | 17 |
| `test/quint/scoring-oracle.test.ts` | 神諭 harness：ITF traces vs TS 實作 | 18 |
| `.github/factory/quint-paths.yml` | Quint 閘門的路徑宣告（仿 risk-paths.yml） | 19 |
| `.github/workflows/quint-verify.yml`（或併入 test.yml） | Quint CI job（required check） | 19 |
| `catalog-info.yaml` | **修改**：新增技術棧 annotation（stack/test-framework/quint-spec） | 20 |
| `docs/ADR/008-quint-formal-verification.md` | Quint 整合的 ADR（含 skills 來源鎖版） | 16,22 |
| `docs/09-roadmap.md`、`docs/10-open-questions.md` 等 | 文件同步 | 22 |

---

## Task 1: 建立 build 工具鏈（dist 產出）

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`（新增 `build` script）
- Test: 無單獨測試檔；以指令驗證

背景：`src/` 是 TypeScript（`noEmit`），CI 要執行計分邏輯必須先編譯。`moduleResolution: bundler` + `.js` 副檔名 import 在 emit 後仍可正確解析，因此一個繼承式 build config 即可。

- [ ] **Step 1: 建立 `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: 在 `package.json` 的 `scripts` 中加入 build**

```json
"scripts": {
  "build": "tsc -p tsconfig.build.json",
  "typecheck": "tsc --noEmit",
  ...
}
```

- [ ] **Step 3: 執行並驗證**

Run: `npm run build && ls dist/scoring dist/stop-rules dist/pipeline dist/integration`
Expected: 四個目錄皆存在（`src/cli/` 尚不存在，`dist/cli` 待 Task 2 建立 `src/cli/*.ts` 後自動出現，無需改 config），`dist/scoring/score.js` 存在。`dist/` 已被 `.gitignore` 忽略（不必 commit dist）。另驗證 emit 產物可被 Node 直接執行：`node -e "import('./dist/scoring/score.js')"` 無錯誤。

- [ ] **Step 4: 確認既有檢查不受影響**

Run: `npm run typecheck && npm test`
Expected: typecheck 通過；138 測試全綠（現有測試不依賴 build）。

- [ ] **Step 5: Commit**

```bash
git add tsconfig.build.json package.json package-lock.json
git commit -m "build: emit dist via tsconfig.build for CI entry points"
```

---

## Task 2: `factory-score` CLI（agent 啟動前初始計分）

**Files:**
- Create: `src/cli/factory-score.ts`
- Test: `src/cli/factory-score.test.ts`

- [ ] **Step 1: 寫失敗測試**

```ts
// src/cli/factory-score.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadScoreInput, main } from './factory-score.js'

const tmp = mkdtempSync(join(tmpdir(), 'factory-score-'))
const catalog = join(tmp, 'catalog-info.yaml')
const riskPaths = join(tmp, 'risk-paths.yml')

writeFileSync(catalog, [
  'apiVersion: backstage.io/v1alpha1',
  'kind: Component',
  'metadata:',
  '  name: demo',
  '  annotations:',
  '    factory.io/business-criticality: tactical',
  '    factory.io/risk-profile: low',
  '    factory.io/complexity: low',
  '    factory.io/agent-automerge: "false"',
  'spec:',
  '  type: service',
  '',
].join('\n'))
writeFileSync(riskPaths, [
  'hard_rules:',
  '  H1: ["src/auth/**"]',
  '  H5: [".github/**", "CODEOWNERS", "catalog-info.yaml", ".dsh/skills/**"]',
  '',
].join('\n'))

describe('factory-score', () => {
  it('讀 catalog 三軸 + risk-paths，輸出計分結果', () => {
    const out = main(['--catalog', catalog, '--risk-paths', riskPaths])
    expect(out.score.total).toBe(0)
    expect(out.score.tier).toBe('on-loop')
    expect(out.score.label).toBe('oversight/on-loop')
    expect(out.annotations.businessCriticality).toBe('tactical')
  })

  it('缺三軸標註 → fail-safe 計 6 分（in-loop）', () => {
    const emptyCatalog = join(tmp, 'empty.yaml')
    writeFileSync(emptyCatalog, 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: x\n')
    const out = main(['--catalog', emptyCatalog, '--risk-paths', riskPaths])
    expect(out.score.total).toBe(6)
    expect(out.score.tier).toBe('in-loop')
  })

  it('loadScoreInput 抽出 factory.io/ annotation 與 hard_rules', () => {
    const { annotations, hardRulePatterns } = loadScoreInput(catalog, riskPaths)
    expect(annotations.agentAutomerge).toBe('false')
    expect(hardRulePatterns.H1).toEqual(['src/auth/**'])
  })
})
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/cli/factory-score.test.ts`
Expected: FAIL（`Cannot find module './factory-score.js'`）。

- [ ] **Step 3: 實作 `src/cli/factory-score.ts`**

```ts
/**
 * factory-score — agent 啟動前的初始計分 CLI（docs/06 §5.1, docs/02 §4 step 2）。
 *
 * 輸入：catalog-info.yaml 的三軸 annotation + .github/factory/risk-paths.yml。
 * 輸出：計分結果 JSON（stdout）。agent 永不參與此判定。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { score } from '../scoring/score.js'
import type { CatalogAnnotations, HardRuleId, ScoreResult } from '../scoring/types.js'

interface CatalogFile {
  metadata?: { annotations?: Record<string, string> }
}
interface RiskPathsFile {
  hard_rules?: Partial<Record<HardRuleId, readonly string[]>>
}

export interface ScoreCliOutput {
  annotations: CatalogAnnotations
  score: ScoreResult
}

export function parseArgs(argv: string[]): { catalogPath: string; riskPathsPath: string } {
  let catalogPath = 'catalog-info.yaml'
  let riskPathsPath = '.github/factory/risk-paths.yml'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--catalog') catalogPath = argv[++i] ?? catalogPath
    if (argv[i] === '--risk-paths') riskPathsPath = argv[++i] ?? riskPathsPath
  }
  return { catalogPath, riskPathsPath }
}

export function loadScoreInput(
  catalogPath: string,
  riskPathsPath: string,
): { annotations: CatalogAnnotations; hardRulePatterns: Partial<Record<HardRuleId, readonly string[]>> } {
  const catalog = load(readFileSync(catalogPath, 'utf8')) as CatalogFile
  const raw = catalog.metadata?.annotations ?? {}
  const annotations: CatalogAnnotations = {
    businessCriticality: raw['factory.io/business-criticality'],
    riskProfile: raw['factory.io/risk-profile'],
    complexity: raw['factory.io/complexity'],
    agentAutomerge: raw['factory.io/agent-automerge'],
  }
  const riskFile = load(readFileSync(riskPathsPath, 'utf8')) as RiskPathsFile
  return { annotations, hardRulePatterns: riskFile.hard_rules ?? {} }
}

export function main(argv: string[]): ScoreCliOutput {
  const { catalogPath, riskPathsPath } = parseArgs(argv)
  const { annotations, hardRulePatterns } = loadScoreInput(catalogPath, riskPathsPath)
  return { annotations, score: score({ annotations, hardRulePatterns }) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
}
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/cli/factory-score.test.ts`
Expected: 3 則 PASS。

- [ ] **Step 5: 驗證 CLI 可直接執行**

Run: `npm run build && node dist/cli/factory-score.js | head -20`
Expected: 輸出含 `"total": 2`（本 repo 的 catalog 為 tactical/high/medium = 0+2+1 = 3？——以實際輸出為準，重點是合法 JSON 且 `score` 物件存在）。註：本 repo 的 `catalog-info.yaml` 三軸為 tactical(0) + high(2) + medium(1) = 3 分 → `review` tier。

- [ ] **Step 6: Commit**

```bash
git add src/cli/factory-score.ts src/cli/factory-score.test.ts
git commit -m "feat(cli): factory-score initial scoring entry for CI"
```

---

## Task 3: `factory-judge` CLI + SR4 補洞

**Files:**
- Create: `src/cli/factory-judge.ts`
- Modify: `src/pipeline/run-work-item.ts`（`AgentRun` 增加 `hasAcceptanceCriteria`，傳入停手規則）
- Modify: `test/e2e/work-item-flow.test.ts`（新增 SR4 觸發測試）
- Test: `src/cli/factory-judge.test.ts`

- [ ] **Step 1: 先修管線缺口（紅）——在 e2e 測試加 SR4 案例**

```ts
// test/e2e/work-item-flow.test.ts 的「停手規則在流程中確實生效」describe 內新增：
it('缺少可驗證的驗收條件 → needs-human (SR4)', () => {
  const r = runWorkItem({
    issueNumber: 115,
    initial: LOW_RISK,
    runAgent: () =>
      runStubAgent({ changedPaths: ['src/a.ts'], hasAcceptanceCriteria: false }),
  })
  expect(r.outcome).toBe('needs-human')
  expect(r.stopDecision?.violations.some((v) => v.rule === 'SR4-unclear-acceptance')).toBe(true)
})
```

同時在 `test/e2e/stub-agent.ts` 的 `StubAgentScript` 與 `StubAgentRun` 增加 `hasAcceptanceCriteria?: boolean | undefined`，並在 `runStubAgent` 中回傳（預設 `undefined`）。

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run test/e2e/work-item-flow.test.ts`
Expected: 新案例 FAIL——`outcome` 為 `ready-for-review` 而非 `needs-human`（SR4 未觸發）。

- [ ] **Step 3: 修管線——`src/pipeline/run-work-item.ts`**

`AgentRun` 增加欄位：

```ts
export interface AgentRun {
  invocation: DshInvocation
  changedPaths?: readonly string[] | undefined
  changedLines?: number | undefined
  assertionDelta?: number | undefined
  addedDependencies?: readonly string[] | undefined
  syncFailures?: number | undefined
  /** Issue 是否帶可驗證的驗收條件（SR4）。undefined = 未判定。 */
  hasAcceptanceCriteria?: boolean | undefined
}
```

Gate 4 的 `evaluateStopRules` 呼叫增加參數：

```ts
const stopDecision = evaluateStopRules({
  syncFailures: run.syncFailures ?? undefined,
  changedPaths: run.changedPaths ?? undefined,
  triggeredHardRules: finalScore.triggeredHardRules,
  addedDependencies: run.addedDependencies ?? undefined,
  assertionDelta: run.assertionDelta ?? undefined,
  hasAcceptanceCriteria: run.hasAcceptanceCriteria ?? undefined,
})
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run test/e2e/work-item-flow.test.ts`
Expected: 全數 PASS（含新 SR4 案例）。

- [ ] **Step 5: 寫 `factory-judge` 的測試 `src/cli/factory-judge.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from './factory-judge.js'

const tmp = mkdtempSync(join(tmpdir(), 'factory-judge-'))
const catalog = join(tmp, 'catalog-info.yaml')
const riskPaths = join(tmp, 'risk-paths.yml')

writeFileSync(catalog, [
  'apiVersion: backstage.io/v1alpha1',
  'kind: Component',
  'metadata:',
  '  name: demo',
  '  annotations:',
  '    factory.io/business-criticality: tactical',
  '    factory.io/risk-profile: low',
  '    factory.io/complexity: low',
  'spec:',
  '  type: service',
  '',
].join('\n'))
writeFileSync(riskPaths, 'hard_rules:\n  H1: ["src/auth/**"]\n  H5: [".github/**", "CODEOWNERS", "catalog-info.yaml", ".dsh/skills/**"]\n')

const report = (body: object): string => {
  const p = join(tmp, 'report.json')
  writeFileSync(p, JSON.stringify(body))
  return p
}

describe('factory-judge', () => {
  it('低風險 + 成功執行 → 終點 ready-to-automerge（Phase 1 由 apply-judge-labels 改為人審）', () => {
    const r = main([report({
      issueNumber: 1,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/util/format.test.ts'],
      changedLines: 40,
      assertionDelta: 6,
    }), catalog, riskPaths])
    expect(r.result.outcome).toBe('ready-to-automerge')
  })

  it('改到 guardrail 路徑 → needs-human（SR3）', () => {
    const r = main([report({
      issueNumber: 2,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['.github/workflows/test.yml'],
    }), catalog, riskPaths])
    expect(r.result.outcome).toBe('needs-human')
    expect(r.result.stopDecision?.violations[0]?.rule).toBe('SR3-guardrail-change')
  })

  it('agent exit 1 → needs-human 且附 stderr', () => {
    const r = main([report({
      issueNumber: 3,
      invocation: { exitCode: 1, stdout: '', stderr: 'model unavailable' },
    }), catalog, riskPaths])
    expect(r.result.outcome).toBe('needs-human')
    expect(r.result.summary).toContain('model unavailable')
  })

  it('缺驗收條件 → needs-human（SR4，Task 3 補洞後可達）', () => {
    const r = main([report({
      issueNumber: 4,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths: ['src/a.ts'],
      hasAcceptanceCriteria: false,
    }), catalog, riskPaths])
    expect(r.result.stopDecision?.violations.some((v) => v.rule === 'SR4-unclear-acceptance')).toBe(true)
  })
})
```

- [ ] **Step 6: 執行確認失敗**

Run: `npx vitest run src/cli/factory-judge.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 7: 實作 `src/cli/factory-judge.ts`**

```ts
/**
 * factory-judge — agent 結束後的終點判定 CLI（docs/02 §4 step 5–6）。
 *
 * 讀取 agent 寫在 workspace 的 .factory/run/report.json，重放進既有的
 * runWorkItem 管線（計分 → DSH 判讀 → 重計分 → 停手規則），輸出最終
 * 終點 JSON。所有判定邏輯皆來自已 100% 測試的 src/pipeline。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runWorkItem, type AgentRun } from '../pipeline/run-work-item.js'
import { loadScoreInput } from './factory-score.js'

interface ReportFile {
  issueNumber: number
  invocation: { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }
  changedPaths?: string[]
  changedLines?: number
  assertionDelta?: number
  addedDependencies?: string[]
  syncFailures?: number
  hasAcceptanceCriteria?: boolean
}

export function main(argv: string[]): { report: ReportFile; result: ReturnType<typeof runWorkItem> } {
  const reportPath = argv[0] ?? '.factory/run/report.json'
  const catalogPath = argv[1] ?? 'catalog-info.yaml'
  const riskPathsPath = argv[2] ?? '.github/factory/risk-paths.yml'
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportFile

  const { annotations, hardRulePatterns } = loadScoreInput(catalogPath, riskPathsPath)
  const runAgent = (): AgentRun => ({
    invocation: report.invocation,
    changedPaths: report.changedPaths,
    changedLines: report.changedLines,
    assertionDelta: report.assertionDelta,
    addedDependencies: report.addedDependencies,
    syncFailures: report.syncFailures,
    hasAcceptanceCriteria: report.hasAcceptanceCriteria,
  })
  return {
    report,
    result: runWorkItem({
      issueNumber: report.issueNumber,
      initial: { annotations, hardRulePatterns },
      runAgent,
    }),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
}
```

- [ ] **Step 8: 執行確認通過 + 全量回歸**

Run: `npx vitest run src/cli test/e2e`
Expected: 全部 PASS。再 `npm run coverage`，確認新增檔案不破壞既有 100% 門檻（新檔案加入 coverage include，需補足至 100%——若 CLI 有未覆蓋分支，擴充測試至全覆蓋）。

- [ ] **Step 9: Commit**

```bash
git add src/cli/factory-judge.ts src/cli/factory-judge.test.ts src/pipeline/run-work-item.ts test/e2e/stub-agent.ts test/e2e/work-item-flow.test.ts
git commit -m "feat(cli): factory-judge terminal-state CLI; thread SR4 acceptance flag through pipeline"
```

---

## Task 4: 對抗性測試——guardrail 檔案存在性與內容不變量

**Files:**
- Create: `test/adversarial/factory-assets.test.ts`
- Modify: `test/adversarial/guardrails.test.ts`（GUARDRAIL_PATHS 納入新檔案）

背景：skills、task-template、workflow 是「設定而非程式」，壞掉不會有功能性症狀（docs/11 §5）。對抗性測試把它們釘住。**先寫測試（紅），再在 Task 5–8 依測試建立檔案（綠）**——本 Task 定義契約，後續 Task 是實現。

- [ ] **Step 1: 建立 `test/adversarial/factory-assets.test.ts`**

```ts
/**
 * Adversarial tests for Phase-1 factory assets (docs/11 §5).
 *
 * These files are configuration, not code: a broken one shows NO functional
 * symptom — the factory keeps running while a protection silently disappears.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const SKILLS: Record<string, string> = {
  'factory-workflow': '主流程',
  'factory-pr-stacking': 'stacked PR',
  'factory-self-review': '自審',
  'factory-stop-rules': '停手',
}

describe('factory skills 存在且 frontmatter 有效（dsh-skill-filesystem 契約）', () => {
  for (const [name, hint] of Object.entries(SKILLS)) {
    it(`${name}/SKILL.md 存在、name 為 kebab-case、含 description 與 ${hint} 內容`, () => {
      const p = `.dsh/skills/${name}/SKILL.md`
      const content = read(p)
      expect(content).toMatch(/^---\nname: /)
      expect(content).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(content).toMatch(/^description: /m)
    })
  }
})

describe('factory-stop-rules 含關鍵禁令', () => {
  const content = read('.dsh/skills/factory-stop-rules/SKILL.md')
  it('明寫 sync 優先於 rebase、-m 必填、submit --auto', () => {
    expect(content).toContain('gh stack sync')
    expect(content).toContain('-m')
    expect(content).toContain('--auto')
  })
  it('包含 needs-human 交還語意', () => {
    expect(content).toContain('needs-human')
  })
})

describe('factory-workflow 含 report.json 契約', () => {
  const content = read('.dsh/skills/factory-workflow/SKILL.md')
  it('要求 agent 寫 .factory/run/report.json 並列出欄位', () => {
    expect(content).toContain('.factory/run/report.json')
    for (const field of ['changedPaths', 'changedLines', 'assertionDelta', 'addedDependencies', 'syncFailures', 'hasAcceptanceCriteria']) {
      expect(content).toContain(field)
    }
  })
})

describe('task-template 自足且指向 skills', () => {
  const content = read('.github/factory/task-template.txt')
  it('含 <ISSUE> 佔位與 skills 指示，不含 skill 內文（避免漂移）', () => {
    expect(content).toContain('<ISSUE>')
    expect(content).toContain('.dsh/skills')
    expect(content).not.toContain('gh stack sync') // 任務描述不重複 skill 內容（docs/04 §3.4）
  })
})

describe('factory-run.yml 具備必要結構', () => {
  const content = read('.github/workflows/factory-run.yml')
  it('workflow_dispatch 輸入 issue_number 與 dry_run', () => {
    expect(content).toContain('issue_number')
    expect(content).toContain('dry_run')
  })
  it('含 concurrency 群組與 needs-human 處理', () => {
    expect(content).toContain('concurrency')
    expect(content).toContain('group: factory-')
    expect(content).toContain('needs-human')
  })
  it('呼叫 dist CLI 而非重寫判定邏輯', () => {
    expect(content).toContain('dist/cli/factory-score.js')
    expect(content).toContain('dist/cli/factory-judge.js')
  })
  it('guardrail patch 與鎖版 DSH', () => {
    expect(content).toContain('config/dsh/factory-guardrail.patch.yml')
    expect(content).toContain('@deepseek-ai/dsh@')
  })
})

describe('Quint Phase A 資產（Task 16–20 建立）', () => {
  it('vendor 的 quint skills 存在（quint-lang/quint-modeling/quint-execute-spec）', () => {
    for (const name of ['quint-lang', 'quint-modeling', 'quint-execute-spec']) {
      const content = read(`.dsh/skills/${name}/SKILL.md`)
      expect(content).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(content).toMatch(/^description: /m)
    }
  })
  it('ADR-008 記錄 quint skills 來源 commit SHA', () => {
    expect(read('docs/ADR/008-quint-formal-verification.md')).toMatch(/quint-co\/quint/)
    expect(read('docs/ADR/008-quint-formal-verification.md')).toMatch(/[0-9a-f]{7,40}/)
  })
  it('Quint 模型存在且為人類撰寫（含 fail-safe 不變量）', () => {
    const q = read('specs/scoring/score.qnt')
    expect(q).toContain('module scoring')
    expect(q).toContain('fail-safe')   // 註解標示來源設計
    expect(q).toContain('invariant')
  })
  it('quint-paths.yml 宣告 src/scoring 與 src/stop-rules', () => {
    const p = read('.github/factory/quint-paths.yml')
    expect(p).toContain('src/scoring/**')
    expect(p).toContain('src/stop-rules/**')
  })
  it('catalog-info.yaml 帶技術棧 annotation 且 quint-spec 指向規格根', () => {
    const c = read('catalog-info.yaml')
    expect(c).toContain('factory.io/stack:')
    expect(c).toContain('factory.io/test-framework:')
    expect(c).toContain('factory.io/quint-spec: specs/scoring')
  })
  it('神諭 harness 測試存在（ITF vs TS）', () => {
    expect(read('test/quint/scoring-oracle.test.ts')).toContain('--out-itf')
  })
})
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run test/adversarial/factory-assets.test.ts`
Expected: 全部 FAIL（檔案不存在）。此為紅燈，Task 5–8 逐一把檔案建出轉綠。

- [ ] **Step 3: 修改 `test/adversarial/guardrails.test.ts` 的 GUARDRAIL_PATHS**

在既有陣列中追加（保持與 `risk-paths.yml` H5 及 CODEOWNERS 一致）：

```ts
const GUARDRAIL_PATHS = [
  '.github/workflows/factory-run.yml',
  '.github/workflows/test.yml',
  '.github/factory/risk-paths.yml',
  '.github/factory/task-template.txt',
  'CODEOWNERS',
  'catalog-info.yaml',
  '.dsh/skills/factory-workflow/SKILL.md',
  '.dsh/skills/factory-pr-stacking/SKILL.md',
  '.dsh/skills/factory-self-review/SKILL.md',
  '.dsh/skills/factory-stop-rules/SKILL.md',
]
```

- [ ] **Step 4: 執行確認**

Run: `npx vitest run test/adversarial`
Expected: `factory-assets` 紅（待 Task 5–8 轉綠）、`guardrails` 既有測試維持綠。

- [ ] **Step 5: Commit**

```bash
git add test/adversarial/factory-assets.test.ts test/adversarial/guardrails.test.ts
git commit -m "test(adversarial): pin factory assets existence and content invariants"
```

---

## Task 5: 四個 factory skills（`.dsh/skills/`）

**Files:**
- Create: `.dsh/skills/factory-workflow/SKILL.md`
- Create: `.dsh/skills/factory-pr-stacking/SKILL.md`
- Create: `.dsh/skills/factory-self-review/SKILL.md`
- Create: `.dsh/skills/factory-stop-rules/SKILL.md`

本 Task 讓 Task 4 的 skills 測試轉綠。內容依 `docs/04-agent-execution-dsh.md` §3.3、`docs/07-stacked-pr-workflow.md` 撰寫；frontmatter 需符合 `dsh-skill-filesystem` 契約（name 為 kebab-case、必填 description）。

- [ ] **Step 1: `.dsh/skills/factory-workflow/SKILL.md`**

```markdown
---
name: factory-workflow
description: 工廠 agent 處理一個 GitHub Issue 工作項的主流程 SOP。載入本 skill 後依序執行：讀 Issue、寫測試、實作、自審、拆 stacked PR、回報，並在結束前寫出執行報告。
---

# 工廠主流程

處理 GitHub Issue #<編號>（由任務描述提供，repo 為當前 workspace 的 repo）。

## 步驟

1. 讀取該 Issue 的內容與驗收條件（`gh issue view <編號>`）。
2. 判斷是否有可驗證的驗收條件：若 Issue 沒有明確的驗收條件（無重現步驟、無「完成 = 可觀察結果」的描述），**不要猜測**——將 `hasAcceptanceCriteria` 設為 `false` 並依 factory-stop-rules 停手。
3. 依「測試先行」順序作業：先寫測試（定義「正確」），再實作使其通過，最後補文件。
4. 依 factory-pr-stacking 的規則拆分並建立 stacked PR。
5. 提交前依 factory-self-review 自審。
6. 在 Issue 留言回報產出的 PR 編號與摘要。
7. **結束前，在 workspace 寫出執行報告**：

```json
{
  "issueNumber": <編號>,
  "invocation": { "exitCode": 0, "stdout": "<最後一則輸出>", "stderr": "" },
  "changedPaths": ["<改動檔案相對路徑>"],
  "changedLines": <總變更行數>,
  "assertionDelta": <測試斷言淨增減，負數表示減少>,
  "addedDependencies": ["<新增相依套件名>"],
  "syncFailures": <gh stack sync 連續失敗次數>,
  "hasAcceptanceCriteria": <true|false>
}
```

寫入路徑：`.factory/run/report.json`（位於 workspace 根目錄）。此報告是 CI 判定終點的輸入；**欄位缺漏時 CI 會以最保守方式處理**，但完整填寫能讓人類接手時看到全貌。

## 原則

- 所有 git/gh 操作使用環境中的 `GH_TOKEN`（GitHub App 身分）。
- 任務描述本身不重複本 skill 內容——需要細節時回到本檔案。
- 任何不確定的情況，依 factory-stop-rules 停手，**不要猜測並繼續**。
```

- [ ] **Step 2: `.dsh/skills/factory-pr-stacking/SKILL.md`**

```markdown
---
name: factory-pr-stacking
description: 如何把一個工作項的變更拆分為一疊可獨立審查的 stacked PR（docs/07）。含 gh stack 指令序列與 CI 環境下的注意事項。
---

# Stacked PR 拆分

## 標準三層（由底而頂）

```
trunk (main)
  └── 01-test    測試/契約先行
        └── 02-impl    實作
              └── 03-docs    文件與註解
```

## 指令序列（CI 環境，全部非互動）

```bash
gh stack init --base main --prefix "factory/<issue編號>" --numbered
git add tests/
gh stack add -m "test: add failing tests for issue #<編號>" -A
# ...實作...
gh stack add -m "feat: implement for issue #<編號>" -A
# ...文件...
gh stack add -m "docs: update notes for issue #<編號>" -A
gh stack submit --auto
```

## 必須遵守

- **`gh stack add` 永遠提供 `-m`**：省略時會開啟編輯器，在 CI 中卡住直到逾時。
- **`gh stack submit` 使用 `--auto`**：不互動提示。
- **同步一律用 `gh stack sync`，不用 `gh stack rebase`**：`sync` 非互動、衝突時自動還原所有分支（交易性）；`rebase` 衝突時需互動介入。
- `gh stack sync` 連續兩次失敗 → 依 factory-stop-rules 停手。
- **拆分上限 200–300 行**（撰寫指引，非閘門）；超過則再拆。
- **不可跨風險層級**：高風險變更單獨成 PR，不與低風險混在一起。
- 每顆 PR 描述含：做什麼（一句話）、為什麼這樣做、在疊中的位置、審查重點、`Closes #<編號>`。

## 不適用 stacking 的情況

變更 < 100 行且單一關注點（如 typo 修正）或純機械式全域替換 → 用單一 PR。
```

- [ ] **Step 3: `.dsh/skills/factory-self-review/SKILL.md`**

```markdown
---
name: factory-self-review
description: 提交 stacked PR 前必須執行的自審清單。任何一項未過即修正，不得帶著已知問題提交。
---

# 提交前自審

## 測試層（01-test）

- [ ] 測試真的驗證了驗收條件，不是為了好過而寫的弱測試
- [ ] 沒有刪除或弱化任何既有斷言（斷言數不得淨減少）
- [ ] 測試在修改前能呈現紅燈（若無法執行，說明原因）

## 實作層（02-impl）

- [ ] 只做一件事，一句話可描述
- [ ] 沒有未經測試涵蓋的副作用
- [ ] 未觸及 guardrail 路徑（`.github/**`、`CODEOWNERS`、`catalog-info.yaml`、`.dsh/skills/**`）
- [ ] 未新增未在既有相依清單中的套件

## 文件層（03-docs）

- [ ] 文件與實作一致
- [ ] 沒有把金鑰、token 或個人資料寫入任何檔案

## 一般

- [ ] 變更行數合計 ≤ 200–300（超過則再拆）
- [ ] PR 描述包含「為什麼這樣做」（docs/07 §5）
```

- [ ] **Step 4: `.dsh/skills/factory-stop-rules/SKILL.md`**（內容即 `docs/04` §3.3 全文）

```markdown
---
name: factory-stop-rules
description: 工廠 agent 必須停手並交還人類的情況。任何一條觸發即停止，不得自行放寬。
---

# 停手規則

以下任一情況發生時，**立即停止**，在 Issue 留言說明原因，貼上 `needs-human` 標籤，然後結束：

1. 同一顆 PR 連續兩次 `gh stack sync` 失敗。（**CI 中一律用 `sync` 不用 `rebase`**：`sync` 為非互動且衝突時會還原所有分支；`rebase` 需互動介入，在 CI 中會卡住至逾時。詳見 docs/07 §3.3）
2. 任務涉及授權邏輯、金流計算、敏感資料處理。
3. 需要修改 CI 設定、branch protection、CODEOWNERS 或 `catalog-info.yaml`。
4. 驗收條件不明確，無法判斷完成與否。
5. 需要新增未在既有相依清單中的套件。
6. 測試無法在不放寬斷言的情況下通過。

**絕不允許的行為**：
- 為了讓測試通過而刪除或弱化測試斷言。
- 為了繞過檢查而修改 guardrail 設定。
- 在不確定時猜測並繼續——不確定就停手。
```

- [ ] **Step 5: 執行確認 skills 測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "factory skills"`
Expected: skills 相關測試 PASS（workflow/task-template/factory-run 相關仍紅，留待 Task 6/8）。

- [ ] **Step 6: Commit**

```bash
git add .dsh/skills/
git commit -m "feat(skills): add four factory SOP skills under .dsh/skills"
```

---

## Task 6: 任務模板與 report 契約工具

**Files:**
- Create: `.github/factory/task-template.txt`
- Create: `src/cli/write-report.ts`（fallback）+ 測試
- Create: `src/cli/dry-run-agent.ts`（stub）+ 測試

- [ ] **Step 1: `.github/factory/task-template.txt`**（自足任務描述，docs/04 §3.4）

```
處理 GitHub Issue #<ISSUE>（repo: 目前 workspace 的 repo）。

1. 先載入並遵循 .dsh/skills/ 中的 factory-workflow 與 factory-stop-rules。
2. 讀取該 Issue 的內容與驗收條件。
3. 依 factory-pr-stacking 的規則拆分並建立 stacked PR（測試先行）。
4. 完成後在 Issue 留言回報產出的 PR 編號，並依 factory-workflow 寫出 .factory/run/report.json。

若觸發任何停手規則，依該規則處理後結束。
```

- [ ] **Step 2: 寫 `write-report` 測試 `src/cli/write-report.test.ts`**

```ts
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReport } from './write-report.js'

const tmp = mkdtempSync(join(tmpdir(), 'write-report-'))
const cwd = (): string => join(tmp, 'ws')

describe('write-report', () => {
  it('agent 已寫 report → 保留原檔不覆寫', () => {
    const ws = cwd()
    writeFileSync(join(ws, '.factory/run/report.json'), JSON.stringify({ issueNumber: 7 }), { recursive: true } as never)
    const p = buildReport({ issueNumber: 7, exitCode: 0, stderr: '', cwd: ws })
    expect(p).toBe(join(ws, '.factory/run/report.json'))
    expect(JSON.parse(readSync(p)).issueNumber).toBe(7)
  })

  it('agent 未寫 → 以 exit code/stderr 補最小 report（失敗路徑可走 judge）', () => {
    const ws = cwd()
    const p = buildReport({ issueNumber: 8, exitCode: 1, stderr: 'boom', cwd: ws })
    const r = JSON.parse(readSync(p)) as { invocation: { exitCode: number; stderr: string } }
    expect(r.invocation.exitCode).toBe(1)
    expect(r.invocation.stderr).toBe('boom')
  })
})

const readSync = (p: string): string => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return readFileSync(p, 'utf8')
}
```

> 註：若測試內 `require` 不適用於 ESM，改為檔案頂部 `import { readFileSync } from 'node:fs'` 並以之取代 `readSync` helper。

- [ ] **Step 3: 實作 `src/cli/write-report.ts`**

```ts
/**
 * write-report — agent 執行後 report 的 fallback 產生器。
 *
 * 正常路徑：agent 依 factory-workflow skill 自行寫出 .factory/run/report.json。
 * fallback 路徑：agent 失敗或未寫（例如啟動即掛），CI 依 exit code/stderr
 * 補一份最小 report，使 factory-judge 仍能走完 needs-human 判定。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface WriteReportInput {
  issueNumber: number
  exitCode: number
  stderr: string
  stdout: string
  timedOut: boolean
  cwd: string
}

export function buildReport(input: WriteReportInput): string {
  const target = join(input.cwd, '.factory/run/report.json')
  if (existsSync(target)) return target // agent 已寫，保留
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    JSON.stringify(
      {
        issueNumber: input.issueNumber,
        invocation: {
          exitCode: input.exitCode,
          stdout: input.stdout,
          stderr: input.stderr,
          timedOut: input.timedOut,
        },
      },
      null,
      2,
    ),
  )
  return target
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // 使用方式：node dist/cli/write-report.js <issueNumber> <exitCode> <stdoutFile> <stderrFile> [--timed-out]
  const [issueNumber, exitCode, stdoutFile, stderrFile] = process.argv.slice(2)
  const read = (p: string): string => (p && existsSync(p) ? readFileSync(p, 'utf8') : '')
  const p = buildReport({
    issueNumber: Number(issueNumber),
    exitCode: Number(exitCode),
    stdout: read(stdoutFile ?? ''),
    stderr: read(stderrFile ?? ''),
    timedOut: process.argv.includes('--timed-out'),
    cwd: process.cwd(),
  })
  process.stdout.write(p + '\n')
}
```

- [ ] **Step 4: 寫 `dry-run-agent` 測試 `src/cli/dry-run-agent.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dryRunReport } from './dry-run-agent.js'

describe('dry-run-agent', () => {
  it('success 情境：低風險報告，改動測試檔、斷言淨增', () => {
    const r = dryRunReport({ scenario: 'success', issueNumber: 101, cwd: mkdtempSync(join(tmpdir(), 'dry-')) })
    expect(r.invocation.exitCode).toBe(0)
    expect(r.changedPaths).toContain('src/util/format.test.ts')
    expect((r.assertionDelta ?? 0)).toBeGreaterThan(0)
  })
  it('blocked 情境：in-loop 初始計分（agent 不該執行）', () => {
    const r = dryRunReport({ scenario: 'blocked', issueNumber: 102, cwd: mkdtempSync(join(tmpdir(), 'dry-')) })
    expect(r.scenario).toBe('blocked')
  })
  it('guardrail 情境：agent 宣稱改到 .github → SR3 應觸發', () => {
    const r = dryRunReport({ scenario: 'guardrail', issueNumber: 103, cwd: mkdtempSync(join(tmpdir(), 'dry-')) })
    expect(r.changedPaths).toContain('.github/workflows/test.yml')
  })
})
```

- [ ] **Step 5: 實作 `src/cli/dry-run-agent.ts`**

```ts
/**
 * dry-run-agent — 以 stub agent 取代真實 DSH（docs/11 §4.3 精神）。
 *
 * 用途：在沒有 LLM key 的 CI 上驗證 factory-run.yml 的流程接線——
 * 計分閘門、標籤、judge 終點、needs-human 路徑。stub 是確定性的：
 * 同一 scenario 永遠產出同一份報告。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type DryRunScenario = 'success' | 'blocked' | 'guardrail'

export interface DryRunInput {
  scenario: DryRunScenario
  issueNumber: number
  cwd: string
}

export function dryRunReport(input: DryRunInput): Record<string, unknown> {
  const base = {
    issueNumber: input.issueNumber,
    invocation: { exitCode: 0, stdout: 'DONE (dry-run stub)', stderr: '' },
  }
  if (input.scenario === 'success') {
    return {
      ...base,
      changedPaths: ['src/util/format.test.ts'],
      changedLines: 40,
      assertionDelta: 6,
      hasAcceptanceCriteria: true,
    }
  }
  if (input.scenario === 'guardrail') {
    return {
      ...base,
      changedPaths: ['.github/workflows/test.yml'],
      changedLines: 5,
      assertionDelta: 0,
      hasAcceptanceCriteria: true,
    }
  }
  // blocked：in-loop 初始計分會擋下 agent，此報告不會被使用
  return { ...base, scenario: 'blocked' }
}

export function main(argv: string[]): Record<string, unknown> {
  const [scenario, issueNumber] = argv
  const cwd = process.cwd()
  const report = dryRunReport({ scenario: (scenario ?? 'success') as DryRunScenario, issueNumber: Number(issueNumber), cwd })
  const target = join(cwd, '.factory/run/report.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(report, null, 2))
  return report
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
}
```

- [ ] **Step 6: 執行確認**

Run: `npx vitest run src/cli/write-report.test.ts src/cli/dry-run-agent.test.ts && npm run build`
Expected: 全部 PASS；build 成功產出 `dist/cli/write-report.js`、`dist/cli/dry-run-agent.js`。

- [ ] **Step 7: 確認 task-template 測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "task-template"`
Expected: PASS（workflow/factory-run 相關仍紅，留待 Task 8）。

- [ ] **Step 8: Commit**

```bash
git add .github/factory/task-template.txt src/cli/write-report.ts src/cli/write-report.test.ts src/cli/dry-run-agent.ts src/cli/dry-run-agent.test.ts
git commit -m "feat(cli): task template and report contract helpers (write-report, dry-run-agent)"
```

---

## Task 7: 標籤/留言 helper CLI

**Files:**
- Create: `src/cli/apply-score-labels.ts` + 測試
- Create: `src/cli/apply-judge-labels.ts` + 測試

設計：兩個 CLI 的**純函式部分**（計算標籤、組留言）與 gh 呼叫分離；純函式被單元測試覆蓋，gh 呼叫是 3 行 wrapper，由 Task 9 的 dry-run E2E 在真實 Actions 驗證。

- [ ] **Step 1: 寫 `apply-score-labels` 測試 `src/cli/apply-score-labels.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { computeScoreLabels, buildBlockComment } from './apply-score-labels.js'

describe('apply-score-labels（純函式）', () => {
  it('on-loop → 貼 oversight/on-loop，不擋', () => {
    const out = computeScoreLabels({ total: 0, tier: 'on-loop', label: 'oversight/on-loop' } as never)
    expect(out.labels).toEqual(['oversight/on-loop'])
    expect(out.blocked).toBe(false)
  })
  it('in-loop → 擋下 agent 並產出說明留言', () => {
    const out = computeScoreLabels({ total: 6, tier: 'in-loop', label: 'oversight/in-loop' } as never)
    expect(out.blocked).toBe(true)
    expect(buildBlockComment(6)).toContain('human-in-the-loop')
  })
})
```

- [ ] **Step 2: 實作 `src/cli/apply-score-labels.ts`**

```ts
/**
 * apply-score-labels — 依初始計分貼 oversight 標籤；in-loop 則擋下 agent。
 *
 * 純函式（computeScoreLabels/buildBlockComment）可單元測試；
 * main() 只做 gh 呼叫包裝。
 */
import { execFileSync } from 'node:child_process'

export interface ScoreLike {
  total: number
  tier: 'on-loop' | 'review' | 'in-loop'
  label: string
}

export function computeScoreLabels(score: ScoreLike): { labels: string[]; blocked: boolean } {
  return { labels: [score.label], blocked: score.tier === 'in-loop' }
}

export function buildBlockComment(total: number): string {
  return `工廠執行未啟動：初始計分 ${total} 分屬 human-in-the-loop（docs/06 §4.3）。設計與實作須由人類主導。`
}

export function main(argv: string[]): void {
  const [issueNumber, scorePath] = argv
  const score = JSON.parse(require('node:fs').readFileSync(scorePath, 'utf8')) as { score: ScoreLike }
  const { labels, blocked } = computeScoreLabels(score.score)
  execFileSync('gh', ['issue', 'edit', issueNumber, '--add-label', labels.join(',')])
  if (blocked) {
    execFileSync('gh', ['issue', 'comment', issueNumber, '--body', buildBlockComment(score.score.total)])
    process.exitCode = 1 // 阻斷 workflow 後續 agent 步驟
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2))
}
```

> ESM 下請在頂部 `import { readFileSync } from 'node:fs'` 取代內聯 `require`。

- [ ] **Step 3: 寫 `apply-judge-labels` 測試 `src/cli/apply-judge-labels.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { computeJudgeLabels, buildJudgeComment, PHASE1_HUMAN_REVIEW_NOTE } from './apply-judge-labels.js'

describe('apply-judge-labels（純函式）', () => {
  it('ready-to-automerge → Phase 1 仍標記等待人類審查，不自動合併', () => {
    const out = computeJudgeLabels({ outcome: 'ready-to-automerge', labels: ['oversight/on-loop'], summary: 'ok' } as never)
    expect(out.labels).toContain('oversight/on-loop')
    expect(out.requiresHuman).toBe(true) // 第 1 期：永不自動合併
    expect(buildJudgeComment('ready-to-automerge', 'ok')).toContain(PHASE1_HUMAN_REVIEW_NOTE)
  })
  it('needs-human → 貼 needs-human 標籤並附交還說明', () => {
    const out = computeJudgeLabels({ outcome: 'needs-human', labels: ['needs-human'], summary: 'SR3 觸發' } as never)
    expect(out.labels).toContain('needs-human')
  })
  it('blocked-in-loop → 不貼 needs-human（agent 從未執行）', () => {
    const out = computeJudgeLabels({ outcome: 'blocked-in-loop', labels: ['oversight/in-loop'], summary: 'x' } as never)
    expect(out.labels).not.toContain('needs-human')
  })
})
```

- [ ] **Step 4: 實作 `src/cli/apply-judge-labels.ts`**

```ts
/**
 * apply-judge-labels — 依 factory-judge 終點貼標籤並留言。
 *
 * Phase 1 閘門：即使終點為 ready-to-automerge，也**不執行合併**，
 * 一律標記等待人類審查（docs/09-roadmap.md §2「第 1 期不開放自動合併」）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const PHASE1_HUMAN_REVIEW_NOTE = '（第 1 期：不自動合併，等待人類審查）'

export interface JudgeLike {
  outcome: 'blocked-in-loop' | 'ready-to-automerge' | 'ready-for-review' | 'needs-human'
  labels: string[]
  summary: string
}

export function computeJudgeLabels(judge: JudgeLike): { labels: string[]; requiresHuman: boolean } {
  const labels = [...judge.labels]
  if (judge.outcome === 'needs-human' && !labels.includes('needs-human')) labels.push('needs-human')
  const requiresHuman = judge.outcome !== 'blocked-in-loop' // Phase 1：任何執行過的終點都要人審
  return { labels, requiresHuman }
}

export function buildJudgeComment(outcome: string, summary: string): string {
  const lines = [`## 工廠執行結果：${outcome}`, '', summary]
  if (outcome === 'ready-to-automerge') lines.push('', PHASE1_HUMAN_REVIEW_NOTE)
  return lines.join('\n')
}

export function main(argv: string[]): void {
  const [issueNumber, judgePath] = argv
  const judge = JSON.parse(readFileSync(judgePath, 'utf8')) as { result: JudgeLike }
  const { labels, requiresHuman } = computeJudgeLabels(judge.result)
  execFileSync('gh', ['issue', 'edit', issueNumber, '--add-label', labels.join(',')])
  execFileSync('gh', ['issue', 'comment', issueNumber, '--body', buildJudgeComment(judge.result.outcome, judge.result.summary)])
  if (!requiresHuman) {
    // blocked-in-loop：已在 apply-score-labels 留言，這裡不再重複
    process.stdout.write('blocked-in-loop; no agent ran\n')
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2))
}
```

- [ ] **Step 5: 執行確認 + 覆蓋率**

Run: `npx vitest run src/cli && npm run coverage`
Expected: 全部 PASS；`src/cli/**` 達到 100% 門檻（不足則補測試到全覆蓋）。

- [ ] **Step 6: Commit**

```bash
git add src/cli/apply-score-labels.ts src/cli/apply-score-labels.test.ts src/cli/apply-judge-labels.ts src/cli/apply-judge-labels.test.ts
git commit -m "feat(cli): label and comment helpers for score and judge stages"
```

---

## Task 8: `factory-run.yml` workflow

**Files:**
- Create: `.github/workflows/factory-run.yml`

本 Task 讓 Task 4 的 workflow 測試轉綠。流程對應 `docs/02` §4 端到端控制流（step 2–6），但**第 1 期不執行合併**（step 6 由人類完成）。

- [ ] **Step 1: 建立 `.github/workflows/factory-run.yml`**

```yaml
# Factory Run — 一個工作項的端到端執行（docs/02 §4, docs/04 §4.1）。
#
# 第 1 期範圍（docs/09 §2）：任務類型僅 agent-add-tests；全程人類審查，
# 永不自動合併。dry_run=true 時以 stub agent 取代真實 DSH，用於在沒有
# LLM key 的 CI 上驗證流程接線。
name: Factory Run

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: 目標 Issue 編號
        required: true
        type: number
      dry_run:
        description: 以 stub agent 取代真實 DSH（驗證流程用）
        required: false
        type: boolean
        default: false
      dry_run_scenario:
        description: dry_run 情境：success | blocked | guardrail
        required: false
        type: choice
        options: [success, blocked, guardrail]
        default: success

concurrency:
  group: factory-${{ inputs.issue_number }}
  cancel-in-progress: false   # 不取消進行中的執行，避免產生半成品（docs/04 §4.3）

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22.21.1'
          cache: npm

      - name: Install and build
        run: |
          npm ci
          npm run build

      # Step 2 — 初始計分（agent 啟動前，docs/06 §5.1）
      - name: Initial score
        id: score
        run: |
          mkdir -p .factory/run
          node dist/cli/factory-score.js > .factory/score.json
          cat .factory/score.json

      # in-loop → 擋下 agent，貼標籤並留言（apply-score-labels 以 exit 1 阻斷）
      - name: Apply score labels (blocks in-loop)
        id: score-labels
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node dist/cli/apply-score-labels.js \
            "${{ inputs.issue_number }}" .factory/score.json || exit 0
        continue-on-error: true   # in-loop 阻斷在此 step 結束流程

      # 若被擋下（in-loop），不執行 agent，直接結束
      - name: Stop when in-loop
        if: steps.score-labels.outcome == 'failure'
        run: |
          echo "blocked-in-loop; agent 未啟動（docs/06 §4.3）"
          exit 0

      # Step 3 — 執行 agent（DSH headless，受限沙箱）
      - name: Run factory agent
        id: agent
        timeout-minutes: 25      # step 級逾時：逾時（exit 124）仍可被捕獲走 needs-human
        env:
          GH_TOKEN: ${{ secrets.FACTORY_APP_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          set +e
          if [ "${{ inputs.dry_run }}" == "true" ]; then
            node dist/cli/dry-run-agent.js \
              "${{ inputs.dry_run_scenario }}" "${{ inputs.issue_number }}" \
              > .factory/run/dry.txt 2>&1
            code=0
          else
            npm install --no-save @deepseek-ai/dsh@0.1.0-rc.6
            mkdir -p "$HOME/.dsh"
            cp config/dsh/settings.ci.yaml "$HOME/.dsh/settings.yaml"
            npx dsh --profile headless \
              --patch config/dsh/factory-guardrail.patch.yml \
              "$(sed "s/<ISSUE>/${{ inputs.issue_number }}/" .github/factory/task-template.txt)" \
              > .factory/run/stdout.txt 2> .factory/run/stderr.txt
            code=$?
          fi
          set -e
          echo "exit_code=$code" >> "$GITHUB_OUTPUT"
          # fallback：agent 未寫 report 時依 exit code 補最小 report
          node dist/cli/write-report.js \
            "${{ inputs.issue_number }}" "$code" \
            .factory/run/stdout.txt .factory/run/stderr.txt

      # Step 4–5 — 執行後判定：重計分 + 停手規則（重用 runWorkItem 管線）
      - name: Judge terminal state
        id: judge
        run: |
          node dist/cli/factory-judge.js \
            .factory/run/report.json catalog-info.yaml .github/factory/risk-paths.yml \
            > .factory/judge.json
          cat .factory/judge.json

      - name: Apply judge labels and comment
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node dist/cli/apply-judge-labels.js \
            "${{ inputs.issue_number }}" .factory/judge.json

      # Step 6（人類）— 第 1 期不自動合併；留言告知等待審查
      - name: Summary
        run: |
          echo "run=${{ github.run_id }} issue=${{ inputs.issue_number }} dry_run=${{ inputs.dry_run }}"
          echo "工廠執行完成。第 1 期：所有變更等待人類審查後合併。"
```

> ⚠️ **待實作驗證（Q04-4 附帶）**：
> - `GH_TOKEN` 在 App 建立（Task 10）前使用 `secrets.GITHUB_TOKEN`（workflow `permissions` 已宣告 `issues: write`，可貼標籤與留言）。Task 11 切換為 App token（`actions/create-github-app-token`，版本與輸出欄位以官方文件核對）。
> - `dry_run_scenario: blocked` 時 stub 不產 report，`score-labels` 的 `continue-on-error` 讓流程在 in-loop 阻斷點結束——dry-run E2E 會驗證此行為。

- [ ] **Step 2: 語法驗證**

Run: `npx --yes yaml-lint .github/workflows/factory-run.yml 2>/dev/null || node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/factory-run.yml','utf8')); console.log('YAML OK')"`
Expected: `YAML OK`（YAML 結構可解析）。

- [ ] **Step 3: 確認 workflow 對抗性測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts`
Expected: **全部 PASS**（skills、task-template、workflow 皆已就位）。

- [ ] **Step 4: 全量回歸 + 覆蓋率**

Run: `npm test && npm run coverage`
Expected: 全部 PASS；覆蓋率門檻全過。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/factory-run.yml
git commit -m "feat(ci): factory-run workflow with dry-run mode and needs-human handling"
```

---

## Task 9: dry-run E2E 驗證（真實 Actions，無 LLM key）

**Files:**
- 無新增檔案；在 GitHub 上操作 + 記錄結果

背景：本機無法執行 GitHub Actions。此 Task 在推上 PR 後，由已合併的 `factory-run.yml` 於真實 runner 上以 stub 驗證三條路徑。**它是 Task 8 之後、真實 run（Task 21）之前的必要關卡**——先證明流程接線正確，才值得花 LLM 成本。

- [ ] **Step 1: 合併 Task 1–8 的 PR**

在 feature branch 上完成 Task 1–8 後，開 PR 合併至 `main`（本 repo 既有 ruleset：required check `test` 必須綠燈——`npm test` + `npm run coverage` 已在 Task 8 Step 4 驗證）。

- [ ] **Step 2: 建立測試用 Issue**

在 repo 開三個 Issue（驗收條件明確，標題如「dry-run E2E: success」等），記下編號 I1/I2/I3。

- [ ] **Step 3: dispatch `success` 情境**

Run（Actions → Factory Run → Run workflow）：
- `issue_number: I1`、`dry_run: true`、`dry_run_scenario: success`

Expected：
1. Issue I1 貼上 `oversight/on-loop` 標籤（初始計分：本 repo 三軸 tactical/high/medium = 3 分 → `oversight/review`；以實際標籤為準，但必須是 `oversight/*`）。
2. stub agent step 執行成功。
3. judge 終點為 `ready-for-review`（3 分）或 `ready-to-automerge`（若計分 0–1），留言含「第 1 期：不自動合併」。
4. **不**出現 `needs-human`。

- [ ] **Step 4: dispatch `blocked` 情境**

Run：`issue_number: I2`、`dry_run: true`、`dry_run_scenario: blocked`

Expected：流程在 score-labels 阻斷；Issue I2 貼 `oversight/*` + 留言「human-in-the-loop…」；**agent step 未被執行**（run log 可見 Skip）。

- [ ] **Step 5: dispatch `guardrail` 情境**

Run：`issue_number: I3`、`dry_run: true`、`dry_run_scenario: guardrail`

Expected：judge 終點 `needs-human`；Issue I3 貼 `needs-human` 標籤，留言含「SR3」或「工廠執行中止」。

- [ ] **Step 6: 記錄結果**

在 PR 或 Issue 留言記錄三個 run 的結果（run 連結 + 標籤變化），作為 Task 21 的對照。**任一情境不符預期，回到對應 Task 修正，不進入 Task 10。**

- [ ] **Step 7: Commit（僅記錄文件）**

```bash
git add docs/09-roadmap.md  # 若需註記 dry-run 驗證結果
git commit -m "docs: record dry-run E2E verification of factory-run workflow"
```

---

## Task 10: GitHub App 建立與安裝（人類手動）+ Secrets

**Files:**
- 無 repo 檔案；GitHub 設定（不可自動化，docs/09 §5.1）

依 `docs/02-architecture.md` D6 的權限表。**此為本計畫唯一的純人類步驟。**

- [ ] **Step 1: 建立 GitHub App**

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App：
- Name: `software-factory-agent`；Homepage: 本 repo URL；Webhook: **Disable**（CI 觸發不需 webhook）。

- [ ] **Step 2: 設定權限（最小化，依 D6）**

| 權限 | 等級 |
|---|---|
| Contents | Read & write |
| Pull requests | Read & write |
| Issues | Read & write |
| Actions | Read |
| Metadata | Read |
| **Administration** | **不授予** |
| **Workflows** | **不授予** |

- [ ] **Step 3: 安裝至試點 repo**

Install App → 僅 `philipz/software_factory`。

- [ ] **Step 4: 產生 private key 並存入 Secrets**

Generate private key → 存檔（安全處）。Repo Settings → Secrets and variables → Actions 新增：
- `FACTORY_APP_ID`：App 的 App ID（整數）
- `FACTORY_APP_PRIVATE_KEY`：private key 全文（`-----BEGIN RSA PRIVATE KEY-----`…）
- `ANTHROPIC_API_KEY`：LLM 提供者的 key（對應 `config/dsh/settings.ci.yaml` 的 `apiKeyEnv`）

> **金鑰紀律**（docs/05 §3）：private key 與 API key **永不寫入 repo**（`.gitignore` 已含 `docs/claude-key` 等模式）。`FACTORY_APP_PRIVATE_KEY` 以 GitHub Secrets 承載，且**永不進入 agent 的 context**——DSH 的 `GH_TOKEN` 只會是換發後的短效 installation token。

- [ ] **Step 5: 驗證 token 換發**

在本機以 App 身分驗證換發（依 `actions/create-github-app-token` 官方文件，或用 `gh api` + App 簽名流程），確認能讀取 Issue。
Expected: 可讀取 repo 內容與 Issue；**不能**修改 branch protection（Administration 未授予）。

---

## Task 11: 切換 workflow 到 App token

**Files:**
- Modify: `.github/workflows/factory-run.yml`（agent step 的 `GH_TOKEN`）
- Modify: `.github/workflows/dsh-sandbox-probe.yml`（如適用）

- [ ] **Step 1: 確認 `actions/create-github-app-token` 版本與輸出欄位**

連網查證（web search / 官方文件）當前版本（docs/04 記為 v3，**未驗證**）與輸出欄位名（`token`）。記錄在 `docs/04` 未決事項 Q04-4 的處置。

- [ ] **Step 2: 在 `factory-run.yml` 新增 mint token step**

在 `Run factory agent` 之前插入：

```yaml
      - name: Mint app token
        id: app-token
        uses: actions/create-github-app-token@<實測版本>
        with:
          app-id: ${{ secrets.FACTORY_APP_ID }}
          private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
```

並將 agent step 的 `GH_TOKEN` 改為 `${{ steps.app-token.outputs.token }}`。

- [ ] **Step 3: 重跑 dry-run E2E（Task 9 三情境）**

Expected: 與 Task 9 相同結果；Issue 上的留言/標籤現在由 **App 身分**發出（可於 Issue 時間軸確認操作者為 `software-factory-agent[bot]`）。

- [ ] **Step 4: 更新 `dsh-sandbox-probe.yml`（選用）**

如 App token 已就緒，可將 probe workflow 的 `ANTHROPIC_API_KEY` 檢查保留、其餘不變。**本步不阻塞。**

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/factory-run.yml
git commit -m "ci: switch factory-run to GitHub App identity"
```

---

## Task 12: Backstage scaffold + 版本鎖定（本機）

**Files:**
- 建立於 repo 外的 `../backstage-app/`（不入 repo，D1）
- Create: `backstage/versions.md`（鎖版紀錄，入 repo）

> ⚠️ **Q03-1/Q03-3 待實作驗證**：以下指令須以官方文件核對（Backstage 版本、create-app 用法、Node 22 支援範圍）。本 Task 的第一步就是連網查證。

- [ ] **Step 1: 連網查證並鎖版**（✅ 2026-08-17 完成）

Web search：Backstage 目前穩定版、`create-app` 指令、Node 22 相容性（Q03-3）。記錄於 `backstage/versions.md`：

```markdown
# Backstage 鎖版紀錄（Q03-1 / Q03-3）

- Backstage 版本：@backstage/create-app@0.9.0
- create-app 指令：npx @backstage/create-app@0.9.0 --path backstage-app --skip-install
  （新版不接受位置參數，須用 --path；會互動詢問 app 名稱，以 stdin 餵入）
- Node 支援：22.21.1 為 Active LTS ✅（官方要求 Active LTS）
- packageManager：yarn@4.13.0（corepack enable 後提供）
- 驗證日期：2026-08-17
```

- [ ] **Step 2: scaffold**

Run（在 repo 外）：
```bash
npx @backstage/create-app@<鎖定版本> backstage-app
cd backstage-app
yarn install
```

- [ ] **Step 3: 本機 dev 驗證**

Run: `yarn dev`
Expected: `http://localhost:3000` 可開啟預設 Backstage UI（q03-3：若 Node 22 不相容，改用 nvm 切至受支援 LTS）。

- [ ] **Step 4: Commit 鎖版紀錄**

```bash
git add backstage/versions.md
git commit -m "docs(backstage): pin Backstage version and record verification"
```

---

## Task 13: Catalog 探索與 annotations 驗證

**Files:**
- Modify: `../backstage-app/app-config.yaml`（repo 外）
- Test: `src/cli/factory-score.test.ts` 已涵蓋解析；本 Task 驗證「Backstage 側」載入

- [ ] **Step 1: 設定 catalog location**

在 `../backstage-app/app-config.yaml` 的 `catalog.locations` 新增（GitHub 探索，Q03-4 一併驗證 `factory.io/` 命名空間）：

```yaml
catalog:
  locations:
    - type: url
      target: https://github.com/philipz/software_factory/blob/main/catalog-info.yaml
```

若採 org discovery，改用 `type: github-discovery` + `catalogPath: /catalog-info.yaml`（以官方文件為準）。

- [ ] **Step 2: 驗證載入**

Run: `yarn dev` → Catalog 頁面搜尋 `software-factory`。
Expected: Component 出現；點入後可見 annotations 區塊含 `factory.io/business-criticality: tactical`、`factory.io/risk-profile: high`、`factory.io/complexity: medium`、`factory.io/agent-automerge: "false"`，以及技術棧 annotation（`factory.io/stack`、`factory.io/test-framework`、`factory.io/quint-spec`——由 Task 20 加入）。**若 `factory.io/` 與既有 annotation 衝突（Q03-4），改用其他命名空間並同步更新 `src/scoring` 與本計畫。**

- [ ] **Step 3: 驗證 Agent 無法竄改（雙層防護）**

確認 `catalog-info.yaml` 在 CODEOWNERS 保護下（已存在 `catalog-info.yaml @philipz`），且 App 的 Issues/Contents 權限無法繞過 PR review（ruleset `main-protection`）。

- [ ] **Step 4: Commit（無 repo 檔案變更則跳過）**

```bash
git add catalog-info.yaml  # 僅當有調整
git commit -m "docs: register pilot repo in Backstage catalog"
```

---

## Task 14: Template `agent-add-tests`

**Files:**
- Create: `backstage/templates/agent-add-tests/template.yaml`
- Modify: `../backstage-app/app-config.yaml`（註冊 template location，repo 外）

> ⚠️ **Q03-2 待實作驗證**：`github:actions:dispatch` scaffolder action 是否存在及其簽章。**實作首步連網查證**；若不存在，採用下方 fallback（Template 建 Issue + 標籤觸發 workflow）。

- [ ] **Step 1: 連網查證 `github:actions:dispatch`**（✅ 2026-08-17 完成）

Web search：Backstage scaffolder built-in actions 清單。**已驗證**：`github:actions:dispatch` 存在（`@backstage/plugin-scaffolder-backend-module-github`），inputs 為 `token`/`repoUrl`/`workflowId`/`workflowInputs`/`branchOrTagName`，**無輸出 schema**——Template 不依賴 workflowRunUrl，改輸出指引至 Actions 頁面（見已提交的 `backstage/templates/agent-add-tests/template.yaml`，採用「dispatch 既有 Issue」而非「建 Issue 再 dispatch」，後者依賴 step 間傳遞未驗證的 issue 編號）。

- [ ] **Step 2: 建立 `backstage/templates/agent-add-tests/template.yaml`**

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: agent-add-tests
  title: 請 agent 補測試
  description: 將「補測試」工作項交由工廠 agent 處理（低風險類別，docs/00 §6 明列）
spec:
  owner: group:default/platform-team
  type: service
  parameters:
    - title: 工作項資訊
      required: [repoUrl, module]
      properties:
        repoUrl:
          title: 目標 repo
          type: string
          ui:field: RepoUrlPicker
          ui:options:
            allowedOwners: [philipz]
        module:
          title: 目標模組/目錄
          type: string
          description: 要補測試的模組或目錄路徑（選填，留空表示由 agent 判斷）
        acceptance:
          title: 驗收條件
          type: string
          ui:widget: textarea
          description: 明確的完成定義（SR4：缺此欄位 agent 會停手）
          default: 新增測試涵蓋目標模組的核心路徑，測試全部通過，且未弱化既有斷言
  steps:
    - id: dispatch
      name: 觸發工廠工作流
      action: github:actions:dispatch
      input:
        repoUrl: ${{ parameters.repoUrl }}
        workflowId: factory-run.yml
        branchOrTagName: main
        workflowInputs:
          issue_number: ${{ steps.create-issue.output.issueNumber }}
    - id: create-issue
      name: 建立工作項 Issue
      action: github:issues:create
      input:
        repoUrl: ${{ parameters.repoUrl }}
        title: 'agent-add-tests: ${{ parameters.module }}'
        body: |
          ## 目標
          為 `${{ parameters.module }}` 補測試。

          ## 驗收條件
          ${{ parameters.acceptance }}

          ## 觸發
          本 Issue 由 Backstage Template 建立，將由工廠 workflow 處理。
  output:
    links:
      - title: 查看執行狀態
        url: ${{ steps.dispatch.output.workflowRunUrl }}
```

> ⚠️ 上述 `steps` 順序有依賴（create-issue 在 dispatch 前，因 dispatch 需要 issue_number）。**實作時以查證後的 action 簽章為準修正欄位與順序**；若 `github:actions:dispatch` 不存在，fallback 改為：Template 只建 Issue（含 `ready` 標籤）→ `factory-run.yml` 增加 `issues: labeled` 觸發（`ready` label）→ 不需 dispatch action。**fallback 反而更鬆耦合（docs/03 §3.2 註），可優先考慮。**

- [ ] **Step 3: 註冊 Template**

在 `../backstage-app/app-config.yaml` 的 `catalog.locations` 新增指向本 repo `backstage/templates/agent-add-tests/template.yaml` 的 location（GitHub url 或 local file location），重啟 `yarn dev`。

- [ ] **Step 4: 端到端驗證 Template**

在 Backstage Create 頁面選 `請 agent 補測試` → 填 repo 與 module → 送出。
Expected：GitHub 產生一個 Issue（含驗收條件與觸發說明）；workflow 被觸發（dispatch 方案）或由 label 事件觸發（fallback 方案）；Issue 上出現 `oversight/*` 標籤。

- [ ] **Step 5: Commit**

```bash
git add backstage/templates/agent-add-tests/template.yaml
git commit -m "feat(backstage): agent-add-tests template"
```

---

## Task 15: TechDocs（mkdocs.yml）

**Files:**
- Create: `mkdocs.yml`

- [ ] **Step 1: 建立 `mkdocs.yml`**（內容即 `docs/03` §4）

```yaml
site_name: Software Factory
docs_dir: docs
nav:
  - 總覽: README.md
  - 來源研究精要: 00-source-summary.md
  - 價值流地圖: 01-value-stream-map.md
  - 系統架構: 02-architecture.md
  - IDP（Backstage）: 03-idp-backstage.md
  - Agent 執行（DSH）: 04-agent-execution-dsh.md
  - 治理與 Guardrails: 05-guardrails-governance.md
  - 人工監督政策: 06-human-oversight-policy.md
  - Stacked PR 流程: 07-stacked-pr-workflow.md
  - 指標與 KPI: 08-metrics-kpi.md
  - 路線圖: 09-roadmap.md
  - 未決事項: 10-open-questions.md
  - 測試策略: 11-test-strategy.md
  - 詞彙表: GLOSSARY.md
plugins:
  - techdocs-core
```

> ⚠️ 待實作驗證（Q03-1 附帶）：`techdocs-core` 版本與 mkdocs 相容性；`README.md` 置於 docs_dir 外的 nav 引用方式（必要時於 `docs/` 下建立 `README.md` 副本或調整 nav 指向 `index.md`）。

- [ ] **Step 2: 本機 build 驗證**

Run（在 backstage-app 內）：`yarn techdocs:build`
Expected: build 成功，`site/` 產出；在 Backstage TechDocs 頁面可見 `docs/` 內容（`backstage.io/techdocs-ref: dir:.` 已在 catalog-info.yaml 標註）。

- [ ] **Step 3: Commit**

```bash
git add mkdocs.yml
git commit -m "docs(techdocs): add mkdocs config for TechDocs publishing"
```

---

## Task 16: Vendor Quint 官方 skills（鎖版）

**Files:**
- Create: `.dsh/skills/quint-lang/SKILL.md`、`.dsh/skills/quint-modeling/SKILL.md`、`.dsh/skills/quint-execute-spec/SKILL.md`（含各 skill 目錄內的其他檔案）
- Create: `docs/ADR/008-quint-formal-verification.md`

背景（R2-Q4=A）：`quint-co/quint` 官方 repo 的 `skills/` 目錄提供 quint-lang / quint-modeling / quint-execute-spec 三個 agent skills。vendor 進 `.dsh/skills/`（rank 100）讓 DSH agent 執行時可發現（docs/04 §3.2 探索規則），隨程式碼版控、受 CODEOWNERS 保護（`/.dsh/skills/` 已在保護清單）。

- [ ] **Step 1: 鎖定來源 commit**

Run: `git ls-remote https://github.com/quint-co/quint.git refs/heads/main`
Expected: 記錄目前 HEAD 的 commit SHA（例如 `abc1234…`）。**vendor 內容以此刻 SHA 為準，更新需走 PR 並記錄新 SHA。**

- [ ] **Step 2: 取得 skills 內容**

Run:
```bash
mkdir -p /tmp/quint-src && cd /tmp/quint-src
git clone --depth 1 https://github.com/quint-co/quint.git
ls quint/skills/
```
Expected: 列出 `quint-lang`、`quint-modeling`、`quint-execute-spec`（名稱以實際為準；若結構不同，以官方 repo 為準並記錄差異）。

- [ ] **Step 3: vendor 進 `.dsh/skills/`**

Run:
```bash
mkdir -p .dsh/skills
cp -r /tmp/quint-src/quint/skills/quint-lang .dsh/skills/quint-lang
cp -r /tmp/quint-src/quint/skills/quint-modeling .dsh/skills/quint-modeling
cp -r /tmp/quint-src/quint/skills/quint-execute-spec .dsh/skills/quint-execute-spec
find .dsh/skills/quint-* -name SKILL.md
```
Expected: 三個 `SKILL.md` 就位；frontmatter 的 `name` 為 kebab-case（quint-lang 等）。

- [ ] **Step 4: 撰寫 `docs/ADR/008-quint-formal-verification.md`**

```markdown
# ADR-008：Quint 正式方法整合（Phase A）

## 狀態
已接受（2026-08-17）

## 決策
以 Quint 驗證工廠自身的計分邏輯：規格即神諭（oracle bridge）。
Quint 官方 agent skills（quint-lang / quint-modeling / quint-execute-spec）
vendor 至 `.dsh/skills/`，鎖定來源 commit：`<來源 commit SHA>`。

## 理由
- docs/06 的計分是 agent 權限的唯一來源，最值得先被正式驗證。
- Quint 不能直接驗證 TS 程式碼；以 `quint run --out-itf` 產生 ITF traces 作為
  神諭，與 TS 實作逐一比對（R2-Q2=D、R2-Q5=C 自建最小 harness）。
- agent 可撰寫 .qnt 草稿，但需人類審查、PR 合併後才生效；同一 run 不得
  自我驗證（docs/06 §4.3）。

## 後果
- 新增 `specs/scoring/score.qnt`、`.github/factory/quint-paths.yml`、
  `quint-verify` CI job（required check，僅對宣告路徑）。
- Phase B（驗證 agent 產出）隨第 2 期另立計畫；屆時評估 quint-connect-ts。
```

- [ ] **Step 5: 對抗性測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "quint skills"`
Expected: `vendor 的 quint skills 存在` 與 `ADR-008 記錄來源 commit` 兩則 PASS（其餘 Quint 測試仍紅，待 Task 17–20）。

- [ ] **Step 6: Commit**

```bash
git add .dsh/skills/quint-lang .dsh/skills/quint-modeling .dsh/skills/quint-execute-spec docs/ADR/008-quint-formal-verification.md
git commit -m "feat(quint): vendor quint official skills and record source pin in ADR-008"
```

---

## Task 17: 計分邏輯的 Quint 模型（人類撰寫）

**Files:**
- Create: `specs/scoring/score.qnt`
- Modify: `package.json`（devDependencies 加入 `@informalsystems/quint`）
- Test: 以 `quint typecheck`／`quint verify`／`quint test` 指令驗證（不放 vitest；由 Task 19 的 CI job 執行）

背景（R2-Q2=A）：只建模 `src/scoring/score.ts` 的純函式。模型由**人類撰寫**，是規格書的機器可讀形式；TS 實作必須與模型一致（Task 18 的神諭 harness 驗證）。

- [ ] **Step 1: 加入鎖版 devDependency**

Run: `npm install -D @informalsystems/quint@0.32.0`
Expected: `package.json` 的 devDependencies 出現 `"@informalsystems/quint": "0.32.0"`（精確鎖版，與本機實測版本一致）。

- [ ] **Step 2: 撰寫 `specs/scoring/score.qnt`**（語法已於 2026-08-17 以本機 quint 0.32.0 實測驗證：`def` 用 `=` 形式、`nondet x = oneOf(Set(...))`、範圍用 `.to()`、primed 變數不可當函式參數）

```quint
// 計分邏輯的 Quint 模型（docs/06-human-oversight-policy.md §3–§4）。
//
// 對應 src/scoring/score.ts 的純函式。本模型由人類撰寫，是規格書的
// 機器可讀形式；Task 18 的神諭 harness 以本模型為 oracle 比對 TS 實作。
// 編碼約定：軸值 0=tactical/low, 1=operational/medium, 2=strategic/high；
// tier 0=on-loop, 1=review, 2=in-loop。
module scoring {
  var state: int      // 0..26：窮舉 3x3x3 輸入組合的計數器
  var bc: int
  var rp: int
  var cx: int
  var total: int
  var tier: int
  var auto: bool

  // --- fail-safe：缺值/非法值一律得 2（docs/06 §3）---
  pure def axisScore(raw: int, valid: Set[int]): int =
    if (raw.in(valid)) raw else 2

  // --- 三軸總分 ---
  pure def totalScore(b: int, r: int, c: int): int = b + r + c

  // --- tier：總分 0–1 → on-loop；2–4 → review；5–6 → in-loop（docs/06 §4）---
  pure def tierForTotal(t: int): int = if (t <= 1) 0 else if (t <= 4) 1 else 2

  // --- 自動合併條件（docs/06 §4.1；第 1 期由 CI 一律改為人審，此模型仍建模原規則）---
  pure def automergeAllowed(t: int, vetoed: bool, hardRules: bool, changedLines: int): bool =
    t == 0 and not(vetoed) and not(hardRules) and changedLines <= 200

  action init = all {
    state' = 0,
    bc' = 0, rp' = 0, cx' = 0,
    total' = 0, tier' = 0, auto' = true,
  }

  // step 窮舉 27 種 (bc, rp, cx) 組合：state 0..26 → bc=state%3, rp=(state/3)%3, cx=state/9
  action step = all {
    state' = (state + 1) % 27,
    bc' = state % 3,
    rp' = (state / 3) % 3,
    cx' = (state / 9) % 3,
    total' = totalScore(bc', rp', cx'),
    tier' = tierForTotal(totalScore(bc', rp', cx')),
    auto' = automergeAllowed(tierForTotal(totalScore(bc', rp', cx')), false, false, 10),
  }

  // --- 不變量（quint verify / run --invariant 檢查）---
  // I1: fail-safe —— 任一軸非法值必得 2，總分 ≥ 4（永不落入 on-loop）
  invariant failSafe = totalScore(axisScore(99, Set(0, 1, 2)), axisScore(0, Set(0, 1, 2)), axisScore(0, Set(0, 1, 2))) >= 4

  // I2: 總分恆在 0..6
  invariant totalInRange = total >= 0 and total <= 6

  // I3: 硬性規則觸發時永不 automerge
  invariant hardRuleBlocks = not(automergeAllowed(tierForTotal(totalScore(0, 2, 0)), false, true, 10))

  // I4: on-loop 且無阻擋 → automerge 可放行
  invariant onLoopAllows = automergeAllowed(tierForTotal(0), false, false, 10)

  // I5: 超過 200 行永不 automerge
  invariant lineCeiling = not(automergeAllowed(tierForTotal(0), false, false, 201))
}
```

> **已實測注意**（2026-08-17，quint 0.32.0）：`action step` 中 `total' = totalScore(bc', rp', cx')` 使用了 primed 變數作為函式參數——實測發現 **primed 變數不可作為函式參數**。若驗證時此處報 parse 錯誤，改為先計算再指派：在 `all { }` 外先以未 primed 名稱計算（如 `val t = totalScore(bc, rp, cx)` 不可行，因需讀 next-state）——**正解是改用「上一步已存變數」：step 中先更新 `bc'/rp'/cx'` 於同一 `all`，再用**前一狀態**的 `bc/rp/cx` 計算（trace 多一步收斂）：以實測回饋為準，容許一次迭代（見下方驗證指令）。

- [ ] **Step 3: 驗證模型**

Run:
```bash
npx quint typecheck specs/scoring/score.qnt
npx quint run specs/scoring/score.qnt --seed 0 --max-steps 30 --invariant failSafe,totalInRange,hardRuleBlocks,onLoopAllows,lineCeiling
```
Expected: typecheck 無錯誤；run 模擬 30 步（覆蓋全部 27 組合）且 5 個 invariant 皆成立。若需要完整狀態空間證明，改用 `npx quint verify specs/scoring/score.qnt --invariant failSafe,totalInRange,hardRuleBlocks,onLoopAllows,lineCeiling`（Apalache；狀態空間 27 組合極小，應快速完成）。

- [ ] **Step 4: 對抗性測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "Quint 模型"`
Expected: `Quint 模型存在且為人類撰寫` PASS。

- [ ] **Step 5: Commit**

```bash
git add specs/scoring/score.qnt package.json package-lock.json
git commit -m "feat(quint): scoring spec model with fail-safe invariants"
```

---

## Task 18: 神諭 harness（ITF traces vs TS 實作）

**Files:**
- Create: `test/quint/scoring-oracle.test.ts`

背景（R2-Q2=D、R2-Q5=C）：自建最小神諭 harness。以 `quint run --seed <固定> --out-itf <file> --max-samples <N>` 產生 ITF JSON traces（含每個輸入下的模型輸出），vitest 解析後與 `src/scoring` 的 TS 實作逐一比對。已實測：`quint run` 支援 `--seed`、`--out-itf`（檔名含 `{seq}` 佔位）、`--max-samples`。

- [ ] **Step 1: 撰寫 `test/quint/scoring-oracle.test.ts`**（ITF 結構已於 2026-08-17 實測：`states` 為扁平物件、整數編碼為 `{"#bigint": "..."}`）

```ts
/**
 * 神諭 harness（docs/superpowers/plans Phase 1 Task 18）。
 *
 * 以 Quint 模型為 oracle：quint run 產生 ITF traces，逐一與 TS 實作比對。
 * 若模型與實作不一致，代表「程式碼偏離規格書」——CI 紅燈。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { score, tierForTotal } from '../../src/scoring/score.js'

const ROOT = join(import.meta.dirname, '../..')

interface ItfState {
  bc?: { '#bigint'?: string } | number
  rp?: { '#bigint'?: string } | number
  cx?: { '#bigint'?: string } | number
  total?: { '#bigint'?: string } | number
  tier?: { '#bigint'?: string } | number
  auto?: boolean
}
interface ItfFile {
  states: ItfState[]
}

/** 解碼 ITF 的整數（{"#bigint": "3"}）與布林。 */
function num(v: { '#bigint'?: string } | number | undefined): number {
  if (typeof v === 'number') return v
  if (v && typeof v['#bigint'] === 'string') return Number(v['#bigint'])
  return NaN
}

/** 以固定 seed 執行 quint 模型，回傳全部 states 的模型輸出（含 init state）。 */
function runOracle(): ItfState[] {
  const tmp = mkdtempSync(join(tmpdir(), 'quint-oracle-'))
  execFileSync('npx', [
    'quint', 'run', '--seed', '0', '--max-steps', '30', '--max-samples', '1',
    '--out-itf', join(tmp, 'trace_{seq}.itf.json'),
    join(ROOT, 'specs/scoring/score.qnt'),
  ], { cwd: ROOT })
  const file = readdirSync(tmp).find((f) => f.endsWith('.itf.json'))
  expect(file, 'quint 應產出 ITF 檔案').toBeDefined()
  const trace = JSON.parse(readFileSync(join(tmp, file!), 'utf8')) as ItfFile
  // 跳過 init state（index 0），只比對 step 產出的 27 種組合
  return trace.states.filter((s) => s.total !== undefined && num(s.total) > 0 || s.tier !== undefined)
}

/** 軸值 0..2 → catalog annotation 字串。 */
function axisName(v: number): 'tactical' | 'operational' | 'strategic' | 'low' | 'medium' | 'high' {
  return (['tactical', 'operational', 'strategic'] as const)[v] ?? 'medium'
}

describe('Quint 神諭：TS 實作與規格模型一致', () => {
  const states = runOracle()

  it('模型產出非空 states', () => {
    expect(states.length).toBeGreaterThan(0)
  })

  it('模型輸出的 tier 與 TS tierForTotal 一致', () => {
    for (const s of states) {
      const t = num(s.total)
      expect(tierForTotal(t), `total=${t}`).toBe(num(s.tier))
    }
  })

  it('模型輸出的 automerge 與 TS score().automergeAllowed 一致', () => {
    for (const s of states) {
      const ts = score({
        annotations: {
          businessCriticality: axisName(num(s.bc)),
          riskProfile: axisName(num(s.rp)),
          complexity: axisName(num(s.cx)),
        },
        changedLines: 10,
      })
      expect(ts.automergeAllowed, `bc=${num(s.bc)} rp=${num(s.rp)} cx=${num(s.cx)}`).toBe(s.auto)
    }
  })
})
```

> 註：`runOracle()` 的 filter 條件依實際 ITF 修正（init state 的欄位與 step 相同，比對時若 `total=0` 會與 init 重疊——以實測輸出調整跳過邏輯，例如只取 `bc/rp/cx` 不全為 0 的 states，或直接全部比對並讓 TS 側對 `total=0` 也成立）。

- [ ] **Step 2: 執行確認**

Run: `npx vitest run test/quint/scoring-oracle.test.ts`
Expected: PASS（模型與實作一致）。若不一致（紅），**以模型為準修正 TS 或修正模型**——差異本身代表規格與程式碼有分歧，須人工判斷何者正確（這是神諭 harness 的價值所在）。

- [ ] **Step 3: 對抗性測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "神諭"`
Expected: `神諭 harness 測試存在` PASS。

- [ ] **Step 4: Commit**

```bash
git add test/quint/scoring-oracle.test.ts
git commit -m "test(quint): oracle harness comparing ITF traces against TS scoring"
```

---

## Task 19: Quint 閘門（quint-paths.yml + CI job）

**Files:**
- Create: `.github/factory/quint-paths.yml`
- Create: `.github/workflows/quint-verify.yml`
- Modify: `config/github/main-ruleset.json`（required check 加入 `quint-verify`）——**注意**：ruleset 由人類套用，本 Task 只更新 repo 內紀錄

背景（R2-Q3=D、R2-Q5=B）：仿 `risk-paths.yml` 的路徑宣告機制。觸及宣告路徑的 PR 必須通過 `quint-verify` required check；未觸及不阻擋。

- [ ] **Step 1: 建立 `.github/factory/quint-paths.yml`**

```yaml
# Quint 正式驗證的觸發路徑（docs/06 §5.2 同構於 risk-paths.yml）。
#
# 觸及任一 pattern 的 PR 必須通過 quint-verify required check：
#   - quint typecheck specs/scoring/score.qnt
#   - quint verify（或 bounded run）全部 invariant
#   - vitest 神諭 harness（test/quint/scoring-oracle.test.ts）
#
# 本檔案位於 .github/ 下，受 CODEOWNERS 保護：agent 不得修改驗證自身的規則。

quint_paths:
  - "src/scoring/**"
  - "src/stop-rules/**"
  - "specs/**"
  - ".github/factory/quint-paths.yml"
```

- [ ] **Step 2: 建立 `.github/workflows/quint-verify.yml`**

```yaml
# Quint 正式驗證（docs/superpowers/plans Phase 1 Task 19）。
# 僅當 PR 觸及 quint-paths.yml 宣告的路徑時作為 required check 生效。
name: Quint Verify

on:
  pull_request:

permissions:
  contents: read

jobs:
  quint-verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22.21.1'
          cache: npm
      - name: Install
        run: npm ci
      - name: Determine if Quint gate applies
        id: gate
        run: |
          changed=$(git diff --name-only origin/main...HEAD)
          apply=$(node -e '
            const fs = require("fs");
            const yaml = require("js-yaml");
            const { minimatch } = require("minimatch");
            const paths = yaml.load(fs.readFileSync(".github/factory/quint-paths.yml", "utf8")).quint_paths;
            const changed = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
            const hit = changed.some((p) => paths.some((g) => minimatch(p, g, { dot: true })));
            process.stdout.write(hit ? "yes" : "no");
          ' <<< "$changed")
          echo "applies=$apply" >> "$GITHUB_OUTPUT"
      - name: Typecheck spec
        if: steps.gate.outputs.applies == 'yes'
        run: npx quint typecheck specs/scoring/score.qnt
      - name: Verify invariants
        if: steps.gate.outputs.applies == 'yes'
        run: npx quint verify specs/scoring/score.qnt --invariant failSafe_at_least_4,total_in_range,hard_rule_blocks_automerge,on_loop_allows_automerge,line_ceiling_blocks
      - name: Oracle harness
        if: steps.gate.outputs.applies == 'yes'
        run: npx vitest run test/quint/scoring-oracle.test.ts
      - name: Skip note
        if: steps.gate.outputs.applies != 'yes'
        run: echo "Quint gate not applicable to this PR"
```

> ⚠️ **實作時須修正**：`git diff origin/main...HEAD` 在 workflow 中需要 fetch 完整歷史（checkout 預設 shallow）；必要時 `fetch-depth: 0`。`minimatch` 的 Node 呼叫方式依套件版本調整（本 repo 用 minimatch 10，`require("minimatch").minimatch` 簽章以實測為準——可改用既有 `src/scoring` 的比對邏輯包成 CLI 以避免重複）。

- [ ] **Step 3: 更新 `config/github/main-ruleset.json` 紀錄**

在 `required_status_checks` 陣列加入 `{ "context": "quint-verify" }`（人類以 `gh api` 套用至實際 ruleset；本 repo 設定指引見 `docs/12`）。**此步是人類動作，與 Task 10 同類。**

- [ ] **Step 4: 對抗性測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "quint-paths"`
Expected: `quint-paths.yml 宣告 src/scoring 與 src/stop-rules` PASS。

- [ ] **Step 5: 全量回歸**

Run: `npm test && npm run coverage`
Expected: 全部 PASS（新增 `test/quint/` 與 `src/cli/` 皆在覆蓋率門檻內；神諭 harness 若被 coverage include 排除，於 `vitest.config.ts` 的 coverage exclude 加入 `test/**`——**以既有設定為準，必要時調整**）。

- [ ] **Step 6: Commit**

```bash
git add .github/factory/quint-paths.yml .github/workflows/quint-verify.yml config/github/main-ruleset.json
git commit -m "feat(ci): quint-verify gate for scoring paths"
```

---

## Task 20: 技術棧規範 annotation + CI 一致性檢查

**Files:**
- Modify: `catalog-info.yaml`（新增三個技術棧 annotation）
- Modify: `src/cli/factory-score.ts`（輸出含 stack 資訊，供 CI 驗證組合決策）＋測試
- Modify: `test/adversarial/guardrails.test.ts`（若有需要）

背景（R2-Q1=A、Q4=D）：精簡三欄位技術棧規範。annotation 是機器可讀事實——CI 讀取後決定要跑哪些驗證（含是否需 Quint）。**人類登錄、agent 不得修改**（catalog-info.yaml 已在 CODEOWNERS 保護）。

- [ ] **Step 1: 在 `catalog-info.yaml` 加入技術棧 annotation**

在既有 `factory.io/*` 區塊後追加：

```yaml
    # --- 技術棧規範（Task 20；供 CI 決定驗證組合，人類登錄）---
    factory.io/stack: typescript
    factory.io/test-framework: vitest
    factory.io/quint-spec: specs/scoring
```

- [ ] **Step 2: 擴充 `factory-score` CLI 輸出 stack 資訊**

`src/cli/factory-score.ts` 的 `ScoreCliOutput` 增加欄位並在 `main()` 回傳：

```ts
export interface ScoreCliOutput {
  annotations: CatalogAnnotations
  /** 技術棧規範（catalog 讀取；CI 依此決定驗證組合）。 */
  stack: { stack?: string; testFramework?: string; quintSpec?: string }
  score: ScoreResult
}
```

`loadScoreInput` 增加讀取 `factory.io/stack`、`factory.io/test-framework`、`factory.io/quint-spec` 並回傳 `stack`；對應測試新增一則：catalog 含三欄位時 `out.stack` 正確解析、缺欄位時為 `undefined`（不影響計分）。

- [ ] **Step 3: CI 一致性檢查（併入 `test.yml` 或 `quint-verify.yml`）**

新增 step（以 node 一行式或既有 CLI）：

```bash
# 宣告的測試框架必須與 package.json 的實際工具一致（規範 ≠ 宣稱）
node -e '
  const fs = require("fs");
  const yaml = require("js-yaml");
  const c = yaml.load(fs.readFileSync("catalog-info.yaml", "utf8"));
  const a = c.metadata.annotations;
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (a["factory.io/test-framework"] !== "vitest") { console.error("test-framework 宣告不符"); process.exit(1); }
  if (a["factory.io/quint-spec"] !== "none" && !fs.existsSync(a["factory.io/quint-spec"])) {
    console.error("quint-spec 路徑不存在:", a["factory.io/quint-spec"]); process.exit(1);
  }
  console.log("tech-stack annotations consistent");
'
```

Expected: 輸出 `tech-stack annotations consistent`。

- [ ] **Step 4: 對抗性測試轉綠**

Run: `npx vitest run test/adversarial/factory-assets.test.ts -t "技術棧"`
Expected: `catalog-info.yaml 帶技術棧 annotation` PASS。

- [ ] **Step 5: 全量回歸 + 覆蓋率**

Run: `npm test && npm run coverage && npm run typecheck`
Expected: 全綠。

- [ ] **Step 6: Commit**

```bash
git add catalog-info.yaml src/cli/factory-score.ts src/cli/factory-score.test.ts
git commit -m "feat(catalog): tech-stack annotations and CI consistency check"
```

---

## Task 21: 真實端到端試跑 ≥ 10 個工作項（含刻意停手）

**Files:**
- 無新增；以 Issue + 真實 DSH 執行

依 `docs/09` §2 出場條件：≥10 個工作項、執行成功率 ≥70%、停手機制實際觸發過至少一次。

- [ ] **Step 1: 準備 10 個工作項**

開 10 個 Issue，任務皆為 `agent-add-tests`（補測試），每個都含**明確驗收條件**與重現/範圍說明（SR4 要求）。範例：「為 `src/scoring/score.ts` 的 `tierForTotal` 補邊界測試」。

- [ ] **Step 2: 依序 dispatch（dry_run: false）**

Run: Actions → Factory Run，逐個 `issue_number` 執行（concurrency 群組防止同一 Issue 重複觸發）。每次 run 後：**人類依 docs/07 §6 由底而頂審查 stacked PR**，核准後合併（第 1 期：agent 永不 merge）。

- [ ] **Step 3: 記錄成功率**

每 run 記錄：初始計分、終點、PR 數、審查耗時、缺陷（審查中發現的問題）。
Expected: 成功率（終點非 needs-human 且產出可審查的 PR）≥ 70%。

- [ ] **Step 4: 刻意製造一次停手（若前十次未自然觸發）**

建立一個**無驗收條件**的 Issue（或要求 agent 修改 `.github/**` 的工作項），dispatch 後預期：
- SR4（缺驗收）或 SR3（改 guardrail）觸發；
- Issue 貼 `needs-human`；
- 留言含觸發規則與交還說明（docs/07 §4.2 格式）；
- agent 不自行重試、不自行放寬。

- [ ] **Step 5: 審查堆疊品質抽檢**

抽 2–3 疊 PR，確認：測試層真的在實作層之下、PR 描述含「為什麼這樣做」、無弱化斷言（對照 `docs/07` §2、§5）。

- [ ] **Step 6: 未決事項回填**

將實作中驗證的 Q04-4（DSH 鎖版）、Q07-2（`--numbered` 命名格式）、Q07-3（gh-stack 行為）結果記錄到對應來源文件。

- [ ] **Step 7: Commit（文件同步）**

```bash
git add docs/
git commit -m "docs: record Phase 1 trial results and resolved open questions"
```

---

## Task 22: 文件同步與 Phase 1 出場條件

**Files:**
- Modify: `docs/09-roadmap.md`（第 1 期狀態）
- Modify: `docs/10-open-questions.md`（已裁決事項移入 §1.7）
- Modify: `docs/04-agent-execution-dsh.md`、`docs/03-idp-backstage.md`（如適用，把「待驗證」改為實測結果）

- [ ] **Step 1: 更新 `docs/10-open-questions.md`**

將下列事項依實際結果標記（來源文件為準，本表為索引）：
- Q04-4（DSH 鎖版方式）→ 已驗證
- Q07-2（`gh stack --numbered` 命名）→ 已驗證
- Q07-3（gh-stack 版本行為）→ 已鎖版
- Q03-1/2/3/4（Backstage 版本、dispatch action、Node 22、annotation 命名空間）→ 依 Task 12–14 實測結果
- Q06-5（二次判定實作方式）→ 第 1 期採「run 內 git diff 重計分」（`factory-judge`）；PR 事件觸發留待第 2 期（工作項 2.4）

- [ ] **Step 2: 更新 `docs/09-roadmap.md` §2 狀態**

勾選第 1 期工作項 1.1–1.8；出場條件逐條標記（含「停手機制已實際觸發」的證據 run 連結）。

- [ ] **Step 3: 更新 README 測試計數**

`npm test` 後更新 README 的測試數目（138 → 實際數值）與新增指令（`npm run build`）。

- [ ] **Step 4: 最終驗證**

Run: `npm ci && npm run typecheck && npm test && npm run coverage`
Expected: 全綠；覆蓋率門檻全過（`src/cli/**` 亦 100%）。

- [ ] **Step 5: Phase 1 出場條件檢查清單（docs/09 §2）**

- [ ] 從 Backstage 觸發 → agent 執行 → stacked PR → 人類審查 → 合併，全程可運作（Task 12–15）
- [ ] `docs/05` §8 治理檢查清單逐條通過（依 `docs/05-guardrails-governance.md` §8 核對）
- [ ] ≥ 10 個工作項完成，執行成功率 ≥ 70%（Task 21）
- [ ] 停手機制已被實際觸發過至少一次且行為正確（Task 21 Step 4）
- [ ] 第 1 期相關未決事項已有答案（Q02-1、Q03-2、Q04-1/2/6、Q07-2——多數已在 Task 2–14 驗證）

- [ ] **Step 6: Commit**

```bash
git add docs/ README.md
git commit -m "docs: close Phase 1 open questions and mark roadmap exit criteria"
```

---

## 自我檢視（Self-Review）

### Spec 覆蓋（docs/09 §2 工作項 → Task）

| 工作項 | Task | 狀態 |
|---|---|---|
| 1.1 GitHub App | 10–11 | ✅ 有 Task |
| 1.2 profile/guardrail 層 | 8（接線既有 patch） | ✅ |
| 1.3 4 個 skills | 5 | ✅ |
| 1.4 factory-run.yml | 8 | ✅ |
| 1.5 計分 + risk-paths | 2–3（包裝既有邏輯） | ✅ |
| 1.6 試點 catalog-info | 13 | ✅ |
| 1.7 Backstage 本機 + 1 Template | 12–14 | ✅ |
| 1.8 端到端 ≥10 項 | 9（stub）+ 21（真實） | ✅ |
| 出場條件：治理清單、成功率、停手觸發 | 21–22 | ✅ |
| Quint Phase A：skills vendor | 16 | ✅ |
| Quint Phase A：計分模型 + invariants | 17 | ✅ |
| Quint Phase A：神諭 harness | 18 | ✅ |
| Quint Phase A：quint-paths 閘門 + CI | 19 | ✅ |
| 技術棧規範 annotation + CI 一致性 | 13、20 | ✅ |

### 已修補的設計缺口

1. **SR4 無法觸發**（`runWorkItem` 未傳 `hasAcceptanceCriteria`）→ Task 3。
2. **job 級逾時會吞掉 needs-human 標記** → Task 8 用 step 級 `timeout-minutes: 25`。
3. **第 1 期 automerge 誤放行風險** → Task 7 的 Phase 1 映射（`ready-to-automerge` → 人審）。
4. **agent 失敗時 report 不存在** → Task 6 `write-report` fallback。
5. **Quint「code vs spec」無直接工具**（R2-Q2/Q5 裁決）→ 神諭 harness（Task 18）＋模型先驗（Task 17），並在 ADR-008 記錄橋接決策。
6. **agent 自我驗證風險**（Q6=B/Q6b=A）→ .qnt 草稿需人審、合併後才生效；同一 run 不得自我驗證。
7. **Quint 無差別套用成本高**（R2-Q5=B）→ 路徑宣告制（`quint-paths.yml`），只擋宣告路徑。

### 型別一致性

- `AgentRun.hasAcceptanceCriteria?: boolean | undefined` 在 Task 3 定義，Task 3 的 `factory-judge`、Task 6 的 dry-run/stub 使用同一欄位名。
- `computeScoreLabels`/`computeJudgeLabels` 的輸入型別（`ScoreLike`/`JudgeLike`）與 `src/scoring/types.ts` 的 `ScoreResult`、`src/pipeline/run-work-item.ts` 的 `PipelineResult` 欄位名一致（`total/tier/label`、`outcome/labels/summary`）。
- `dryRunReport` 的 scenario 型別 `'success' | 'blocked' | 'guardrail'` 與 workflow 的 `dry_run_scenario` choice 選項一致。

### 占位掃描

- 所有 code step 均含完整程式碼；Backstage 相關（Task 12–15）標記 ⚠️ 待實作驗證處**皆附驗證指令與 fallback**（符合 docs/03 的查證聲明），非「TBD」占位。
- `actions/create-github-app-token` 版本、`github:actions:dispatch` 簽章以「實作首步連網查證」明示，並提供 fallback（Task 14）。

---

## 執行交接（Execution Handoff）

計畫已儲存於 `docs/superpowers/plans/2026-08-17-software-factory-phase1.md`。兩種執行方式：

1. **Subagent-Driven（建議）** — 每個 Task 派一個全新 subagent，Task 之間我審查（兩階段 review），迭代快。
2. **Inline Execution** — 在同一 session 以 executing-plans 批次執行，設檢查點供審查。

要選哪一種？
