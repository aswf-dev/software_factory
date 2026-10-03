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
| [`docs/16-rescore-multirepo.md`](docs/16-rescore-multirepo.md) | 跨 repo 二次判定操作（rescore dispatch） |
| [`docs/17-backstage-rebuild.md`](docs/17-backstage-rebuild.md) | Backstage 重建手冊（新機器 / 雲端 VM 重新安裝） |
| [`docs/20-work-items.md`](docs/20-work-items.md) | SDLC 改善工項清單（含狀態追蹤） |
| [`docs/21-candidate-work-item-types.md`](docs/21-candidate-work-item-types.md) | 候選工作類型清單（活文件） |
| [`docs/22-scoreboard-platform-evaluation.md`](docs/22-scoreboard-platform-evaluation.md) | Scoreboard 雲端平台評估（Vercel / Cloudflare / 其他 SaaS） |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | 詞彙表：統一用語與常見錯誤用法 |
| [`docs/ADR/`](docs/ADR/) | 架構決策記錄（D1–D7） |

## 從哪裡開始讀

| 你的角色 | 建議順序 |
|---|---|
| **決策者／主管** | `README` → `09` 路線圖 → `10` 未決事項（§1.1 需你裁決的 6 項） |
| **實作工程師** | `02` 架構 → `04` DSH 執行 → `05` 治理 → `07` stacked PR |
| **審查者** | `06` 監督政策 → `07` §6 審查者指引 |
| **想理解為什麼** | `00` 來源精要 → `01` 價值流 → `ADR/` |

## 接入指引（Onboarding：讓一個新 repo 能被工廠處理）

工廠可對**任何 repo**（含非 `philipz` owner）工作，但目標 repo 必須先滿足下列條件。
前 4 項若缺少，`factory-run.yml` 會**在花費任何 LLM 成本之前失敗**。

| # | 必要條件 | 檢查指令 | 缺少時的症狀 |
|---|---|---|---|
| 1 | 已安裝 GitHub App `softwarefactory-bot` | `gh api orgs/<org>/installations --jq '.installations[].app_slug'` | Mint app token 步驟失敗 |
| 2 | 存在 `software-factory` 分支（工廠 trunk） | `gh api repos/<owner>/<name>/git/ref/heads/software-factory` | `::error::目標 repo ... 不存在分支 base_branch=software-factory` |
| 3 | 根目錄有 `catalog-info.yaml` | `gh api "repos/<owner>/<name>/contents/catalog-info.yaml?ref=software-factory"` | `error: file not found: target/catalog-info.yaml` |
| 4 | 有 `.github/factory/risk-paths.yml` | `gh api "repos/<owner>/<name>/contents/.github/factory/risk-paths.yml?ref=software-factory"` | 同上（risk-paths 路徑） |
| 5 | Issues 功能已啟用 | `gh api repos/<owner>/<name> --jq .has_issues` | Backstage `github:issues:create` 無法建立 Issue |

> **注意 1**：條件 3、4 的檔案位於 `software-factory` 分支，**查詢時務必帶 `?ref=software-factory`**。
> 省略會查到預設分支（`main`）而得到誤導性的 404。
>
> **注意 2**：GitHub 對 **fork** 一律預設關閉 Issues（設計上希望 bug 回報到上游）。
> fork 來的 repo 需手動開啟第 5 項：`gh api -X PUT repos/<owner>/<name> -F has_issues=true`

### 步驟

以 `<owner>/<name>` 代表目標 repo。條件 2–4 都寫在 **`software-factory` 分支**上（`main` 絕不觸碰，Q-P2-1）。

```bash
# 1. 建立工廠 trunk 分支（自 main 分出）
MAIN_SHA=$(gh api repos/<owner>/<name>/git/ref/heads/main --jq .object.sha)
gh api -X POST repos/<owner>/<name>/git/refs \
  -f ref=refs/heads/software-factory -f sha="$MAIN_SHA"

# 2. 加入 catalog-info.yaml 與 risk-paths.yml（見下方內容），推到 software-factory 分支
#    risk-paths.yml 可直接沿用本 repo 的 .github/factory/risk-paths.yml（H1–H7 通用）

# 3. 驗證計分（本 repo 內執行；決定 agent 能否自主跑）
npm run build
node dist/cli/factory-score.js \
  --catalog <目標 repo>/catalog-info.yaml \
  --risk-paths <目標 repo>/.github/factory/risk-paths.yml
```

`catalog-info.yaml` 最小範例：

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: <name>
  description: <一句話描述>
  annotations:
    # 三軸評分（docs/06 §3）；每軸 0–2 分
    factory.io/business-criticality: tactical   # tactical | operational | strategic
    factory.io/risk-profile: low                # low | medium | high
    factory.io/complexity: low                  # low | medium | high
    factory.io/stack: typescript
```

### 三軸評分決定 agent 能否自主執行

**這是接入時最容易踩的坑**：三軸標註直接決定工作項會不會被擋下。

| 總分 | tier | 結果 |
|---|---|---|
| 0–1 | `on-loop` | agent 自主執行，允許 automerge |
| 2–4 | `review` | agent 執行，需人類審查 |
| 5–6 | `in-loop` | **agent 被 `exit 1` 擋下**，人類主導（`agent-analyze` 除外，可僅分析） |

未標註的軸會 **fail-safe 判為 2 分**（保守方向）——三軸全未標＝6 分＝直接 `in-loop`，agent 完全跑不起來。
另外，觸碰 `risk-paths.yml` 的 H1–H7 硬性規則會**強制 risk = 2 分且無裁量空間**。

真實 PoC repo 宜標 `tactical`/`low`/`low`（0 分）；高風險 repo（如涉及金流）標高分是刻意讓其落在 `in-loop`。

## 使用方式（開立工作項）

### 方式 A：Backstage 表單（建議）

Backstage → **開立 Factory 工作項**（`backstage/templates/factory-work-item/template.yaml`）。

填寫 → 送出即代表**人類核准**（取代 label 閘門），流程為：
建立格式合規的 Issue → dispatch `factory-run.yml` → agent 在目標 repo 的 trunk 上工作 → 交付 stacked PR。

| 欄位 | 說明 |
|---|---|
| 一句話需求 | 自動加上 `[factory] ` 前綴成為 Issue 標題 |
| 任務類型 | `agent-add-tests` / `agent-fix-bug` / `agent-update-deps` / `agent-write-docs` / `agent-analyze` |
| 需求描述（PRD） | 可按「✨ 一次生成」讓 LLM 產生草稿再逐欄審改 |
| 驗收標準（DoD） | 三項必勾 |
| 目標 repo | 預設 `philipz`，**可改為其他 owner**（須先完成上方接入指引） |
| 目標分支 | 固定 `software-factory` |

### 方式 B：CLI dispatch

Issue 需已存在且格式合規（見 `.github/ISSUE_TEMPLATE/factory-work-item.yml`）。

```bash
gh workflow run factory-run.yml --repo aswf-dev/software_factory \
  -f issue_number=<Issue 編號> \
  -f repo=<owner>/<name> \
  -f base_branch=software-factory \
  -f task_type=agent-update-deps
```

**首次接入建議先跑 dry run**（以 stub agent 取代真實 DSH，不花 LLM 成本，可驗證前置條件是否齊備）：

```bash
gh workflow run factory-run.yml --repo aswf-dev/software_factory \
  -f issue_number=<編號> -f repo=<owner>/<name> \
  -f dry_run=true -f dry_run_scenario=success
```

### 二次判定（rescore）

PR 開出後若需重新計分（例如調降某軸後），見 `docs/16-rescore-multirepo.md`。
**無自動化**——App 無 `actions:write` 權限，須手動觸發。

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
