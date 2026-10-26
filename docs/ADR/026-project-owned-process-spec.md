# ADR-026：系統流程 spec 歸專案所有——機制 repo 只保留名冊與規則

- **狀態**：已接受（2026-10-20，使用者裁決；實作待第二個租戶驗證完成後進行）
- **部分已被取代**：`ADR-027` §9（已接受，2026-10-26）——歸屬不變，系統 spec 與模組清單合併為專案 repo 的 `factory/system.bpmn`。
- **日期**：2026-10-20
- **決定者**：使用者（「這是專案自身的治理流程，軟體工廠不該存放各專案的流程資料」）
- **修訂**：`ADR-023` §1（系統級 spec 的位置）
- **對應**：`ADR-025`（租戶模板）、`ADR-024`（執行語意）、`ADR-001`（GitHub 為真相）

## 脈絡

`ADR-023` §1 把流程描述分兩層：系統級 `processes/<system>.yaml` 放**機制 repo**，模組級 `factory/process.yaml` 放**目標 repo**。第二個真實租戶（`tradingbot-tw/saga-pattern`）導入時浮現兩個問題：

1. **歸屬錯位**：系統 spec（`scale`、釘哪個模板與版本、階段、額外步驟）是**專案自己的治理選擇**，卻由平台 repo 保管；專案每次調整都要對平台 repo 開 PR。
2. **租戶隔離失效**：機制 repo 是 **public**。實測（2026-10-20）未登入即可讀取租戶模板（raw URL 200）與每個系統的快照（release asset 200），而 Scoreboard 頁面以 Cloudflare Access ＋ `TENANT_ACCESS` 擋住同一份資料。目前兩個租戶的 repo 本身也是 public，沒有實際外洩；但第一個 private 租戶就會經由機制 repo 外洩流程、工單標題與閘門狀態。

集中保管系統 spec 的主要理由是「防止專案自行移除閘門」——但這不必靠**檔案放在哪裡**，可以靠**讀取時驗證**。

## 決策

### 1. 歸屬

| 資料 | 位置 | 理由 |
|---|---|---|
| meta-contract（必含閘門、task_type 白名單、P0–P5） | 機制 repo（程式） | 平台規則 |
| `factory/S|M|L` preset | 機制 repo `templates/factory/` | 平台提供 |
| **納管名冊**（只有 `owner/repo`） | 機制 repo `processes/registry.json` | 快照要知道讀誰；防止任意 repo 自行註冊 |
| 租戶模板 | 機制 repo `templates/<tenant>/`（**暫不變**，見 §4） | 跨專案共用、需釘版本、平台審核（`ADR-025`） |
| **系統 spec** | **專案 repo `factory/system.yaml`** | 專案的治理選擇，由專案自己的 branch protection 管 |
| 模組清單 | 專案 repo `factory/process.yaml`（不變） | 描述專案程式碼 |

### 2. 防止弱化治理：讀取時驗證

快照每次產生時讀取專案的 `factory/system.yaml`，以機制 repo 的 `validateProcess` 對照 meta-contract 與它釘選的模板版本驗證：`system` 必須等於 repo、必含閘門不得移除、`template_version` 必須存在、`extra_steps` 只能追加。**驗證失敗不產生該系統的新快照**（沿用上一份並在 warnings 說明原因），而不是靜默接受。

### 3. 名冊

`processes/registry.json` 只列已納管的 `owner/repo`（加入時間、租戶）。新增租戶＝對機制 repo 開一行的 PR（平台審核「誰可以納管」），之後的流程調整全部在專案 repo 內完成。快照 workflow 的 discover 改讀名冊。

### 4. 不在本 ADR 範圍

- **租戶模板的公開問題**：暫維持於機制 repo；第一個 private 租戶出現時再決定（租戶自有 template repo，或非公開 registry）。
- **快照的儲存位置**：public release 對 private 租戶不可接受，需改存不公開的位置（例：經 Scoreboard ingest 寫入 D1／R2，頁面照舊以 `TENANT_ACCESS` 控管）。另案處理。

## 後果

### 正面
- 專案擁有自己的流程資料，可見範圍與審核權跟著專案 repo 走。
- 機制 repo 不再累積各專案的設定；平台只保管規則與名冊。
- 治理防線從「檔案位置」移到「每次讀取都驗證」，覆蓋面更大（專案 repo 內被手改也擋得住）。

### 負面
- 驗證從 PR 時（機制 repo CI）移到快照時：專案改壞 spec 不會在專案 PR 上被擋，而是在下一次快照時被拒（以 warnings 呈現）。可在專案 repo 提供可選的 CI 檢查補強。
- 快照需要讀每個專案 repo 的兩個檔案（App token 已涵蓋 contents read）。

## 遷移計畫

1. 名冊 `processes/registry.json`，列 `agent-playground/restate-cloudflare-workers-poc`、`tradingbot-tw/saga-pattern`。
2. 快照 workflow（H5）：discover 讀名冊；產生步驟從專案 repo 讀 `factory/system.yaml` 並做讀取時驗證；失敗沿用舊快照。
3. 兩個專案各開 PR 新增 `factory/system.yaml`（內容＝現有 `processes/<owner>/<repo>.yaml`）。
4. 確認快照改由專案 repo 讀取後，刪除機制 repo 的 `processes/<owner>/<repo>.yaml`；`systems.test.ts` 改為驗證讀取時驗證邏輯本身。
5. Scoreboard：系統 spec 編輯器改在專案 repo 開 PR（沿用 `modules-pr` 的租戶 repo 寫入路徑，白名單加 `factory/system.yaml`）；模組端點的前置條件改為「在名冊中」。

## 重評觸發條件

- 出現 private 租戶（觸發 §4 兩項）。
- 讀取時驗證造成的「延遲發現」實際造成誤導（考慮強制專案 repo 的 CI 檢查）。
