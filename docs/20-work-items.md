# 20 — SDLC 改善工項清單

> **來源**：`docs/19-swebok-v4-sdlc-gap-analysis.md`（SWEBOK v4 對照）＋多輪共識討論（2026-09-01，deepseek/Opus5 兩 session 收斂後由使用者裁決）。
> **用途**：把已裁決的改善項轉成可執行的工廠工作項清單，含狀態追蹤。**本清單是追蹤索引**——各工項的細節（PRD/DoD）以此為準，執行後在 Issue 與本表同步。
> **讀者**：投放工作項的人、平台工程師。

---

## 0. 裁決記錄（Q19-1~5，2026-09-01 使用者確認）

| 編號 | 裁決 |
|---|---|
| **Q19-1** | P0 六項全採；P1 六項逐項後議 |
| **Q19-2** | 新工作類型先做 `agent-analyze`，實跑驗證後再議其餘 |
| **Q19-3** | `agent-analyze` 產出 = 報告 PR（docs/、單層）＋建議下一步 |
| **Q19-4** | ADR-014 裁掉三項（Disposal、正式 CCB、容量/DR），各附重啟觸發條件 |
| **Q19-5** | 預防行動追蹤欄位內建於 docs/14 期檢模板；docs/08 只定義衍生指標 |

**共識新增項**（辯論產出，非 Q19 原列）：task_type 與計分正交性文件化（docs/06 §5.2/§4.1/§8）、docs/15 教訓（git 狀態重查）、add-tests 模板/skill 一致化、docs/19 以 deepseek 分支為準併入共識修正。

---

## 1. 工項總覽

| # | 工項 | 類型 | 優先 | 主要檔案 | 監督 | Issue | 狀態 |
|---|---|---|---|---|---|---|---|
| A1 | P0-2 需求變更控制條款 | agent-write-docs | 1 | `.dsh/skills/factory-stop-rules` | H5→審查 | #192 | ✅ 合併（PR #206） |
| A2 | P0-6 Agent 行為守則 | agent-write-docs | 2 | docs/ 新章節 | 低 | #193 | ✅ 合併（PR #209） |
| A3 | P0-5 ADR-014 裁適宣告＋索引補齊 | agent-write-docs | 3 | `docs/ADR/014-*`＋README | 低 | #194 | ✅ 合併（PR #207） |
| A4 | P0-4 觀察期 PDCA 模板 | agent-write-docs | 4 | `docs/14`＋`docs/08` | 低 | #195 | ✅ 合併（PR #208） |
| A5 | 正交性文件化（§5.2/§4.1/§8） | agent-write-docs | 5 | `docs/06` | 低 | #196 | ✅ 合併（PR #204） |
| A6 | docs/15 教訓（git 狀態重查） | agent-write-docs | 6 | `docs/15` | 低 | #197 | ✅ 合併（PR #203） |
| A7 | add-tests 模板/skill 一致化 | agent-write-docs＋測試 | 7 | `.github/factory/`＋skill＋測試 | H5→審查 | #198 | ✅ 合併（PR #205） |
| B1 | P0-1 G8 需求追蹤落地 | agent-fix-bug | 8 | `src/cli/factory-judge/crosscheck`＋pipeline | 中 | #199 | ✅ 完成（PR #216/#222/#223 已合併） |
| B2 | P0-3 G5 DoD 具體性檢查 | agent-fix-bug | 9 | `src/cli/factory-issue-check`＋Issue 模板 | 中 | #200 | ✅ 完成（PR #211/#220/#221 已合併） |
| C1 | 新增 `agent-analyze` 類型 | 綜合（最大項） | 10 | 七處接線＋試點 | H5→審查 | #201 | ✅ 完成（PR #227＋試點 T1/T2/T3＋4 衍生修正） |
| D1 | docs/19 共識修正＋合併 | agent-write-docs | 11 | `docs/19`＋`docs/10` | 低 | #202 | ✅ 完成（PR #224 已合併；PDF 另以 PR 補入） |

### 1.1 批次 E — Scoreboard 與技能撰寫迴圈（2026-09-05 新增，待開 Issue）

來源：`ADR-015`（Scoreboard 裁決）、`ADR-016`（技能提案）、`docs/25`／`docs/26`。**E1–E6 全部完成（2026-09-06）。**

| # | 工項 | 類型 | 主要檔案 | 監督 | 狀態 |
|---|---|---|---|---|---|
| E1 | 裁決與規格文件（ADR-015/016、docs/24/25/26、docs/22 v2、索引） | 人類撰寫 | `docs/**` | 低 | ✅ **完成（2026-09-05）** |
| E2 | Scoreboard MVP（Astro + Workers + D1 + Access） | 人類／新 repo | `philipz/factory-scoreboard` | 獨立 repo | ✅ **完成（2026-09-05）** |
| E3 | 機制 repo 接線：`factory-push-event` CLI ＋ workflow 推送步驟 | agent-fix-bug | `src/cli/factory-push-event.ts`＋`factory-run.yml` | H5→審查 | ✅ **完成（2026-09-05）** |
| E4 | skill-gap 通道：`ReportSchema.skillGap`＋留言段落＋`factory-workflow` SKILL 附加節 | agent-fix-bug | `src/cli/factory-judge.ts`／`apply-judge-labels.ts`／SKILL | H5→審查 | ✅ **完成（2026-09-06）** |
| E5 | `skills-lock` 完整性校驗＋`--promote` | agent-fix-bug | `src/cli/factory-skills-lock.ts`＋`config/factory/skills-lock.json` | H5→審查 | ✅ **完成（2026-09-06）** |
| E6 | `agent-propose-skill` 任務型別（八處接線＋crosscheck `--propose-skill-only`） | 綜合 | workflow／template／skill／crosscheck／對抗性測試 | H5→審查 | ✅ **完成（2026-09-06）** |
| P1 | `agent-pbt-audit` 任務型別（ADR-019 實作順序 3–5：vendor `hegel`／`hegel-review`＋類型專屬派送、八處接線＋preflight、in-loop 豁免、crosscheck `--pbt-audit-only`、禁止自動合併、機制留言、skill 疊加）＋aswf.dev 選項 | 人類（本 session） | `src/pbt-audit/**`、`src/cli/**`、workflow、template、Backstage、`.dsh/skills/**`、`philipz/factory-scoreboard` | H5→審查 | 🚧 **stacked PR 審查中（2026-10-05）**；試點（實作順序 6）由使用者以 `philipz/fubon-tradingbot` 實際工單進行 |

> **依賴序**：E1（契約）→ E2（接收端）→ E3（推送）→ E4（訊號）→ E5（鎖與放行）→ E6（提案型別）。E3–E6 之間無強依賴，但 E6 的價值依賴 E4 的訊號累積。

> **監督欄說明**：改 `.github/**`、`.dsh/skills/**`、`catalog-info.yaml` 觸發 H5 → risk=2 → 人類審查（預期行為，非阻礙）。

> **E2／E3 完成註記（2026-09-05）**
>
> - **E2**：`philipz/factory-scoreboard` 已部署，正式站台為 https://aswf.dev
>   （原 `https://factory-scoreboard.philipz.workers.dev` 仍指向同一個 Worker）。
>   71 tests（真實 workerd + D1）、Worker 壓縮後 172 KiB（預算 16.8%）。
>   Cloudflare Access 與 GitHub `SCOREBOARD_URL`／`SCOREBOARD_TOKEN` **均已設定完成**
>   （見該 repo 的 `scripts/setup-wizard.sh`）。
> - **E3**：`src/cli/factory-push-event.ts`（31 tests）＋ `factory-run.yml` 新增
>   「Push event to scoreboard」步驟（位於 Summary 之後、artifact 上傳之前）。
>   已實測推送至線上 Scoreboard 成功，且 5 種失敗情境（後台離線、無 env、401、
>   參數錯誤、缺檔）**全部 exit 0**，不影響工廠終態。
> - **未設定 secret 時的行為**：CLI 靜默跳過並印出原因；工廠一切照常。
>   因此 E3 可先合併，Access／secret 設定完成後自動開始收資料。

> **E4 完成註記（2026-09-06）**
>
> - **落地範圍**：`ReportSchema.skillGap`（`factory-judge.ts`）＋`src/skill-gap/render.ts`（新模組）
>   ＋`apply-judge-labels.ts` 的 `skill-gap` 標籤與留言段落＋`factory-workflow` SKILL 指示。
> - **修補一個既存的靜默不一致**：`factory-push-event.ts:199` 早已讀 `report.skillGap`，
>   但 `ReportSchema` 無此欄位而 zod 預設 strip——推送端拿得到、Issue 留言拿不到。
>   E4 之前若 agent 回報缺口，兩個消費端會**各說各話**；本次補 schema 後兩端一致。
> - **三項設計決策**：①`skillGap` **不進入 pipeline 判定**（不在 `toAgentRun`）——否則 agent
>   多一個「宣稱缺技能即改變終態」的施力點；②`category` 強制 kebab-case fail-loud——
>   聚類鍵劣化會讓 docs/25 §3 的「≥3 次」門檻永遠達不到；③缺席時留言與標籤**逐字等同現況**。
> - **驗證**：924 tests 全綠、`src/cli/**` 與 `src/skill-gap/**` 維持 100% 分支；
>   新增 4 個變異（M4 去重守衛、M5 `requiresHuman` 洩漏、M6 kebab-case 放寬、
>   M7 skillGap 洩漏進 pipeline）**均實測「變異→紅、還原→綠」**；
>   並以 dist/ 實機跑通「report → judge.json → 標籤＋留言 → 推送事件」全鏈，
>   含「無 skillGap 時輸出與 E4 前逐字相同」的回歸驗證。
> - ~~**尚未驗證**：真實 run 中 agent 是否會主動填寫此欄位~~
>   → ✅ **已於 2026-09-06 以真實 DSH 呼叫驗證，見下方 E5/E6 註記的「紀律實證」。**

> **E5／E6／REQ 錨定 完成註記（2026-09-06）**
>
> **Q16-1／Q25-1 實機驗證（先做，因為它決定目錄名）**：ADR-016 原將
> 「`proposals/` 不在 DSH 探索 rank 上」列為**推論**。以真實 `dsh --profile headless`
> 兩次獨立探測確認：對照組 `.dsh/skills/probe-visible` **被發現**（證明探測法有效）、
> `proposals/skills/probe-canary` **未被發現**。→ **推論成立**，維持 `proposals/skills/`，
> 不需改用 `.factory/proposals/`。**ADR-016 的安全樞紐（誤合併也不生效）成立。**
>
> - **E5**：`src/cli/factory-skills-lock.ts`（`--verify`／`--update`／`--promote`）＋
>   `config/factory/skills-lock.json`（6 個 skill）＋`factory-run.yml` 於 `cp -r` 後校驗。
>   **`--verify` 恆 exit 0**（ADR-016 §5 第一階段僅警告；Q16-2 待人類裁決升紅燈）——
>   校驗不得成為新的失敗來源。實測模擬「cp 掉了 factory-stop-rules」→ 正確回報
>   `missing` 且仍 exit 0。**本次實作中它真的抓到一次**：我改了 factory-workflow SKILL.md
>   卻未跑 `--update`，verify 回報 `changed`（同 `pnpm-lock` 過期的性質）。
> - **E6**：新增 `agent-propose-skill`（**八處接線全做**，docs/21 §1）。crosscheck 新增
>   `--propose-skill-only`（**白名單**：只允許 `proposals/skills/**` 與 `docs/**`）。
>   兩個「僅產出」旗標互斥（同時指定→ CliError，避免寬鬆的那套悄悄生效）。
>   `apply-score-labels` 的 in-loop 放行清單擴為 `OUTPUT_ONLY_TASK_TYPES`（analyze＋propose-skill），
>   **tier／標籤／automerge 均不變**（ADR-016 §4，非放寬監督層級）。
>   模型路由（接線 7）經查證為**複雜度導向、與 task_type 正交**，故為 no-op。
> - **REQ id 錨定**：`factory-issue-check` 將驗收條目編號為 `REQ-n` 並回寫 Issue 留言；
>   `factory-crosscheck --requirement-anchors` 比對 `report.requirements[].id`。
>   **第一階段為 advisory**（獨立 `advisories` 欄位，**不影響 `ok`、不擋 run`**）——
>   DoD 由自由文字解析，直接 fail-loud 會製造假陽性而重蹈 `defect/*` 失效覆轍。
>   訊號經 `extra` 槽送 Scoreboard（`requirements_failed`／`requirements_total`／
>   `requirement_advisories`），**不改 schema v2，接收端零改動**。
>
> **紀律實證（docs/25 §7 最高風險的直接檢驗，2026-09-06）**
>
> 無法用 CI 驗（本 repo `risk-profile: high`＋改 `.dsh/skills/**` 觸 H5 → 必然 in-loop 被擋），
> 也無法用 dry_run 驗（stub agent 固定輸出）。故以**本機真實 DSH 呼叫**執行：
> 建一個 pnpm workspace fixture（`vitest.config.mts` 位於非慣例路徑、devDeps 被裁掉），
> 以隔離的 `DSH_HOME` 載入工廠 skills，跑真實 LLM。
>
> **結果：agent 主動填寫了 `skillGap`，且格式完全合法**——
> `category: "trimmed-fixture-dev-deps"`（合法 kebab-case）、`needed`／`context` 具體且誠實，
> 並正確沿用了驗收條件的 `REQ-1`／`REQ-2` 編號。
> 全鏈以 dist/ 實測貫通：report → judge（schema 收下）→ `skill-gap` 標籤＋留言段落 →
> Scoreboard 事件 `skill_gap` 非 null。
>
> **這一項的意義**：docs/25 §7 把「紀律失效」列為最高風險（前例：180 顆 PR 累計 0 筆
> `defect/*` 標記）。本次實證顯示 **T1 偵測層不依賴人工紀律即可產生訊號**——
> 因為填寫者是 agent 而非人類，且 SKILL 指示已足以驅動該行為。
> **但樣本數為 1**，且情境是刻意製造的缺口；真實工作項的填寫率仍需累積觀察。
>
> **A 批狀態（2026-09-01）**：7/7 已合併進 software-factory（PR #203–#209）並隨 PR #210 同步至 **main**；Issues #192–#198 已人工關閉（docs/07 §3.5）。

---

## 2. 批次 A — 文件/規則類（agent-write-docs）

### A1 · P0-2 需求變更控制條款

- **目標檔案**：`.dsh/skills/factory-stop-rules/SKILL.md`（＋docs/07 或 docs/06 交叉引用）
- **PRD**：`factory-stop-rules` 新增條款：「執行中發現需求與 Issue 描述不符（缺漏／矛盾／範圍歧義）→ 停手，留言說明差異，貼 `needs-human`；**不自行擴大範圍**」。人類可更新 Issue 重跑或開新 Issue。對應 SWEBOK Ch1 §6.2–6.3。
- **DoD**：條款已加入 skill；對應文件引用更新；`test/adversarial/factory-assets.test.ts` 仍綠。
- **風險**：改 `.dsh/skills/**` → H5 → 人類審查。

### A2 · P0-6 Agent 行為守則

- **目標檔案**：`.dsh/skills/factory-stop-rules/SKILL.md` 前言 或 docs/ 新章節
- **PRD**：整合誠實報告（`docs/18` §2.3）、不弱化測試（SR6）、不自我驗證（`06` §4.3、`11` §1.2）、停手優於猜測，為一份「factory agent 行為守則」。對應 SWEBOK Ch14 §1.2。
- **DoD**：守則完成；每條標註既有規則出處；繁體中文。

### A3 · P0-5 ADR-014 裁適宣告＋索引補齊

- **目標檔案**：`docs/ADR/014-sdlc-tailoring.md`（新）＋`docs/ADR/README.md`
- **PRD**：依 `docs/19` §7 草案定稿；**三項裁掉（Disposal、正式 CCB、容量/DR）各附一行「重新檢視觸發條件」**（第二位協作者、repo 轉客戶端、自架 runner）；宣告六階段生命週期與流程裁適表；同步補 README 索引缺的 **011–013**。對應 SWEBOK Ch10 §2.8。
- **DoD**：ADR-014 含裁適表＋重啟條件；README 索引列出 011–014；`docs/10` Q19-4 標記已裁決。

### A4 · P0-4 觀察期 PDCA 模板

- **目標檔案**：`docs/14-observation-period.md`（期檢模板擴充）＋`docs/08-metrics-kpi.md`（衍生指標）
- **PRD**：期檢模板擴充為：缺陷分類 → 根因 → 預防行動 → 下期驗證效果（PDCA 的 Check→Act）；**追蹤欄位內建於期檢模板（Q19-5 裁決）**；`docs/08` 只定義「預防行動完成率」衍生指標。對應 SWEBOK Ch10 §3.1、Ch12 §2.4.1、Ch18 §9。
- **DoD**：docs/14 模板含追蹤欄位；docs/08 指標定義新增；`docs/10` Q19-5 標記已裁決。

### A5 · 正交性文件化（共識項）

- **目標檔案**：`docs/06-human-oversight-policy.md`
- **PRD**：三處修改——①§5.2 計分資料來源表加註記「**工作類型（task_type）不是計分輸入**——正交性是 §5.1『agent 無權參與判定』的必然結果」；②§8 局限 3 加交叉引用（根因指向 §5.2 註記）；③§4.1 自動合併條件清單加「類型級限制」說明（語意風險類型的唯一施力點，如 security-fix 一律人類審查）。
- **DoD**：三處修改完成；`docs/10` 新增 Q19-6 追蹤項（或隨工項標記）。

### A6 · docs/15 教訓（共識項）

- **目標檔案**：`docs/15-observation-trial-log.md`
- **PRD**：新增教訓條目（沿用既有「**教訓：**」格式）：「跨 session/turn 協作時 git 分支／工作樹狀態可能已變；宣稱任何狀態前以 `git branch --show-current` / `git cat-file -e HEAD:<path>` 重查；『上輪查過』不算數」。
- **DoD**：條目已加。

### A7 · add-tests 模板/skill 一致化（共識項）

- **目標檔案**：`.github/factory/task-template-add-tests.txt`＋`.dsh/skills/factory-workflow/SKILL.md`（＋對抗性測試若有模板內容檢查）
- **PRD**：**劃界**——add-tests = 為既有行為補測試（test-only 單層）；測試必須在既有實作上直接綠燈；**若測試揭露既有缺陷（紅燈且非測試自身錯誤）→ 以 `it.skip` 交付（斷言完整保留）＋Issue 留言報告＋建議開 fix-bug 工作項**（沿用 fix-bug 既有機制，不停手）。`task-template-add-tests.txt` 第 4 步改為單層語意，與 skill「01-test 層是主體」一致。
- **DoD**：模板與 skill 一致；測試綠；docs/07 或 docs/09 路由說明同步。
- **風險**：改 `.github/`、`.dsh/skills/**` → H5 → 人類審查。

---

## 3. 批次 B — 程式/機制類

### B1 · P0-1 G8 需求追蹤落地

- **目標檔案**：`src/cli/factory-judge.ts`（ReportSchema）、`src/cli/factory-crosscheck.ts`、`src/pipeline/run-work-item.ts`、`docs/18`
- **PRD**：`report.json` 增加 `requirements: [{id, status}]`；`factory-crosscheck` 驗證「每條驗收條件（Issue DoD）→ 對應測試／實作 → status 齊全」，缺失即 fail-loud。對應 SWEBOK Ch1 §7.3。
- **範圍邊界（#199 試跑發現，2026-09-01）**：`.dsh/skills/factory-workflow/SKILL.md` 的 report 範本更新屬 **H5（guardrail）**——agent 依 stop-rules 第 8 條誠實停手（Issue 自身矛盾：PRD 含 H5 路徑但 DoD 禁高風險）。**分工**：範本更新＝本機端／人類（已於本機端完成，見 SKILL.md `requirements` 欄位）；agent 範圍＝schema＋crosscheck＋pipeline＋測試。二者必須同批落地，否則全量 crosscheck 紅（schema 收緊但範本未同步）。
- **DoD**：ReportSchema 含 requirements；crosscheck 驗證邏輯 100% 分支測試；E2E／對抗性測試更新；`docs/18` G8 標記完成。

### B2 · P0-3 G5 DoD 具體性檢查

- **目標檔案**：`src/cli/factory-issue-check.ts`、`.github/ISSUE_TEMPLATE/factory-work-item.yml`
- **PRD**：`factory-issue-check` 留言增加「DoD 具體性提示」（每條驗收條件含可觀察結果、無空泛詞彙）；**與未來的「確效提示」分開**（G5 = Verification 形式檢查；確效 = Validation 人機提示，本次不做後者）。對應 SWEBOK Ch1 §4.3。
- **DoD**：檢查邏輯＋測試；留言格式更新；`docs/18` G5 標記完成。

---

## 4. 批次 C — 新工作類型（最大項）

### C1 · 新增 agent-analyze 類型

- **PRD**：定義 `agent-analyze`：分析／調查工作項（bug 重現、根因分析、影響分析、可行性、in-loop 前置分析），**不產生程式碼變更**；產出 = `docs/` 報告 PR（單層，可審查、可版本化）＋「建議下一步」（可直接開成工作項）；DoD = 報告含結論摘要／證據與根因／影響範圍／方案比較（含被拒方案）／建議下一步。in-loop 高風險工作項可用此型產出分析（符合「僅分析不實作」）。
- **七處接線**：
  1. `.github/ISSUE_TEMPLATE/factory-work-item.yml` — 下拉加 `agent-analyze`
  2. `.github/workflows/factory-run.yml` — `options` 陣列
  3. `.github/factory/task-template-analyze.txt` — 新模板
  4. `.dsh/skills/factory-workflow/SKILL.md` — 任務型別分支
  5. `test/adversarial/factory-assets.test.ts` — 兩處釘死清單更新（4→5 型）
  6. `config/dsh/model-tiers.yaml`／`src/cli/factory-model.ts` — 路由考量（複雜度路由已覆蓋；analyze 偏推理，依試點調 tier）
  7. `docs/07`（analyze=單層拆分）＋`docs/09`（路由說明）
- **DoD**：七處接線完成、對抗性測試 5 型綠；**試點驗證 ≥1 個真實工作項實跑**（人類安排，比照 Phase 2）；`docs/10` Q19-2/3 標記已裁決。

- **試點結果（2026-09-01）**：T1（#228→報告 PR #231）、T2（#229→#230）、T3（#595→#597，fubon in-loop 6 分前置分析）全數完成並合併；報告品質經抽查良好（結論/證據/影響/方案比較/建議下一步五段齊全）。
- **試點衍生修正（4 個，全部合併）**：#232 guard 跨 repo 分支檢查改用 App token（原用 github.token 查目標 repo 必 404）；#233 analyze 模板明訂 requirements 語意；#234 quint 二進位快取（~/.quint，避免並行 rate limit）；#236 重跑遇既有交付時誠實回報（changedPaths=[]＋標明既有 PR）。
- **風險**：改 `.github/`、`skills/` → H5 → 人類審查；試點屬觀察期動作。

---

## 5. 批次 D — 收尾

### D1 · docs/19 共識修正＋合併

- **目標檔案**：`docs/19-swebok-v4-sdlc-gap-analysis.md`（deepseek 分支 HEAD）＋`docs/10`
- **PRD**：併入共識修正——§6.2 改掉「write-docs 可機械驗證」前提（改為「誠實性檢查 vs 正確性檢查」＋下游放大效應）；補 security-fix「語音風險不可見於計分＋類型級限制」；add-tests 改為「模板/skill 衝突＋劃界」論述；§6.5 補 task_type 正交性；§7 ADR-014 標註 Q19-4 已裁決；`docs/10` Q19-1~5 全部標記已裁決。走 PR 合併進 `software-factory` trunk。
- **DoD**：docs/19 修正完成；Q19 標記完成；PR 合併。

---

## 6. 執行順序與依賴

```
A1→A2→A3→A4（獨立文件項，可並行投放）
  ↓
A5→A6→A7（共識項；A7 含測試，與 A1 同觸 H5）
  ↓
B1→B2（程式項，TDD；B1 的 report schema 獨立於 A 批）
  ↓
C1（新類型，最大項；依賴前面類型路徑走順）
  ↓
D1（docs/19 收尾；Q19 標記依賴前項完成）
```

## 7. 延後項目（Q19-1/2 裁決）

- **P1 六項**（釋出管理、rollback runbook、ATDD 驗收層、架構審查指引、自動化判定、估算裁適）：逐項後議，建議 P0 落地＋觀察期數據後再裁。
- **候選類型**：agent-write-spec、agent-refactor、agent-security-fix、agent-migrate、agent-release-notes——詳細評估（定義/依據/風險/前置/紅線/排序）見 `docs/21-candidate-work-item-types.md`（活文件，逐步完善）。

---

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q20-1 | 工項是否開成 GitHub Issue（`factory-work-item` 模板，`meta/observation` 標籤） | 使用者裁決投放方式 |
| ~~Q20-2~~ | C1 試點驗證的安排（目標 repo、樣本數） | ✅ **已裁決（2026-09-01）**：software_factory×2（T1/T2）＋fubon-tradingbot×1（T3 in-loop，complexity 暫時調升後復原） |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
