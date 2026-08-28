# ADR-011：依 Issue 複雜度分級路由 LLM 模型（model tier routing）

- **狀態**：已接受
- **日期**：2026-08-25
- **決定者**：平台架構（經 plan 審查核准）
- **對應**：`04-agent-execution-dsh.md` §7、`06-human-oversight-policy.md` §3.3 與 Q06-2、`10-open-questions.md` Q04-10、`config/dsh/model-tiers.yaml`

## 脈絡

factory-run 目前以固定映射挑模型：`model_provider` input 選 provider，每種 provider 對應單一 model（`deepseek→deepseek-v4-flash`、`qwen→qwen3.7-flash`、`anthropic→claude-sonnet-4-5`），寫入 DSH settings 的 `agent-default-model` 後跑 `dsh --profile headless`。**所有 Issue 一律同一顆模型，與難度無關**——簡單工作項也用不到最強模型，複雜工作項又缺乏更強模型選項。

需求（用戶裁決，2026-08-28 更新）：依 Issue 需求複雜度選擇對應等級的 LLM——低/中 → `qwen3.8-flash`（2026-08-27 起為預設）、高 → `deepseek-v4-pro`、**最高（critical）→ `claude-opus-5`**；sonnet 僅作 fallback。並在 `factory-issue-check`（零 LLM 成本的格式檢查流程）留言中回報複雜度分析與建議模型。

> **2026-08-28 裁決（取代先前「只有最高才用 fable」）**：`claude-fable-5` 需額外 credit（帳號方案未包含；實測 run #33175623064 無法使用）——**移除 fable-5**，critical 預設改為同代旗艦 `claude-opus-5`（$5/25、1M ctx、支援 xhigh/max thinking）。

## 決策

1. **複雜度訊號：啟發式分析，零 LLM 成本**。新模組 `src/issue-analysis/complexity.ts` 把 docs/06 §3.3 的客觀判準（低=單一檔案/模組；中=跨數模組；高=跨服務/新架構/共用抽象）機械化為決定性的關鍵字/計數規則，讀 Issue body 的任務類型＋需求四段文字，輸出 `{complexity, score, evidence}`。每條判據進 `evidence` 給人看。**fail-safe 方向為 high**（需求缺失/不可分析 → 最強適用模型；不可知 ⇒ 不降級）。
2. **模型分級：`config/dsh/model-tiers.yaml`**。每個 tier 宣告 `primary`＋`fallback` chain（`{provider, model[, reasoningEffort]}`）。用戶優先序由對抗性測試釘住：low/medium=`qwen3.8-flash`、high=`deepseek-v4-pro`、**critical=`claude-opus-5`（fable-5 已移除）**；sonnet 僅作 fallback（品質擔保，正常不走）。
3. **單一解析核心：`src/model-tier/resolve.ts`**。解析順序：手動 `--tier` ＞ Issue 需求分析 ＞ catalog 標註（`factory.io/complexity`）＞ fail-safe high。**critical 額外條件**：分析為 high 且 `score.total ≥ 4`（review 上緣；5–6 為 in-loop，agent 不啟動故不耗模型）。`factory-model` CLI 與 `factory-issue-check` 共用此核心——留言建議與實際路由永不打架。
4. **接線**：
   - `factory-run.yml` 新增「Select model tier」步驟（`gh issue view --json body` ＋ `factory-model` CLI → `.factory/model.json`）；agent 步驟改為沿 `model.json` 的 chain 迭代（`jq -c '.chain[]'`），每項重寫 `agent-default-model` 後跑 dsh；**provider 層失敗（429/credential/UNKNOWN_MODEL）沿 chain fallback，任務層失敗不重試**（docs/02 §6 不變）。
   - `factory-issue-check` 留言擴充為三行：格式合規 ＋ 📊 複雜度分析（等級＋判據）＋ 🤖 建議模型（tier＋primary＋fallback）。
   - Inputs：新增 `model_tier`（auto/low/medium/high/critical，預設 auto）；`model_provider` 加 `auto` 並改預設 `auto`（語意改為「偏好 provider」，chain 內該 provider 置前）。

## 模型選擇與成本依據（pi-ai catalog 定價，USD/MTok input/output，2026-08 查證）

| tier | primary | 成本 | 相較候選 |
|---|---|---|---|
| low/medium | qwen3.8-flash（2026-08-27 起） | $0.15/0.47 | 最便宜（deepseek-v4-flash 退居 fallback） |
| high | deepseek-v4-pro | $0.435/0.87 | ~11× 便宜於 claude-opus-5（$5/25） |
| critical | claude-opus-5 | $5/25 | 最高 tier；fable-5 已移除（需額外 credit） |
| fallback | deepseek-v4-pro / qwen3.8-flash | — | 品質擔保，正常不走 |

> **2026-08-28 修正**：critical 由 `claude-fable-5` 改為 **`claude-opus-5`**（$5/25、1M ctx、支援 xhigh/max thinking）——fable-5 需額外 credit，帳號方案未包含（實測 run #33175623064 無法使用），故移除 fable-5 並以同代旗艦 opus-5 為 primary。

誠實揭露：「deepseek-v4-pro ≈ opus/sonnet 等級」是待 A/B 驗證的假設（非實測對比）。config 為唯一事實來源，`model_tier` 手動覆寫可隨時指定 opus；high tier 的 fallback 不含 opus，避免無謂升級。

## 後果

### 正面

- 成本匹配能力：簡單工作項不浪費旗艦模型，複雜工作項可用最強模型。
- 檢查與執行共用同一解析核心：留言建議即實際路由，無第二套邏輯可漂移。
- 維持零 LLM 成本的格式檢查設計（分析是決定性的啟發式，不是 LLM call）。
- fail-safe 方向與計分一致：不可知 ⇒ 不降級（high/pro），也不誤燒 fable 旗艦成本。

### 負面

- 啟發式是粗略近似（承接 Q06-2「複雜度軸自動判定最弱」），可能誤判；以「留言展示判據給人看＋`model_tier` 覆寫」緩解。
- critical 用 fable（$10/50）成本高；以嚴格觸發條件（high 且 total≥4）＋`token_budget` 上限控制。
- Anthropic 429 風險（Q04-8 歷史）：高/最高 tier 的 fallback 含 opus/fable；以 deepseek primary 為主的設計降低主路徑對 Anthropic 的依賴。

## 未做（日後選項）

- LLM 分析的複雜度判定（需 key＋成本，不符本 gate 零成本設計）。
- 每 tier 的 `reasoningEffort` 調校（config 已支援欄位，預設不設定）。
- 其他更便宜旗艦（kimi-k2.7-code、MiniMax-M3、gemini-3.1-pro、gpt-5.6-terra、qwen3.7-max）需新增 API key 或 route 宣告。
