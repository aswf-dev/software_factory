# 形式化驗證服務 V2：工廠端（task type、guard 豁免、加密 artifact、工具鏈） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `aswf-dev/software_factory` 的 `factory-run` 能執行形式化驗證的四個 agent 階段（grill／quint／lean／tests），並在公開 runner 上不洩漏使用者提供的內容。

**Architecture:** 在既有 `factory-run.yml` 上以「驗證模式」分支擴充：新增 4 個 task type 與對應 task template；以一支可單元測試的 CLI（`factory-verify-mode`）判定驗證模式與 guard 豁免，workflow 只呼叫它；驗證模式的 `target/.factory/run/` 在 artifact 上傳前以 age 公鑰加密，只留密文；Lean 工具鏈以 elan 安裝並快取。

**Tech Stack:** TypeScript 5.9 strict（`tsc -p tsconfig.build.json` → `dist/cli/*.js`）、vitest、GitHub Actions、`age-encryption`（npm）、elan／Lean 4.35.0 core（無 Mathlib）、Quint 0.33.0（已快取）。

**Spec:** `aswf-dev/software_factory` PR #132 `docs/ADR/029-formal-verification-service.md` §5、§6、§7、§9；V1 已完成（scoreboard PR #93）。

## Global Constraints

- 新增 task type 固定為 `agent-verify-grill`、`agent-verify-quint`、`agent-verify-lean`、`agent-verify-tests`。
- 驗證類 task 一律 **不做三軸計分**、**不檢查 `factory-stage prereqs`（ADR-022）**、**永不自動合併**。
- 驗證類 task 的 `base_branch` 允許等於目標 repo 的**預設分支**；其他 task type 仍適用 ADR-013（不得為 `main`）。
- 驗證類 task 不要求 `catalog-info.yaml` 與 `.github/factory/risk-paths.yml`。
- agent 只能寫 `specs/**` 與測試檔（白名單由 task template 明列）；驗證類 agent **不得 push 分支、不得開 PR**。
- 驗證類 task 的 `target/.factory/run/` **加密後才上傳**；公鑰取自 repo secret `VERIFY_AGE_PUBLIC_KEY`，缺它時驗證類 task 直接失敗（fail closed）。
- 加密使用 `age-encryption`（npm）與其 X25519 recipient；不得自行實作密碼學。
- 既有 8 個 task type 的行為與 guard 不變；既有測試全綠。
- Lean 版本固定 `leanprover/lean4:v4.35.0`，只用 core、**不安裝 Mathlib**。

## Review Focus

1. **非驗證 task 不受影響**：驗證模式的判定只由 task type 決定，其餘 task 仍會擋下 `base_branch=main`、仍要求 catalog／risk-paths。→ Task 2 測試。
2. **缺公鑰時不洩漏**：沒有 `VERIFY_AGE_PUBLIC_KEY` 或加密失敗時，workflow 必須失敗且**不上傳明文**。→ Task 3 測試＋workflow 步驟順序。
3. **加密產物可解**：以測試專用 keypair（公鑰加密、私鑰解密）證明密文可還原，且 bundle 內檔名與原路徑一致。→ Task 3 測試。
4. **永不自動合併**：四個新 task type 都出現在 `NO_AUTOMERGE_TASK_TYPES`。→ Task 1 測試。
5. **驗證模式不得寫入正式程式碼**：task template 的白名單必須明確排除 `src/**`（除測試檔）與 `.github/**`。→ Task 1 審查＋Task 5 的 crosscheck 設定。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `.github/workflows/factory-run.yml` | 新 task type 選項、驗證模式分支（guard 豁免、加密上傳、Lean 工具鏈） |
| `.github/factory/task-template-verify-grill.txt` 等 4 份 | 各階段的 agent 指示與寫入白名單 |
| `src/cli/factory-verify-mode.ts` | 判定是否驗證模式、允許的 base branch、是否需要 catalog／risk-paths、要跑哪些 task template |
| `src/cli/factory-verify-encrypt.ts` | 把 `target/.factory/run/` 打包並以 age 公鑰加密 |
| `src/pipeline/no-automerge.ts` | 加入四個 task type |
| `.dsh/skills/lean-formal-verification/**` | vendored Lean skill（含 `scripts/verify-lean.sh`、`templates/`、`references/`） |
| `config/factory/skills-lock.json` | 驗證類 task 的 skill 派發 |
| `test/verify-mode.test.ts`、`test/verify-encrypt.test.ts` | 單元測試 |

---

### Task 1: 四個 task type、task template、no-automerge

**Files:** Modify `.github/workflows/factory-run.yml`（`task_type` 選項）、`src/pipeline/no-automerge.ts`；Create `.github/factory/task-template-verify-{grill,quint,lean,tests}.txt`；Test `test/no-automerge.test.ts`（既有檔可擴充）

**Interfaces:**
- Produces：`VERIFY_TASK_TYPES = ['agent-verify-grill','agent-verify-quint','agent-verify-lean','agent-verify-tests'] as const`（放在 `src/pipeline/verify-task-types.ts`，供 Task 2 使用）。
- task template 內容要點（每份都要有）：角色與階段目標、**寫入白名單**、**禁止** push 分支／開 PR、產出路徑、完成條件；quint 階段要讀 `specs/quint/RULES.md` 並輸出 `specs/quint/`；lean 階段以 input `verify_phase`（`statements`／`proofs`）區分；tests 階段以目標 repo 的測試框架寫 `todo` 測試。

- [ ] **Step 1: 失敗測試**：`NO_AUTOMERGE_TASK_TYPES` 含四個新 type；`VERIFY_TASK_TYPES` 內容與順序正確。
- [ ] **Step 2–4:** 確認失敗 → 實作 → 通過。
- [ ] **Step 5: Commit** `feat(verify): verify task types, templates and no-automerge`

### Task 2: 驗證模式 CLI 與 guard 豁免

**Files:** Create `src/cli/factory-verify-mode.ts`；Modify `.github/workflows/factory-run.yml`（guard 步驟改呼叫 CLI；catalog／risk-paths／stage-prereq 檢查以 verify 模式跳過）；Test `test/verify-mode.test.ts`

**Interfaces:**
```ts
export interface VerifyModeDecision {
  verify: boolean
  baseBranchAllowed: boolean
  requiresCatalog: boolean
  requiresRiskPaths: boolean
  requiresStagePrereqs: boolean
  error: string | null
}
export function decideVerifyMode(input: { taskType: string; baseBranch: string; defaultBranch: string }): VerifyModeDecision
```
- 非驗證 task：`verify=false`、`requiresCatalog/riskPaths/StagePrereqs=true`、`baseBranchAllowed = baseBranch !== 'main'`。
- 驗證 task：`verify=true`、三者為 `false`、`baseBranchAllowed = baseBranch === defaultBranch`（或等於 `software-factory` 以便過渡期相容）；其他值 → `error`。

- [ ] **Step 1: 失敗測試**：四種情境（非驗證＋main → 擋；驗證＋預設分支 → 過；驗證＋任意分支 → 擋並回 error；未知 task type → `verify=false` 且按非驗證規則處理）。
- [ ] **Step 2–4:** 確認失敗 → 實作 → 在 workflow 的 guard 步驟前插入 `node dist/cli/factory-verify-mode.js`，輸出 `verify=true/false` 供後續 step 的 `if:` 使用 → 通過。
- [ ] **Step 5: Commit** `feat(verify): verify mode decision and guard exemption`

### Task 3: 以 age 公鑰加密 run artifacts

**Files:** Create `src/cli/factory-verify-encrypt.ts`；Modify `.github/workflows/factory-run.yml`（驗證模式：加密後才上傳，只上傳密文）；Modify `package.json`（`age-encryption`）；Test `test/verify-encrypt.test.ts`

**Interfaces:**
```ts
// 讀 target/.factory/run/ 下所有檔案（遞迴），輸出單一 age 密文檔
export function encryptDir(opts: { dir: string; outFile: string; recipient: string }): Promise<{ files: string[] }>
```
- 內容格式：JSON lines，每行 `{"path":"<相對路徑>","b64":"<base64 內容>"}`，整份以 age 加密（X25519 recipient）。
- 缺 `recipient`（空字串）→ 拋錯，不產生任何輸出檔。

- [ ] **Step 1: 失敗測試**：以 `age-encryption` 在測試內產生 keypair（或用固定測試 key），加密後以私鑰解密，JSON lines 解析回來，`path` 集合等於輸入檔；空 recipient 拋錯且無輸出檔。
- [ ] **Step 2–4:** 確認失敗 → 實作 → 通過。
- [ ] **Step 5: Commit** `feat(verify): age-encrypt verify run artifacts`

### Task 4: vendored Lean skill 與 dispatch

**Files:** Create `.dsh/skills/lean-formal-verification/**`（複製 `~/.agents/skills/lean-formal-verification` 的 `SKILL.md`、`scripts/`、`templates/`、`references/`）；Modify `config/factory/skills-lock.json`

**Interfaces:** skills-lock 中 `agent-verify-lean` 的 `onlyFor` 指向 `lean-formal-verification`；`agent-verify-quint` → `quint-modeling`＋`quint-lang`；`agent-verify-grill` → 無（純讀碼）；`agent-verify-tests` → 無。

- [ ] **Step 1: 失敗測試**：新增 `test/skills-lock.test.ts` 斷言四個 task type 的 skill 對照，且 `.dsh/skills/lean-formal-verification/SKILL.md` 與 `scripts/verify-lean.sh` 存在、`lean-toolchain` 為 `leanprover/lean4:v4.35.0`。
- [ ] **Step 2–4:** 確認失敗 → 複製檔案 → 通過。
- [ ] **Step 5: Commit** `feat(verify): vendor lean-formal-verification skill`

### Task 5: Lean 工具鏈、crosscheck 白名單與端到端 dry run

**Files:** Modify `.github/workflows/factory-run.yml`（elan 安裝＋快取、verify 模式的 crosscheck 白名單）；Create `docs/34-verify-runbook.md`

**Interfaces:** crosscheck 在驗證模式下只允許 `specs/**` 與測試檔變更；`docs/34` 寫明手動 dispatch 的完整指令與預期產出。

- [ ] **Step 1:** 在 workflow 加入（僅 verify 模式）：
  - `Install Lean (elan)`：`curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain leanprover/lean4:v4.35.0`
  - `Cache Lean`：`actions/cache`，path `~/.elan`、`target/specs/lean/.lake`，key `lean-${{ hashFiles('target/specs/lean/lean-toolchain') }}`
- [ ] **Step 2:** crosscheck 白名單：驗證模式只允許 `specs/**`、`**/*.test.*`、`**/test/**`，其餘變更即失敗。
- [ ] **Step 3:** `docs/34-verify-runbook.md`：`gh workflow run factory-run.yml -f repo=<owner>/<name> -f task_type=agent-verify-quint -f base_branch=<預設分支> -f issue_number=<N>`，並列出驗證模式與一般模式的差異。
- [ ] **Step 4: 驗證**：`pnpm test`、`pnpm build`、`pnpm typecheck` 全綠；以 `gh workflow run --dry_run` 能力不存在，改以 `act`／本地 `node dist/cli/factory-verify-mode.js` 模擬三種輸入。
- [ ] **Step 5: Commit** `feat(verify): lean toolchain, crosscheck whitelist and runbook`

---

## 後續

V3（scoreboard `/verify` 頁面、GitHub OAuth、回呼 API 傳遞 G1 確認後的輸入、live handlers、發佈 PR）與 V4（uber_payment_poc 驗收）各自另寫計畫。V1 最終審查的 I2–I4（effect 序列化、failed／blocked 狀態、gate 可退回／BPMN 版本釘住）是 V3 的驗收門檻。

---

## 修訂（controller，Task 1 review 後）

Task 1 審查指出五個跨 Task 的缺口，併入後續 Task：

**Task 2 擴大**（原 guard 豁免之外，還要）：
- **VARIANT_HEADER 閘控**：`factory-run.yml` 注入到所有 agent prompt 的 `VARIANT_HEADER`（約 L911-919）命令 agent 建 `factory/<issue>-<variant>-` 分支並宣稱 CI 驗證前綴。驗證類 task 必須改注入一份「不建分支、不 push、不開 PR」的 header（保留 variant 以維持 N-version 選項）。
- **跳過評分／裁判／留言**：`Initial score`（約 L504-510）、`Judge`（約 L1331-1343，`factory-score.ts` 在缺 `catalog-info.yaml` 時拋錯）、以及終態／compare 的留言（約 L1595-1608）在驗證模式必須跳過（ADR-029 §5/§6：不寫發現到公開 Issue）。
- **crosscheck 白名單依語言放寬**：`specs/**`、`**/*.test.*`、`**/*_test.go`、`**/tests/**`、`**/test/**`，並在 runbook 說明。
- 移除「不得 commit」與 crosscheck `uncommitted-changes` 的衝突：驗證類 agent **可以 commit 到本地**（不 push），crosscheck 以 diff 比對工作區。

**Task 3 擴大**：加密 bundle 的範圍從 `target/.factory/run/` 擴大到
`target/.factory/run/` ＋ `target/specs/**` ＋ 被修改／新增的測試檔，並在 bundle 內保留相對路徑（下一個階段要用）。

**新增 Task 6：階段輸入 bundle**（V2 必需，否則階段 ③ 不可能完成）
- `src/cli/factory-verify-input.ts`：以 `VERIFY_AGE_PRIVATE_KEY` 解密上一個階段的 bundle（或 G1 確認後的 `RULES.md`／G2 的 `TRIAGE.md`），解到 `target/` 下，路徑白名單同 Task 3。
- workflow 新增 input `verify_input_bundle`（base64，可空）與步驟：驗證模式下先解包，再跑 agent。
- 測試：加密→解密往返、白名單外的路徑（`src/**`、`.github/**`）必須拒絕。
- 註：token 效期與 bundle 傳遞的實際串接由 V3 的 Worker 負責；V2 只保證 CLI 與 workflow 能接收並驗證。
