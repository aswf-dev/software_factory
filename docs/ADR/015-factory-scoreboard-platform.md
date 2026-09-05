# ADR-015：Factory Scoreboard 管理平台（平台、前端與設計風格裁決）

- **狀態**：已接受
- **日期**：2026-09-05
- **決定者**：使用者裁決（平台定位、Astro 前端、warp.dev 風格）＋平台架構（技術規格）
- **對應**：`22-scoreboard-platform-evaluation.md`（評估來源）、`26-scoreboard-integration.md`（事件契約）、`25-skill-authoring-loop.md`（skill-gap 消費端）、`ADR-001`（GitHub 為單一事實來源）、Q22-1～9

## 脈絡

`docs/22`（2026-09-02 建立）評估了「收集 factory 費用與效益資料的產品網站」的平台選型，狀態明載為「**評估文件（未裁決）**」，Q22-1～5 全數待決。

同時出現兩項新需求：

1. **skill-gap 證據收集**（`docs/25`）：技能提案的門檻是「同 category ≥3 次」，但 `docs/22` 的事件 schema **只有成本欄位，無 skill-gap**。無後台時只能人工數 Issue 留言。
2. **資料保存期限的硬限制**（實測）：run artifacts **~90 天過期**（run 33891806331 的 `factory-run-23`，`expires_at: 2026-12-03`），而 skill-gap 的重複可能跨越數月。

`philipz/factory-scoreboard` repo 已建立（2026-09-05，private，`main` 單一 commit，僅 README）。

## 決策

### 1. Q22-1：主平台 —— Cloudflare Workers + D1 + Astro + Access

依 `docs/22` §6.1 的建議。理由：免費層涵蓋 MVP～小團隊、$5/mo 後用量近乎無上限、單一供應商低維運、TypeScript 生態與機制 repo 一致。

### 2. Q22-2：repo —— `philipz/factory-scoreboard`（已建立）

與機制 repo 分離：權限獨立、產品化乾淨、**不改變 software_factory 的運行方式**。

### 3. Q22-3：認證 —— 分兩層

| 階段 | 做法 |
|---|---|
| MVP／內部後台 | **Cloudflare Access**，login method 選 GitHub（零程式碼、免費 50 人） |
| 開放付費客戶 | 換 Managed Auth（Clerk／Supabase Auth／Auth0），Access 退回只保護內部端點 |

**關鍵約束**：事件以 `owner` 為租戶維度，**不以登入身分（JWT `sub`／email）為資料主鍵**——換 IdP 只是換登入層，不必遷資料。

### 4. Q22-4：多租戶／收費 —— 第一版只留 `owner` 欄位 ＋ 匯出 API

billing 待實際付費使用者出現再實作。

### 5. Q22-5：隱私 —— MVP 需登入；事件不含 issue 內文

`crosscheck_mismatches` **只存 `kind` 不存 `detail`**（detail 含檔案路徑）。詳見 `docs/26` §6。

### 6. Q22-6（新）：與 `weekly-metrics.sh` 的關係 —— 並存

**Scoreboard 為主要查詢介面**；`scripts/weekly-metrics.sh` 保留為**離線輔助**（無網路或不想登入時可用）。

> **明確界定**：這**不是**降級路徑，而是便利工具。見 Q22-7。

### 7. Q22-7（新）：平台定位 —— 管理平台，持續運作，**無放棄條件**

**使用者裁決（2026-09-05）**：Scoreboard 是工廠的**營運介面**（成本歸戶、skill-gap 證據、未來收費依據），建置後持續運作。

> **與 Backstage／OTel 的區別（必須寫明，避免誤類比）**：`docs/22` §1.3 曾以「此 repo 已因維運成本凍結 Backstage（Q03-6/Q13-1）、延後 OTel（Q08-4）」為判準，暗示 Scoreboard 也應有退場門檻。**此類比不成立**——那兩者是「可有可無的觀察工具」，而管理平台承載營運職能。定位不同，治理方式亦不同。

**取代放棄條件的是營運健康度指標**：

| 指標 | 目標 | 異常處置 |
|---|---|---|
| 事件接收成功率 | ≥99% | 查 Worker log；CI 端 `continue-on-error` 保證不影響工廠 |
| 事件延遲 | <60s | 檢查 D1 寫入 |
| 資料完整性 | 每個成功 run 皆有事件 | 以 `run_id` 對帳（`docs/26` §4） |
| 免費層用量 | <80% | 逼近即升 Workers Paid（$5/mo） |

### 8. Q22-8（新）：前端框架 —— Astro

**使用者裁決（2026-09-05）**。技術依據（2026-09-05 查證）：

| 事實 | 數值 | 來源 |
|---|---|---|
| Worker 體積上限 | 免費層 **3 MiB**／付費層 **10 MiB** | [OpenNext Cloudflare](https://opennext.js.org/cloudflare) |
| Next.js via OpenNext 官方範例 | `gzip: 2295.89 KiB` ≈ **免費層的 75%** | 同上 |
| Astro SSR 輸出 | 數百 KB 量級 | 一般量級（本專案以 CI 驗收 <1 MiB 把關） |

**必須同時記載的更正**：**Next.js 在 Cloudflare Workers 上為官方支援**（framework guides 同時列有 Astro、Next.js、OpenNext adapter），`npm create cloudflare@latest -- --framework=next --platform=workers` 為官方指令。先前「不綁 Next.js」的表述（`docs/22`:174）**未附理由**，本 ADR 補上依據並修正該措辭。

**選 Astro 的實質理由**（依重要性）：
1. **體積與免費層匹配**：OpenNext 範例已用掉免費層 75%，本專案的資料表格頁只會增加依賴
2. **抽象層更少**：Astro → Workers 直接；Next.js → OpenNext → Workers 多一層轉譯，除錯路徑更長
3. **本專案重心在 API 不在前端**：6 個端點 ＋ 3 個表格頁；Next.js 的強項（ISR、image、RSC、SEO）在私有後台**完全用不到**

**改用 Next.js 的觸發條件**（誠實清單，比照 `docs/22` §6.2 對 Vercel 的處理）：
- 維護者熟悉 Next.js 而不熟 Astro（**團隊熟悉度是真實成本，此條最正當**）
- Scoreboard 演進為功能豐富的產品（複雜互動、大量 React 元件庫）
- 接受一開始就用 Workers Paid（體積上限升至 10 MiB）
- 日後可能改部署 Vercel

**Astro 實作要點**（官方文件查證）：`output: 'server'` 為 `@astrojs/cloudflare` 預設（純靜態頁須個別 `export const prerender = true`）；`public/.assetsignore` 須含 `_worker.js` 與 `_routes.json`；D1 經 `Astro.locals.runtime.env` 取用；Astro 5.x 需 Node ≥20.3／22（本機實測 v22.21.1、pnpm 11.25.0 皆符合）。

### 9. Q22-9（新）：視覺風格 —— 仿 warp.dev 終端美學

**使用者裁決（2026-09-05）**。設計語彙自 `https://www.warp.dev/` 的 HTML 與 CSS chunk 實測擷取（2026-09-05）：

**色彩**（Warp 原值，供參考）：`--color-background: #121212`、`--color-text: #eef7fa`、`--card-bg: #08090a`、`--color-border: #424647`、`--accent-2: #7267ff`、`--color-accent-purple: #cbb0f7`；灰階以 oklch 定義。

> **關鍵洞察**：Warp 的 `--card-bg`（`#08090a`）**比** `--color-background`（`#121212`）**更深**——用「卡片比底更暗」製造凹陷感，與一般設計系統（卡片較亮）相反。這是其終端質感的來源之一。

**字體**：Warp 使用 matter／matterMono（**商用授權，不可使用**）、Azeret Mono、Inter、Instrument Serif。本專案僅用**免費授權**字體：`Azeret Mono`（標題／數據／標籤）、`Inter`（內文）、`Noto Sans TC`（中文）。

**排版母題**（實測出現次數）：`⌗` ×18、`>_` ×16、`nav/` ×8、`[ fig. N · 名稱 ]` ×7、`[ X ] 單字母` ×7。本專案借用此語彙（如 `[ fig. 1 · 成本總覽 ]`、`[ C ] Cost`）。

**語意色為自訂**（Warp 未提供，後台必需）：`--ok #3fb950`、`--warn #d29922`、`--danger #f85149`、`--info #58a6ff`、**`--no-data #6b6f70`**。

> **`--no-data` 是把政策寫進設計系統**：`docs/04` §5.1 規定量測失敗不得偽造數字。`unavailableReason` 非空時以專屬灰階顯示「無資料」，**視覺上就與 `$0` 不同**。

**合規界線（重要）**：
- ✅ 借用**設計語言**（配色策略、終端母題、排版風格）
- ❌ **不**複製 Warp 的 logo、商標、專有字體（matter）、原始 CSS 檔、文案
- 這是**風格致敬**而非資產挪用

### 10. 與 ADR-001 的關係

**GitHub 仍是唯一權威來源。** Scoreboard 為**收集＋呈現**層：

- 工作項狀態、標籤、終態 → **GitHub Issue 為準**
- 後台資料可隨時從 Issue 與 Actions **重建**
- 兩者衝突時**以 Issue 為準**

**ADR-001 不被推翻。**

## 後果

### 正面

- skill-gap 的 promote 門檻從「人工數留言」變成**一個查詢**（`docs/25` §3）
- 事件永久儲存，**突破 artifacts ~90 天過期**的限制
- 跨 repo 彙整天然可行（schema 第一版即有 `owner`／`repo`）
- `skills_digest` 使 promote **效果可驗證**（gap 是否在新 skill 版本後消失）——回應 `docs/08` §2.4「預防行動完成率」的判讀要求
- 機制 repo 僅增加一個 `continue-on-error` 步驟，**運行方式不變**

### 負面 / 取捨

- 新增一個需持續維運的系統（無退場條款——這是刻意的定位選擇）
- Cloudflare 帳號、D1、Access、secret 設定**須由人類手動完成**（agent 無權）
- 事件為既有產物的副本，存在與 Issue 不同步的可能 → 以 §10 的權威界線與 `docs/26` §4 對帳處理

### 中性

- schema v1→v2 無既有資料，遷移成本為零；日後演進靠 `schema_version` ＋ `extra`

## 替代方案

### A. 不建平台，維持 `weekly-metrics.sh`
**未採用**：artifacts 90 天過期使跨月聚類不可行；且週檢依賴人工執行，`defect/*` 標籤累計 0 筆（180 顆合併 PR）已證明此模式會靜默失效。

### B. 把事件 commit 回一個資料 repo，網站只讀
**未採用**：等於把 GitHub 當資料庫；且付費／多租戶路徑無解（`docs/22` §5.3 已排除純靜態方案）。

### C. Vercel + Next.js
**未採用**：見 Q22-8。Hobby 方案不可商用；體積優勢不存在；本專案不需其強項。保留為觸發條件成立時的替代方案。

### D. 為 Scoreboard 設放棄條件（比照 Backstage／OTel）
**未採用**：使用者裁決其為管理平台而非觀察工具。以營運健康度指標取代退場門檻（Q22-7）。

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q22-10 | Backstage 開單事件是否納入 MVP | 建議 MVP 只做 `factory-ci`（`docs/26` Q26-2） |
| Q22-11 | 免費層額度數字為 2026-09 查證 | 實際註冊前重查官方頁面（`docs/22` §7 已列此風險） |
| Q22-12 | Astro 產物實際體積未實測 | 以 CI 驗收條件（壓縮後 <1 MiB）把關 |
