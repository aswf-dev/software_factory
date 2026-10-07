---
name: factory-workflow
description: 工廠 agent 處理一個 GitHub Issue 工作項的主流程 SOP。載入本 skill 後依序執行：讀 Issue、寫測試、實作、自審、拆 stacked PR、回報，並在結束前寫出執行報告。
---

# 工廠主流程

處理 GitHub Issue #<編號>（由任務描述提供，repo 為當前 workspace 的 repo）。

## 步驟

1. 讀取該 Issue 的內容與驗收條件（`gh issue view <編號>`）。
2. 判斷是否有可驗證的驗收條件：若 Issue 沒有明確的驗收條件（無重現步驟、無「完成 = 可觀察結果」的描述），**不要猜測**——將 `hasAcceptanceCriteria` 設為 `false` 並依 factory-stop-rules 停手。
3. 依「測試先行」順序作業：先寫測試（定義「正確」），再實作使其通過，最後補文件。
4. 依 factory-pr-stacking 的規則拆分並建立 stacked PR。
5. 提交前依 factory-self-review 自審。
6. 在 Issue 留言回報產出的 PR 編號與摘要。
7. **結束前，在 workspace 寫出執行報告**：

```json
{
  "issueNumber": <編號>,
  "invocation": { "exitCode": 0, "stdout": "<最後一則輸出>", "stderr": "" },
  "changedPaths": ["<改動檔案相對路徑>"],
  "changedLines": <總變更行數>,
  "assertionDelta": <測試斷言淨增減，負數表示減少>,
  "addedDependencies": ["<新增相依套件名>"],
  "syncFailures": <gh stack sync 連續失敗次數>,
  "hasAcceptanceCriteria": <true|false>,
  "requirements": [{"id": "<驗收條件編號>", "status": "<passed|failed|skipped>"}],
  "skillGap": {"category": "<kebab-case 分類>", "needed": "<缺什麼 SOP>", "context": "<情境>"},
  "openQuestions": ["<僅 agent-write-spec 必填：未決事項>"],
  "pbtAudit": {"seeds": [<seed>], "testCasesPerSeed": 5000, "properties": <n>, "passed": <n>, "failed": <n>, "timeouts": <n>, "findings": [<見「agent-pbt-audit」一節>]}
}
```

寫入路徑：`.factory/run/report.json`（位於 workspace 根目錄）。此報告是 CI 判定終點的輸入；**欄位缺漏時 CI 會以最保守方式處理**，但完整填寫能讓人類接手時看到全貌。

> **`requirements` 欄位（G8 需求追蹤，docs/20 B1）**：每一條 Issue 驗收條件（DoD）對應一個
> `{id, status}`——`id` 為驗收條件編號、`status` 為其對應測試/實作的狀態
> （`passed`/`failed`/`skipped`）。`factory-crosscheck` 會驗證該欄位完整性（每條驗收條件
> 都有對應條目且 status 齊全）；此欄位缺漏或造假時與 `changedPaths` 同樣觸發 needs-human。
> **此欄位為「誠實自報」＋CI 交叉驗證，不取代人類審查（docs/06 §4.3）。**
>
> **`status` 只有這三個值，大小寫一致，不接受同義詞**：達成寫 `passed`（不是 `met`／`done`／`ok`），
> 未達成寫 `failed`，不適用或不屬於本次 run 寫 `skipped`（不是 `deferred`／`n/a`）。
> 例如 `agent-write-spec` 不變量階段遇到「模型檢查結果」這類模型階段的驗收條件，寫 `skipped`，
> 原因寫在選填的 `evidence` 字串。寫錯任何一個值，CI 會判定**整份 report 格式不合規**，
> 已開好的 PR 也會以 needs-human 收場（philipz/fubon-tradingbot#670）。

**寫完 report 立即自檢**（必做；只驗 JSON 語法不夠，格式錯誤 CI 不會替你修正）。下列命令印出 `true`
才算通過；印出 `false` 或報錯就修正 report 再跑一次：

```bash
jq -e '
  (.issueNumber | type == "number")
  and (.invocation | type == "object")
  and ((.requirements // []) | all(.[]; (.id | type == "string")
        and (.status == "passed" or .status == "failed" or .status == "skipped")))
  and ((.skillGap // null) == null
        or ((.skillGap.category | type == "string" and test("^[a-z0-9]+(-[a-z0-9]+)*$"))
            and (.skillGap.needed | type == "string" and length > 0)))
' .factory/run/report.json
```

> **`assertionDelta` 欄位（SR6 的輸入，docs/18 §2.3.1）**：CI 會從 `git diff` **獨立實算**
> 測試檔的斷言淨增減並與你回報的值比對。只鎖一個方向：**實算為淨減少、而你未回報或
> 回報非負 → fail-loud → needs-human**。數值不必與 CI 相同（計數口徑本來就會有落差），
> 但**方向必須誠實**：刪掉斷言就要回報負數。不確定時寧可回報更負的值——那只會讓 SR6
> 觸發，是安全方向。**不填不等於安全**：CI 實算到淨減少時，空著的欄位與回報 0 同樣會被擋下。

> **`skillGap` 欄位（技能缺口回報，docs/25 §2.1、docs/20 E4）**：**選填**。
> **只在你已經要停手、或為了繞過某個障礙而多花了顯著功夫時才填**——目的是讓人類知道
> 「該補什麼 SOP」，不是要你在每次執行時多做一個判斷。
>
> - `category`：聚類鍵，**必須是 kebab-case**（如 `monorepo-test-path`、`java-multimodule-mvn`）。
>   格式不合會讓 CI fail-loud。先參考近期 Issue 是否已有同義分類，**沿用既有名稱**優於自創；
>   同一缺口用不同名稱會讓計數分散，導致該缺口永遠達不到提案門檻。
> - `needed`：缺少的是什麼**可執行的 SOP**（不是「我不會做 X」，而是「缺 X 的步驟說明」）。
> - `context`：選填，哪一個 Issue／哪一步遇到。
>
> **不得為了填而虛構缺口**：沒遇到就整個欄位省略——省略是正常且預期的。虛報技能缺口
> 與虛報 `changedPaths` 同屬不誠實回報（docs/18 §2.3）。此欄位**不影響終態判定**
> （不會讓你更容易通過或被擋下），只會在 Issue 貼上 `skill-gap` 標籤供人類彙整。
>
> **例外——停手或無法完成時必須顯式表態**：若你依 `factory-stop-rules` 停手、
> 或明知本工作項無法完成，則 `skillGap` **不可省略**，二選一：
>
> - 有缺口 → 照上述三欄填寫；
> - 確認沒有缺口（純屬 Issue 本身的問題，與你的能力無關）→ 明寫 `"skillGap": null`。
>
> **理由**：目前「沒遇到缺口」與「遇到了但沒想到要回報」在資料上**完全一樣**（都是欄位缺席），
> 人類無從分辨。`null` 是你的**顯式否認**，成本一個字，卻讓這兩者可區分。
> 停手時 CI 會檢查此欄位並在缺席時發出 advisory——**那只是提醒，不擋你的終態、
> 不改任何標籤**，也不會因此要求你補一個不存在的缺口。

> **報告必須誠實反映實際變更（docs/18 §2.3）**：CI 會以 `factory-crosscheck` 把
> `changedPaths`/`changedLines` 與實際 git diff 交叉比對——漏報或虛報（如宣稱改了檔但
> 沒建分支、或改了檔卻沒寫進報告）會直接觸發 needs-human。填寫前先以
> `git diff --name-only $BASE_BRANCH...<分支>` 核對。

> **重跑／既有交付（2026-09-01 T3 試點 #595 教訓）**：若執行中發現**本工作項的交付物已存在**
> （如前次 run 已開 PR 且內容完整），**不得重複建立 PR**；此時 `changedPaths` 填 `[]`、
> `changedLines` 填 `0`（本次 run 無新變更），並在 Issue 留言與 report 中標明**既有 PR 編號**
> 與你對其內容的**驗證結論**（讀過、確認涵蓋驗收條件）。crosscheck 的 `no-trace` 只攔
> 「宣稱變更卻零交付」的假完成；誠實標示重複使用不會誤觸。不確定既有 PR 是否完整時，
> 依 factory-stop-rules 停手交還人類，**不要猜測**。

## 任務型別

任務描述會指明型別（agent-add-tests / agent-fix-bug / agent-update-deps / agent-write-docs / agent-write-spec / agent-analyze / agent-propose-skill / agent-pbt-audit）。依型別調整：

- **agent-add-tests**：為**既有行為**補測試——test-only **單層**（01-test 是主體，無實作/文件層），新增測試必須在既有實作上**直接綠燈**。若測試揭露**既有缺陷**（紅燈且非測試自身錯誤）→ 以 `it.skip` 交付（斷言完整保留、該層單獨 CI 綠）＋在 Issue 留言報告＋建議另開 agent-fix-bug 工作項修復（沿用 fix-bug 的紅燈交付機制，**不停手**，本工作項不改實作）。若既有測試已充分覆蓋，依 factory-stop-rules 誠實停手（不為交差而製造無意義測試）。
- **agent-fix-bug**：先寫「重現失敗」的測試（紅），再實作修復（綠）。不刪除/弱化既有斷言。**01-test 層的紅燈測試以 `it.skip` 提交**（斷言完整保留、該層單獨 CI 綠；紅燈驗證在沙箱內完成）；**02-impl 層 un-skip（改回 `it`）**並含修復——否則 01-test 單獨 PR 必然 CI 紅（docs/07 §2.2 教訓，試點 #3）。
- **agent-update-deps**：通常是單一 PR（docs/07 §2.3）；不得未經核可新增未鎖定的新套件（SR5）；更新後全量測試。
- **agent-write-docs**：文件與實作一致；繁體中文；單層 PR 為主。
- **agent-write-spec**：可執行規格型（`.qnt`／模型檢查，ADR-008、**ADR-018**）。**一張 Issue、兩個 run**：先寫**不變量**（出自規格書），經人工核准（`spec/approved`）後，下一次派工才寫 **as-is 模型**（出自程式碼）。**本次階段由 CI 判定**，見任務描述與 `.factory/run/spec.json`——只做本次階段，不得自行切換或替另一階段預先產出。**不改 `src/`**（修復另開工單）。**不變量階段**：只改 `specs/<name>/invariants.qnt`、`source.md`、`docs/**`；`source.md` 由 CI 寫入，**原封不動提交**；不變量**只能出自 `source.md`**，每個 `val INV_*` 上方以 `// source: <出處> §<節>` 逐字引用原文，**不定義** `val WIT_*`；PR 寫 `Refs #<issue>`，**不得**用關閉關鍵字。**模型階段**：只改 `model.qnt`、`instances.qnt`、`verify.yml`、`docs/**`；`invariants.qnt`、`source.md` 已核准不得修改，`traces/` 只能由 CI 寫入；`model.qnt` 必須 `import` 並 **`export invariants.*`**；每條 `INV_*` 在 `model.qnt` 定義至少一個**情境 witness**（`val WIT_*`，正面描述不變量要保護的情境確實發生，**不得**是不變量的否定、不得在初始狀態就成立），`verify.yml` 只能引用 `model.qnt` 的 witness；PR 寫 `Closes #<issue>`。**兩條建模規則**：(1) 設定範圍以程式實際接受的輸入為準——`verify.yml` 每個常數附 `domain_justification`，程式未限制就涵蓋邊界與奇偶，不得用程式沒有的假設縮小範圍；(2) 反例是**候選發現**，不得修改模型讓它消失，由後續 `agent-fix-bug` 的紅燈測試回放。`verify.yml` **不得宣告預期結果**——結果一律由 CI 重新執行並判定。**兩個階段都要寫未決事項**：PR 描述的 `## 未決事項` 章節，以及 report 的 `openQuestions`（空陣列不算回答，沒有時寫 `{"none": "<理由>"}`）。**三條硬規則**（源自 34735315950 事故：agent 寫了規格卻從未 commit，逾時後整場產出歸零）：(1) **先建分支、每完成一個檔案就 commit**，不要等全部做完；(2) 模型檢查先用**縮小規模**量單次牆鐘再放大，同一條命令**最多重試 3 次最佳化**，逾時上限用盡仍不達標就**停手交還人類**（附已量測牆鐘、嘗試過的變體、降界所需條件），**不得**沉默無限迭代；(3) 找到違反的檢查通常很快，先做；不變量成立時的窮盡證明慢，後做。**不得**以自撰規格在同一 run 內驗證自撰程式碼（docs/06 §4.3）。
- **agent-analyze**：分析/調查型（bug 重現、根因分析、影響分析、可行性、in-loop 前置分析）——**不產生程式碼變更**，只允許 `docs/research/` 下的報告檔。產出為 **docs/ 報告 PR（單層）**＋「建議下一步」（可直接開成工作項）；DoD = 報告含結論摘要／證據與根因／影響範圍／方案比較／建議下一步。**in-loop（5–6 分）工作項可用**——docs/06 §4「僅可產出分析與方案，不得實作」的實作；報告不具放行效力，仍須人類審查（crosscheck 以 analyze 模式驗證無 src/ 變更，違反即 needs-human）。**report.json 的 `requirements` 必填**：每條驗收條件對應 `{id, status}`（`passed`＝報告已涵蓋／`failed`＝報告指出未涵蓋或無法達成／`skipped`＝不適用），缺漏會觸發 `requirements-missing` fail-loud（docs/20 B1）。
- **agent-pbt-audit**：事後稽核型（ADR-019）——對**一個**既有模組寫 property-based test，**只能新增或修改 PBT 測試檔、不得刪除**（crosscheck 以 pbt-audit 模式驗證）；單層 01-test；失敗的 property 寫進 report 的 `pbtAudit.findings`，**不開 Issue、不修 bug**。**in-loop（5–6 分）工作項可用**（前提是上述白名單加上類型層級禁止自動合併）。完整規則見下方「agent-pbt-audit」一節。
- **agent-propose-skill**：技能提案型（ADR-016、docs/25 §4）——依 Issue 描述的技能缺口撰寫技能草案。**寫入 `proposals/skills/<name>/SKILL.md`（kebab-case），絕不寫入 `.dsh/skills/`**：後者是已生效技能目錄，受 H5＋CODEOWNERS 保護；草案須由人類審查並執行 `factory-skills-lock --promote` 後才生效（**產出與生效分離**——草案不在任何 DSH 探索路徑上，誤合併也不會生效）。**不修改** `src/`、`.github/`、`.dsh/`、`config/`、`catalog-info.yaml`（crosscheck 以 propose-skill 模式白名單驗證，越界即 needs-human）。草案要求：frontmatter 合法（`name` kebab-case 且與目錄同名、`description` 必填，否則 DSH 靜默丟棄）、內容為**可執行步驟**非泛泛原則、**不得弱化或繞過 factory-stop-rules 任何一條**、不得與既有技能矛盾、不得含憑證。**in-loop（5–6 分）工作項可用**（同 analyze，僅產出不實作）。`requirements` 必填，規則同上。

## agent-pbt-audit（ADR-019）

**PBT 只在這個類型裡出現。** 其他類型的 run **不得**新增或修改 PBT 測試檔（crosscheck 判 `pbt-outside-audit` → needs-human），也拿不到 `hegel`／`hegel-review` skill。開發當下寫的 property，依據只能來自你剛讀的 Issue 與你即將寫的實作，違反「不得以自撰依據驗證自撰產出」（ADR-008）。

### 什麼邏輯用什麼驗證（ADR-019 §3，三者互不取代）

| 邏輯類型 | 用什麼 |
|---|---|
| 狀態機、協定、權限決策、時序性質 | Quint（`agent-write-spec`） |
| 輸入空間大的純函式合約（parser、序列化、數值計算、路徑比對、schema 邊界） | PBT（`agent-pbt-audit`） |
| 定義域很小的有限組合 | 直接窮舉的範例測試 |
| 測試本身是否有效 | 人工 mutation 測試（docs/11 §6.1） |

### property 的依據（ADR-019 §4）

先有依據，才寫 property。每個 property 上方以註解標明出處：

| 依據 | 標註範例 |
|---|---|
| 已核准的 `INV_*`（模組跑過 write-spec） | `// source: INV_lock_exclusive (specs/redlock/invariants.qnt)` |
| Issue 的驗收條件 | `// source: Issue #42 AC-2` |
| 通用性質（roundtrip、不 crash、冪等、順序無關） | `// source: generic/roundtrip` |
| 本次**未修改**的既有程式碼的文件／簽章／assert | `// source: src/factory-draft/parse.ts:31` |

- 沒有依據的 property 不寫（`hegel-review` 第 5 點）。把被測函式的邏輯重寫一份再比對，不算 property。
- 模組有已核准的 `INV_*` 時，必須一併翻譯成 property。
- PBT **只新增、不取代**既有範例測試（ADR-019 §6）。

### PBT 檔命名（crosscheck 白名單，ADR-019 R6）

| 語言 | PBT 檔 |
|---|---|
| TS/JS | `**/*.pbt.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` |
| Java | `**/src/test/**/*PbtTest.java` |
| Go | `**/*_pbt_test.go` |
| Rust | `**/tests/**/*pbt*.rs`（不得寫在 src 內的 `#[cfg(test)] mod`） |
| C++ | `**/*_pbt_test.{cc,cpp,cxx}` |
| OCaml | `**/test/**/*_pbt.ml` |

除此之外的路徑一律不得改動；共用的 generator／settings helper 若不存在，屬於前置作業不足，依 factory-stop-rules 停手。

### 流程

1. **smoke property**：先寫一個最簡單的 property 跑一次，確認 runner 能載入 Hegel。跑不起來 → 停手（前置作業不足，不要自行修改設定或依賴）。
2. 依 `hegel` skill 盤點公開 API、寫 property；generator 的範圍要和合約一樣寬。
3. **判定「通過」**：`CI=true`，且 **20 個隨機 seed × 每 seed 5000 cases** 全部通過，才可放進 PR。單次執行通過不算：試點中有 property 在 20 個 seed 裡失敗 7 次。
4. 失敗的 property **不放進 PR、不用 skip、不修 bug**：寫進 `pbtAudit.findings`。
5. 自審時逐條跑 `hegel-review` 的 12 點（見 factory-self-review）。

### `pbtAudit.findings` 的格式

每條候選發現一個物件，CI 會原樣貼到 Issue（你**不要**自己開 Issue 或留言貼發現）：

```json
{
  "property": "<property／測試名稱>",
  "source": "<依據標註，同 // source:>",
  "draws": "<Hegel 縮減後印出的 draws，原樣貼上>",
  "seed": <HEGEL_SEED>,
  "hegelVersion": "<例如 0.4.7>",
  "reproTest": "<固定輸入的紅燈範例測試，可直接貼上執行>",
  "propertyToRestore": "<修正後要加回的 property（選填）>"
}
```

`seeds`、`testCasesPerSeed`、`properties`、`passed`、`failed`、`timeouts` 照實填。這些是**自報**數字，CI 會和它自己量到的值並列顯示，不參與判定——但寫錯會在人類審查時被看見。

### TypeScript／Jest 補充說明（試點實測，`docs/research/hegel-ts-pilot-fubon-2026-10.md` §4）

1. 寫法：`test('…', () => hegel.test((tc) => { … }))`；async 用 `hegel.testAsync`。**一定要包在 `() =>` 裡**（hegel.dev 官網仍是舊寫法，沒包會在載入時就執行）。
2. 案例數與 seed 一律經由目標 repo 的 settings helper 傳入（例如 `pbtSettings()` 讀 `HEGEL_TEST_CASES`、`HEGEL_SEED`）。`@hegeldev/hegel` 0.4.7 會無條件覆寫原生的 `HEGEL_TEST_CASES` 與 `hegel.toml`，不要依賴它們。
3. 稽核執行指令（**pattern 放在 `--selectProjects` 前面**，否則它會被當成 project 名稱吃掉、改跑整個 suite）：
   `rm -rf .hegel && CI=true HEGEL_SEED=<n> HEGEL_TEST_CASES=5000 npx jest '<pattern>' --selectProjects unit --testTimeout=600000`
4. **每次評估或重現前先 `rm -rf .hegel`**：本機資料庫會以測試函式原始碼為 key 重播舊的失敗，會讓你誤判。
5. generator：除了全域範圍，**必須另外直接建構邊界值與特殊值**（`oneOf` 加上邊界 ±k、`sampledFrom([NaN, Infinity, -Infinity, -0, …])`），讓 CI 的 100 cases 也守得住。
6. seed 只有明確指定時才看得到，因此判定「通過」時一律帶 `HEGEL_SEED`，並把用過的 seed 記進 `pbtAudit.seeds`。
7. `hegel.test` 是同步迴圈，Jest 的 timeout 打斷不了；卡住時由 run 的 timeout 收尾，不要自己無限重試。

**其他語言**（Java、Go、Rust、C++、OCaml）尚未有試點：讀該語言 Hegel 函式庫的文件與原始碼（`hegel` skill 的做法），把遇到的陷阱寫進 report 的 `skillGap`，供人類回填本節。Java 17–21 用 `dev.hegel:hegel-jna`，測試 JVM 需要 `--enable-native-access=ALL-UNNAMED`。

## 原則

- 所有 git/gh 操作使用 GitHub App 身分：**若環境變數 `GH_TOKEN` 不存在，先執行**
  `export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)`（短效 installation token，
  由 CI 寫入 workspace；讀取失敗則依 factory-stop-rules 停手）。**永不把 token 寫入任何
  會進 git 的檔案**（如 commit message、文件、測試）。
- **目標 repo 與 trunk 分支也以檔案傳遞**（DSH 會剝離 process env；工作目錄可能是
  其他 repo 的 checkout）：`export GH_REPO=$(cat .factory/run/repo 2>/dev/null)`、
  `export BASE_BRANCH=$(cat .factory/run/base-branch 2>/dev/null)`。`GH_REPO` 讓 gh 的
  issue/PR 操作指向目標 repo；`BASE_BRANCH` 是 PR 合併目標（stack 的 base）——
  **絕不 push 到 main**（Q-P2-1）。
- `git push` 的認證已由 CI 設定（remote URL 內嵌 App token，優先於任何 credential helper）——**直接 push 即可**，不要自行改 remote URL、不要寫入 token 到任何檔案。


- **分支命名**：格式 `factory/<issue編號>-<nn>-<layer>`（如 `factory/12-01-test`）為唯一允許；gh-stack **v0.1.0** 用 `gh stack init --base "$BASE_BRANCH" factory/<issue>-01-test ...` 直接列分支名建立（**不接受** `--numbered`/`--prefix`）；不得自行命名（如 `08-18-docs_...`）或以 dash 取代 slash。
- **PR 一律非 draft**：`gh stack submit --auto` 或 `gh pr create` 皆不可加 `--draft`（draft 無法合併，擋住審查流程）。

- 任務描述本身不重複本 skill 內容——需要細節時回到本檔案。
- **輸出紀律**：設計/推導/思考過程不輸出到 stdout（DSH stdout 有輸出上限，過量輸出會導致執行中斷）——產物直接寫入目標檔案，stdout 只留簡短進度與最終摘要。
- 任何不確定的情況，依 factory-stop-rules 停手，**不要猜測並繼續**。
