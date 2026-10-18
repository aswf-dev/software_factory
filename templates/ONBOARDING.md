# 租戶模板 onboarding（ADR-025）

這份文件寫給「想讓自己的公司／專案用一套自己的軟體工廠流程」的人。你會新增一個模板、讓系統釘住它，必要時加上自己的閘門。

## 0. 先確認你不需要新模板

| 你的需求 | 用什麼 |
|---|---|
| 只是流程長短不同 | 用 `factory/S`、`factory/M`、`factory/L` preset，不要新增模板 |
| 想在 preset 上加幾個步驟／閘門 | `process.yaml` 的 `extra_steps`／`gates`（可加不可刪） |
| 公司有**自己的階段順序**或步驟集 | 新增租戶模板（本文件） |

## 1. 模板檔

路徑：`templates/<tenant>/<name>.yaml`

- `tenant`：小寫 slug（例 `acme`），代表組織。
- `name`：英數與連字號（例 `review-first`），代表流程。
- `version`：正整數，**發布後不可變**；改流程＝新版。

```yaml
tenant: acme
name: review-first
version: 1
source: acme/SDLC.md §3
phases: [P0, P1, P2, P3]
gates: [HG1, HG2, HG4, HG5, HG6, ACME-SECURITY]
gate_defs:
  - id: ACME-SECURITY
    signers: [security-lead]
    scope: phase
    evidence: adr
steps:
  - {id: A1, phase: P0, action: 分析需求, kind: work-item, task_type: agent-analyze, per: system}
  - {id: A2, phase: P1, action: 安全審查, kind: human, gates: [ACME-SECURITY]}
  - {id: A3, phase: P2, action: 補測試, kind: work-item, task_type: agent-add-tests, per: module}
```

### meta-contract（不可違反）

1. `phases` 只能是 `P0`–`P5`（順序遞增）。
2. `task_type` 必須是工廠既有清單（`agent-add-tests`、`agent-analyze` 等）；`human` 不得帶 `task_type`。
3. 必含 `HG1`、`HG2`、`HG4`、`HG5`、`HG6`；不得移除。
4. 自訂閘門 id 必須是 `<TENANT-UPPER>-<NAME>`（例 `ACME-SECURITY`），且**必須**在 `gate_defs` 宣告 `signers`（≥1）、`scope`、`evidence`（單簽核者、證據必填、可撤回；quorum 另案）。
5. 步驟順序由你決定；`extra_steps` 只能加在系統實例，不會改到模板。

## 2. 目錄條目

在 `templates/index.json` 的 `templates` 陣列加一筆；`template` 欄位是模板本體（與 YAML 相同）。最省事的做法是用上游 `factory-template` 產生：

```bash
# 先寫好 templates/acme/review-first.yaml，再
node dist/cli/factory-template.js list --root .   # 確認目錄與檔案一致；不一致會報錯
```

> `templates/index.json` 內嵌的 `template` 必須與 YAML 檔相等；`src/process/registry.test.ts` 會在 CI 讀真實檔案釘住這件事。手動編輯時最容易漏的就是這一塊——建議從 `factory-template` 的輸出貼回。

## 3. 驗證

```bash
pnpm run typecheck
pnpm run test:unit        # 含 registry ↔ templates/** 一致性
node dist/cli/factory-template.js resolve --root . --id acme/review-first
```

CI 的 `Test` workflow 會跑同一組測試，不需要額外的 workflow step。

## 4. 系統採用

在系統的 `processes/<system>.yaml`（機制 repo）：

```yaml
system: acme/portal
scale: M                     # 治理強度，由人宣告（HG2）；與模板脫鉤
scale_evidence: docs/research/120-a0.md
template: acme/review-first
template_version: 1
phases: [P0, P1, P2]
gates: [HG1, HG2, HG4, HG5, HG6, ACME-SECURITY]
extra_steps: []              # 可加，不能改模板
```

`phases` 必須是模板的連續前綴；`gates` 必須包含模板的所有 gates。

## 5. 簽核自訂閘門

在導入追蹤 Issue 留言：

```html
<!-- factory:gate id=ACME-SECURITY state=signed evidence=https://acme.test/adr/42 -->
```

- 只有模板已宣告的 id 會被接受；未宣告或未提供模板時會產生 warning。
- `state=revoked` 可撤回；`[bot]` 作者一律忽略（工廠不能簽自己的閘門）。
- 簽核規則與 HG 相同；quorum 另案（`Q-ORCH-4`）。

## 6. 審查與版本

- 模板 PR 由 `CODEOWNERS` 的租戶目錄規則分派；平台擁有者審查後合併。
- 版本不可變：流程調整開新 `version`，系統再以 PR 改 `template_version`。
- 不要把租戶模板放進別的租戶目錄，也不要共用自己的 gate id 前綴。

## 7. 可看的完整範例

機制 repo 內有一個明確標示為範例的租戶模板與對應的合成系統：

| 檔案 | 內容 |
|---|---|
| `templates/example/review-first.yaml` | 範例模板（自訂閘門 `EXAMPLE-SECURITY`） |
| `processes/samples/example-portal.yaml`（＋modules／issues／comments） | 採用它的合成系統；`factory-snapshot` 會發佈 `example/portal` |
| `/scoreboard/process/templates/example/review-first` | Scoreboard 的定義預覽（由 registry 轉換） |
| `/scoreboard/process/live/example/portal` | live 拓撲（快照發佈後；示範租戶模板路徑） |

## 8. UI（Scoreboard）

- 模板目錄：`/scoreboard/process` 的「模板目錄」區塊（registry）。
- 定義預覽：`/scoreboard/process/templates/<tenant>/<name>`。
- 編輯器：`/scoreboard/process/edit/<system>` 可選租戶模板，匯出 `processes/<system>.yaml`（不寫入、不開 PR）。
- production 的 live／模板頁會套用 `TENANT_ACCESS`；沒有被列出的租戶會得到 403。
