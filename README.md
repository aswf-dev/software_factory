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
| [`docs/ADR/`](docs/ADR/) | 架構決策記錄 |

## 語言慣例

- **文件、規格、說明**：繁體中文
- **程式碼識別名、檔名、branch 名、commit message**：英文
