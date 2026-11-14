# Process templates

> **2026-11-14：租戶自訂模板（`templates/<tenant>/*.yaml`）已移除，只剩 `factory/S|M|L`（PR #181）。**
> 原因：BPMN 是正本（ADR-027 §9），租戶模板沒有 BPMN，下游只能近似轉換成另一種圖（Issue #179）。
> 流程規則、目錄維護、系統採用與遷移方式見 [ONBOARDING.md](ONBOARDING.md)；決策見
> `docs/ADR/025-tenant-process-templates.md`（已被取代）。

## 目錄（`templates/index.json`）

`templates/index.json` 是模板的機械事實來源：每個模板一筆 `{id, tenant, name, version, path, template}`——`template` 是模板本體（`phases`／`gates`／`steps`）。consumer（Scoreboard）只需抓這一份 JSON 就能畫圖，不必解析 YAML；`factory-template` 會驗證目錄內嵌內容與 `path` 的檔案相等。系統釘 `template: <id>` ＋ `template_version`，consumer 用目錄回答「檔案在哪」。

```bash
node dist/cli/factory-template.js list --root .
node dist/cli/factory-template.js resolve --root . --id factory/M
```

`factory-template` 會檢查目錄與 `templates/**` 一致（檔案存在、版本相符、沒有未列出的模板）；不一致就是 CliError，不是 warning。`src/process/registry.test.ts` 也在 CI 釘住這份一致性。

| 路徑 | id | 說明 |
|---|---|---|
| `templates/factory/S.yaml` | `factory/S` | 小型 preset（`docs/29` §9.1） |
| `templates/factory/M.yaml` | `factory/M` | 中型 preset（§9.2） |
| `templates/factory/L.yaml` | `factory/L` | 大型 preset（§9.3） |

規則：

1. **版本不可變**：發布後改流程＝新版（`version` +1），系統以 `template_version` 釘選。
2. **meta-contract**：四種 step kind、`task_type` 白名單、`P0`–`P5`、必含 `HG1/HG2/HG4/HG5/HG6`。
3. **自訂 gate** 在系統 `process.yaml` 的 `gate_defs` 宣告（id 以 `<TENANT-UPPER>-` 開頭，例 `ACME-SECURITY`；`HG0`–`HG7` 保留）；必須宣告 `signers`／`scope`／`evidence`（單簽核者、證據必填、可撤回；quorum 見 `Q-ORCH-4`）。
4. factory preset 不可移除步驟或重排；系統只能透過 `extra_steps` 追加，不能改模板。
