# ADR-011：依 Issue 複雜度分級路由 LLM 模型（model tier routing）

- **狀態**：已接受
- **日期**：2026-08-25
- **決定者**：平台架構（經 plan 審查核准）
- **對應**：`04-agent-execution-dsh.md` §7、`06-human-oversight-policy.md` §3.3 與 Q06-2、`10-open-questions.md` Q04-10、`config/dsh/model-tiers.yaml`

## 脈絡

factory-run 目前以固定映射挑模型：`model_provider` input 選 provider，每種 provider 對應單一 model（`deepseek→deepseek-v4-flash`、`qwen→qwen3.7-flash`、`anthropic→claude-sonnet-4-5`），寫入 DSH settings 的 `agent-default-model` 後跑 `dsh --profile headless`。**所有 Issue 一律同一顆模型，與難度無關**——簡單工作項也用不到最強模型，複雜工作項又缺乏更強模型選項。

需求（用戶裁決，2026-09-11 更新）：依 Issue 需求複雜度選擇對應等級的 LLM——低/中 → `qwen3.8-flash`（2026-08-27 起為預設）、高 → `deepseek-flash`、**最高（critical）→ `claude-opus-5`**；sonnet 僅作 fallback。並在 `factory-issue-check`（零 LLM 成本的格式檢查流程）留言中回報複雜度分析與建議模型。

> **2026-09-27 裁決**：critical primary 改為 `claude-opus-5-5`（$4/20，支援 low～max effort），`claude-opus-5` 退為第一順位 fallback（同樣 `reasoningEffort: max`）。DSH 0.1.7-rc.1 綁定的 pi-ai 0.85.1 目錄尚未收錄 opus-5-5：升級前它在約 2 秒內以 `UNKNOWN_MODEL` 失敗（未發出網路請求），命中 provider 層 fallback 後改用 opus-5，行為與改動前相同；DSH 升級到收錄 opus-5-5 的 pi-ai（0.87.1 起）後自動生效，不需再改設定。刻意不在 `settings.providers.yaml` 手動宣告——models 清單會整個取代 anthropic route 的內建目錄，連 opus-5／sonnet-5 的參數都要自行維護。

> **2026-10-02 修正（失敗分類）**：DSH 升到 0.2.0-rc.2（pi-ai 0.87.1）後 opus-5-5 首次真正執行（run 36838600120，fubon-tradingbot#625）：跑 167 秒後 exit 1，workflow 改用 opus-5 從頭重跑（opus-5 佔該單成本 91%）。查核發現 workflow 的失敗分類有兩個缺陷：(1) 拒答只認 `Usage Policy|refused to complete the request`，認不得 Anthropic 拒答的 `stop_details.explanation`（例：`This request was declined because it could enable cyber harm.`，官方明言文字不穩定）；(2) provider 錯誤以不分大小寫的 `AUTH|401|429…` grep **整份 stderr**，而 stderr 含 agent 的 reasoning 串流——一句「no auth logic touched」就足以觸發 fallback。加上每次嘗試覆寫同一個 `stderr.txt`，opus-5-5 的真實錯誤行已遺失，**該次失敗的確切原因無法回溯**（以 #625 內容對 opus-5-5 effort=max 實測 3 次皆正常完成，run 36936592309）。修正：分類改由 `factory-attempt-classify`（`src/model-tier/attempt-outcome.ts`）只看 DSH 終止錯誤行 `dsh: <CODE>: <message>`，錯誤行印到 job log，每次嘗試的 stdout/stderr 另存 `attempt-<n>.*.txt` 隨 artifact 上傳。另：DSH 0.2.0-rc.2 不開放 anthropic route 設定 `compat.allowedFallbackModels`（pi-ai 已支援 Anthropic server-side fallback），故拒答時仍是 workflow 層換模型重跑。
>
> **後續（#337 驗證與報告 F1–F3）**：#337 以 critical 派工，opus-5-5 單次嘗試完成（run 36950035701）。報告指出的三點處置：**F1** 每次嘗試的時限＝全部剩餘預算，真逾時必然耗盡預算而停止，「逾時沿 chain 升級」實際走不到——行為安全（critical 的下一項 opus-5 並不比 opus-5-5 強），只更正註解；**F2** 預算用盡仍會以 `timeout 0`（無時限）啟動下一項——改為每項嘗試前檢查剩餘預算，用盡即停；**F3** 終止錯誤行改為只認 stderr 最後一個非空行（DSH 以 aborted／hook blocked 結束時不印錯誤行，往回搜尋會撿到 reasoning 中形似錯誤行的內容）；殘留：reasoning 最後一行恰為該格式時仍會誤認，完全排除需改讀 session log。另：run artifact 改為排除 `gh-token`。

> **2026-10-06 修正（第四種拒答措辭）**：fubon-tradingbot#654（agent-fix-bug，總分 4 × 複雜度 high → critical）的 opus-5-5 在第 20 秒被前置攔截（run 37419721657）：`dsh: PI_AI_ERROR: This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.`。措辭不含 `usage policy|refus|declin`，被分類成 agent-error，chain 其餘三項（opus-5 → deepseek-flash → qwen）一項都沒試即交還人類。修正：`REFUSAL_MESSAGE` 加入 `terms of service` 與 `\bblocked\b`。比對刻意保留寬度——範圍已限於 critical 且為 DSH 終止錯誤行的 PI_AI_ERROR；誤判成拒答只多試 chain 下一項（受預算檢查約束），漏判則整張單停擺，代價不對稱。觸發原因未能確認（推測與 Issue 內文含大段待照抄的 AI 產出程式碼有關）。

> **2026-08-28 裁決（取代先前「只有最高才用 fable」）**：`claude-fable-5` 需額外 credit（帳號方案未包含；實測 run #33175623064 無法使用）——**移除 fable-5**，critical 預設改為同代旗艦 `claude-opus-5`（$5/25、1M ctx、支援 xhigh/max thinking）。

> **2026-09-11 裁決（DeepSeek V4 系列汰換）**：DeepSeek 於 2026-09-10 發布 `DeepSeek-V4.1-Flash`，宣告「在性能、費用、速度、總用時等各項指標上全面超越 V4 Pro」。依官方 API 文件（[Change Log](https://api-docs.deepseek.com/updates/)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)）：
>
> - 新模型 id 為 **`deepseek-flash`**（官方原文：*Use `deepseek-flash` as the model name*）；
> - 舊名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` **已退役**，僅保留相容轉送至 V4.1 Flash；
> - 自 **2026-09-14 12:00（北京時間）**起至 `V4.1 Pro` 發布前，`deepseek-v4-pro` 的請求全部路由至 V4.1 Flash 並按其單價計費。
>
> 因此 `deepseek-v4-flash` 與 `deepseek-v4-pro` 一律改為 **`deepseek-flash`**：low/medium 的 deepseek fallback 與 high 的 primary 現為同一顆模型（官方端本就會如此路由，明寫新 id 才與實際計費模型一致）。
>
> ⚠️ **實測修正**：`deepseek-v4.1-flash` 是**不存在的 id**——DeepSeek API 回 `HTTP 400: The supported API model names are deepseek-flash, deepseek-v4-pro`。此外 `deepseek-flash` **不在 pi-ai 0.85.1（現行最新）的內建 catalog** 內，直接使用會被 DSH 以 `UNKNOWN_MODEL` 擋下；故 `config/dsh/settings.providers.yaml` 的 deepseek route 改為**手動宣告 models**（該檔已註明：models 清單會取代該 route 的內建 catalog，需自行維護 ctx/compat 欄位）。

## 決策

1. **複雜度訊號：啟發式分析，零 LLM 成本**。新模組 `src/issue-analysis/complexity.ts` 把 docs/06 §3.3 的客觀判準（低=單一檔案/模組；中=跨數模組；高=跨服務/新架構/共用抽象）機械化為決定性的關鍵字/計數規則，讀 Issue body 的任務類型＋需求四段文字，輸出 `{complexity, score, evidence}`。每條判據進 `evidence` 給人看。**fail-safe 方向為 high**（需求缺失/不可分析 → 最強適用模型；不可知 ⇒ 不降級）。
2. **模型分級：`config/dsh/model-tiers.yaml`**。每個 tier 宣告 `primary`＋`fallback` chain（`{provider, model[, reasoningEffort]}`）。用戶優先序由對抗性測試釘住：low/medium=`qwen3.8-flash`、high=`deepseek-flash`（2026-09-11 起；原 `deepseek-v4-pro`）、**critical=`claude-opus-5` + `reasoningEffort: max`（fable-5 已移除）**；sonnet 僅作 fallback（**跨供應商可用性替補**，正常不走——第三方基準顯示它不是品質升級，見下節）。
3. **單一解析核心：`src/model-tier/resolve.ts`**。解析順序：手動 `--tier` ＞ Issue 需求分析 ＞ catalog 標註（`factory.io/complexity`）＞ fail-safe high。**critical 額外條件**：分析為 high 且 `score.total ≥ 4`（review 上緣；5–6 為 in-loop，agent 不啟動故不耗模型）。`factory-model` CLI 與 `factory-issue-check` 共用此核心——**邏輯**一致，無第二套規則可漂移。

   > **修正（2026-09-11）**：本條原寫「留言建議與實際路由永不打架」，**這是錯的**。兩者共用核心但**輸入不同**：`factory-issue-check` 是零 LLM 成本的開單即時檢查，**不做計分**（計分是 factory-run 的 Initial score 步驟），故傳入的 `scoreTotal` 為 undefined，critical 升級分支在該路徑**結構上不可達**——留言的 tier 天花板永遠是 high。實測案例：[fubon-tradingbot#611](https://github.com/philipz/fubon-tradingbot/issues/611#issuecomment-5632704780) 留言建議 `deepseek/deepseek-flash`（high），實跑為 `anthropic/claude-opus-5`（critical）。
   >
   > 另注意觸發區間極窄：`total ≥ 5` 會落入 in-loop（agent 不啟動），故 **critical 實際上只有「恰好 4 分」會觸發**——即 review 區間的最上緣。
   >
   > 處置（2026-09-11 用戶裁決）：**改留言措辭**——tier 為 high 且設定有 critical primary 時，留言附一行揭露「實跑若計分 ≥ 4 會升級為 critical（含該模型名，取自設定非硬編碼）」。未採「留言也計分」（會讓零成本檢查變重並依賴 catalog 三軸資料）。
4. **接線**：
   - `factory-run.yml` 新增「Select model tier」步驟（`gh issue view --json body` ＋ `factory-model` CLI → `.factory/model.json`）；agent 步驟改為沿 `model.json` 的 chain 迭代（`jq -c '.chain[]'`），每項重寫 `agent-default-model` 後跑 dsh；**provider 層失敗（429/credential/UNKNOWN_MODEL）沿 chain fallback，任務層失敗不重試**（docs/02 §6 不變）。
   - `factory-issue-check` 留言擴充為三行：格式合規 ＋ 📊 複雜度分析（等級＋判據）＋ 🤖 建議模型（tier＋primary＋fallback）。
   - Inputs：新增 `model_tier`（auto/low/medium/high/critical，預設 auto）；`model_provider` 加 `auto` 並改預設 `auto`（語意改為「偏好 provider」，chain 內該 provider 置前）。
5. **計算強度軸：heavy-verify 強制 critical，繞過計分門檻（2026-09-13，34735315950 事故修正）**。

   複雜度軸量的是**變更廣度/風險**，但模型的成敗還受「任務是否把 CPU-bound 工作迴圈塞進 run」支配。事故實證：Issue #7（as-is Quint 規格＋反例存證）的複雜度判據只有「目標檔案提及 13 處」→ high → `deepseek-flash`；總分未達 `CRITICAL_MIN_TOTAL` 故未升級。Agent 在 50 分鐘內重寫模型 4 版、起停 10+ 個 Apalache job，最後卡在 `state 8/12` 被 step timeout 砍掉——`0` commit、`0` PR、`0` bytes stdout，成本 $0.306 全損。

   - **新增判定**：`src/issue-analysis/complexity.ts` 的 `detectComputationalIntensity()` 以兩段式（工具級關鍵字 `quint`/`apalache`/`tla+`/`模型檢查`/`形式化`/`z3`… 任一命中；或泛用詞 `verify`/`反例` **且** 規格級 sharpener `spec`/`規格`/`max-steps`/`不變式` 同時命中）判 `heavy-verify`。**刻意保守**：單獨的「verify」不算——幾乎每個 Issue 都有「驗證方式」段落，誤報會讓所有任務吃旗艦成本。
   - **路由後果**：`resolveModelTier` 見 `computationalIntensity === 'heavy-verify'` 時**直接升 critical**（不要求 `score.total ≥ 4`），並在 resolution 上標記 `escalation: 'heavy-verify'`。理由：本 ADR 原門檻是「review 上緣的成本保險」，但 heavy-verify 的失敗模式不是改壞東西，而是**整個 run 的牆鐘被吃掉、交付為零**——此時提早升級（更早做出「降界並記錄」的取捨）期望值明顯較高。`escalation` 與「本次是否剛好才升 tier」**解耦**：總分剛好達標的 heavy-verify 任務同樣要拿到放寬的逾時預算。
   - **逾時連動**：`factory-run.yml` 的 agent 逾時改為計算式（原硬編碼 50 分）。heavy-verify → 110 分、critical（總分升級）→ 70 分、其餘 → 50 分；`agent_timeout_minutes` input 非 0 時完全覆寫。
   - **手動優先**：`model_tier` 明示時不套用強制升級（人類覆寫優先於啟發式，與既有解析順序一致）。設定檔缺 critical tier 時退回原 tier 並在 `reason` 明寫（不靜默假裝升級）。

## 模型選擇與成本依據（pi-ai catalog 定價，USD/MTok input/output，2026-08 查證）

| tier | primary | 成本 | 相較候選 |
|---|---|---|---|
| low/medium | qwen3.8-flash（2026-08-27 起） | $0.15/0.47 | 最便宜（deepseek 退居 fallback） |
| high | deepseek-flash（2026-09-11 起） | $0.30/1.20 | ~17× 便宜於 claude-opus-5（$5/25） |
| critical | claude-opus-5（`reasoningEffort: max`） | $5/25 | 最高 tier；**effort 必須明設 max**，見下方基準實測 |
| fallback | claude-sonnet-5 / deepseek-flash / qwen3.8-flash | — | **可用性**替補（非品質升級），正常不走 |

> **deepseek-flash 定價**：官方定價頁**直接以 USD 公布**（無需匯率換算）且**分時段**——輸入（快取未命中）空閒 $0.15／高峰 $0.30、輸出空閒 $0.60／高峰 $1.20、輸入（快取命中）空閒 $0.003／高峰 $0.006；高峰時段＝週一至週五 **01:00–04:00、06:00–10:00（UTC）**，其餘為空閒、價格減半。本表與 `pricing.yaml` 為單一價格欄位，故採**高峰價**（保守，不低估成本）。誠實揭露：空閒時段實付為此值的一半。

> **機器可讀副本**：定價表另有 `config/dsh/pricing.yaml`（`factory-usage` 換算「每工作項成本」
> 的唯一事實來源，`docs/04` §5.1）。兩處同源，對抗性測試釘住「model-tiers 引用的每個
> model id 都必須在 pricing.yaml 有價」。

> **2026-08-28 修正**：critical 由 `claude-fable-5` 改為 **`claude-opus-5`**（$5/25、1M ctx、支援 xhigh/max thinking）——fable-5 需額外 credit，帳號方案未包含（實測 run #33175623064 無法使用），故移除 fable-5 並以同代旗艦 opus-5 為 primary。

### 第三方基準實測（2026-09-11，Artificial Analysis Intelligence Index v4.3）

原本「deepseek ≈ opus/sonnet 等級」只是待驗證的假設。[Artificial Analysis](https://artificialanalysis.ai/models/comparisons/deepseek-v4-1-flash-vs-claude-opus-5) 的第三方數據讓它可以被部分替換為事實：

| 模型（effort） | Intelligence Index | AutomationBench-AA | Terminal-Bench v4.0 | AA-Omniscience | 每任務成本 |
|---|---|---|---|---|---|
| **Opus 5（max）** | **51** | 57% | **49%** | **37** | $5.86 |
| deepseek-flash（max） | 40 | **69%** | 27% | **−5** | **$0.27** |
| Opus 5（**low**） | 40 | 52% | 26% | 29 | $1.10 |
| Sonnet 5（max） | 38 | 37% | 14% | 16 | $5.09 |

三個可據以行動的結論：

1. **對 sonnet 的假設成立、對 opus-max 不成立**。deepseek-flash 綜合分**高於** Sonnet 5（40 vs 38）且 agentic 指標大幅領先；但明顯**低於** Opus 5 的 max effort（40 vs 51）。
2. **critical tier 的價值完全繫於 effort**。Opus 5 在 low effort 只有 40 分——與 deepseek-flash 打平卻貴約 21 倍。本 ADR 原本「不設定 `reasoningEffort`」的做法，等於讓最高 tier 可能付旗艦價換平手品質。**2026-09-11 裁決：critical 明設 `reasoningEffort: max`**（opus-5 只接受 `off`/`xhigh`/`max`）。
3. **sonnet 作為 high 的 fallback 不是「品質擔保」**——它綜合分更低、agentic 指標差距明顯（AutomationBench 37% vs 69%），成本卻高約 19 倍。它的真實作用是**跨供應商可用性替補**（DeepSeek 限流/故障時仍能完成工作），文件措辭已據此更正。

> **誠實揭露**：這是第三方綜合基準，**不是我們工作負載的實測**。方向不一致之處必須併陳：最接近本專案情境的 Terminal-Bench v4.0 由 Opus 大幅領先（49% vs 27%），但 AutomationBench-AA 反由 deepseek-flash 領先（69% vs 57%）。因此本次**不調整 tier 分層本身**，只修正 effort 設定與錯誤措辭。另：AA-Omniscience 為 **−5**（懲罰幻覺的知識指標，負值代表不確定時傾向自信給錯）——這正是本 repo「不採信 agent 自述、以 crosscheck／測試佐證」（docs/02 §4）的必要性佐證，殘餘風險由該機制承擔。
>
> AA 頁面列出的價格與 `config/dsh/pricing.yaml` **完全一致**（含 opus cacheRead $0.50，原為 `input×0.1` 的推估值，現獲第三方佐證）。

誠實揭露：「V4.1 Flash 全面超越 V4 Pro」為 DeepSeek 官方公告說法，本 repo 未做獨立對比驗證。config 為唯一事實來源，`model_tier` 手動覆寫可隨時指定 opus；high tier 的 fallback 不含 opus，避免無謂升級（見上：fallback 的角色是可用性而非升級）。

> **副作用（2026-09-11 起）**：low/medium 的 deepseek fallback 與 high 的 primary 均為 `deepseek-flash`，故 low/medium 的跨 provider failover 與 high 的主路徑落在同一顆模型。這反映官方實際路由行為（V4 Pro 請求本就被導向 V4.1 Flash），非設定錯誤；待 `V4.1 Pro` 上線後可重新拉開 high tier 的層級差。

## 後果

### 正面

- 成本匹配能力：簡單工作項不浪費旗艦模型，複雜工作項可用最強模型。
- 檢查與執行共用同一解析核心：留言建議即實際路由，無第二套邏輯可漂移。
- 維持零 LLM 成本的格式檢查設計（分析是決定性的啟發式，不是 LLM call）。
- fail-safe 方向與計分一致：不可知 ⇒ 不降級（high/`deepseek-flash`），也不誤燒 opus 旗艦成本。

### 負面

- 啟發式是粗略近似（承接 Q06-2「複雜度軸自動判定最弱」），可能誤判；以「留言展示判據給人看＋`model_tier` 覆寫」緩解。
- critical 用 opus-5（$5/25）成本高；以嚴格觸發條件（high 且 total≥4）＋`token_budget` 上限控制。
- Anthropic 429 風險（Q04-8 歷史）：最高 tier 的 primary 為 opus-5；以 deepseek/qwen 為主的下層設計降低主路徑對 Anthropic 的依賴。
- deepseek 計價改為分時段（高峰為空閒的 2×）：本 repo 以高峰價估算，`factory-usage` 的成本數字在空閒時段會**高估**（誠實方向：不低估）。

## 未做（日後選項）

- LLM 分析的複雜度判定（需 key＋成本，不符本 gate 零成本設計）。
- ~~每 tier 的 `reasoningEffort` 調校~~ → **critical 已於 2026-09-11 明設 `max`**（理由見上節基準實測）。low/medium/high 仍未設定（走 provider 預設）——誠實揭露：AA 的 deepseek-flash 40 分是在 **Max Effort** 下測得，我們跑預設 effort，**實際品質可能低於該數字**；是否替 high tier 也明設 effort 尚待決定。
- 其他更便宜旗艦（kimi-k2.7-code、MiniMax-M3、gemini-3.1-pro、gpt-5.6-terra、qwen3.7-max）需新增 API key 或 route 宣告。
