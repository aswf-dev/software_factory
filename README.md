# Software Factory — 自動化軟體工廠

以 **Spotify Backstage** 為內部開發者平台（IDP）入口、**DeepSeek Harness (DSH)** 為 agent 執行核心、**GitHub stacked PR** 為交付載體的自動化軟體工廠設計。

## 本 Repo 的狀態：文件先行（Documentation-First）

本階段**只產出設計文件，不建置系統**。所有技術主張都必須對應可驗證的指令或套件；未經驗證者一律在文中標註為「假設，待實作驗證」，並收攏至 `docs/10-open-questions.md`。

實作將在文件審定後另行提出計畫。

## 設計依據

Gartner G00843405,《How to Maximize the Impact of Agentic AI in the SDLC》(2026-01-19)。
原始 PDF 置於 `docs/`，因該研究禁止再散布，本 repo 僅摘要其重點與結構並標註出處，不重製全文。

## 文件導覽

| 文件 | 內容 |
|---|---|
| [`docs/00-source-summary.md`](docs/00-source-summary.md) | 來源研究精要：三階段、六階段價值流、四支柱、自主性階梯、監督三軸 |
| [`docs/01-value-stream-map.md`](docs/01-value-stream-map.md) | 六階段價值流地圖與瓶頸識別 |
| [`docs/02-architecture.md`](docs/02-architecture.md) | 系統架構、元件邊界、資料流與控制流 |
| [`docs/03-idp-backstage.md`](docs/03-idp-backstage.md) | Backstage IDP 設計：Catalog、Templates、TechDocs |
| [`docs/04-agent-execution-dsh.md`](docs/04-agent-execution-dsh.md) | DSH 執行契約：headless 呼叫、skills、逾時重試 |
| [`docs/05-guardrails-governance.md`](docs/05-guardrails-governance.md) | IDP 四支柱落地與治理 |
| [`docs/06-human-oversight-policy.md`](docs/06-human-oversight-policy.md) | 監督分級的可判定規則 |
| [`docs/07-stacked-pr-workflow.md`](docs/07-stacked-pr-workflow.md) | stacked PR 拆分、rebase 與合併流程 |
| [`docs/08-metrics-kpi.md`](docs/08-metrics-kpi.md) | 輸出型與成果型雙軌 KPI |
| [`docs/09-roadmap.md`](docs/09-roadmap.md) | 分期路線圖與 Definition of Done |
| [`docs/10-open-questions.md`](docs/10-open-questions.md) | 待驗證假設與待裁決事項 |
| [`docs/11-test-strategy.md`](docs/11-test-strategy.md) | 測試框架與測試計畫（第 0 期核心交付） |
| [`docs/12-repo-settings-guide.md`](docs/12-repo-settings-guide.md) | GitHub repo 設定指引（分支保護、required checks） |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | 詞彙表：統一用語與常見錯誤用法 |
| [`docs/ADR/`](docs/ADR/) | 架構決策記錄（D1–D7） |

## 從哪裡開始讀

| 你的角色 | 建議順序 |
|---|---|
| **決策者／主管** | `README` → `09` 路線圖 → `10` 未決事項（§1.1 需你裁決的 6 項） |
| **實作工程師** | `02` 架構 → `04` DSH 執行 → `05` 治理 → `07` stacked PR |
| **審查者** | `06` 監督政策 → `07` §6 審查者指引 |
| **想理解為什麼** | `00` 來源精要 → `01` 價值流 → `ADR/` |

## 開發

本 repo 同時是工廠的**試點對象**（dogfooding，見 `docs/11-test-strategy.md` §1）。

```bash
npm ci                    # 安裝（版本已精確鎖定）
npm run typecheck         # TypeScript strict 檢查
npm run build             # emit dist/（CI entry points 使用）
npm test                  # 335 則測試
npm run test:unit         #   計分邏輯、停手規則、factory CLI
npm run test:integration  #   DSH 契約、gh CLI 解析、CLI 實機
npm run test:adversarial  #   guardrail 是否真的擋得住
npm run test:e2e          #   完整工作項流程（stub agent）
npm run test:quint        #   Quint 神諭 harness（模型 vs TS 實作）
npm run coverage          # 門檻：scoring/stop-rules/pipeline/cli 需 100% 分支
```

> **注意**：工廠對本 repo **永不自動合併**（`catalog-info.yaml` 的 `factory.io/agent-automerge: "false"`）。理由：agent 驗證自己的產出是 `docs/06` §4.3 明文禁止的模式。

**`main` 分支已受保護**（ruleset `main-protection`）：所有變更——包含人類的——都必須經 PR 與審查。設定方式見 `docs/12-repo-settings-guide.md`。

## 語言慣例

- **文件、規格、說明**：繁體中文
- **程式碼識別名、檔名、branch 名、commit message**：英文
