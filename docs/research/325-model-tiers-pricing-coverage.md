# 325 — model-tiers 引用模型 vs. pricing 定價條目覆蓋分析

> **問題**：`config/dsh/model-tiers.yaml` 各 tier 引用的模型，是否都在 `config/dsh/pricing.yaml` 有定價條目？有無缺漏或多餘條目？
> **查證日期**：2026-09-27（base `software-factory`）。**本工單為分析型，未修改任何程式碼或設定。**

## 1. 結論摘要

**無缺漏、無多餘**：model-tiers.yaml 共引用 **4 個唯一 model id**，pricing.yaml 恰好有 **4 筆**條目，雙向一對一對應。三條路由（opus / deepseek / qwen）的 primary 與所有 fallback 皆有定價，成本換算（`src/usage/pricing.ts`）不會出現查不到價的 route。

資料本身乾淨；真正的缺口在**護欄只釘單向**：對抗性測試只驗「tier 引用 → 有定價」，不驗反向的孤兒條目，且價格值一致性只斷言 4 個模型中的 3 個。

## 2. 證據與根因

驗證命令（只讀，可重現；於 repo 根目錄執行，輸出見下表）：

```bash
node -e 'const{load}=require("js-yaml"),fs=require("fs");const t=load(fs.readFileSync("config/dsh/model-tiers.yaml","utf8")).tiers,p=load(fs.readFileSync("config/dsh/pricing.yaml","utf8")).pricing,r=new Set();for(const x of Object.values(t)){r.add(x.primary.model);(x.fallback||[]).forEach(f=>r.add(f.model))}for(const m of r)console.log(m,p[m]?"HAS":"MISSING");for(const k in p)if(!r.has(k))console.log("ORPHAN",k)'
```

| model id | 引用位置（model-tiers.yaml 行號） | pricing.yaml 定價 | in/out USD/MTok | cacheRead |
| --- | --- | --- | --- | --- |
| `qwen3.8-flash` | L32 low.primary、L39 medium.primary、L54 high.fb[1]、L76 critical.fb[1] | **有**（L28–30） | 0.15 / 0.47 | 缺欄（刻意，見 pricing.yaml L15） |
| `deepseek-flash` | L49 high.primary、L35 low.fb[0]、L42 medium.fb[0]、L74 critical.fb[0] | **有**（L31–34） | 0.3 / 1.2 | 0.006 |
| `claude-sonnet-5` | L52 high.fb[0] | **有**（L35–38） | 2 / 10 | 0.2 |
| `claude-opus-5` | L70 critical.primary（`reasoningEffort: max`, L71） | **有**（L39–42） | 5 / 25 | 0.5 |

反向檢查：pricing.yaml 的 4 筆條目全部被引用，**無孤兒條目**（ORPHAN 輸出為空）。

根因（為何目前乾淨）：`test/adversarial/factory-assets.test.ts:1465–1478` 在 CI 釘住「tier 引用的每個 model id 都必須有 `inputUsdPerMTok`/`outputUsdPerMTok` 且 > 0」，2026-09-11 把 `deepseek-v4-flash`/`deepseek-v4-pro` 併成 `deepseek-flash` 時同步改了兩檔，故未留殘餘。

未被護欄覆蓋的兩點（**目前無實害，屬預防性**）：(1) **孤兒條目無人攔**——從 tiers 移除某模型但 pricing 留著，測試仍綠，會累積誤導成本表的死條目；(2) **價格值只驗 3/4**——`factory-assets.test.ts:1480–1489` 斷言 qwen3.8-flash、deepseek-flash、claude-opus-5 的數值，**未斷言 `claude-sonnet-5`（2/10）**，該值被改動不會紅燈。

## 3. 影響範圍

- **模組**：`src/usage/pricing.ts`（`lookupPricing`）、`src/usage/render.ts`（成本欄）、`src/cli/factory-usage.ts`、`src/cli/factory-model.ts`＋`factory-issue-check.ts`（讀 tiers 建議模型）。
- **使用者**：無使用者可見影響——現況已正確；下游的每工作項成本報表與 `token_budget` 判斷維持準確。
- **下游**：若日後新增 tier/模型而未補定價，`factory-assets` 會紅燈擋下（既有保護有效）；孤兒條目則只影響文件可信度，不影響金額計算（查不到就不會被用）。

## 4. 方案比較

| 方案 | 內容 | 評價 |
| --- | --- | --- |
| **A（建議）** 補雙向護欄 | 在 `factory-assets.test.ts` 既有 describe 內加一條「pricing.yaml 無未被 tiers 引用的孤兒條目」，並把 `claude-sonnet-5` 補進價格值斷言 | 採納：成本極低（純測試、無 src 變更）、把本次人工比對變成 CI 常駐檢查 |
| **B** 現況不動 | 依賴每次改模型時人工同步兩檔 | 拒絕：2026-08/09 已改過 3 次模型組合，靠人工記憶遲早漏；漏了測試不會告訴你 |
| **C** 由 pricing.yaml 自動產生 tiers（單一事實來源） | 合併兩檔或以程式推導 | 拒絕：兩檔語意不同（政策 vs. 價格），合併會讓 ADR-011 的路由裁決與價格查證混在一起；且需改 `src/`，遠超本次收益 |

## 5. 建議下一步

可直接開成 **agent-add-tests** 工作項（test-only 單層，預期直接綠燈）：

> **標題**：為 pricing.yaml 補「孤兒定價條目」與 claude-sonnet-5 價格值的對抗性測試
> **範圍**：只改 `test/adversarial/factory-assets.test.ts`（「用量與成本契約」describe 內），不動 `config/`、不動 `src/`。
> **驗收條件草案**：
> - REQ-a：新增測試斷言「`pricing.yaml` 每個 key 都出現在 `model-tiers.yaml` 的 primary/fallback 引用集合中」；刻意在 pricing.yaml 加一筆假條目時該測試紅燈（沙箱驗證後還原）。
> - REQ-b：價格值一致性測試補上 `claude-sonnet-5` 的 `inputUsdPerMTok === 2`、`outputUsdPerMTok === 10`。
> - REQ-c：`npx vitest run test/adversarial/factory-assets.test.ts` 全綠，且未修改任何 `config/` 或 `src/` 檔案。

本報告**不具放行效力**，須人類審查後才可據以開立上述工作項（docs/06 §4）。
