# 19 — SWEBOK v4 對照：SDLC 差距分析與改善建議

> **依據**：IEEE Computer Society《Guide to the Software Engineering Body of Knowledge》v4.0a（2026-08 釋出，editor: Hironori Washizaki）。全文 411 頁、18 個知識領域（KA）＋附錄 B（ISO/IEC/IEEE 12207 標準地圖）。原始 PDF 置於 `docs/swebok-v4.pdf`（IEEE Computer Society 免費下載物，computer.org/swebok，無散布限制）。
> **讀者**：規劃工廠範圍的人、平台工程師、決定「流程要不要改」的人。
>
> **本文件的性質**：以 SWEBOK v4 作為「一個完整 SDLC 該有哪些流程要素」的對照基準，檢視工廠現有流程的覆蓋度與缺口。**覆蓋度弱不等於必須補**——每一項建議都附「本專案是否適用」的裁適判斷。SWEBOK 是體（body of knowledge），不是強制規範；本文件只引章節號與要點，不重製全文。

---

## 1. 目的與方法

### 1.1 為什麼用 SWEBOK v4 對照

工廠的設計依據目前只有 Gartner G00843405（`00-source-summary.md`）。Gartner 研究回答的是「**agentic AI 該怎麼導入 SDLC**」；SWEBOK 回答的是「**一個完整的 SDLC 本身該有哪些流程要素**」。兩者互補：SWEBOK 提供流程完整性的基準，讓我們能檢查「導入 AI 的過程中，有沒有把某些傳統工程環節整段省略」。

### 1.2 對照單位

- **SWEBOK 側**：18 個 KA（Ch1 Software Requirements、Ch2 Architecture、Ch3 Design、Ch4 Construction、Ch5 Testing、Ch6 Operations、Ch7 Maintenance、Ch8 SCM、Ch9 Management、Ch10 Process、Ch11 Models & Methods、Ch12 Quality、Ch13 Security、Ch14 Professional Practice、Ch15 Economics、Ch16–18 基礎）＋附錄 B。
- **工廠側**：`docs/00–18`、`.dsh/skills/factory-*`（4 個）、`.github/workflows/`（8 個）、`src/`（pipeline/scoring/stop-rules/issue-analysis/model-tier/crosscheck 等）、`catalog-info.yaml`、13 份 ADR、`.github/ISSUE_TEMPLATE/factory-work-item.yml`。

### 1.3 判讀規則

| 覆蓋度 | 意義 |
|---|---|
| **強** | 有專屬機制且實跑驗證過（含對抗性測試） |
| **中** | 有機制但部分環節缺失或未校準 |
| **弱** | 僅提及或僅雛形 |
| **N/A** | 對本專案（內部工具 repo、單人維護、docs-first）不適用——裁適裁掉 |

---

## 2. 工廠 SDLC 現況摘要

```
Request (GitHub Issue)
  │  ① factory-issue-check（格式/DoD/複雜度分析留言）
  ▼
[CI 計分 Gate] 三軸 0–6（業務關鍵性×風險×複雜度，H1–H7 硬規則）
  ├─ 5–6 in-loop ─► blocked-in-loop（不啟動 agent）
  ├─ 2–4 review  ─► 啟動 agent（禁止合併）
  └─ 0–1 on-loop ─► 啟動 agent（符合 §4.1 全部條件才可自動合併）
  ▼
[Model tier 路由]（complexity → chain 迭代）
  ▼
[DSH agent 執行] 讀 Issue → 測試先行 → stacked PR（01-test → 02-impl → 03-docs）
  ▼
[Cross-check G3] report.json ↔ 實際 git diff 交叉驗證
  ▼
[Judge] 終態判定 → [Stop rules SR1–8] → [二次計分（單向升級）] → 合併決策
  ▼
人類審查 → 合併（trunk=software-factory → 人工同步 main）
  ▼
[Observe] defect/escape、defect/review 標籤 → 期檢五問 → 新工作項回流
```

**靜默失敗補強**（`docs/18`）：G1 終態守衛、G2 外部 cleanup workflow、G3 crosscheck 已落地；G4（紅燈證據留存）、G5（DoD 形式檢查）、G6（獨立測試重跑）、G8（requirement→status evidence）為 P2 未實作。

---

## 3. 18 KA 覆蓋度矩陣

| KA | 覆蓋 | 工廠對應機制 | 主要缺口 |
|---|---|---|---|
| **Ch1 Requirements** | 中 | Issue 模板 = acceptance-criteria-based spec（§4.3）、DoD 檢查 | 無 NFR 欄位、無雙向追蹤（G8）、無執行中變更控制、驗證方法單一 |
| **Ch2 Architecture** | 中 | ADR（D1–D13）、in-loop 擋架構變更 | 無架構評估方法（ATAM 類）、無架構審查清單 |
| **Ch3 Design** | 弱 | PR 描述要求「為什麼這樣做」 | 無工作項級設計產物；design rationale 不結構化 |
| **Ch4 Construction** | 強 | TDD、stacked PR、lint、覆蓋率門檻 | 建構標準/建構量測未明文化 |
| **Ch5 Testing** | 強 | 測試金字塔＋對抗性測試＋Quint oracle＋覆蓋率 80% | 無驗收測試層（ATDD）、無非功能測試、無 mutation score、無測試完成準則 |
| **Ch6 Operations** | 弱 | Operate 僅監測＋agent 輔助分析（D5 限制） | 無 rollback runbook、無 incident/change management、無容量/DR |
| **Ch7 Maintenance** | 中 | `agent-fix-bug` 類型、defect 標籤 | 無 impact analysis 步驟、無技術債估算 |
| **Ch8 SCM** | 中 | branch protection、ruleset、stacked PR、required checks | 無版本/釋出管理、無設定稽核（FCA/PCA）、無狀態紀帳 |
| **Ch9 Management** | 中 | 路線圖含出場/放棄條件、閘門、停手規則 | 無估算紀律、無風險登錄（機率×影響）、無 closure review |
| **Ch10 Process** | 中 | 六階段價值流、`08` 指標、季度工作坊 | 未宣告生命週期裁適、無正式 PDCA 循環、指標未接 GQM |
| **Ch11 Models & Methods** | 強 | Quint 形式驗證（Ch11 §4.2）、TDD、stacked PR 增量 | 無 prototyping 方法（不確定需求時） |
| **Ch12 Quality** | 中 | guardrails、defect/escape 標籤、監督查核 | 無獨立 SQA/process assurance、無缺陷特徵化（defect characterization） |
| **Ch13 Security** | 中 | H1–H7 硬規則、security-scan.yml、Dependabot | 無 threat modeling、無漏洞管理流程、無滲透/動態測試 |
| **Ch14 Professional Practice** | 中 | docs-first、PR 審查指引、`07` §6 審查者指引 | 無 agent 行為守則（倫理對應物） |
| **Ch15 Economics** | 弱 | token_budget（未設數值）、每工作項成本指標 | 無成本效益決策流程、無估算方法、無 ROI 評估 |
| **Ch16–18 基礎** | N/A/部分 | Quint 用到形式邏輯；`08` 有量測效度意識（Goodhart） | 根因分析（Ch18 §9）未流程化 |

---

## 4. 已對齊 SWEBOK 的設計（肯定現有，避免改善變破壞）

| 工廠機制 | 對應 SWEBOK 要素 | 說明 |
|---|---|---|
| Issue 模板的驗收條件（DoD） | Ch1 §4.3 acceptance criteria-based spec | 正是 SWEBOK 明列的規格方法之一 |
| 測試先行、`it.skip` 紅燈策略 | Ch4 §4.16 test-first、Ch5 §6.1.2 shift-left | 紅燈驗證在沙箱、綠燈才提交 |
| Quint 正式驗證 | Ch11 §4.2 formal methods（model checking） | 對計分邏輯做狀態空間探索 |
| 三軸計分 = 監督層級 | Ch12 §1.4.2 integrity levels | 以風險等級決定 V&V/監督強度，機制相同 |
| 雙層 guardrail＋停手規則 | Ch13、Ch9 §2.5 | 「碰到即滿分」的硬規則 = 機械化風險判定 |
| 雙軌指標＋成對觀察＋Goodhart 警覺 | Ch9 §6、Ch18 §7 | 量測效度意識比多數同規模專案強 |
| 缺陷標籤（defect/escape、defect/review） | Ch18 §9 RCA 的雛形、Ch12 §2.4.1 | 已具備「合併後缺陷」的追蹤語意 |
| docs-first＋ADR＋PR「為什麼」 | Ch14 §1.8、Ch3 §4.6 | 文件與決策理性有結構化記錄 |
| stacked PR 縮小審查單元 | Ch7 §4.4 CI/CD 精神 | 對應「review 容量是人類的、有限的」警覺 |

---

## 5. 分級改善建議

### 5.1 P0 — 直接強化既有機制（低成本、高價值）

#### P0-1 需求→程式碼可驗證追蹤（G8 落地）

- **SWEBOK 出處**：Ch1 §7.3 Requirements Tracing——「每個需求的設計元素是否存在？每個設計元素是否有需求起因？」雙向追蹤是需求管理的標準做法。
- **現況**：`docs/18` §4 已把 G8（report 無 requirement→status evidence）列為 P2；目前 Issue→PR→測試只靠隱式連結（`Closes #N`）。
- **做法**：`report.json` 增加 `requirements: [{id, status}]`（id = Issue 的驗收條件編號）；`factory-crosscheck` 驗證「每條驗收條件都有對應測試（01-test）與實作（02-impl）且 status 齊全」。
- **裁適**：完整雙向追蹤（含設計元素層）對本專案過重；只做到「驗收條件→測試→實作→狀態」一層即可。

#### P0-2 需求變更控制

- **SWEBOK 出處**：Ch1 §6.2 Requirements Change Control、§6.3 Scope Matching；Ch8 §3 變更控制。
- **現況**：執行中發現需求與 Issue 描述不符時，agent 沒有明確處置規則——可能自行擴大範圍（危險）或亂猜。
- **做法**：`factory-stop-rules` 新增條款：「執行中發現需求與 Issue 不符（缺漏/矛盾/範圍歧義）→ 停手，留言說明差異，貼 needs-human；不自行擴大範圍」。人類可更新 Issue 重跑或開新 Issue。
- **裁適**：不做 CCB 層級的正式變更委員會——單人 repo 用「停手交還」即足夠。

#### P0-3 DoD 具體性檢查（G5 落地）

- **SWEBOK 出處**：Ch1 §4.3 驗收條件必須「可驗證」。
- **現況**：`docs/18` §4 G5——DoD 檢查只驗證 checkbox 字面存在，內容可空泛。
- **做法**：`factory-issue-check` 留言增加「DoD 是否具體可驗證」提示（每條含可觀察結果、無空泛詞彙如「確認沒問題」）。

#### P0-4 觀察期升級為 PDCA + 缺陷特徵化

- **SWEBOK 出處**：Ch10 §3.1（PDCA 是流程改善的基礎典範）、Ch12 §2.4.1 Defect Characterization（分類法＋RCA）、Ch18 §9.2 Root Cause–Based Improvement（六步：選問題→蒐證→找根因→選矯正→實作→觀察）。
- **現況**：`docs/14` 有標籤與兩率；`docs/09` §6 五問是 Check 但**沒有 Act**——改善行動不追蹤、不驗證。
- **做法**：期檢報告模板擴充為：缺陷分類（哪一類：邏輯/契約/測試缺口/環境）→ 根因 → 預防行動（可開成工作項）→ 下期驗證效果。`docs/08` 增「預防行動追蹤」欄位。

#### P0-5 生命週期裁適宣告（ADR-014）

- **SWEBOK 出處**：Ch10 §2.8 Software Life Cycle Adaptation——每個系統都要裁適生命週期並**記錄裁適理由**。
- **現況**：六階段價值流是隱式模型，從未宣告「選了什麼模型、裁掉哪些標準流程、為什麼」。
- **做法**：新增 `docs/ADR/014-sdlc-tailoring.md`，宣告：
  - 生命週期模型：連續交付/lean 六階段（Plan→Create→Verify→Release→Configure→Operate）；
  - 裁適決定：保留哪些 SWEBOK/ISO 12207 流程（測試、SCM 部分、RCA 部分）、委託 agent 哪些（Create、部分 Verify）、人類保留哪些（Plan 決策、高風險設計、架構、事故修復）、**裁掉哪些**（Retirement/Disposal 不適用、正式 CCB 不適用、容量/DR 對內部工具 repo 延後）；
  - 同時修補 `docs/ADR/README.md` 索引缺 011–013 的問題。

#### P0-6 Agent 行為守則文件化

- **SWEBOK 出處**：Ch14 §1.2 Codes of Ethics and Professional Conduct——工程專業要有行為守則；對應到工廠就是「agent 的行為守則」。
- **現況**：誠實報告（`docs/18` §2.3）、不弱化測試（SR6）、不自我驗證（`docs/11` §1.2）分散在四處。
- **做法**：`factory-stop-rules` skill 前言或 docs/ 新章節整合為一份守則：誠實、不越權、揭露不確定、不弱化證據、不自我驗證、停手優於猜測。

### 5.2 P1 — 重要缺口（中等成本）

| # | 改善 | SWEBOK 出處 | 做法 | 裁適 |
|---|---|---|---|---|
| P1-1 | **釋出管理** | Ch8 §6.2 | trunk→main 同步時產 semver tag＋CHANGELOG＋release notes（含 factory 產出清單） | 工具 repo 用輕量版（tag＋changelog 即可） |
| P1-2 | **部署後驗證與 rollback runbook** | Ch6 §3.2–3.3 | 對試點 repo 定義部署後冒煙驗證＋回滾程序（文件級） | 內部工具可先文件化，不需自動化回滾 |
| P1-3 | **驗收測試層（ATDD）** | Ch5 §2.1.4 | add-tests 類型的驗收條件可轉為 acceptance test；模板加「驗收測試命令」欄位 | 視工作項性質，非強制 |
| P1-4 | **架構審查指引** | Ch2 §4.1–4.3 | in-loop 架構變更的人類審查清單（views、significant decisions、替代方案、技術債） | 只適用高風險變更 |
| P1-5 | **自動化決策判定 formal 化** | Ch15 §2、Ch9 §1.2 | 「先問傳統自動化 vs AI」checklist 成為工作項模板欄位（`01` §4.4 的 CBRE 精神） | 用於投放決策，不阻塞 |
| P1-6 | **估算裁適宣告** | Ch9 §2.3、Ch15 §8 | 明示哪些工作項需估算、哪些不需要；高複雜度要求 analogy/decomposition 粗略估算 | 明示「預設不估算」的裁適理由，避免默認 |

### 5.3 P2 — 可選（後續累積）

| # | 改善 | SWEBOK 出處 | 備註 |
|---|---|---|---|
| P2-1 | mutation score 檢查 | Ch5 §4.2.2 | 高風險類別可加；工具 repo 暫緩 |
| P2-2 | 季度設定稽核（FCA/PCA） | Ch8 §5 | 呼應 Q12-1（ruleset JSON 與實際漂移） |
| P2-3 | threat modeling 產出 | Ch13 §4.2 | 高風險 repo 的 in-loop 工作項要求 |
| P2-4 | incident management 流程 | Ch6 §4.1 | Operate 階段擴充（D5 後） |
| P2-5 | 測試 incident 報告結構化 | Ch5 §5.2.5 | defect/review 標籤加結構化欄位 |
| P2-6 | ADR README 索引補齊 011–013 | — | 文件衛生，立即可做 |

---

## 6. 工作類型擴充評估

### 6.1 現況結構缺口

現有四型（`agent-add-tests` / `agent-fix-bug` / `agent-update-deps` / `agent-write-docs`）**全部是「Create 階段、中低風險、產程式碼或文件」**的類型。兩個方向沒有對應類型：

1. **in-loop（5–6 分）高風險工作項**：`docs/06` §4 明定此層級「僅可產出分析與方案，不得實作」——但目前**沒有類型使用這個能力**，高風險工作項直接被 `blocked-in-loop` 擋下，agent 零產出。這是現有設計最浪費的一格。
2. **Plan／Verify 階段**：`docs/00` §3 Phase 2 Step 1 明列的「自動化 code review、spec-driven development」都無對應類型。

### 6.2 候選類型（分級）

#### P0 候選

| 類型 | 內容 | 依據 | 風險 | 拆分 |
|---|---|---|---|---|
| **`agent-analyze`** | 分析/調查，**不產程式碼變更**：bug 重現、根因分析、影響分析、可行性 | `docs/06` §4 in-loop「agent 僅可分析」；`docs/01` §2.6「根因分析 agent 輔助」先例；SWEBOK Ch7 §2.1.3、Ch18 §9、Ch9 §1.2 | **最低**（純報告） | 單層 PR（報告＋建議實作計畫） |
| **`agent-refactor`** | 重構（行為保持）：code smell、取代棄用 API | `docs/00` §3 Phase 2 Step 1 明列；`docs/06` §4.2 on-the-loop 清單；SWEBOK Ch7 §4.2 | 中（動共用抽象→H4→自動落入人類審查） | 01-test（characterization tests）→ 02-impl → 03-docs |

#### P1 候選

| 類型 | 內容 | 依據 | 風險 | 備註 |
|---|---|---|---|---|
| **`agent-security-fix`** | 安全漏洞修補 | `docs/00` §3 Phase 2 Step 1「自動修補安全漏洞」；§9「2028 年修補 70% 漏洞」預測；SWEBOK Ch13 §4.6 | 中高（觸 H1/H3 自動 risk=2→人類審查） | DoD 可要求附 CVE/CWE 引用 |
| **`agent-write-spec`** | 規格/設計草稿 | `docs/00` §3 Phase 2 Step 1 spec-driven development；`docs/01` §2.1「agent 產規格草稿」已合法 | **產出物低／流程位置高**（見 §6.6 第 3 點） | 填補「工作項級無設計產物」缺口；人類審查後才實作；需四護欄 |

#### P2 候選

| 類型 | 內容 | 依據 | 備註 |
|---|---|---|---|
| **`agent-migrate`** | 框架/API/語言遷移 | `docs/06` §4.2「替換已棄用函式/API」 | 範圍大，Phase 3+ 再議 |
| **`agent-release-notes`** | CHANGELOG/release notes 產生 | SWEBOK Ch8 §6.2 | 需先有釋出流程（P1-1），否則無產出對象 |

### 6.3 治理紅線（不該加，明示理由）

| 類型 | 為何不該加 |
|---|---|
| `agent-ci-fix` / `agent-guardrail-update` | `factory-stop-rules` SR3＋H5 明確禁止 agent 改 CI/guardrail/CODEOWNERS/`catalog-info.yaml`——是安全模型核心 |
| `agent-review-own`（自我審查後放行） | `docs/06` §4.3 禁止 agent 驗證自己的產出並據以放行 |
| `agent-architect-decision`（自主架構決策） | `docs/00` §6 把軟體架構列為 human-in-the-loop；agent 只能產草稿（`agent-write-spec`），不能決策 |

### 6.4 新增一型的機械工作清單（已查證接線）

> `test/adversarial/factory-assets.test.ts` 有**兩處釘死「4 型清單」**（下拉選單對應＋模板檔存在性），不是加個選項就完事。

1. `.github/ISSUE_TEMPLATE/factory-work-item.yml` 下拉選單加選項；
2. `.github/factory/task-template-<type>.txt` 新模板（workflow 以 `task-template-${TASK_TYPE#agent-}.txt` 路由，缺檔 fallback＋`::warning::`）；
3. `factory-workflow` / `factory-stop-rules` skill 分支；
4. `test/adversarial/factory-assets.test.ts` 更新兩處釘死清單；
5. `docs/09` §3 2.1 路由說明＋`docs/07` 拆分規則（新類型可能需新拆分：analyze=單層、refactor=三層）；
6. 每型定義：驗收條件模板、模型路由（`config/dsh/model-tiers.yaml`）、試點驗證（比照 Phase 2「實跑驗證」）。

### 6.5 候選類型的評估篩子

每個候選類型都必須通過以下五問（缺一不可）：

1. **Gartner 來源是否明列**為 agent 適合工作（`docs/00` §3 Phase 2 Step 1 清單、`docs/06` §4.2 清單）？
2. **是否有可驗證的驗收條件**（SR4）——「完成 = 可觀察結果」？
3. **風險是否可機械判定**（H-rules 可覆蓋）？
4. **是否適合既有 stacking**（或定義新拆分規則）？
5. **是否違反停手規則與 guardrail 不變量**？

### 6.6 共識修正（2026-09-01，deepseek/Opus5 兩 session 辯論收斂＋實證）

以下四點為 §6 各節的後續修正，與既有內容衝突時**以本節為準**：

1. **計分與任務類型正交（已實證）**：`task_type` **完全不進入計分**——`ScoreInput`（`src/scoring/types.ts`）只有 annotations／changedPaths／changedLines／hardRulePatterns 四輸入。這是刻意設計（§5.1「agent 無權參與判定」的必然結果），不是缺陷。後果：**語意風險類型（如 security-fix）在計分上不可見，類型級限制（docs/06 §4.1 條件清單）是唯一施力點**，不是可選補強。已文件化於 `docs/06` §5.2 註記／§4.1／§8 局限 3（PR #204）。
2. **add-tests 劃界**：add-tests = 為**既有行為**補測試（test-only 單層）；測試必須在既有實作上直接綠燈；若測試揭露既有缺陷（紅燈且非測試自身錯誤）→ 以 `it.skip` 交付（斷言完整保留）＋Issue 留言報告＋建議開 fix-bug 工作項（沿用 fix-bug 機制，不停手）。原「語意雙重性」論述已由「模板與 skill 指令衝突＋計分 risk=0 前提」取代（模板/skill 一致化見 PR #205）。
3. **write-spec 風險重估**：`agent-write-spec` 是「**產出物風險低、流程位置風險高**」——它的語意正確性沒有任何自動機制可驗證（G3 只驗證報告與 diff 一致性，是誠實性檢查非正確性檢查），且錯誤會被下游放大（一份誤解的規格 → 多個正確實作的錯誤東西）。若要做，需四護欄：產出標記 draft、類型級禁自動合併、`spec/approved` 標籤、DoD 含未決事項。
4. **security-fix 語音風險警告**：路徑式 H-rules 對安全類工作是**系統性偏弱**（SQLi 修補可落在 `src/db/query-builder.ts`，不命中任何規則、計分可低至 0–1）；docs/06 §8 局限 3 已誠實揭露。故 security-fix 一律需類型級限制（不得自動合併，無論計分）。

---

## 7. 生命週期裁適宣告（ADR-014 草案）

```markdown
# ADR-014：SDLC 生命週期模型與裁適宣告

- **狀態**：提議中
- **日期**：<合併日>
- **決定者**：平台工程師

## 脈絡
工廠導入 AI 前後從未宣告其生命週期模型。SWEBOK Ch10 §2.8 要求：
每個系統裁適生命週期並記錄裁適理由，否則流程缺漏無法被檢視。

## 決策
採用「連續交付/lean 六階段」生命週期（Plan→Create→Verify→Release→
Configure→Operate，來源 `00` §2）。裁適決定如下：

| SWEBOK/ISO 12207 流程 | 處置 | 理由 |
|---|---|---|
| 需求規格（acceptance criteria） | 保留，agent 輔助草稿 | Ch1 §4.3 |
| 需求追蹤（雙向） | 部分保留（P0-1 一層追蹤） | 過重者裁掉 |
| 需求變更控制 | 保留（P0-2 停手交還） | 不做正式 CCB |
| 設計記錄 | 保留（PR「為什麼」＋P1-4 架構審查） | 工作項級文件不強制 |
| 建構（TDD） | 委託 agent | `00` §3 Phase 2 Step 1 |
| 測試 | 保留＋自動化（金字塔＋Quint） | `11` |
| 釋出管理 | 補強（P1-1） | Ch8 §6.2 |
| 維運/事故 | 人類主責，agent 輔助分析 | D5 |
| 退休/處置（Disposal） | **裁掉** | 內部工具 repo 不適用 |
| 正式 CCB | **裁掉** | 單人 repo，用停手規則取代 |
| 容量/DR | **裁掉（延後）** | 內部工具 repo，Q05-1 精神揭露 |

## 後果
正面：流程缺漏可被檢視；裁適理由有記錄。
負面：宣告後，未宣告的流程缺漏即為已知缺口，不能推說「不知道」。
## 替代方案
- 直接採用 ISO/IEC/IEEE 12207 全流程：過重，不符單人/內部工具情境。
- 不宣告：維持現狀，但流程缺漏無法被討論。
```

---

## 8. 建議的後續工作項

依優先序轉成 factory 工作項（`agent-write-docs` 型為主，P0-1 涉及程式碼則需含測試）：

| 優先 | 工作項 | 類型 | 內容 |
|---|---|---|---|
| 1 | P0-2 需求變更控制條款 | agent-write-docs | `factory-stop-rules` 新增「需求與 Issue 不符 → 停手」條款 |
| 2 | P0-5 ADR-014 裁適宣告 | agent-write-docs | 撰寫 ADR-014＋修補 ADR README 索引（011–013） |
| 3 | P0-6 Agent 行為守則 | agent-write-docs | 整合誠實報告/不弱化測試/不自我驗證為一份守則 |
| 4 | P0-1 G8 落地 | agent-fix-bug 或新類型 | report schema＋crosscheck 驗證（含測試） |
| 5 | P0-3 G5 DoD 檢查 | agent-fix-bug 或新類型 | `factory-issue-check` 具體性提示 |
| 6 | P0-4 期檢 PDCA 模板 | agent-write-docs | `docs/14` 期檢模板擴充 |
| 7 | **新增 `agent-analyze` 類型** | 新工作項（§6.4 清單） | 建議先做：風險最低、填補 in-loop 缺口 |
| 8 | **新增 `agent-refactor` 類型** | 新工作項（§6.4 清單） | 需 characterization test 拆分規則 |

> **新工作類型的順序建議**：先 `agent-analyze`（純報告、機制負擔最小、填補 in-loop 空白），實跑驗證後再 `agent-refactor`；`agent-security-fix` 與 `agent-write-spec` 視需求。

---

## 未決事項

| 編號 | 事項 | 需要誰決定 | 處置 |
|---|---|---|---|
| ~~Q19-1~~ | P0/P1 改善項是否全部採納，還是只採納子集 | 使用者 | ✅ **已裁決（2026-09-01）**：P0 六項全採，P1 逐項後議 |
| ~~Q19-2~~ | 新工作類型先做哪一個（建議 `agent-analyze`） | 使用者 | ✅ **已裁決**：先 `agent-analyze`，實跑驗證後再議其餘 |
| ~~Q19-3~~ | `agent-analyze` 的產出格式（報告＋建議實作計畫？） | 使用者 | ✅ **已裁決**：報告 PR（docs/、單層）＋建議下一步 |
| ~~Q19-4~~ | ADR-014 裁適表中「裁掉」項目是否同意（Disposal、正式 CCB、容量/DR） | 使用者 | ✅ **已裁決**：三項全裁，各附重啟觸發條件 |
| ~~Q19-5~~ | `docs/08` 是否加「預防行動追蹤」欄位（P0-4） | 使用者 | ✅ **已裁決**：追蹤欄位內建於 docs/14 期檢模板；docs/08 只定義衍生指標 |

> 工項清單見 `docs/20-work-items.md`（A1–A7、B1–B2、C1、D1 共 11 項）。本文件的未決事項已收攏至 `docs/10-open-questions.md`。

---

## 參考（SWEBOK v4 章節）

- Ch1 §4.3、§6.2–6.3、§7.3 — 需求規格/變更控制/追蹤
- Ch2 §4 — 架構評估
- Ch5 §2.1.4、§4.2.2、§5 — 測試層級/量測/流程
- Ch6 §3.2–3.3、§4.1 — 釋出/rollback/incident
- Ch7 §2.1.3、§4.2 — impact analysis/重構
- Ch8 §5、§6 — 稽核/釋出管理
- Ch9 §1.2、§2.3、§2.5、§5 — 可行性/估算/風險/結束
- Ch10 §2.6、§2.8、§3 — 生命週期/裁適/PDCA
- Ch11 §4.2 — 形式方法
- Ch12 §1.4.2、§2.4 — integrity levels/缺陷特徵化
- Ch13 §4.2、§4.6 — threat modeling/漏洞管理
- Ch14 §1.2、§1.8 — 倫理/文件
- Ch15 §2、§8 — 決策/估算
- Ch18 §9 — 根因分析
