# Process templates

`templates/<tenant>/<name>.yaml`，由 `src/process/spec.ts` 驗證；決策見 `docs/ADR/025-tenant-process-templates.md`。

| 路徑 | id | 說明 |
|---|---|---|
| `templates/factory/S.yaml` | `factory/S` | 小型 preset（`docs/29` §9.1） |
| `templates/factory/M.yaml` | `factory/M` | 中型 preset（§9.2） |
| `templates/factory/L.yaml` | `factory/L` | 大型 preset（§9.3） |

規則：

1. **版本不可變**：發布後改流程＝新版（`version` +1），系統以 `template_version` 釘選。
2. **meta-contract**：四種 step kind、`task_type` 白名單、`P0`–`P5`、必含 `HG1/HG2/HG4/HG5/HG6`。
3. **自訂 gate** 必須以 `<TENANT-UPPER>-` 開頭（例 `ACME-SECURITY`）；`HG0`–`HG7` 保留。
4. 工廠 preset 不可移除步驟或重排；租戶模板可在 meta-contract 內自由排序。
