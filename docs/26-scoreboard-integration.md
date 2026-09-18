# 26 — Scoreboard 事件契約與接線規格

> **依據**：`ADR-015`（平台裁決）、`22-scoreboard-platform-evaluation.md` §3–§4（schema 與推送契約草案）、`04-agent-execution-dsh.md` §5（用量量測）、`src/usage/report-schema.ts`（既有契約）
> **用途**：定義 `factory-run` 與 `factory-scoreboard` 之間的事件契約、推送規格與對帳方式。**這是兩個 repo 之間唯一的介面定義**。
> **讀者**：實作推送端（機制 repo）或接收端（`philipz/factory-scoreboard`）的人。
>
> **設計原則**：**收集面永不影響執行面。** 推送失敗、後台離線、額度用盡——工廠的終態判定完全不受影響。

---

## 1. 事件 schema v2

單一 `work_item_events`（append-only）。**不新增資料表**，維持 `docs/22` §3 的單一事件表設計。

```jsonc
{
  "event_id": "uuid",              // 冪等鍵（由 run_id + issue_number 派生）
  "schema_version": 2,
  "occurred_at": "2026-10-14T08:37:38Z",   // factory-run 結束時間（ISO 8601）
  "source": "factory-ci",          // factory-ci | backstage-form | …

  "owner": "philipz",              // 租戶維度（與登入身分解耦）
  "repo": "software_factory",
  "issue_number": 228,
  "run_id": 33891806331,           // Actions run id（可回溯原始 log）
  "task_type": "agent-fix-bug",
  "model_tier": "high",            // model.json 的 tier

  // ── 成本（直接透傳 UsageReportSchema）──
  "usage": {
    "source": "dsh-session-log",
    "totals": { "inputTokens": 145412, "outputTokens": 57721,
                "cacheReadTokens": 3775488, "cacheWriteTokens": 0,
                "reasoningTokens": 42079, "totalTokens": 3978621,
                "costUsd": 0.037, "unpricedModels": [], "cacheReadUnpriced": false },
    "routes": [{ "provider": "deepseek-official", "model": "deepseek-v4-flash", … }],
    "pricingRef": "config/dsh/pricing.yaml",
    "measuredAt": "2026-10-14T08:37:38Z",
    "sessionCount": 1,
    "unavailableReason": null      // 非空 → 量測失敗，看板須顯示「無資料」
  },

  // ── 品質與 skill-gap（v2 新增）──
  "outcome": "needs-human",        // blocked-in-loop | ready-to-automerge | ready-for-review | needs-human
  "skill_gap": {                   // nullable
    "category": "monorepo-test-path",
    "needed": "…",
    "context": "…"
  },
  "stop_reason": "SR4",            // nullable；停手規則編號
  "crosscheck_mismatches": ["requirements-missing"],   // 僅 kind，不含 detail
  "skills_digest": "sha256:…",     // 本次 run 實際載入的 skills 版本
  "extra": {}                      // 前向相容槽
}
```

### 1.1 三個關鍵約束

| # | 約束 | 理由 |
|---|---|---|
| 1 | `usage` **直接沿用** `src/usage/report-schema.ts` 的 `UsageReportSchema` 形狀，欄位名不改 | 兩 repo **共用同一份契約**；不製造第二套定義（沿用 `factory-judge.ts` 的立場：第二套規則一旦分歧，寬鬆的那套會成為實際生效的規則） |
| 2 | `unavailableReason` **必須透傳**；非空時看板顯示「無資料」**而非 `$0`** | `docs/04` §5.1：量測失敗時「不偽造數字」。以專屬灰階 `--no-data` 呈現，**視覺上就與 $0 不同** |
| 3 | `crosscheck_mismatches` 只存 `kind`，**不存 `detail`** | 隱私（Q22-5）：`detail` 含檔案路徑與 issue 內容；`kind` 足以聚類 |

### 1.2 資料來源對應

| 事件欄位 | 來源檔案 | 產生步驟 |
|---|---|---|
| `usage` | `target/.factory/run/report.json` 的 `usage` 區塊 | Measure usage & cost |
| `outcome` | `.factory/judge.json` 的 `result.outcome` | Judge terminal state |
| `stop_reason` | `.factory/judge.json` 的 `result.stopDecision` | 同上 |
| `crosscheck_mismatches` | `.factory/crosscheck.json` 的 `mismatches[].kind` | Cross-check |
| `skill_gap` | `report.json` 的 `skillGap`（agent 自報） | Run factory agent |
| `model_tier` | `.factory/model.json` 的 `tier` | Select model tier |
| `repo`／`issue_number`／`task_type`／`run_id` | workflow inputs 與 `github.run_id` | — |
| `skills_digest` | `config/factory/skills-lock.json` 的彙總 hash | Skills 同步步驟 |
| `extra.skill_gap_unreported` | `crosscheck.json` 或 `judge.json` 的 `advisories`（kind `skill-gap-unreported`） | Cross-check／Judge |

### 1.3 `extra` 槽目前承載的欄位

`extra` 是前向相容槽（§1 schema）：**新增欄位不需要接收端改動，也不改 schema 版本**。

| 欄位 | 型別 | 意義 |
|---|---|---|
| `requirements_failed` | `string[]` | 狀態為 `failed` 的驗收條件 id（只送 id，不送條文——隱私，§1.1 約束 3）|
| `requirements_total` | `number` | 驗收條件總數 |
| `requirement_advisories` | `string[]` | crosscheck advisory 的 `kind`（不含 `detail`）|
| `skill_gap_unreported` | `true`（不存在即否）| 本次 run 異常收場卻未回報 `skillGap`——**「可能漏報」的訊號，不是缺口本身** |

**`skill_gap_unreported` 的三個設計約束**：

1. **布林而非陣列**：crosscheck 與 judge 可能對同一次 run 各發一條 advisory，
   布林由構造上就不重複，接收端不必自行去重。
2. **不發生時不寫入欄位**：不製造 `false` 噪音，與 `extra` 其他欄位同慣例。
3. **與 `skill_gap` 是不同的東西**：`skill_gap` 是缺口內容（進 `/skill-gaps` 聚類）；
   `skill_gap_unreported` 只說「這次 run 落在缺口可能漏掉的那一類」，**不應**被當成
   一筆缺口計數。它的用途是回答「訊號是真的沒有，還是模型不報」（`docs/25` §2.4）。

> **注意**：`judge.json`／`crosscheck.json` 在部分終態下不存在（如 agent 逾時、crosscheck 失敗擋下 judge）。推送端**必須容忍缺檔**，以 `null` 填入而非中止。

---

## 2. 推送規格

### 2.1 端點

```
POST https://<scoreboard>/api/v1/events
Authorization: Bearer ${{ secrets.SCOREBOARD_TOKEN }}
Content-Type: application/json
```

> **路徑前綴是 `/api`**，與 `src/cli/factory-push-event.ts` 的實作一致。
> 實測 `POST /v1/events` 回 `404`、`POST /api/v1/events` 回 `401`（未帶 token），
> 可據此確認路由是否存在。

### 2.2 CI 接線（機制 repo 唯一改動）

在 `factory-run.yml` 既有的「Measure usage & cost」之後追加一步：

```yaml
- name: Push event to scoreboard
  if: always() && steps.agent.outcome != 'skipped'
  continue-on-error: true        # 推送失敗絕不擋 run
  env:
    SCOREBOARD_URL: ${{ vars.SCOREBOARD_URL }}
    SCOREBOARD_TOKEN: ${{ secrets.SCOREBOARD_TOKEN }}
  run: |
    node dist/cli/factory-push-event.js \
      --repo "${{ inputs.repo }}" \
      --issue "${{ inputs.issue_number }}" \
      --run-id "${{ github.run_id }}" \
      --task-type "${{ inputs.task_type }}" \
      --report target/.factory/run/report.json \
      --judge .factory/judge.json \
      --crosscheck .factory/crosscheck.json \
      --model .factory/model.json \
      || echo "::warning::scoreboard 推送失敗（不擋 run）"
```

**設計要點**：
- `continue-on-error: true` ＋ `|| echo` **雙重保險**——與既有 usage 量測步驟同原則（`factory-run.yml:459`）
- `if: always()`——失敗與逾時的 run **也要記錄**，否則統計只剩成功案例（幸存者偏差）
- `SCOREBOARD_URL` 用 `vars` 而非 `secrets`（非機密，便於除錯）

### 2.3 `factory-push-event` CLI 的設計立場

**純資料搬運，無判斷邏輯**——沿用 `factory-judge.ts` 的既有立場：

- 讀取既有產物 → 組裝事件 → POST
- **不**重新計算成本、**不**判定終態、**不**推論 skill-gap
- 缺檔以 `null` 填入，不中止
- 網路失敗 exit 0（由 workflow 的 `continue-on-error` 兜底亦可，但 CLI 自身也不應以失敗告終）

> **為何強調這點**：若推送端有自己的判斷邏輯，就出現「後台數字與 Issue 標籤不一致」的可能。事件必須是既有事實的**忠實副本**。

---

## 3. 冪等性

**`event_id` 由 `run_id` ＋ `issue_number` 派生**（UUIDv5 或 `sha256(run_id:issue_number)` 前 32 字元）。

- 同一 run 重試（Actions re-run）→ 相同 `event_id` → 接收端以 `INSERT OR REPLACE` 或 `ON CONFLICT DO UPDATE` 處理
- **不重複計數**：聚類與成本統計以 `event_id` 去重
- 接收端回傳 `200`（新建）或 `200` + `{"deduplicated": true}`（已存在）

---

## 4. 對帳（資料完整性）

**目標**：每個成功的 factory-run 都應有對應事件。

```bash
# 列出近期 factory-run 的 run_id
gh run list --workflow=factory-run.yml --limit 50 --json databaseId,conclusion

# 對照 Scoreboard
curl -s "$SCOREBOARD_URL/api/v1/events?from=<date>" | jq '[.[].run_id]'
```

**差異處置**：
- 事件缺失 → 查該 run 的 log 是否有 `scoreboard 推送失敗` warning
- 可補推：以 artifacts 重建事件並手動 POST（artifacts ~90 天內有效）

> **對帳頻率**：納入 `docs/14` §2.1 的每週節奏（與缺陷標籤檢查同一次操作）。

---

## 5. 權威來源界線（重要）

**GitHub 仍是唯一權威來源（ADR-001 不變）。**

| 面向 | 權威 | 說明 |
|---|---|---|
| 工作項狀態、標籤、終態 | **GitHub Issue** | 後台只是副本 |
| PR 與程式碼變更 | **GitHub** | 同上 |
| 成本與 skill-gap 統計 | Scoreboard（呈現層） | 資料源仍是 Issue 留言與 run artifacts |

**衝突時以 Issue 為準。** 後台資料可隨時從 Issue 與 Actions 重建——這是「後台不是第二個事實來源」的操作定義。

---

## 6. 隱私

| 規則 | 實作 |
|---|---|
| 不傳 issue 內文 | 事件無 `title`／`body` 欄位 |
| 不傳 mismatch 明細 | 只傳 `kind`，不傳 `detail`（含檔案路徑） |
| 不傳憑證 | 事件組裝不讀 `.factory/run/gh-token` |
| 不以登入身分為主鍵 | 以 `owner` 為租戶維度（`docs/22` §6.4） |
| skill-gap 的 `context` | agent 自填，**須避免貼入完整程式碼**；`factory-workflow` SKILL 明載此限制 |

---

## 7. 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q26-1 | `skills_digest` 的計算方式（全體 hash vs 逐 skill） | 建議全體彙總 hash；實作時定案並記於 `skills-lock.json` 格式。<br>⚠️ **2026-09-17 實測：此欄位從未接線，所有事件一律為 `null`**（`factory-push-event` 讀 `report.skillsDigest`，而沒有任何步驟寫入該欄位）。連帶後果：`docs/25` §5 生效驗證第 4 步「Scoreboard 可比對 `skills_digest` 前後」目前**做不到**。 |
| Q26-2 | Backstage 開單事件（`source: backstage-form`）是否納入 MVP | 建議 MVP 只做 `factory-ci`；開單事件待 Backstage 解凍後再議 |
| Q26-3 | 對帳是否自動化 | MVP 手動；若缺失率高再考慮自動告警 |

---

## 修訂記錄

| 日期 | 變動 |
|---|---|
| 2026-09-05 | 建立：事件 schema v2、推送規格、冪等性、對帳、權威來源界線與隱私規則 |
| 2026-09-17 | 新增 §1.3 記載 `extra` 槽目前承載的四個欄位（含新增的 `skill_gap_unreported`）；Q26-1 補記 `skills_digest` 實測恆為 `null` 且連帶使 `docs/25` §5 的生效驗證第 4 步無法執行。**schema v2 未變動，接收端零改動** |
