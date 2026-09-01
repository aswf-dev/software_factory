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
| C1 | 新增 `agent-analyze` 類型 | 綜合（最大項） | 10 | 七處接線＋試點 | H5→審查 | #201 | 待執行 |
| D1 | docs/19 共識修正＋合併 | agent-write-docs | 11 | `docs/19`＋`docs/10` | 低 | #202 | 待執行 |

> **監督欄說明**：改 `.github/**`、`.dsh/skills/**`、`catalog-info.yaml` 觸發 H5 → risk=2 → 人類審查（預期行為，非阻礙）。
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
- **候選類型**：agent-write-spec（需四護欄：draft 標記／禁自動合併／spec-approved 標籤／DoD 含未決事項）、agent-refactor（需 characterization-test 拆分規則）、agent-security-fix（需類型級限制）、agent-migrate、agent-release-notes（需先有釋出流程）：等 C1 實跑驗證後再議。

---

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q20-1 | 工項是否開成 GitHub Issue（`factory-work-item` 模板，`meta/observation` 標籤） | 使用者裁決投放方式 |
| Q20-2 | C1 試點驗證的安排（目標 repo、樣本數） | 人類安排，比照 Phase 2 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
