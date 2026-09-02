# 22 — Factory Scoreboard 雲端平台評估（Vercel / Cloudflare / 其他 SaaS）

> **用途**：評估「收集 factory 費用與效益資料的產品網站」該用哪個雲端平台，並畫出「私人 → 小團隊 → 付費產品」的演進路徑。
> **狀態**：**評估文件（未裁決）**——本文件是決策輸入，不是已接受的架構。裁決後另寫 `ADR-015`、開 `docs/20` 工項與 MVP Issue。
> **讀者**：決定平台選型與 Scoreboard 產品走向的人。
>
> **前置**：`PR #248` 已合併——每次 factory-run 的 token 用量與成本現已落在 Issue 留言與執行報告（`report.json` 的 `usage` 區塊／`usage.json`），是「費用收集」的資料源。本文件引用的欄位以合併後為準。
>
> **外部資料聲明**：平台免費層／定價為 **2026-09 查證的外部資料**，會變動——只作為決策方向佐證，**選型當下必須以各官方頁面為準**。

---

## 1. 目的、範圍與成功判準

### 1.1 目的

建立一個雲端網站，**收集 factory 各工作項的費用與效益資料**並展示：

- 每工作項的 token 用量與 USD 成本（`PR #248` 已產出）
- 任務類型（task_type）、LLM 模型（provider/model）——分析 **ROI／效益**與作為**未來收費依據**
- 隨功能增加陸續收集更多欄位（版本化事件 schema）

網站同時是**軟體工廠的產品首頁**（對外呈現）與**後台 Scoreboard**（對內分析）。

### 1.2 範圍

- **本文件回答**：平台選型（Vercel vs Cloudflare Workers vs 其他 SaaS）＋建議架構＋演進路徑。
- **不做**：UI 設計、billing 實作、平台帳號註冊/部署、平台程式碼。這些是裁決後的 MVP 工項。

### 1.3 成功判準（評估面）

| 判準 | 說明 |
|---|---|
| 起步成本 ≈ 0 | 單人/MVP 階段免費或近乎免費 |
| 可無痛升到小團隊 | 認證、多 repo、權限分級不需砍掉重練 |
| **不擋未來多租戶/收費** | 資料模型從第一版就有 owner/repo 隔離欄位；auth 有升級路徑 |
| 維運負擔低 | 此 repo 已因維運成本凍結 Backstage（Q03-6/Q13-1）、延後 OTel（Q08-4）——平台若需自架 DB/認證/備份，與這個先例衝突 |
| 與 GitHub 單一事實來源共存 | 不推翻 ADR-001；平台是「收集＋呈現」，不是新的真相源 |

---

## 2. 需求與演進三階段

| 階段 | 使用者 | 需求 | 平台要求 |
|---|---|---|---|
| **MVP** | 你／小團隊 | 接收 factory-run 推送、存每工作項事件、後台看板（成本/token/task_type/model 趨勢）、產品首頁 | 收 POST＋SQL 儲存＋簡單認證＋靜態前端 |
| **中期** | 小團隊＋內部 | 多 repo 彙整、ROI 分析視圖、欄位擴充、GitHub OAuth 或 IdP | analytics 查詢、RBAC、schema 演進 |
| **長期** | 付費使用者 | 多租戶隔離、訂閱/計費、資料所有權與匯出、SLA/備份 | auth＋billing 整合、租戶隔離、可匯出 |

> **關鍵推論**：這不是「唯讀看板」——需要**接收推送的後端**（公開 HTTP endpoint＋secret 驗證）與**長期事件儲存**。因此「純靜態托管」（GitHub Pages）與「無後端 SaaS」先天不符，直接排除（見 §5 矩陣）。

---

## 3. 資料模型草案（事件式、前向相容）

單一 **`work_item_events`**（append-only 事件列）。理由：CI 推送、Backstage 表單推送、未來新來源都能寫同一張表；`PR #248` 的 `usage` 區塊就是天然的事件體。

```jsonc
{
  "event_id": "uuid",                    // 冪等鍵（CI 重試不重複計）
  "schema_version": 1,
  "occurred_at": "2026-09-02T08:37:38Z", // factory-run 結束時間
  "source": "factory-ci",                // factory-ci | backstage-form | …
  "owner": "philipz",                    // 多租戶隔離從第一版就有
  "repo": "software_factory",
  "issue_number": 228,
  "run_id": 33523314113,                 // Actions run id（可回溯原始 log）
  "task_type": "agent-analyze",          // factory-run 的 task_type input
  "model_tier": "high",                  // model.json 的 tier（若可取得）
  "provider": "deepseek-official",       // usage.routes[].provider（實際 route）
  "model": "deepseek-v4-flash",          // usage.routes[].model
  "totals": {                            // usage.totals 的透傳（PR #248）
    "inputTokens": 145412,
    "outputTokens": 57721,
    "cacheReadTokens": 3775488,
    "reasoningTokens": 42079,
    "totalTokens": 3978621,
    "costUsd": 0.037
  },
  "extra": { "…": "…" }                  // 未來新欄位（JSON，不破壞 schema）
}
```

**與現有產物的對應**：

| 現有產物 | 取用欄位 |
|---|---|
| `usage.json`（artifact）／`report.json` 的 `usage` | `totals`、`routes[].provider/model`、`measuredAt` |
| factory-run input | `task_type`、`repo`、`issue_number` |
| `model.json`（CI artifact） | `tier`、`chain`（實際用到的 model 由 usage.routes 更準） |
| Backstage 開單表單 | `repo`、`task_type`、`issue_number`（開單當下即有事件、成本未發生時 totals 可空） |

> **誠實揭露**：`costUsd` 是估算（依 `config/dsh/pricing.yaml`，非供應商帳單）——事件 schema 標 `costUsd` 為估算值，避免日後被誤當帳單依據（`docs/04 §5.1` 已聲明）。

---

## 4. 收集管道設計（契約草案，實作在裁決後）

### 4.1 CI 推送（主路徑）

`factory-run.yml` 在「Measure usage & cost」步驟後加一步：

```
POST https://<scoreboard>/v1/events
Authorization: Bearer ${{ secrets.SCOREBOARD_TOKEN }}
body: { event_id, occurred_at, source: "factory-ci", repo, issue_number,
        run_id, task_type, totals: <usage.totals>, routes: <usage.routes> }
```

- secret 放 GitHub repo secret（沿用 D6「credential 只放 env 參照、永不入檔」慣例）。
- 冪等：以 `event_id`（或 `run_id+issue_number`）去重；失敗重試安全。
- 失敗不擋 run：推送是收集面，不影響 factory 終態判定（與 usage 量測同原則，`docs/04 §5.1`）。

### 4.2 Backstage 表單推送

「開立 Factory 工作項」template 的 action 或 webhook → 同一個 `POST /v1/events`（`source: "backstage-form"`）。開單當下先記一筆「已建立、成本未發生」的事件；factory-run 結束後以 `issue_number` 補 `totals`。

### 4.3 端點契約草案

| 端點 | 用途 | 認證 |
|---|---|---|
| `POST /v1/events` | 接收事件（CI/Backstage/未來來源） | 共享 secret（內部）→ 未來 per-owner token |
| `GET /v1/events?owner=&repo=&from=&to=` | 後台查詢 | 登入後授權（owner 範圍） |
| `GET /v1/summary?…` | 看板聚合（成本/月、token/工作項、task_type/model 分佈） | 登入後授權 |
| `POST /v1/export` | raw JSON 匯出（資料所有權） | 登入＋owner 驗證 |

---

## 5. 平台評估矩陣

### 5.1 候選清單與理由

| 候選 | 納入理由 |
|---|---|
| **A. Cloudflare Workers + D1 + Pages + Access** | 一個供應商包下收 POST、SQL 儲存、靜態前端、認證；免費層大 |
| **B. Vercel（Next.js + Vercel Postgres/KV）** | DX 最佳、PR preview 最強；與本 repo 的 GitHub 流程最貼 |
| **C. Supabase（BaaS）＋ 任一前端托管** | Postgres＋Auth/RBAC 現成；適合「資料重、analytics 重」的未來 |
| **D. Netlify** | Functions＋Forms＋Identity 都有，中間選項 |
| **E. Fly.io / Render（container）** | 全權掌控、商用自由；維運重 |
| **F. GitHub Pages / 純靜態** | 成本 $0、維運最低——但**無接收端、無 DB**，不符「收集推送資料＋收費」需求 → 排除，僅列為對照 |

### 5.2 比較矩陣（2026-09 查證，以官方頁面為準）

| 面向 | A. Cloudflare Workers+D1 | B. Vercel (Pro) | C. Supabase＋前端 | D. Netlify | E. Fly.io/Render |
|---|---|---|---|---|---|
| **免費層** | Workers 100k req/day、D1 ~5GB、Pages 無限靜態、Access ~50 人免費（官方：Workers [pricing](https://developers.cloudflare.com/workers/platform/pricing/)、D1 [pricing](https://developers.cloudflare.com/d1/platform/pricing/)） | Hobby 個人免費；**商用/付費產品需 Pro**（[Hobby plan](https://vercel.com/docs/plans/hobby)、[AUP](https://vercel.com/legal/acceptable-use-policy)） | Postgres 500MB＋Auth 免費層 | 中等免費層 | 少量免費額度 |
| **商用/AUP** | ✅ 允許商用 | ⚠️ Hobby 不可商用；Pro 起跳 | ✅ 商用 OK | 商用需付費層 | ✅ 商用 OK |
| **收 POST＋DB** | Worker 收 POST 原生；D1 = SQLite 語法 | Functions 收 POST；DB 另購 | Edge Functions 較弱（建議另配 worker）；DB/Auth 最強 | Functions 收 POST | container 全權 |
| **Auth／多租戶** | Access 內建（免費 50 人）→ 付費擴充 | 需另接（Auth0/Clerk/Supabase Auth） | **Auth/RBAC 現成**，多租戶成熟 | Identity 較陽春 | 自建 |
| **收費路徑** | Workers Paid $5/mo 用量近無限；Stripe 可接 | Pro→Enterprise；生態成熟 | 付費方案成熟、與 Stripe 整合常見 | 有付費層 | 自建計費 |
| **維運負擔** | 低（單一供應商、D1 免備份？→需確認） | 低 | 低（DB/auth 代管）；但要多管一個前端托管 | 低 | **高**（此 repo 先例不愛） |
| **分析/查詢** | D1 SQL 夠用；大量 analytics 需遷 pg | Postgres 可上 pg | **最強**（pg + 延伸） | 一般 | 全權 |
| **與 GitHub 整合** | 一般（可連 repo/PR preview） | **最強**（原生 preview、GitHub App 生態） | 一般 | 好 | 一般 |
| **估月費（小團隊、輕流量）** | ~$0–25 | ~$20–100+ | ~$0–25（+前端托管） | ~$0–19 | ~$5–25＋維運 |

> 外部佐證：[Cloudflare vs Vercel for a SaaS in 2026](https://tools.thesoundmethod.me/posts/cloudflare-vs-vercel-for-saas-2026)（成本預測性、全球 edge、R2 zero-egress vs Vercel DX/preview 的權衡）——僅供參考，數字以官方為準。

### 5.3 排除說明

- **F（純靜態）**：無接收端。除非改走「CI 把事件 commit 回一個資料 repo，網站只讀」，但那等於把 GitHub 當 DB——不是本需求要的「收集推送」架構；且付費/多租戶無解。保留為「$0 對照組」。
- **E（Fly/Render）**：彈性最大但維運最重。此 repo 已有「維運成本 > 價值即降級」的決策文化（Backstage、OTel），除非未來出現 container 專屬需求否則不建議。

---

## 6. 建議（供裁決，未定案）

### 6.1 主架構建議：A. Cloudflare（Workers API + D1 儲存 + Pages/Assets 前端 + Access 認證）

理由：

1. **免費層涵蓋 MVP～小團隊**：Workers 100k req/day、D1 5GB、Access 免費 50 人——正好對齊「短期後台給小團隊」。
2. **$5/mo 後用量近乎無上限**（Workers Paid）：對齊「長期開放給付費使用者」的擴充需求，不需遷移平台。
3. **單一供應商、低維運**：收 POST（Worker）＋儲存（D1）＋前端（Pages/Assets）＋認證（Access）一個 dashboard，與本 repo「凍結 Backstage、延後 OTel」的低維運先例一致。
4. **TypeScript/JS 生態一致**：本 repo 已是 TS；Worker 以 TS 開發，前端可用 Astro/Remix/Hono 等輕框架（不必綁 Next.js）。
5. **多租戶收費路徑清楚**：schema 第一版就有 `owner`；Access 免費 50 人 → 付費後升級 Access/正式 IdP；Stripe 接 Worker 是常見做法。

### 6.2 換 Vercel 的觸發條件（誠實清單）

若以下任一成立，Vercel 是合理替代（選 B 而非 A）：

- 你確定前端要 **Next.js** 且重度依賴其 SSR/ISR/image 生態。
- 你要 **每 PR preview deployment** 給團隊審（Vercel 這點明顯最強）。
- 你接受付費產品**一上線就付 Pro**（Hobby 不可商用），且月費 $20+/seat 不是問題。
- 你偏好「一個框架公司」的整合 DX 勝過跨供應商的成本預測性。

> Vercel 版替代架構：Next.js（App Router）＋ Vercel Postgres 或 Neon ＋ 前端接 Auth0/Clerk；資料模型與 §3 相同。

### 6.3 若資料分析未來變重（ROI/多租戶 analytics）

A 的 D1（SQLite 系）在「事件量大＋複雜 analytics＋多租戶計費查詢」時會先到頂。**遷移路徑**：

1. D1 保留為事件接收緩衝，把彙整結果寫進第二儲存，或
2. 直接換 **Postgres 系**（C. Supabase 或 Neon；Cloudflare 可透過 Hyperdrive 連外部 pg），事件表語法相容度高（SQL）。

此遷移是「資料變重才做」，不阻塞 MVP——但**事件 schema 第一版就要有 owner/事件時間/版本欄位**，讓遷移只是搬資料不是重造。

---

## 7. 風險與限制

| 風險 | 說明 | 緩解 |
|---|---|---|
| 免費層數字會變 | Workers/D1/Access 免費額度官方會調整 | 文件標查證日期；選型當下重查官方頁面 |
| Vendor lock-in | Worker runtime 與 D1 綁 Cloudflare | 收發契約（§4）平台中立；事件可 `GET /v1/export` 匯出 raw JSON；SQL 語法標準化 |
| 資料所有權/隱私 | 成本資料含 repo 名、issue 內容間接資訊；未來付費使用者資料 | 匯出 API；owner 隔離；隱私預設（Q22-5） |
| costUsd 是估算 | 非供應商帳單（docs/04 §5.1） | schema 標明估算；日後可對齊正式帳單 |
| 多租戶太晚做 | 若第一版無 owner 欄位，日後拆資料很痛 | §3 schema 內建 owner/event_id/schema_version |
| 認證被小看 | 先「簡單 auth」後「付費」可能重寫 | MVP 就用 Access（免費）而非自製；收費時才接 IdP/Stripe |

---

## 8. 需裁決事項（Q22）

| 編號 | 事項 | 建議 | 影響 |
|---|---|---|---|
| **Q22-1** | 主平台：Cloudflare（A）vs Vercel（B）vs 其他 | **A. Cloudflare Workers+D1+Pages+Access**（§6.1） | 決定 MVP 技術棧 |
| **Q22-2** | Scoreboard 程式 repo 位置 | 新 repo（如 `philipz/factory-scoreboard`）——與機制 repo 分離、權限獨立、產品化乾淨 | 部署、權限、CODEOWNERS |
| **Q22-3** | 認證方案 | MVP：Cloudflare Access（免費 50 人）；收費前換正式 IdP | §6.1、§7 |
| **Q22-4** | 多租戶/收費啟用時機 | 第一版只留 `owner` 欄位＋匯出 API；billing 等付費使用者出現再實作 | §3、§7 |
| **Q22-5** | 資料隱私預設 | 成本資料含 repo/issue 資訊：MVP 預設不公開、後台需登入；「未來開放付費查閱」的公開範圍待裁 | §2、§7 |

> 裁決後：寫 `ADR-015`、`docs/20` 加工項、開 MVP Issue（平台程式碼、收集契約實作）。

---

## 9. 本文件 DoD（評估文件本身的驗收）

- [x] 三階段需求表（§2）
- [x] 事件 schema 草案＋與現有產物對應（§3）
- [x] CI/Backstage 推送契約草案（§4）
- [x] ≥6 平台比較矩陣＋來源與查證日期（§5）
- [x] 明確建議＋替代觸發條件（§6）
- [x] 風險清單（§7）
- [x] Q22-1~5（§8，收攏至 docs/10）

---

## 修訂記錄

| 日期 | 變動 |
|---|---|
| 2026-09-02 | 建立：平台評估（Cloudflare vs Vercel vs 其他），資料源接 PR #248 |
