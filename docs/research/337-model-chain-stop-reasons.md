# 337 — model chain 迴圈的 stop reason：觸發條件與後續動作（PR #336 實機驗證）

> **問題**：factory-run 的 model chain 迴圈有哪些 stop reason？各自何時觸發？會換 chain 下一項，還是停止並交還人類？
> **分析基準**：`origin/main` @ `eb60065`（PR #336 合併點）；trunk `software-factory`（`685d5c9`）尚未含 #336，沒有 `attempt-outcome.ts`。只讀 `.github/workflows/factory-run.yml`（下稱 yml）與 `src/model-tier/attempt-outcome.ts`（下稱 ts）。**本工單為分析型，未修改任何程式碼或設定。**

## 1. 結論摘要

- 迴圈共有 4 種 stop reason（§2 表）。`agent-error` 一律停止；`provider-error` 與 `model-refusal`（僅 critical）換下一項；`agent-inner-timeout` 看剩餘預算決定。
- **F1（主要發現）**：真正逾時時，`agent-inner-timeout` 的「換下一項」**走不到**。單次上限等於全部剩餘預算（yml L735），逾時後剩餘必為 0，因此一律停止。yml L690–693 註解說「逾時改為沿 chain 升級」，與實際行為不符。只有非逾時造成的 137（如 OOM 的 SIGKILL）會走到 continue，而且會被誤標為逾時。
- **F2（邊界情況）**：可 fallback 的失敗若在預算最後一秒內自行結束，剩餘時間會被捨入為 0。下一項就以 `timeout … 0` 啟動，也就是**沒有時限**，只剩 step 級逾時兜底，重演 A4 原本要消除的失敗模式。
- **F3（殘餘風險）**：若 dsh 非 0 結束卻沒有真正的終止錯誤行，reasoning 中以 `dsh: ` 開頭的行仍會被當成錯誤行。
- 對本工單驗證的意義：Opus 5.5 若逾時，**不會**產生 `attempt-2.*`；只有 provider-error／model-refusal 才會產生。`attempt-1.*` 不論成敗都會留下（L754–755）。critical 非 heavy-verify、也未手動覆寫時，首行應為 `… (attempt=1, remaining=4200s)`（L512–520、L718）。

## 2. 證據與根因

| stop reason | 觸發條件 | 後續動作 | 依據 |
|---|---|---|---|
| `agent-inner-timeout` | dsh exit 124（timeout 到期）或 137（送 TERM 後 30s 仍未結束而被 KILL；外部 SIGKILL 也是 137） | 剩餘 > 0：換下一項；≤ 0：停止。真逾時必 ≤ 0（F1） | yml L735–737、L747–768 |
| `provider-error` | exit ≠ 0 且非 124/137；最後一行 `dsh:` 錯誤行的代碼 ∈ {RATE_LIMIT, MISSING_CREDENTIAL, UNKNOWN_MODEL, AUTH, INVALID_CREDENTIAL}，或訊息含獨立的 401／429，或含 invalid_api_key | 換下一項（chain 用盡時以此原因停止） | ts L31、L33、L72–73；yml L788–789 |
| `model-refusal` | 前提同上，另須 tier＝critical、代碼 `PI_AI_ERROR`、訊息符合 `/usage policy\|refus\|declin/i`（比 provider 規則先判斷） | 換下一項。非 critical 不適用此規則，改依 provider 規則判定，不符即 `agent-error`（停止） | ts L40、L69–70 |
| `agent-error` | 下列任一：沒有 `dsh:` 終止錯誤行；錯誤行不符上兩類；分類 CLI 失敗；迴圈結束後 exit ≠ 0 卻沒有止原因 | 停止（break，不重試，docs/02 §6） | ts L67、L75；yml L782–784、L791、L796 |

「停止」指 break 出迴圈。止原因經 `write-report --stop-reason` 寫入 report（L804–821），終態由 Judge／Handle agent timeout/failure／G1 守衛（L1010、L1027–1046、L1069–1112）決定；這些步驟的內部不在本報告範圍。每次嘗試的輸出另存為 `attempt-N.*`，隨 `target/.factory/run/` 上傳成 artifact（L1155–1166）。

可重現步驟（GNU coreutils 9.4；第一行照抄 L735–750 的算術，以 `sleep` 代替 dsh）：

```bash
R=2; S=$(date +%s); timeout --signal=TERM --kill-after=30s "$R" sleep 5; c=$?; E=$(( $(date +%s)-S )); R=$((R-E)); [ $R -lt 0 ] && R=0; echo "exit=$c elapsed=$E remaining=$R"  # exit=124 elapsed=2 remaining=0 → L762 break
timeout 0 sleep 2; echo "exit=$?"  # 2 秒後 exit=0：時限設為 0 等於停用時限
```

- F1 根因：`ELAPSED` 是整秒差，必定 ≥ `ATTEMPT_TIMEOUT`（＝`REMAINING_SEC`），扣減後被夾到 0（L749–750），於是 L762 break，L767 的「escalating」永遠不會印出。對照組：把上式第一項換成 `bash -c 'kill -9 $$'`、預算 5s，結果是 `exit=137 elapsed=0 remaining=5`，走 continue，卻被標成 `agent-inner-timeout`。
- F2 根因：迴圈開頭沒有檢查預算（L701–737）。實測：起點對齊 x.8 秒、預算 2s、第一項 `sleep 1.5; exit 1`，得 `elapsed=2s remaining=0s`；分類若為可 fallback，第二項會在 `remaining=0s` 下跑滿 4s。
- F3 根因：`terminalDshError` 只排除「整行等於 `dsh: reasoning:`」的行（ts L51）。實測以 `node --experimental-strip-types` 呼叫 `classifyFailedAttempt`：stderr 為 `dsh: reasoning:` 加上一行 reasoning `dsh: RATE_LIMIT: 429 …`、之後沒有真正的錯誤行，結果是 `{"outcome":"provider-error","fallback":true}`。DSH 是否真會在沒有錯誤行時非 0 結束，本範圍未驗證（ts L45 的註解預期有這種情況）。

## 3. 影響範圍

- 模組：yml 的 Run factory agent 步驟（L599–821）、ts 與其 CLI 橋接 `factory-attempt-classify`，以及以 `--stop-reason`／`--timed-out` 為輸入的 report、judge、scoreboard（L802）。
- 使用者：派工者與接手的人類。critical 逾時時會直接交還人類，不會改由 Opus 5 接手，與註解的預期不同；非逾時的 137 被記成逾時，會誤導歸因。
- 下游：F2 觸發時，該次嘗試只受 step 級逾時（預算＋5 分，L527–530、L604）約束；被 runner 砍掉時，迴圈內的 write-report 不會執行。每次 fallback 都以新的 dsh session 重跑，成本疊加（基線 run 36838600120：$4.20，其中 Opus 5 佔 $3.82）。
- 分支：trunk 落後 main（沒有 #336），在 trunk 上工作的 agent 讀不到本報告引用的 ts。

## 4. 方案比較

- **方案 A（建議）：語意對齊＋預算守衛**。在迴圈開頭加 `[ "$REMAINING_SEC" -le 0 ] && break` 堵住 F2，並把 L690–693 註解與 ADR-011 改寫為「真逾時會耗盡預算，因此停止」。改動小、不動預算政策；代價是正式放棄「逾時升級」。
- **方案 B（不採用）：實作逾時升級**。為 chain 後續項保留預算（例如單次上限＝剩餘預算 − 保留量）。不採用的理由：primary 的時間變短，長任務更容易逾時；下一項要從頭重跑、預算又更少，成功率低且成本加倍；預算怎麼切屬於政策決定，應由人類裁決。
- **方案 C（不採用）：維持現狀，只補說明**。F2 沒修，沒有時限的嘗試仍可能出現，違反 A4 的目標。
- F3 不另立方案：發生機率低，且要先確認 DSH 的行為，列為待人類裁決事項。

## 5. 建議下一步

**工作項草案**（agent-fix-bug；改動 `.github/**` 會命中 H5，需要人類審查）：「factory-run model chain：預算歸零後不再啟動嘗試，並對齊逾時語意」
- AC1：迴圈內、`timeout --signal=TERM` 之前加上「`REMAINING_SEC` ≤ 0 則 break」的守衛，止原因沿用前一次嘗試；不得以 0 秒呼叫 `timeout`。
- AC2：在 `test/adversarial/factory-assets.test.ts` 新增斷言，釘住 AC1 的守衛及其位置（先紅後綠），且 `pnpm test` 綠燈。
- AC3：L690–693 的註解與 `docs/ADR/011-model-tier-routing.md` 不再宣稱真逾時會沿 chain 升級。
- 待人類裁決：(1) 是否仍要逾時升級（方案 B）；(2) 非逾時的 137 是否改用獨立的止原因；(3) F3 是否要請 DSH 在 reasoning 區段之後輸出明確界線。
