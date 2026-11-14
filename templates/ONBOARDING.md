# 流程模板：只用 `factory/S|M|L`（租戶自訂模板已移除）

> **2026-11-14：租戶自訂模板（`templates/<tenant>/*.yaml`）已整個移除（PR #181）。**
> 原因：BPMN 是正本（ADR-027 §9），租戶模板只有 YAML、沒有 BPMN，下游只能把它近似轉換成另一種圖，
> 同一套流程的圖與實際執行可能不一致（Issue #179）。`templates/index.json` 現在只含 `factory/S|M|L`；
> 既有三個試點租戶模板與對應的 `processes/**` 也一起刪除了。
> 決策紀錄：ADR-025（已被取代）、ADR-027、ADR-028。

## 0. 先確認你需要什麼

| 你的需求 | 用什麼 |
|---|---|
| 只是流程長短不同 | `factory/S`、`factory/M`、`factory/L` preset |
| 想在 preset 上加幾個步驟／閘門 | 系統 `process.yaml` 的 `extra_steps`／`gates`（可加不可刪，見 §4） |
| 公司自訂的簽核閘門 | 系統 `process.yaml` 的 `gate_defs`（見 §4、§5） |
| 不同的**階段順序**或**步驟集** | **不支援**。自訂模板已移除；請開 Issue 描述需求，由平台評估是否擴充 factory 模板或 `extra_steps` |
| 想改 factory preset 本身 | 向平台提 Issue；preset 由平台擁有者維護（§6） |

## 1. 流程規則（meta-contract，仍然適用）

以下規則由 `src/process/spec.ts` 驗證，factory preset 與系統 `process.yaml` 都要遵守：

1. `phases` 只能是 `P0`–`P5`（順序遞增）；**不自訂階段名**（`Q-ORCH-5` 裁決 A）——用步驟 `action` 表達階段語意。
2. `task_type` 必須是工廠既有清單（`agent-add-tests`、`agent-analyze` 等）；`human` 不得帶 `task_type`。
3. 必含 `HG1`、`HG2`、`HG4`、`HG5`、`HG6`；不得移除。
4. 自訂閘門 id 必須是 `<TENANT-UPPER>-<NAME>`（例 `ACME-SECURITY`），且**必須**在 `gate_defs` 宣告 `signers`（≥1）、`scope`、`evidence`（單簽核者、證據必填、可撤回；quorum 另案）。
5. `extra_steps` 只能加在系統實例，不會改到模板；id 不得與模板衝突，phase 必須在已宣告的 phases 內。
6. 系統的 `phases` 必須是模板的連續前綴；`gates` 必須包含模板的所有 gates。

## 2. 模板目錄（`templates/index.json`）

`templates/index.json` 是模板的機械事實來源：每個模板一筆 `{id, tenant, name, version, path, template}`——`template` 是模板本體（`phases`／`gates`／`steps`）。consumer（Scoreboard）只需抓這一份 JSON 就能畫圖，不必解析 YAML。系統釘 `template: <id>` ＋ `template_version`。

現在只有三個條目：

| 路徑 | id | 說明 |
|---|---|---|
| `templates/factory/S.yaml` | `factory/S` | 小型 preset（`docs/29` §9.1） |
| `templates/factory/M.yaml` | `factory/M` | 中型 preset（§9.2） |
| `templates/factory/L.yaml` | `factory/L` | 大型 preset（§9.3） |

`factory-template` 會檢查目錄與 `templates/**` 一致（檔案存在、版本相符、沒有未列出的模板）；不一致是 CliError，不是 warning。`src/process/registry.test.ts` 也在 CI 釘住這份一致性。

## 3. 驗證

```bash
pnpm run typecheck
pnpm run test:unit                                        # 含 registry ↔ templates/** 一致性
node dist/cli/factory-template.js list --root .            # 目錄與檔案一致？
node dist/cli/factory-template.js resolve --root . --id factory/M
```

CI 的 `Test` workflow 會跑同一組測試，不需要額外的 workflow step。

## 4. 系統採用（`processes/<system>.yaml`）

```yaml
system: acme/portal
scale: M                     # 治理強度，由人宣告（HG2）；與模板脫鉤
scale_evidence: docs/research/120-a0.md
template: factory/M          # 只能是 factory/S|M|L
template_version: 1
phases: [P0, P1, P2]         # 模板 phases 的連續前綴
gates: [HG1, HG2, HG4, HG5, HG6, ACME-SECURITY]
gate_defs:                   # 公司自訂閘門（可選）
  - id: ACME-SECURITY
    signers: [security-lead]
    scope: phase
    evidence: adr
extra_steps: []              # 可加，不能改模板
```

## 5. 簽核自訂閘門

在導入追蹤 Issue 留言：

```html
<!-- factory:gate id=ACME-SECURITY state=signed evidence=https://acme.test/adr/42 -->
```

- 只有 `process.yaml` 的 `gate_defs` 已宣告的 id 會被接受；未宣告會產生 warning。
- `state=revoked` 可撤回；`[bot]` 作者一律忽略（工廠不能簽自己的閘門）。
- 簽核規則與 HG 相同：**單簽核者**＋證據必填＋可撤回；**不做 quorum**。團隊自行取得共識後，由一位代表簽核，`evidence` 請指向共識文件（會議紀錄、ADR、審查結論）。

## 6. 版本與審查

- **factory preset 由平台擁有者維護**（`CODEOWNERS`）。要調整 preset 請開 Issue，不要直接複製一份到別的目錄。
- 版本不可變：流程調整開新 `version`，系統再以 PR 改 `template_version`。
- 不要把 factory preset 複製到 `templates/<tenant>/`；那個目錄已經不存在，`factory-template` 會報「目錄有但找不到檔案」。

## 7. 已移除的租戶模板與遷移

2026-11-14 移除的檔案：`templates/example/review-first.yaml`、`templates/agent-playground/review-first.yaml`、
`templates/tradingbot-tw/saga-pattern.yaml`，以及對應的 `processes/**`。

原本使用租戶模板的系統，遷移方式：

1. 先看 `factory/S|M|L` 哪一個最接近；`process.yaml` 改 `template:`／`template_version:`。
2. 需要多出來的步驟或閘門 → `extra_steps`／`gates`／`gate_defs`。
3. 真的表達不了（不同的階段順序、要刪步驟）→ 開 Issue 說明需求；`meta-contract` 的「可加不可刪」是刻意的。

要看實際的流程定義與圖：

| 位置 | 內容 |
|---|---|
| `templates/factory/{S,M,L}.yaml` | 三個工廠模板 |
| `templates/factory/*.bpmn`（Scoreboard repo） | 前述模板的 BPMN 正本；圖與執行定義同源 |
| `/docs/process/flows/{S,M,L}` | 流程預覽（不需要登入） |
| `/docs/process/flows/{quint-verification,hegel-audit,exemption}` | 驗證閘門的三個分支子流程 |

合成系統範例仍在 `processes/samples/payment-platform.*`（採 `factory/M`）。

## 8. UI（Scoreboard）

- 流程定義與圖：`/docs/process`（公開；S／M／L 與三個驗證分支子流程）。
- 編輯器：`/scoreboard/process/edit/<system>` 選 `factory/S|M|L`，匯出 `processes/<system>.yaml`（不寫入、不開 PR）。
- 模板目錄與定義預覽已移除（租戶模板下架，`/docs/process/templates/*` 301 到 `/docs#process`）。
- production 的 live／模板頁會套用 `TENANT_ACCESS`；沒有被列出的租戶會得到 403。
