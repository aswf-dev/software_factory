# SASE 方法論採用範圍分析

> **問題**：arXiv 2509.06216v3《Agentic Software Engineering: Foundational Pillars and a Research Roadmap》提出的 Structured Agentic Software Engineering（SASE），其雙工作臺（ACE／AEE）與六類 artifact（BriefingScript／LoopScript／MentorScript／CRP／MRP／VCR）是否有必要整合進 `aswf-dev/software_factory`？
> **查證日期**：2026-10-09
> **判準**：已觀測痛點驅動（見 §1.1）。**不採用**「框架完整度」作為判準。
> **對應決策**：`ADR/020-sase-adoption.md`

---

## 1. 結論摘要

### 1.1 判準與證據分級

「有必要」的定義是：**該機制能關閉一個已有觀測證據支持的缺口**。「論文說應該有」本身不構成理由。

| 等級 | 證據類型 | 效力 |
|---|---|---|
| **E1** | 已完成根因調查的具名事件（`docs/research/228` 等） | 最高 |
| **E2** | 具名實證事件，有前後對照（`Q07-2`、`Q12-4`、`Q12-5`） | 高 |
| **E3** | 現行手段的結構性事實（crosscheck mismatch 種類、`memory`／`trace` ABSENT） | 中（是機制缺口，非已發生事故） |

### 1.2 總結論

**SASE 不應作為方法論整合進本專案。** 三個理由，依重要性排序：

1. **多數 SASE 機制在工廠已有功能對應物**，且差距主要在**型態**而非**有無**（§2.1）。同時工廠在**機械可判定性**上明顯超前：三軸監督評分有形式化模型與模型檢查、`report.json` 對 git diff 有獨立交叉驗證、驗收項目有 `REQ-N` 覆蓋檢查——**這些 SASE 全篇未提**（§2.3）。
2. **SASE 重頭戲的核心主張已被非 SASE 的手段達成**。LoopScript 主張「依任務宣告嚴謹度」，而工廠已用 `task_type` ＋ `risk-paths.yml` H1–H7 ＋ 三軸評分 ＋ `model-tiers.yaml` ＋ ADR-011 逾時宣告達成；最大單筆全損（50 分鐘／19.4M token／USD $0.306／0 commit／0 PR）**是靠宣告修好的**（`ADR-011` L51–55）。
3. **證據反駁了兩個候選缺口**。CRP 的前提是「agent 停手品質不足」，但兩次自然停手都被判定**誠實且正確**，而唯一的重建成本事件（#199）根因是 `apply-judge-labels` 的**契約缺口**，不是徵詢格式。N-version 則無成本基線可評估。

**但 SASE 有兩個主張通過了判準**：BriefingScript 指向的**工單精確性**（有 E1 級證據），以及 MRP 指向的**證據保存期限與凍結追溯**（有 E1 級證據，但部分已由 `docs/18` G4／G6 涵蓋）。

### 1.3 逐項裁決一覽

| SASE 項 | 裁決 | 決定性依據 |
|---|---|---|
| ACE 雙工作臺 | **不採用** | `Q03-6` 已裁決 Backstage 降級凍結（`docs/10` L113）；單人環境無 N-to-N 使用者 |
| AEE／ATIE agent-native 工具鏈與 MCP | **不採用** | repo 零 MCP；無證據顯示 grep／文字搜尋造成失敗 |
| 論文研究議程與教育章節（§7.6、§3.3） | **不採用** | 非生產系統範圍 |
| N-version 平行多版本 | **不採用** | token 預算門檻仍為 0＝不設限（`docs/10` L82）；成本基線不存在；Anthropic 429 為既有外部限制（`docs/13` L61） |
| LoopScript | **不採用** | 核心主張已由非 SASE 手段實現（見 §1.2 理由 2）；編排重複列為**工程觀察** |
| CRP | **不採用**，隨 `ADR-010` 觸發條件一併重啟 | §2.2（A）——證據反駁其前提 |
| BriefingScript | **方向接受**，實作待另案開單（規格見 `ADR/020` §3） | §2.2（BriefingScript）——有 E1 證據 |
| MentorScript | **延後**，併入 ATLE 觸發條件 | 增量＝規則**內容**驗證；現行替代＝`docs/25` skill 撰寫迴圈 |
| MRP | **部分已涵蓋**：引用 `docs/18` G4／G6 不重複開單；只為**保存期限與凍結追溯**新增觸發條件 | §2.2（MRP） |
| ATLE 持久記憶 | **延後**，綁 `docs/25` 迴圈人工負荷 | §2.2（D）——有重複性 E1／E2 證據 |

---

## 2. 證據與根因

### 2.1 對照總表：SASE 機制 vs 工廠既有實作

| SASE 機制 | 工廠既有實作 | 型態差距 |
|---|---|---|
| **BriefingScript**（五段：Goal&Why／Success Criteria／Context／Blueprint／Validation Loop） | Issue Form 的 `需求描述（PRD）` 四段 ＋ `驗收標準（DoD）` 三必勾 ＋ `前置工作項` ＋ `spec_name`／`spec_source`（`.github/ISSUE_TEMPLATE/factory-work-item.yml`）；`REQ-N` 驗收編號（`docs/32` L72）；形式化規格 `specs/<name>/*.qnt`；11 個 `task-template-*.txt` | **最小**。已有機器可讀欄位與形式化規格；缺「不變量」與「已知問題」子段，DoD 具體性檢查目前只是**建議**（`src/cli/factory-issue-check.ts` L659–663） |
| **LoopScript** | `.github/workflows/factory-run.yml`（1,332 行）＋ `src/pipeline/run-work-item.ts` Gate 1–5 ＋ `task_type` ＋ `risk-paths.yml` ＋ 三軸評分 ＋ `model-tiers.yaml` ＋ `ADR-011` 逾時宣告 | 流程是**寫死的 shell**，非可宣告組裝的 playbook；且編排**重複實作**兩份（workflow 與純函式） |
| **MentorScript**（可 lint／可測試／可衝突檢測的規則庫） | 8 個 `.dsh/skills/*/SKILL.md` ＋ `config/factory/skills-lock.json`（sha256 ＋ `onlyFor`）＋ `docs/25` 撰寫迴圈 ＋ `ADR-016` propose-only | 內容是**散文**；雜湊只鎖版本，**不驗內容**；無「決策→規則」追溯 |
| **Merge-Readiness Pack** | `report.json` ＋ `judge.json` ＋ `crosscheck.json` ＋ `usage.json` ＋ `factory-run-<issue>` artifact bundle ＋ PR body 模板（`docs/07` L262–274） | 證據**分散**；`report.json` 的 zod schema **無 `evidence` 欄位**；無 trajectory／agent-turn trace 模組；**artifact 會過期**（`docs/25` L160） |
| **Consultation Request Pack** | `needs-human` 標籤 ＋ SR1–SR8 ＋ `openQuestions[]` ＋ `skillGap` ＋ Issue 留言 | **無結構化請求 artifact**。但見 §2.2（A）：證據不支持這是缺口 |
| **Version Controlled Resolution** | PR 核准 ＋ `spec/approved` ＋ `factory/approved` 標籤 ＋ HG0–HG7 人類閘門（`docs/29` L258–274） | 無「與請求相連」的裁決 artifact；但 `spec/*` 標籤流已具備兩階段人類裁決的形狀 |
| **ACE／AEE 雙工作臺** | Backstage（設計入口，已裁決降級凍結）＋ DSH headless ＋ sandbox | 方向一致；ACE 部分已被判定「維運負擔不值得」（`Q03-6`） |
| **ATLE／ATIE** | `memory` 概念 **0 個程式碼命中**；`trace` 僅 Quint 反例；MCP **全無** | 硬缺席，非型態差異 |

### 2.2 逐項證據

#### （A）CRP：證據反駁其前提

SASE 主張 CRP 是為了「讓 agent 能結構化地請求人類專業」。查證結果：

- **沒有**任何「agent 停手但講不清楚」的觀測實例。兩次自然停手被明確判定為正確行為：`docs/15-observation-trial-log.md` L148「**價值案例（兩次誠實停手，SR4 真實運作）**」；L149「agent **未猜測、未硬寫必紅測試、未動程式**，依 SR4 停手等裁決」；`docs/13-phase1-acceptance.md` L35「#11 … 誠實停手：邊界測試已存在（mutation 驗證），正確」。
- 唯一的「重建成本」事件是 #199：`docs/research/228-post-stop-ready-for-review-root-cause.md` L190–192「最後一則留言貌似權威終態…實際指向一個不存在的 PR——「ready-for-review 卻無東西可審」；需要回溯讀前一篇自由文字才能重建真相」。但該檔 L18 已明確定位根因：「**這是流程缺陷（契約缺口）**…不是計分誤判」。**修法是 code ＋ contract，與徵詢格式無關。**
- 交接格式要求確實存在（`docs/07-stacked-pr-workflow.md` L225–243：原因／已完成／衝突內容／建議下一步／執行紀錄），但 `docs/15` L54 顯示**四個格式 mutant 全部存活**測試套件——「對「格式」完全沒有牙齒」。也就是說：**格式不良的交接不會被觀測到，而是不會被偵測到**；這與 CRP 要解決的問題方向相反。
- `needs-human` 的量：`docs/research/230-warp-deepwiki-adoption-analysis.md` L65 記載 6 筆。
- CRP 的 N-to-N 面向在本 repo 無使用者：`Q12-4` 記載「單人 repo 無第二雙眼睛」。

**根因**：CRP 是多角色**路由**機制（把請求送給對的專家人類）。在單人、單 agent 的現況下沒有路由對象；它是 N-to-N 協作的前置機制，而 N-to-N 已由 `ADR-010` 延後（觸發條件現況 1/3）。

#### （B）MRP：證據最強，但部分已有歸屬

- `docs/ADR/011-model-tier-routing.md` L16：「每次嘗試覆寫同一個 `stderr.txt`，opus-5-5 的真實錯誤行已遺失，**該次失敗的確切原因無法回溯**」（run 36838600120，2026-10-02，fubon-tradingbot#625）。
- `.factory/skill-gap-recovery/camunda_hazelcast-25.md` L3–6：「run `34371349788`…與 `34372193923`…皆因 judge/labels 步驟失敗…`apply-judge-labels` 未執行 → 兩則技能缺口**從未出現在本 Issue**…僅存在於 Scoreboard 事件與 run artifacts（`factory-run-25`，`expires_at: 2026-12-08`）」。同型事件在 `software_factory-287.md` L3–5 再次發生（run 34731487680）。
- `docs/25-skill-authoring-loop.md` L160：「Run artifacts | **會過期（~90 天）**」。
- `docs/18-silent-failure-hardening.md` L20：「report.json 是 agent 自報；judge 的 zod 只驗證形狀、不驗證真實性」；L111–112：「**攻擊路徑不是回報假數字，而是根本不填**」。
- `docs/15-observation-trial-log.md` L159：試點 #2／#3 的 `factory/*` PR「只有 agent 自報測試、無獨立 CI 驗證」；L169「**教訓**：agent 自報「測試全綠」≠ CI 綠燈」。
- `docs/25` L194–197：`claude-opus-5` 兩次「**自創 report 欄位**…並**漏填 `requirements`**」，一次觸發 crosscheck `requirements-missing` 而失敗。

**但**：`docs/18` 已獨立識別兩個未關項——L155（G4）「紅燈是 TDD 的關鍵證據，absence 沒有成為 evidence」；L157（G6）「若 target repo 無 CI 覆蓋 factory 分支，「tests pass」只有 agent 自述」。**「證據的真實性」已由 G4／G6 涵蓋**，重複開單只會製造同一件事兩張單。

SASE 真正新增的部分是**保存期限與凍結追溯**（versioned links 到 BriefingScript／MentorScript／工具／trajectory，以保證可重現）：G4／G6 不論及「證據會不會消失」，而上述兩個 E1 事件的核心痛點正是「**唯一證據只存在於會過期的 artifact**」。故只為此新增觸發條件。

#### （C）MentorScript：多發性證據，但已有替代機制

SASE 主張規則應「可 lint、可單元測試、可衝突檢測」。工廠現行機制的實際失效清單（**全部是規則／文件／設定文本與現實不符**，非 stop rule 語意錯誤）：

| 事件 | 引註 |
|---|---|
| CI 鎖定的 gh-stack v0.1.0 不接受 skill 教的 `--numbered`／`--prefix`，agent 被迫自創分支名 | `docs/15` L130（`Q07-2`） |
| 「留言建議與實際路由永不打架」——**該條文本身是錯的**（fubon#611 建議 high，實跑 critical） | `docs/ADR/011` L40 |
| 拒絕措辭清單不含 `usage policy|refus|declin` → 被分類為 agent-error，chain 其餘三項**一項都沒試即交還人類** | `docs/ADR/011` L20（run 37419721657） |
| 「流程裡**沒有合法的執行者**」→ fubon#654 依 Issue 修改兩支 PBT 檔，11 分鐘產出被 crosscheck 以 `pbt-outside-audit` 全數交還人類 | `docs/30-pbt-audit-runbook.md` L131、`docs/ADR/019` L259（run 37422161781） |
| yml L690–693 註解說「逾時改為沿 chain 升級」，**與實際行為不符** | `docs/research/337-model-chain-stop-reasons.md` L9 |
| G3 的「已修」**曾經只修了一半**，且被記成已修 | `docs/18` L22–26 |
| 記載 crosscheck「額外校驗 frontmatter 合法」——實際上只比對路徑；「記在同一格會讓『已經有人查過內容了』成為錯誤的安全感」 | `docs/25` L268–273 |
| skill 派送是裸 `cp -r`；「若這份 copy 不完整或機制 repo 誤刪某個 SKILL.md，**agent 會安靜地在缺少 `factory-stop-rules` 的情況下執行**」 | `docs/25` L100–101 |
| SKILL 的可見性強度**取決於模型**：claude 家族在 4 次可回報情境中 0 次填寫；「模型換了，訊號就沒了，而且**沒有任何紅燈**」 | `docs/25` L177–197、L208 |

**根因**：`skills-lock.json` 只鎖 sha256，所以「檔案內容本身是錯的」完全通過驗證。這是 SASE「MentorScript 要可測試」主張在本 repo 的實證支撐。

**但結論不是「導入 MentorScript」**：`docs/25` 的 skill 撰寫迴圈**已經是內容錯誤的偵測器**（T1／T2／T3 偵測、≥3 次門檻、7 項 promote checklist），只是靠人驅動。所以由 SASE 帶來的增量是「把人工迴圈機械化」，也就是把 `docs/25` 的檢查變成可執行的規則驗證——**與 ATLE 的增量是同一件事**。故兩者合併為一條觸發條件。

#### （D）ATLE：重複性證據充足

| 重複模式 | 引註 |
|---|---|
| 同型終態衝突**兩例**，#11（2026-08-18）與 #199（2026-09-01）；「凡 agent 依 skill 第 8 條…停手，**100% 復發**」 | `docs/research/228` L205–207；L37「**非孤例**」 |
| 同一個 add-only 標籤缺陷兩度發生（#571、#199） | `docs/15` L153、`docs/research/228` L59 |
| 同一缺口、同一 Issue、**相隔 6 分鐘**的兩次 run：「兩者為**同一缺口的同義異名**…應合併為 1 個 category × 2 次」 | `.factory/skill-gap-recovery/camunda_hazelcast-25.md` L11–14 |
| 同一模型行為兩次（opus 自創 report 欄位、漏填 `requirements`） | `docs/25` L194–196 |
| 同一失效模式在**兩個 repo**（camunda 2026-09-09、software_factory 2026-09-13） | 兩份 `.factory/skill-gap-recovery/*.md` |
| 同一跨 session 失效：「上輪查過」不算數（兩個 session 用舊資訊宣稱分支歸屬） | `docs/15` L232–236 |

**根因**：目前唯一的「記憶」是 `docs/25` 的人工迴圈加 `skills-lock.json`。它可以運作，但需要人類把每次停手轉成提案、再審核生效。

#### （E）BriefingScript：有 E1 證據，指向工單欄位

- `docs/15-observation-trial-log.md` L150–152：人類寫的驗收標準**數學上不可能滿足**；教訓為「**人類側的『已修正』須驗證生效**（grep 確認）」。→ **人類的 brief 本身就是缺陷來源。**
- `.factory/skill-gap-recovery/camunda_hazelcast-25.md` L27：「前次 run（`#34371349788`）已因相同原因停手並貼 needs-human，**DoD 仍未補專有驗收條目**」。→ **DoD 缺漏 → 同一缺口反覆停手。**
- `docs/14-observation-period.md` L71–80：「180 顆合併 PR，`defect/escape` 與 `defect/review` 皆為 0 筆…**判讀為「感測器未運作」而非「品質良好」**」。→ 驗收端感測器失效。
- `docs/15` L163：「agent 沒做錯，是**流程規格缺口**」（TDD 先紅 × stacked PR 每層獨立綠燈）。

**現行機制的實際強度**：`factory-issue-check.ts` 的 `VAGUE_TERMS`（L104–120）、`OBSERVABLE_PATTERNS`（L126–131）、`checkDodSpecificity`（L196–206）**已存在**，但輸出是**建議**，不影響 `ok`（L659–663 的 `ok` 只看 `missing`、`spec.errors`、`pbtAudit.errors`、`pbtOutsideAudit`）。因此「DoD 必須可驗證」目前**沒有牙齒**。

**SASE 的貢獻**：把「成功判準必須可驗證」與「不變量」變成 brief 的結構性欄位——這與工廠既有的 `REQ-N`、ADR-018 的 `INV_*`、`specs/*.qnt` 同方向，只是工單層還缺。

#### （F）LoopScript：核心主張已達成

- 最大單筆全損：`docs/25` L219–222「50 分鐘、19.4M token、USD $0.306 全損…**那段發現連同整場產出一起消失**」；`docs/ADR/011` L51「Agent 在 50 分鐘內重寫模型 4 版、起停 10+ 個 Apalache job，最後卡在 `state 8/12` 被 step timeout 砍掉——`0` commit、`0` PR、`0` bytes stdout」。
- **修法不是引入 LoopScript，而是宣告**：`docs/ADR/011` L53–55「heavy-verify → 110 分、critical → 70 分、其餘 → 50 分」。
- 其餘成本事件也都靠既有宣告與分類處理：run 36838600120（L16「opus-5 佔該單成本 **91%**」）、run 37419721657（L20）、`docs/research/337` L9–10（逾時語意缺陷）。

**根因**：LoopScript 的**目的**（依任務分量決定嚴謹度與資源）已由 `task_type` × `risk-paths.yml` × 三軸評分 × `model-tiers.yaml` × ADR-011 逾時宣告共同實現。剩下的差距是「可宣告組裝」——即把 1,332 行 shell 與 `runWorkItem` 純函式的**編排重複**收斂。那是工程整潔度問題，且**沒有任何觀測事故歸因於「不夠宣告式」**（#199 是 report schema 契約缺口；`Q12-5` 是設定套用問題）。故列為工程觀察，不列方法論缺口。

#### （G）N-version 與 ACE／ATIE

- N-version 無成本基線：`docs/10-open-questions.md` L82「**實際門檻值仍待基線數據後設定**（預設 0 = 不設限）」。在 token 預算未設限的情況下，平行多版本無法評估成本。
- Anthropic 429（`docs/13` L61）已是既有外部限制，平行化會加劇。
- ACE：`Q03-6` 已裁決 Backstage 降級為純 GitHub 觸發、工件凍結（`docs/10` L113）。SASE 的 ACE 會逆轉該決策，且本 repo 無 N-to-N 使用者（`Q12-4`）。
- ATIE／MCP：repo 零 MCP（無 `.mcp.json`，`config/dsh/` 無 MCP 設定）。無證據顯示文字搜尋造成失敗。

### 2.3 反向對照：SASE 未涵蓋而工廠已有

這一節是「為何未採用」的核心論證：**SASE 全篇未提這些機制，而工廠已在運作**。

| 工廠機制 | 引註 |
|---|---|
| 三軸監督評分為**機械可判定閘門**，且有形式化模型 ＋ Apalache 不變量驗證 ＋ TS↔Quint oracle test | `src/scoring/`、`specs/scoring/score.qnt`、`test/quint/scoring-oracle.test.ts`、`ADR-008` |
| `report.json` 對 git diff 的**獨立交叉驗證**（`no-trace`、`unreported-changes`、`reported-not-in-diff`、`assertion-delta-*` 等 mismatch kinds） | `docs/18` L60–138、`src/cli/factory-crosscheck.ts` |
| `REQ-N` 對 `requirements[]` 的覆蓋檢查 | `src/cli/factory-issue-check.ts` L258–260、`docs/32` L72 |
| SR1–SR8 stop rules（agent 唯一的合法退出路徑） | `.dsh/skills/factory-stop-rules/SKILL.md`、`docs/04` L287 |
| 雙層 guardrail（DSH 層 ＋ GitHub 層） | `ADR-004`、`config/dsh/factory-guardrail.patch.yml` |
| **10 個模組要求 100% 分支覆蓋率**（scoring／stop-rules／pipeline／cli／model-tier 等） | `vitest.config.ts` L11–105 |
| `skills-lock.json` 雜湊鎖版 ＋ `--verify` fail-closed | `config/factory/skills-lock.json`、`src/cli/factory-skills-lock.ts` |
| G1 terminal-state guard（任何先前步驟崩潰即回填 `needs-human`） | `docs/18` |
| 版本鎖定與 `pnpm audit --audit-level=high` 進 CI 閘門 | `.github/workflows/test.yml` |

**含義**：若以「框架完整度」為判準，會得出「工廠缺 6 項 SASE 機制」的結論；但同一份對照顯示**SASE 也缺 9 項工廠機制**，其中包含本專案最核心的信任來源。判準若不是「已觀測痛點」，這個對照會系統性偏向論文。

### 2.4 證據限制

撰寫本文件時刻意標註的限制——**這些限制本身即是文件可信度的一部分**：

1. `docs/25` L148–151 的跨 run cluster 計數（`monorepo-test-path` 4 次等）**未經獨立複驗**：同批字串被用作測試 fixture（`src/skill-gap/render.test.ts` L15–46），且本機無 Scoreboard 資料可交叉核對。本文件**不以該數字作決策依據**。
2. `docs/18` L174–175 自述：「**G1/G2/G3 的實機行為…尚未實跑驗證**」。
3. `docs/18` 的 G3 mismatch kinds **沒有任何一件被歸因到實際事故**——G3 的動機是外部稽核（`docs/18` L3–6），不是本 repo 事故。故 §2.2（B）引用的是「機制缺口」，不是「已發生造假」。
4. §2.2（A）的結論是「**沒有**證據」，不是「證據顯示良好」。交接格式 mutant 全部存活（`docs/15` L54）意味著**不良交接不會被觀測到**；這是觀測能力的限制，非品質的保證。
5. `docs/24` L152–153 的「交接後上下文遺失」是**未經驗證的引用主張**，非本 repo 觀測。
6. 本文件全部引註取自 repo 內既有文件與程式碼；未執行新的實機實驗。

---

## 3. 影響範圍

### 3.1 若不導入（本文件建議）

| 面向 | 影響 |
|---|---|
| 不一致風險 | 無。維持 `docs/00` 的單一凍結依據 |
| 未解缺口 | 3 個，全部轉為可觀測觸發條件（見 §5）：記憶／規則內容驗證、證據保存期限與凍結追溯、本決策自身重啟 |
| 已知殘餘 | `factory-run.yml` 與 `runWorkItem` 的編排重複列為**工程觀察**（不建 trigger，因為無事故歸因） |
| 外部對話 | 可透過 `docs/GLOSSARY.md` §10 的單向對照進行，不需要改動任何設計文件 |

### 3.2 若導入（成本，作為對照）

- 詞彙斷裂：`docs/00`（Gartner 四支柱）與 SASE（actors／processes／tools／artifacts 四支柱）**沒有血緣關係**，並存會製造雙詞彙體系，違反 `docs/00` §8「後續文件一律回指本節次」的規則。
- 逆轉既有裁決：ACE ← `Q03-6`；多 agent／CRP ← `ADR-010`；自主性上限 ← `ADR-005`。
- 成本衝突：N-version ← token 預算未設限（預設 0）＋ 429 限制。
- 工程面：`factory-issue-check.ts` 的 `FIELD_TITLES`／`DOD_LABELS` 被**4 處逐字釘住**（Issue Form、issue-check、`src/factory-draft/issue-body.ts`、Backstage template）＋對抗性測試；`ADR-019` R3（L245）已實測「新增表單欄位要同步 6 處（含 aswf.dev）」。

---

## 4. 方案比較

| 選項 | 內容 | 為何採用／不採用 |
|---|---|---|
| **A（建議）** | 不導入；SASE 僅作對照組。三個缺口轉觸發條件；BriefingScript 增量的規格記於 ADR-020 §3（尚未開單） | 唯一同時滿足「已觀測痛點判準」與「不製造雙詞彙」的選項 |
| B | 全面導入 SASE（ACE／AEE ＋ 六類 artifact） | 與 `Q03-6`、`ADR-005`、`ADR-010` 直接衝突；多數機制已有對應物 |
| C | 以 SASE 取代 Gartner 作為框架來源 | 三軸評分與監督分級在 Gartner 監督三軸上有直接血緣，換掉等於重做地基 |
| D | 全部不採用，且不留對照與觸發條件 | 省成本，但失去外部文獻對話能力，且同一問題會被重新提起（`docs/research/` 已有一份未被任何文件引用的同型提案） |
| E | 把 AIDLC 提案一併納入分流 | 範圍較大；本次使用者裁決只評 SASE，故不納入（見 §5 註） |

---

## 5. 建議下一步

1. **作出裁決並記錄**：`ADR/020-sase-adoption.md`（狀態：已接受），含逐項裁決表、三條觸發條件，以及「SASE 未涵蓋而工廠已有」專節。
2. **建立詞彙對照**：`docs/GLOSSARY.md` 新增 §10，單向對照（工廠用語 → SASE 用語），並明寫「不作為設計依據」。
3. **登錄觸發條件**：
   - `Q20-SASE-1`（ATLE ＋ MentorScript 增量）：同一缺口類別跨兩個觀察期未收斂，或人工提案處理量超過協商門檻 → `docs/10` §1.3
   - `Q20-SASE-2`（MRP 保存期限與凍結追溯）：再次發生「失敗原因無法回溯」或「證據僅存於會過期的 artifact」 → `docs/10` §1.4
   - `Q20-SASE-3`（本 ADR 自身重啟）：出現公開 SASE 實作案例、或論文修訂／正式發表 → `docs/10` §1.4
4. **做工單精確性**（唯一通過判準且有實作價值的增量）：**規格已記錄於 `ADR/020` §3，尚未開單。** 三項增量——可驗證 DoD 硬閘門（把既有建議升級為影響 `ok`）、`不變量：` PRD 子段、`已知問題 / 專有驗收條目：` PRD 子段。**全部落在既有 PRD textarea 內，不新增獨立表單欄位**（依 `ADR/019` R3 先例）。開單與否由使用者決定；本階段的分析交付止於此。
5. **不做事**：`docs/00` 零改動（Gartner 凍結依據）；`mkdocs.yml` 零改動（`docs/research/**` 依慣例不入 nav）；`docs/research/awslabs:aidlc-workflows-integration-2026-10-08.md` 維持現狀。

> **AIDLC 註記**：`docs/research/awslabs:aidlc-workflows-integration-2026-10-08.md`（2026-10-08）是同型提案，但**未被任何文件引用、無 ADR、無工項**。本文件不處理它（範圍裁決），僅記錄此結構性事實：repo 目前沒有「外部方法論提案」的通用分流機制，本 ADR 是第一次。若日後要建立該機制，應另開工項，不併入本決策。

---

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q20-SASE-1 | ATLE 持久記憶（含 MentorScript 規則內容驗證增量） | 列觸發條件，見 `ADR/020` 觸發條件節 |
| Q20-SASE-2 | MRP 證據保存期限與凍結追溯 | 列觸發條件，見 `ADR/020` 觸發條件節 |
| Q20-SASE-3 | 本決策自身的重新檢視 | 列觸發條件，見 `ADR/020` 觸發條件節 |

> 本文件的未決事項已收攏至 `docs/10-open-questions.md`。
