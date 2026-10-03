# Issue #2 分析報告：factory-run.yml 的 workflow_dispatch 輸入參數

> 類型：agent-analyze｜來源：`.github/workflows/factory-run.yml` L19–L72（唯讀，未修改）｜工單目的：遷移至 aswf-dev/software_factory 後的實機驗證

## 結論摘要
`workflow_dispatch` 共 **10** 個輸入參數，名稱／型別／預設值見下方「輸入參數表」（1 張表）。
關鍵發現：`repo` 的預設值仍是遷移前的舊 repo `philipz/software_factory`（L34）——遷移後若未顯式覆蓋此參數就手動觸發，Factory Run 會派工到舊 repo；其餘預設值均與新 repo 相容。

## 證據與根因
- 可重現驗證（於 repo 根執行，結果與本表一致）：`python3 -c "import yaml; ins=yaml.safe_load(open('.github/workflows/factory-run.yml'))[True]['workflow_dispatch']['inputs']; print(len(ins), {k: (v.get('type'), v.get('default')) for k, v in ins.items()})"` → 10 個參數。
- 僅 `issue_number` 為 `required: true`（L20–L23）；GitHub Actions 不允許 required 輸入宣告 `default`，故其預設值記為 `—`。
- choice 型別選項數：`task_type` 8 項（L28）、`dry_run_scenario` 3 項（L49）、`model_tier` 5 項（L55）、`model_provider` 4 項（L61）。
- 根因：此 workflow 早於 repo 搬遷；PR #1 搬移機制 repo 時未同步更新 L34 的 `repo` 預設值，觸發介面預設仍指向舊 repo。

## 輸入參數表

| 名稱 | 型別 | 預設值 |
| --- | --- | --- |
| `issue_number` | number（required） | — |
| `task_type` | choice | `auto` |
| `repo` | string | `philipz/software_factory` ⚠️ |
| `base_branch` | string | `software-factory` |
| `dry_run` | boolean | `false` |
| `dry_run_scenario` | choice | `success` |
| `model_tier` | choice | `auto` |
| `model_provider` | choice | `auto` |
| `token_budget` | number | `0`（不設限） |
| `agent_timeout_minutes` | number | `0`（自動：heavy-verify 110／其餘 50） |

## 影響範圍
- 受影響者：在新 repo 以 web UI 或 `gh workflow run` 手動觸發 Factory Run 的所有人（須顯式傳 `repo`）。
- `run-name`（L15）與 `concurrency`（L74–L75）引用 `repo`／`issue_number`：預設值錯誤會一併影響 G2 cleanup 的 run-name 解析契約與併發群組歸組。

## 方案比較
- **A（採行）靜態快照報告（本檔）**：符合 Issue 驗證方式（1 張表、≤40 行）、零程式碼變更；附出處行號供未來 workflow 變動時核對。
- **B（拒絕）在本 PR 順改 `repo` 預設值，或以 CI 自動生成參數表文件**：需觸碰 `.github/**`（workflow 設定屬高風險路徑，依停手規則 3 須人類處理；且本工單為唯讀分析、agent-analyze 禁止實作）→ 拒絕。

## 建議下一步
- 新工作項（觸碰 `.github/**`，需人類核准）：「更新 factory-run.yml `workflow_dispatch.repo` 預設值為 `aswf-dev/software_factory`」。驗收草案：YAML 解析 L34 default == `aswf-dev/software_factory`；`run-name`／`concurrency` 格式契約不變；dry_run 迴歸綠燈。
- 遷移驗證操作：手動觸發本工單類型時顯式傳 `repo` 與 `issue_number`，確認 run 目標為新 repo、Issue 留言作者為 GitHub App、Scoreboard 推送至新 repo。
