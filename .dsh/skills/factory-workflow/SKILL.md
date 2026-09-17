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
  "skillGap": {"category": "<kebab-case 分類>", "needed": "<缺什麼 SOP>", "context": "<情境>"}
}
```

寫入路徑：`.factory/run/report.json`（位於 workspace 根目錄）。此報告是 CI 判定終點的輸入；**欄位缺漏時 CI 會以最保守方式處理**，但完整填寫能讓人類接手時看到全貌。

> **`requirements` 欄位（G8 需求追蹤，docs/20 B1）**：每一條 Issue 驗收條件（DoD）對應一個
> `{id, status}`——`id` 為驗收條件編號、`status` 為其對應測試/實作的狀態
> （`passed`/`failed`/`skipped`）。`factory-crosscheck` 會驗證該欄位完整性（每條驗收條件
> 都有對應條目且 status 齊全）；此欄位缺漏或造假時與 `changedPaths` 同樣觸發 needs-human。
> **此欄位為「誠實自報」＋CI 交叉驗證，不取代人類審查（docs/06 §4.3）。**

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

任務描述會指明型別（agent-add-tests / agent-fix-bug / agent-update-deps / agent-write-docs / agent-write-spec / agent-analyze / agent-propose-skill）。依型別調整：

- **agent-add-tests**：為**既有行為**補測試——test-only **單層**（01-test 是主體，無實作/文件層），新增測試必須在既有實作上**直接綠燈**。若測試揭露**既有缺陷**（紅燈且非測試自身錯誤）→ 以 `it.skip` 交付（斷言完整保留、該層單獨 CI 綠）＋在 Issue 留言報告＋建議另開 agent-fix-bug 工作項修復（沿用 fix-bug 的紅燈交付機制，**不停手**，本工作項不改實作）。若既有測試已充分覆蓋，依 factory-stop-rules 誠實停手（不為交差而製造無意義測試）。
- **agent-fix-bug**：先寫「重現失敗」的測試（紅），再實作修復（綠）。不刪除/弱化既有斷言。**01-test 層的紅燈測試以 `it.skip` 提交**（斷言完整保留、該層單獨 CI 綠；紅燈驗證在沙箱內完成）；**02-impl 層 un-skip（改回 `it`）**並含修復——否則 01-test 單獨 PR 必然 CI 紅（docs/07 §2.2 教訓，試點 #3）。
- **agent-update-deps**：通常是單一 PR（docs/07 §2.3）；不得未經核可新增未鎖定的新套件（SR5）；更新後全量測試。
- **agent-write-docs**：文件與實作一致；繁體中文；單層 PR 為主。
- **agent-write-spec**：可執行規格型（`.qnt`／模型檢查，ADR-008）。交付 `specs/**` 規格檔＋驗證證據（反例 ITF、牆鐘量測），通常**不改 `src/`**（規格描述現況，修復另開工單）。**三條硬規則**（源自 34735315950 事故：agent 寫了規格卻從未 commit，逾時後整場產出歸零）：(1) **先建分支、每完成一個檔案就 commit**，不要等全部做完；(2) 模型檢查先用**縮小規模**量單次牆鐘再放大，同一條命令**最多重試 3 次最佳化**，逾時上限用盡仍不達標就**停手交還人類**（附已量測牆鐘、嘗試過的變體、降界所需條件），**不得**沉默無限迭代；(3) 反例類（`INV_VIOLATED_*`，深度淺）先做，真不變式的窮盡證明（慢）後做。**不得**以自撰規格在同一 run 內驗證自撰程式碼（docs/06 §4.3）。
- **agent-analyze**：分析/調查型（bug 重現、根因分析、影響分析、可行性、in-loop 前置分析）——**不產生程式碼變更**，只允許 `docs/research/` 下的報告檔。產出為 **docs/ 報告 PR（單層）**＋「建議下一步」（可直接開成工作項）；DoD = 報告含結論摘要／證據與根因／影響範圍／方案比較／建議下一步。**in-loop（5–6 分）工作項可用**——docs/06 §4「僅可產出分析與方案，不得實作」的實作；報告不具放行效力，仍須人類審查（crosscheck 以 analyze 模式驗證無 src/ 變更，違反即 needs-human）。**report.json 的 `requirements` 必填**：每條驗收條件對應 `{id, status}`（`passed`＝報告已涵蓋／`failed`＝報告指出未涵蓋或無法達成／`skipped`＝不適用），缺漏會觸發 `requirements-missing` fail-loud（docs/20 B1）。
- **agent-propose-skill**：技能提案型（ADR-016、docs/25 §4）——依 Issue 描述的技能缺口撰寫技能草案。**寫入 `proposals/skills/<name>/SKILL.md`（kebab-case），絕不寫入 `.dsh/skills/`**：後者是已生效技能目錄，受 H5＋CODEOWNERS 保護；草案須由人類審查並執行 `factory-skills-lock --promote` 後才生效（**產出與生效分離**——草案不在任何 DSH 探索路徑上，誤合併也不會生效）。**不修改** `src/`、`.github/`、`.dsh/`、`config/`、`catalog-info.yaml`（crosscheck 以 propose-skill 模式白名單驗證，越界即 needs-human）。草案要求：frontmatter 合法（`name` kebab-case 且與目錄同名、`description` 必填，否則 DSH 靜默丟棄）、內容為**可執行步驟**非泛泛原則、**不得弱化或繞過 factory-stop-rules 任何一條**、不得與既有技能矛盾、不得含憑證。**in-loop（5–6 分）工作項可用**（同 analyze，僅產出不實作）。`requirements` 必填，規則同上。

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
