# 05 — Guardrails 與治理

> **依據**：`00-source-summary.md` §4（IDP 四大支柱）、§5（自主性階梯與治理挑戰）、§7（三大警示）、`02-architecture.md` D4（雙層 guardrail）、D6（GitHub App 權限）
> **讀者**：負責安全與平台治理的工程師
> **本文件的地位**：guardrail 設計的單一事實來源。任何放寬都必須修改本文件並留下理由，不得在實作中臨時決定。

---

## 1. 治理的根本命題

來源研究 `00` §5 的結論語只有一句，但決定了整份治理設計：

> **「Agents are new insiders.」**（agent 是新的內部人）

**內部人風險的特性**是：擁有合法憑證、在信任邊界內活動、行為看似正常。傳統的周界防護（擋外部攻擊）對此無效。

因此本專案的治理不問「如何阻止 agent 被入侵」，而問三個內部人問題：

1. agent **能做什麼**？（權限最小化）
2. agent **做了什麼**？（可稽核）
3. agent 出錯時**誰承擔、如何止血**？（責任與止損）

### 1.1 雙層防護（D4）與其不變量

| 層 | 機制 | 防護對象 | 失效時 |
|---|---|---|---|
| **DSH 層** | sandbox mode、approval policy、skills 規則 | agent 在**執行期**能做什麼 | GitHub 層仍能阻止變更落地 |
| **GitHub 層** | branch protection、required checks、CODEOWNERS、App 權限 | agent 的**產出**能否進入主線 | DSH 層仍限制執行期破壞 |

> **核心不變量（無例外）**：
> **agent 不得擁有修改 guardrail 本身的權限。**
>
> 這條規則若被違反，雙層防護會**同時**失效——因為 agent 可以先拆掉一層，再拆另一層。D6 不授予 `Administration` 與 `Workflows` 權限，就是這條不變量的機制執行。

---

## 2. 支柱一：Guardrails

> `00` §4 原文定義：透過透明的資料記錄確保合規，並藉由阻擋無效請求保護系統。

### 2.1 DSH 層

| 機制 | 設定 | 已查證來源 |
|---|---|---|
| **Sandbox 模式** | CI 中固定 `workspace-write`；**永不使用 `danger-full-access`** | `dsh-sandbox-policy`：三模式為 `read-only`/`workspace-write`/`danger-full-access`，**預設 `read-only`（fail-safe）** |
| **模式的不可竄改性** | 模式以 durable 事件記錄，session 建立時釘選 | `dsh-sandbox-policy`：「The switch IS its event; nothing mutates the mode out of band」 |
| **核准政策** | CI 中設為 `never`（拒絕而非等待） | `dsh-permission-presets`：綁定 `sandbox/mode` 與 `approval/policy` |
| **工作目錄限定** | 限於該次 run 的 workspace | `dsh-sandbox-policy`：session 的 immutable `cwd` 成為 `workspaceRoot` |

**已查證的重要性質**：session 建立時會**釘選** `permissionPresets/preset`、`sandbox/mode`、`approval/policy`，之後的設定變更**永不影響既有 session**。這代表 agent 無法在執行途中自我提權——權限在開始時就已凍結。

### 2.2 GitHub 層

```
main 分支保護：
├── 禁止直接推送（含 App）
├── required status checks 全綠才可合併
├── CODEOWNERS 對高風險路徑強制人類審查
└── 禁止強制推送與刪除分支
```

**CODEOWNERS 的關鍵設計**：

```
# .github/CODEOWNERS
# 預設擁有者
*                           @my-org/dev-team

# --- guardrail 自身：agent 絕不可自行變更 ---
/.github/                   @my-org/platform-team
/.github/workflows/         @my-org/platform-team
/.github/CODEOWNERS         @my-org/platform-team
/catalog-info.yaml          @my-org/platform-team
/.dsh/skills/               @my-org/platform-team

# --- 高風險路徑：對應 00 §6 的 human-in-the-loop 清單 ---
/src/auth/**                @my-org/security-team
/src/payment/**             @my-org/security-team
/src/**/authorization*      @my-org/security-team
```

> **設計理由**：前一組保護的是**工廠的規則本身**（含 `.dsh/skills/`——若 agent 能改自己的 SOP，SOP 就不是約束）；後一組對應 `00` §6 明列的高風險類別（授權邏輯、財務計算、敏感資料）。
>
> ⚠️ 路徑模式須依實際 repo 結構調整；上例為示意。

### 2.3 透明的資料記錄（原文要求的「合規」面）

| 記錄對象 | 位置 |
|---|---|
| agent 的每次執行 | GitHub Actions run log（含 stdout/stderr） |
| agent 的每次變更 | commit 歷程（以 App 身分，可辨識） |
| agent 的決策與停手原因 | Issue 留言 |
| token 消耗 | OTel 遙測（`dsh-session-telemetry-otel`） |
| session 完整軌跡 | DSH session 持久化紀錄 |

**保存期限**：⚠️ 待定（Q05-3）。原則是至少涵蓋一個稽核週期。

---

## 3. 支柱二：憑證管理

> `00` §4 原文定義：集中管理 API key、支援 secrets manager，以實現安全的存取控制與存取路徑監控。

### 3.1 核心原則（已查證的 DSH 設計恰好一致）

`dsh-credentials` README 的原文教義：

> **「Configuration carries references to secrets, never the secrets.」**
> 設定檔寫的是 `apiKeyEnv: DEEPSEEK_API_KEY` 這類**參照**，實際值存於憑證提供者。

三項已查證的後果：

1. **設定檔可安全同步與在 UI 呈現**——因為裡面沒有密鑰。
2. **消費端逐操作解析**（`resolve(ref)` 於每次操作開始時呼叫，**不跨操作快取**）——輪替密鑰能立即在下一次請求生效，無須重啟。
3. **空值即視為未設定**——空白永遠無法偽裝成已設定的密鑰。

### 3.2 工廠的憑證清單與存放

| 憑證 | 存放位置 | 誰能讀 | 輪替方式 |
|---|---|---|---|
| **GitHub App private key** | GitHub Secrets（`FACTORY_APP_PRIVATE_KEY`） | Actions runner | 人類手動；建議年度 |
| GitHub installation token | 執行期產生（`actions/create-github-app-token`） | 該次 run | **自動短效**，隨 run 結束失效 |
| LLM API key | GitHub Secrets（`DEEPSEEK_API_KEY`） | Actions runner | 人類手動 |

### 3.3 不可違反的規則

> **密鑰不得進入 agent 的 context。**

agent 透過**環境變數**間接使用憑證（`gh` CLI 讀 `GH_TOKEN`、LLM adapter 讀 API key），但**密鑰值本身永不出現在任務描述、skill 內容或 agent 的對話歷程中**。

**理由**：agent 的 context 會被送往 LLM 供應商，且會留存於 session 紀錄。密鑰一旦進入 context，即等同外洩。

**檢查方式**：
- CI 中禁止 `echo $SECRET` 類指令；
- `.gitignore` 已排除 `.env`、`*.pem`、`*.key`（見本 repo 的 `.gitignore`）；
- GitHub Secrets 在 run log 中自動遮蔽（但**不可依賴此為唯一防線**）。

### 3.4 GitHub App private key 的特殊地位

它是本系統**最敏感的單一密鑰**——持有者可取得 agent 的全部權限。因此：

- 只存於 GitHub Secrets，**不存於任何開發者的本機**；
- 建立 App 與安裝為**人類手動操作，不可自動化**（`03` §8 步驟 1）；
- 若疑似外洩，**立即於 GitHub App 設定中撤銷並重新產生**。

---

## 4. 支柱三：沙箱環境

> `00` §4 原文定義：提供安全隔離的基礎設施以執行 AI agent 與 AI 生成的程式碼，使測試、評估、部署得以安全進行。

### 4.1 隔離的三個層次

| 層 | 機制 | 隔離對象 | 狀態 |
|---|---|---|---|
| **1. 程序層** | DSH sandbox（landlock，Linux） | 檔案系統存取 | ⚠️ Linux 行為待驗證（Q04-3） |
| **2. 容器層** | GitHub Actions runner（每次 run 全新 VM） | 整個執行環境 | ✅ 平台保證 |
| **3. 網路層** | runner 的出向網路 | 外部連線 | ⚠️ 預設不受限（見下） |

**GitHub-hosted runner 的天然優勢**：每次 run 都是**全新的、用完即棄的環境**。這免費提供了 `00` §4 要求的隔離基礎設施，且自動滿足 `01` §3 消除清單 E1（消除手動開環境票）。

### 4.2 網路層的誠實說明

⚠️ **GitHub-hosted runner 的出向網路預設不受限**。agent 可存取任意外部網址。

**風險**：資料外洩、供應鏈攻擊（安裝惡意套件）。

**本階段的因應**（分層，非完美）：

1. `factory-stop-rules` skill 禁止新增未在既有相依清單中的套件（`04` §3.3 第 5 條）——提示層。
2. PR 審查會看到任何 `package.json` / lockfile 變更——機制層。
3. CODEOWNERS 可將相依清單納入保護——機制層。

> **誠實揭露**：以上皆為**偵測與嚇阻**，非**預防**。真正的網路隔離需要 self-hosted runner 搭配出向白名單，成本較高。第一階段接受此風險，因為：(a) 執行環境用完即棄；(b) 產出必經人類審查；(c) 密鑰不在 context 中。**但這是一項已知的殘餘風險，不是已解決的問題**（Q05-1）。

---

## 5. 支柱四：成本管理

> `00` §4 原文定義：監控 AI 資源與推論成本，對異常支出模式發出告警。

| 層 | 機制 | 狀態 |
|---|---|---|
| **硬性時間上限** | Actions `timeout-minutes: 30` | ✅ 立即可用，必然生效 |
| **Token 計量** | `dsh-token-meter`（已查證） | ✅ 可量測 |
| **遙測輸出** | `dsh-session-telemetry-otel`（已查證） | ⚠️ 需接指標後端 |
| **中止門檻** | 依 token 讀數中止 | ⚠️ **門檻值未定**（Q02-5） |
| **異常告警** | 支出模式偵測 | ⚠️ 需先有基線 |

**第一階段的務實做法**：先**只量測不中止**。時間上限已提供保護；累積數週基線後再設 token 門檻。憑空定門檻會造成頻繁誤中止（過低）或形同虛設（過高），兩者都比誠實地說「還不知道」更糟。

---

## 6. 自主性階梯的分級治理

依 `00` §5 的四層階梯，本專案的定位與對應治理：

| 層級 | 特性 | 治理挑戰（原文） | 本專案 |
|---|---|---|---|
| AI assistants | 規則式，低自主 | 究責與 guardrails | 已超越 |
| **Simple AI agents** | 專門化、任務特定、自主 | 互通性、可靠性與評估 | **← 第 1 期定位** |
| **Collaborative AI agents** | 跨多 agent 協調，高能動性 | 編排與互動的**複合風險** | **← 上限（D5）** |
| AI agent ecosystems | 跨組織協作 | 行為、協調、合規、**共謀** | **明確排除** |

### 6.1 各層級的治理要求

**Simple AI agents（第 1 期）**：
- 每次執行獨立、無狀態（`04` §1.3）→ 天然限制爆炸半徑。
- 治理重點：**可靠性評估**——建立 exit code、一次通過率、`needs-human` 率的基線。

**Collaborative AI agents（上限）**：
- 若引入多 agent 協作（如一個寫碼、一個審查），複合風險出現：**兩個 agent 可能互相確認彼此的錯誤**。
- 治理要求：**審查者 agent 的產出不得取代人類審查，只能作為附加意見**。人類審查在 D5 的範圍內永不移除。

> **多 agent 工具（dsh-agent-teams / workflow 工具）的採用門檻**（2026-08-24 評估，ADR-010）：
> 現階段**不採用**。現行 factory 的 skills 與 CI templates 皆以「單一 DSH headless agent 處理單一工作項」為前提（一次 run = 一次 headless 呼叫、單一 `report.json`、judge/stop-rules/token 預算全部圍繞單 agent），而多 agent 團隊插件（如 `dsh-agent-teams`）或 workflow 編排工具會瓦解「單一帳戶單元」的缺陷歸因與棘輪機制。採用前必須依序滿足：
> 1. **Q05-5 先補齊**：複合風險治理細則——審查者 agent 產出僅為附加意見（人類審查永不移除）、缺陷歸因與棘輪延伸到團隊、token 分帳與 report 聚合格式、stop-rules 由隊長繼承/轉交；
> 2. **版本與 headless 驗證**：DSH 升級至插件目標 API 世代後，在 `factory-run` 相同的 headless + `factory-guardrail.patch.yml`（workspace-write + approval never）下實測（沿用 `dsh-sandbox-probe` 模式），確認狀態檔寫入不違反沙箱；
> 3. **任務規模**：出現單 agent 無法勝任的工作項型別（或 roadmap 第 3 期之後明確要求角色分工）——現行工作項刻意小（≤100–300 行），平行化已由 Actions 層「每 issue 一個 run」達成。
> 另注意：安裝插件需改 DSH 設定面，屬 SR3（需改 CI 設定）與 H5 保護範圍，只能由人類決策；agent 不得自行引入。

> **為何排除生態系層**：跨組織 agent 協作涉及共謀與合規問題，遠超小團隊的治理能力。這是能力邊界的誠實承認。

---

## 7. 對三大警示的具體因應

`00` §7 的三項警示與本專案的對應：

| 警示 | 本專案的因應 | 落實位置 |
|---|---|---|
| **安全風險升高** | 雙層 guardrail、權限最小化、密鑰不進 context、沙箱隔離 | 本文件 §2–§4 |
| **效力轉移而非節省**（瓶頸移到 code review） | stacked PR 縮小審查單元；KPI 納入 PR 大小與審查等待時間 | `07`、`08` |
| **技能退化** | 高風險類別維持人工主導；review 為必修 | `06`、下方 §7.1 |

### 7.1 技能退化的具體防範

原文警告：**AI 依賴侵蝕獨立判斷力，當工具失效或不可用時反而損害生產力**。

本專案的防範措施：

1. **高風險類別禁止 agent 實作**（`06` 計分 5–6）——確保核心能力持續由人行使。
2. **審查是必修**——人類必須實際讀懂 agent 的產出才能核准，而非橡皮圖章。
3. **agent 必須解釋其變更**——PR 描述須說明「為何這樣改」，使審查者能驗證推理而非只看結果。
4. **停手時交還完整脈絡**——`needs-human` 附上已嘗試的內容，讓人類能接手而非重做。

> **值得留意的張力**：措施 2 與「提升生產力」存在張力——若審查草率，技能退化與品質風險同時發生；若審查嚴謹，速度提升受限。**這個張力無法用工具消除，只能靠 `07` 縮小審查單元來緩解**。誠實面對它，比假裝自動化能解決它更安全。

---

## 8. 治理的檢查清單

實作完成後，逐條驗證（每條都應可實測，而非宣稱）：

- [ ] agent 的 GitHub App **無** `Administration` 與 `Workflows` 權限（D6）
- [ ] `main` 分支禁止直接推送，App 亦不例外
- [ ] `.github/`、`CODEOWNERS`、`catalog-info.yaml`、`.dsh/skills/` 均在 CODEOWNERS 保護下
- [ ] CI 中 sandbox 模式為 `workspace-write`，**非** `danger-full-access`
- [ ] approval policy 為 `never`（CI 中不等待人工核准）
- [ ] 密鑰以環境變數參照使用，**未出現**在任務描述或 skill 中
- [ ] Actions workflow 設有 `timeout-minutes`
- [ ] agent 的 commit 可由身分辨識為非人類
- [ ] `factory-stop-rules` skill 存在且被任務描述引用
- [ ] 高風險路徑（授權、金流、敏感資料）在 CODEOWNERS 中指定人類審查者

---

## 未決事項

| 編號 | 事項 | 風險等級 | 處置 |
|---|---|---|---|
| Q05-1 | **runner 出向網路預設不受限**（§4.2） | 中 | 第一階段接受並揭露；若處理敏感資料則需 self-hosted runner + 出向白名單 |
| Q05-2 | landlock 在 Linux runner 的實際隔離強度未驗證 | 中 | 實作時在 CI 驗證（= Q04-3） |
| Q05-3 | 稽核紀錄保存期限未定 | 低 | 依組織政策決定 |
| Q05-4 | token 中止門檻未定 | 低 | 先量測再定（= Q02-5） |
| Q05-5 | 多 agent 協作時的複合風險治理細則未展開 | 低 | 第 1 期不涉及；引入前須先補此節（2026-08-24 已評估 dsh-agent-teams / workflow 工具，結論：目前不採用，門檻見 §6.1 與 ADR-010） |
| Q05-6 | CODEOWNERS 的高風險路徑模式需依實際 repo 結構調整 | 低 | 實作時確定 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
