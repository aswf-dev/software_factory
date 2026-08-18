# 13 — Phase 1 驗收報告（最窄路徑打通）

> **依據**：`09-roadmap.md` §2（第 1 期範圍與出場條件）、`11-test-strategy.md`（測試證據）、試跑實測紀錄（2026-08-18）
> **讀者**：決定是否放行進入第 2 期的人
> **本文件立場**：驗收報告是**證據清單**，不是宣稱清單。標示「已驗證」處皆有 run/PR/測試可回溯；標示「未實測」處誠實揭露，不為求好看而含糊（對照 `04` §2.5 假通過的教訓）。

---

## 1. 範圍回顧

Phase 1 = 打通一條端到端可運作的最窄路徑（docs/09 §2）：

```
Issue → CI 計分 → DSH agent（受限沙箱 + skills）→ stacked PR → 人類審查 → 合併
```

另加（使用者裁決）：**Quint 正式方法**（Phase A：驗證工廠自身計分邏輯）與**多 provider 模型路由**（避開單一 provider rate limit）。

## 2. 出場條件逐條驗證（docs/09 §2）

| # | 條件 | 判定 | 證據 |
|---|---|---|---|
| 1 | 端到端全程可運作（Backstage 觸發 → agent → stacked PR → 人類審查 → 合併） | ⚠️ **部分達成** | agent→stacked PR→審查→合併 ✅（10 工作項實測）；**Backstage Template 觸發未在真實部署實測**（僅本機 dev server HTTP 200；Catalog/Template 設定就緒但未跑通 dispatch） |
| 2 | `05` §8 治理檢查清單逐條通過 | ✅ | 核心不變量由對抗性測試（31+19 則）+ 真實試跑驗證（SR3 在 CI 真實觸發） |
| 3 | ≥10 工作項，成功率 ≥70% | ✅ **10/10、90%** | 見 §3 |
| 4 | 停手機制實際觸發且行為正確 | ✅ | #11 organic 誠實停手（mutation 驗證既有測試已滿足）+ 試跑期間多次 needs-human |
| 5 | 第 1 期未決事項已有答案 | ✅ | Q02-1/Q03-2/Q04-1/2/6/Q07-2 已驗證（`10` §1.7） |

> **條件 1 的誠實揭露**：Backstage 的 Catalog URL location 在合併後可解析（repo 已在 GitHub），但「Template 表單 → `github:actions:dispatch` → workflow」這條路徑從未用真實 Backstage 執行過。驗證只到「本機 dev server 可跑 + Template YAML 已註冊 + action 簽章已查證」。**放行 Phase 2 前應補此實測**（或依 Q03-6 評估降級為純 GitHub 觸發）。

## 3. 試跑結果（10 個工作項）

| # | 工作項 | 終點 | 產出 PR | 備註 |
|---|---|---|---|---|
| 11 | tierForTotal 邊界 | needs-human → 人審裁決關閉 | — | 誠實停手：邊界測試已存在（mutation 驗證），正確 |
| 12 | rescore mutation | ready-for-review | #20 ✅ | 首顆 agent PR，已合併 |
| 21 | gh-parse 指標邊界 | ready-for-review | #31 + #32 ✅ | 2 層 stacked |
| 22 | DSH 結果判讀 | ready-for-review | #28 + #29 ✅ | 2 層 stacked |
| 23 | formatCliError | ready-for-review | #34 + #35 ✅ | 含 ME 存活變異（有價值新增） |
| 37 | stop-rules 盲點 | ready-for-review | #44 + #45 ✅ | SR3 負向控制 |
| 38 | dsh-result mutation | ready-for-review | #43 ✅ | 單顆 |
| 39 | parseArgs mutation | ready-for-review | #51 + #52 ✅ | 單顆→2 層 |
| 40 | matchHardRules 漏標 | ready-for-review | #47 ✅ | M-B/M-C 存活變異 |
| 41 | hasLabel/parseIssues | ready-for-review | #48 + #49 ✅ | 2 層 |

**成功率**：9/10 產出可審查 PR 並全數合併（90%）≥ 70% 門檻 ✅
**產出規模**：16 顆 merged PR（含 setup）、新增 mutation-strength 測試 41 則（8 檔案）、測試總數 293 → **335**、覆蓋率 **100%**

## 4. 實作障礙排除紀錄（7 輪，皆實測定位）

這些是 Phase 1 最珍貴的知識——每個都是「推論正確但實測推翻」或「文獻未寫明」的發現：

| # | 現象 | 根因 | 修正 | 登錄 |
|---|---|---|---|---|
| 1 | agent 無法建 PR | **GITHUB_TOKEN 不能用 GraphQL 建 PR**（即使有 `pull-requests: write`） | GitHub App 身分（D6） | Q05-7 |
| 2 | agent 內 gh 看不到 token | **DSH sandbox 剝離 process env**（docs/04 §4.1 假設被推翻） | token 寫入 workspace 檔（`.factory/run/gh-token`）+ skill 指示讀取 | Q04-7 |
| 3 | push 403 | checkout 的 credential helper（GITHUB_TOKEN）優先於 credential store | remote URL 內嵌 App token | Q05-8 |
| 4 | `git commit` 失敗 | checkout 不設 git identity | 設定 bot identity | — |
| 5 | push 仍 403 | **checkout 的 extraheader 寫在獨立檔、經 `includeIf.gitdir` 引入**，`--unset-all` 清不掉 | 移除 includeIf 項目 | Q05-8（完整） |
| 6 | 平行 run 探針衝突 | 共用 `_factory-auth-probe` 分支名 | run id 唯一化 | — |
| 7 | Anthropic 429 rate limit | opus-5 用量觸頂（外部限制） | **多 provider failover 鏈**（deepseek→qwen→anthropic，預設 deepseek-v4-flash） | Q04-8 |

> 每輪都在「花 LLM 成本之前」以探針/本機實測定位——唯最後成功 run 才消耗 LLM。這是試跑方法論的核心成果。

## 5. Quint 正式方法（Phase A）驗證

| 項目 | 結果 |
|---|---|
| 計分模型 `specs/scoring/score.qnt` | **Apalache model-check 6 不變量全部成立**（含 fail-safe、automerge 條件）|
| 神諭 harness | 400 個取樣狀態下**模型與 TS 實作完全一致**（`test/quint/scoring-oracle.test.ts`）|
| CI 閘門 | `quint-verify` required check（`src/scoring/**` 等路徑觸發）已套用至線上 ruleset（Q12-5）|
| 模型價值 | 抓到我計畫中一個**寫錯的 invariant**（單軸非法時 total≥4 不成立）——正式方法立即顯效 |

## 6. docs/09 §6 五問（每期結束誠實回答）

1. **閒置比下降了嗎？** — ⚠️ **無法量測**：缺 Process Time（Q08-7 未解）。基線已建（fubon-tradingbot 511 PR），但本 repo 試跑期太短無統計意義。
2. **缺陷逃逸率上升了嗎？** — ⚠️ **無數據**：335 測試 + 100% 覆蓋 + 人類審查 16 顆 PR 未發現缺陷，但正式缺陷追蹤機制（Q08-2）未建立。
3. **創新工作佔比上升了嗎？** — ⚠️ **無數據**：試跑期為驗證性質，非生產工作流。
4. **審查還是認真的嗎？** — ⚠️ **單人審查（Q12-4 已知缺口）**：所有 PR 由 philipz 審查合併；無第二雙眼睛。審查確實逐顆進行（含 mutation 表核對），但單點依賴成立。
5. **下一個限制在哪裡？** — **人類審查容量**（docs/07 §6.3 預言兌現：16 顆 PR 排隊時審查成為瓶頸）+ **Backstage 部署未實測**。

## 7. 殘餘風險與 Phase 1 遺留

| 項目 | 狀態 | 影響 |
|---|---|---|
| Backstage Template 端到端未實測 | 未解決 | 出場條件 1 的 caveat；Phase 2 前補測或降級 |
| 單人審查（Q12-4） | 已知缺口 | 第二位協作者時恢復核准要求 |
| 試跑期太短、無生產工作流數據 | 未解決 | 五問中三項無數據，Phase 2 需累積 |
| gh stack 命名慣例偏差（#45/#49/#52 分支名不合 `factory/` 前綴） | 已強化 skill（禁自命名 + 禁 `--draft`） | 後續 run 驗證 |
| Anthropic rate limit | 已緩解（多 provider failover） | 非零風險：單 provider 仍可能觸頂，failover 已覆蓋 |
| 缺陷追蹤紀律（Q08-2） | 未建立 | Phase 2 建立標記慣例 |

## 8. 結論與建議

**Phase 1 核心目標達成**：最窄路徑端到端真實運作（90% 成功率）、停手機制驗證、Quint 正式方法落地、多 provider 彈性。

**放行 Phase 2 的兩個前置**（建議完成後再規劃 Phase 2）：
1. ~~Backstage Template 端到端實測~~ —— **已裁決降級**（Q03-6/Q13-1，見 `14` §1.7）；出場條件 1 的 caveat 以「純 GitHub 觸發已實證」閉合
2. **補一輪觀察期數據**（缺陷追蹤 + 少量真實工作項），讓 §6 五問有實質答案

---

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| ~~Q13-1~~ | Backstage 端到端 or 降級裁決 | ✅ **已裁決：降級**（純 GitHub 觸發，工件凍結保留；日後多人可升級，見 `14` §1.7）|
| Q13-2 | 驗收報告與 `10` 未決事項的同步（Q08-7 等仍待） | 已收攏至 `10` |
