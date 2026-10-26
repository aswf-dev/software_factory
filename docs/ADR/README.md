# 架構決策記錄（ADR）

本目錄記錄軟體工廠的重要架構決策。每份 ADR 說明**脈絡、決策、後果、替代方案**——特別是**為何未採用替代方案**，因為那通常比決策本身更有資訊量。

## 格式

```markdown
# ADR-NNN：<決策標題>

- **狀態**：提議中 | 已接受 | 已取代（被 ADR-XXX 取代）
- **日期**：YYYY-MM-DD
- **決定者**：<角色>

## 脈絡
<面對什麼問題？有哪些限制？>

## 決策
<決定做什麼？>

## 後果
### 正面
### 負面
### 中性

## 替代方案
<考慮過什麼？為何未採用？>
```

## 索引

| ADR | 決策 | 狀態 | 對應 |
|---|---|---|---|
| [ADR-001](001-github-as-source-of-truth.md) | GitHub 為唯一事實來源，Backstage 為入口 | 已接受（`ADR-027` 提議修訂：新增流程位置分層） | D1 |
| [ADR-002](002-dsh-headless-execution.md) | agent 執行走 DSH headless 一次性呼叫 | 已接受 | D2 |
| [ADR-003](003-stacked-pr.md) | 一個工作項 = 一疊 stacked PR | 已接受 | D3 |
| [ADR-004](004-dual-layer-guardrails.md) | 雙層 guardrail（DSH 層 + GitHub 層） | 已接受 | D4 |
| [ADR-005](005-autonomy-ceiling.md) | 自主性上限設為 on-the-loop 低風險類別 | 已接受 | D5 |
| [ADR-006](006-github-app-identity.md) | agent 以 GitHub App 身分行動 | 已接受 | D6 |
| [ADR-007](007-github-actions-ci.md) | CI 平台採用 GitHub Actions | 已接受 | D7 |
| [ADR-008](008-quint-formal-verification.md) | Quint 正式方法整合（Phase A） | 已接受 | `11-test-strategy.md` |
| [ADR-009](009-backstage-partial-unfreeze.md) | Backstage 局部解凍——factory-work-item 模板作為統一入口 | 已接受 | `14` §1.7 修正 |
| [ADR-010](010-agent-team-tools-deferred.md) | 多 agent 團隊工具（dsh-agent-teams / workflow 工具）延後採用 | 已接受 | `05` §6.1、Q05-5 |
| [ADR-011](011-model-tier-routing.md) | 依 Issue 複雜度分級路由 LLM 模型（model tier routing） | 已接受 | `04` §7、`06` §3.3、Q06-2 |
| [ADR-012](012-guardrail-reference-architecture.md) | Guardrail 集中化架構（消除目標 repo 副本漂移） | 已接受 | `04` §3.2、`factory-issue-check.yml`、`factory-run.yml` |
| [ADR-013](013-trunk-unification-software-factory.md) | factory trunk 統一——機制 repo 也採 software-factory 分支 | 已接受 | `09` §2.2、Q-P2-1、`factory-run.yml` |
| [ADR-014](014-sdlc-tailoring.md) | SDLC 生命週期模型與裁適宣告 | 已接受 | `00` §2、SWEBOK Ch10 §2.8 |
| [ADR-015](015-factory-scoreboard-platform.md) | Factory Scoreboard 管理平台（平台／Astro 前端／設計風格） | 已接受 | `22`、`26`、Q22-1～9 |
| [ADR-016](016-agent-authored-skills-propose-only.md) | agent 撰寫技能——「產出」與「生效」分離 | 已接受 | `25`、`04` §3.2、`05` §1.1、`06` §4.3 |
| [ADR-017](017-backstage-work-item-history.md) | Backstage 解凍擴大——工作項歷史唯讀查閱 | 已接受 | `ADR-009`、`03` §3.4 |
| [ADR-018](018-intent-driven-write-spec.md) | `agent-write-spec` 改為規格書驅動——不變量出自意圖、模型出自程式碼 | 已接受（實作待後續 PR） | `ADR-008`、`21` §2.1、Q21-1／Q21-2 |
| [ADR-019](019-property-based-testing-hegel.md) | 目標 repo 的程式碼層驗證採 PBT（Hegel），以事後稽核工作項執行 | 已接受（實作中，2026-10-05 修訂） | `ADR-008`、`ADR-018` §1、`11`、`research/pbt-library-survey-2026-10`、`research/hegel-ts-pilot-fubon-2026-10` |
| [ADR-020](020-sase-adoption.md) | SASE 方法論的採用範圍與不採用理由（ACE／AEE／LoopScript／CRP 不採用；BriefingScript 增量另開工項） | 已接受（N-version 一列由 ADR-021 取代） | `research/sase-adoption-analysis-2026-10-09`、`10` Q20-SASE-1～3 |
| [ADR-021](021-nversion-parallel-pattern.md) | N-version 平行執行——追認與修正（可選開關、`compare` 為唯一終態寫入者、G1／G2 認終態標記、draft PR 由人選勝者）；附代理設計模式採用邊界 | 已接受 | `ADR-020`、`ADR-010`、`docs/24`、`docs/18`、`docs/26` §3 |
| [ADR-022](022-sequential-stages.md) | 依序模式——以「前置工作項」串接工作項：派工時以即時狀態檢查前置、未完成即停派；完成時刪落選分支並通知下游（aswf.dev webhook 轉送） | 已接受 | `ADR-021`、`ADR-018` §12、`docs/24` §2.1、`docs/32` §4 |
| [ADR-023](023-workflow-process-spec-and-topology-ui.md) | 流程以 `process.yaml` 描述（系統級＋模組級）、拓撲 UI 採 React Flow；OpenRig 僅作參考實作，其 agent 團隊方法論不採用 | 已接受（2026-10-18 兩次修訂）；**將被 `ADR-027` 取代**（提議中），實作凍結 | `research/55-workflow-topology-ui`、`29` §6／§8、`31` §2、`ADR-001`、`ADR-010`、`ADR-022`、`10` `Q-ORCH-1/2` |
| [ADR-024](024-process-execution-semantics.md) | 流程的「執行」語意——UI 產生待開工作項清單，人按下送出；走既有入口，不新增派工路徑 | 已接受；**將被 `ADR-027` 取代**（提議中） | `ADR-023`、`ADR-022`、`29` §1.1／§8、`31` §1、`docs/24` §2.1、`10` `Q-ORCH-3` |
| [ADR-025](025-tenant-process-templates.md) | 多租戶公司流程模板——工廠固定 meta-contract，租戶擁有自己的模板（版本化、釘版本）；自訂 gate 以 `<TENANT>-<NAME>` 命名；`scale` 與模板脫鉤；S/M/L 降為 preset | 已接受；模板格式將被 `ADR-027` §9 取代（提議中） | `ADR-023`、`ADR-024`、`29` §6／§8／§9、`10` `Q-ORCH-4/5` |
| [ADR-026](026-project-owned-process-spec.md) | 系統流程 spec 歸專案所有（`factory/system.yaml`）；機制 repo 只保留納管名冊與規則，讀取時驗證；揭露 public 機制 repo 使租戶隔離失效（模板與快照可匿名讀取） | 已接受（實作待遷移）；檔案格式將被 `ADR-027` §9 取代（提議中） | `ADR-023` §1、`ADR-025`、`ADR-001` |
| [ADR-027](027-bpmn-process-orchestration.md) | 以 BPMN 編排系統價值流——GitHub 管事實、Durable Object 管流程位置；人按送出才派工；工作項＝工廠擁有的子流程；HG 為 message catch、以本人身分在 GitHub 簽核；模板／系統／模組全部以 BPMN XML 為正本；process.yaml 只往前刪除 | 提議中 | `ADR-028`、`research/56-bpmn-orchestration`、`ADR-001`、`ADR-022`～`ADR-026` |
| [ADR-028](028-bpmn-runtime-stack.md) | BPMN 執行技術選型——bpmnkit 全環境使用（編輯器／檢視器／linter／模擬／執行）、DO 以事件日誌為準並重播恢復、FEEL-only、與 Scoreboard 同 Worker、WebSocket Hibernation、PITR 備援、引擎升級重播閘門；附 PoC 驗收標準 | 提議中 | `ADR-027`、`research/56-bpmn-orchestration`、`ADR-015` |

## 何時該寫新的 ADR

- 決策會影響多個模組或平面
- 決策難以逆轉，或逆轉成本高
- 曾認真考慮過其他選項
- 未來的人可能會問「當初為什麼這樣做？」

反之，可逆的、局部的、顯而易見的決定不需要 ADR。
