# 15 — 觀察期試跑紀錄

> **依據**：`14-observation-period.md` §2（觀察期試跑）、`11-test-strategy.md` §6（mutation-strength tests）。
> **目的**：逐條記錄 `meta/observation` 試跑工作項的**產出與誠實停手結論**，讓 docs/14 §2.2 的期檢有實質數據。
> **讀者**：審查 factory PR 的人、每期結束做檢視的人

---

## 1. 試跑紀錄

| # | 工作項 | 方法 | 產出 | 備註 |
|---|---|---|---|---|
| 45 | `factory-judge loadReport` mutation 掃描 | mutation-strength tests（型別契約） | 見 Issue #59 留言 | 4 個存活變異（M1–M4）補釘 |
| 48 | `apply-judge-labels` 純函式 mutation 掃描 | mutation-strength tests（純函式契約） | 見 Issue #72 留言 | 3 個存活變異（M1–M3）補釘 |

### 1.1 #45 — factory-judge loadReport（觀察點）

- **目標**：mutation 驗證 `loadReport`（`docs/02 §4`、`docs/06 §5.1`）——證明對 agent 自報 `report.json` 的 zod 型別看守有「牙齒」。
- **發現**：既有 `factory-judge.test.ts`（24 則）只測「欄位缺席」與「欄位完全錯型別」（如 `changedPaths: 'str'`），從未傳過「欄位換型別」的含糊值。對四條**選填欄位**的型別契約（元素型別、數值/布林型別）是完全未覆蓋的——下列每個變異在既有套件下都存活（全綠）：
  - M1 `changedPaths` 元素 `string` → `string|number`
  - M2 `changedLines` `number` → `number|string`
  - M3 `invocation.timedOut` `boolean` → `boolean|string`
  - M4 `hasAcceptanceCriteria` `boolean` → `boolean|string`
- **實作**：新增 `src/cli/factory-judge-mutation.test.ts`（8 則，每變異配 1 反例 + 1 錨定），四變異皆實測「變異→紅、還原→綠」。
- **價值**：這四條選填欄位各自對應一個**許可決策路徑**（`changedLines`/`assertionDelta` 影響計分、`timedOut` 影響 needs-human 判讀、`hasAcceptanceCriteria` 觸發 SR4）。過去放寬其中任何一條都不會讓任何既有測試變紅；補釘後這類回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下，不能再悄悄溜進。

### 1.2 #48 — apply-judge-labels 純函式（觀察點）

- **目標**：mutation 驗證 `apply-judge-labels` 的純函式 `computeJudgeLabels`/`buildJudgeComment`（`docs/02`、`docs/06 §5.1`）——證明套件對這顆標籤貼附決策有「牙齒」，並落實 Issue「純函式」的無副作用契約。
- **發現**：既有 `apply-judge-labels.test.ts`（10 則）對純函式只用 `toContain(..)`，有三條隱性契約完全未釘住，下列變異在既有套件下都存活（全綠）：
  - M1 去除 needs-human 去重守衛（一律 push）→ 重複 `needs-human` 標籤不被抓
  - M2 `const labels = [...judge.labels]` 改成直接參考 `judge.labels`（push 污染輸入陣列）→ 純函式無副作用契約失效不被抓
  - M3 留言標頭 `## 工廠執行結果：` 被改寫 → 判讀標頭格式不被抓
- **實作**：新增 `src/cli/apply-judge-labels-mutation.test.ts`（5 則），三變異皆實測「變異→紅、還原→綠」，且既有套件下皆存活（Before GREEN / After RED）。
- **價值**：標籤貼附是**監督決策的輸出載體**（`needs-human`/`oversight/*` 決定誰審、審不審）。過去誤刪去重守衛、把純函式改成有副作用、或抽換留言標頭，都不會讓既有測試變紅；補釘後這三類回歸在 CI gate（`src/cli/**` 100% branch）就會被攔下。

每次試跑結果在對應 Issue 留言回報 PR 編號；缺陷標記依 `14` §1 紀律。
