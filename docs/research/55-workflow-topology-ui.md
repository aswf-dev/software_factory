# 55 — 流程拓撲 UI 與 process spec（工單編排的呈現層）

> **狀態**：研究／設計草案（2026-10-18）。**未實作任何程式**。
> **讀者**：要「用 UI 制定工廠流程」的人、要實作 v1 的人、要審查 `ADR-023` 的人。
> **關聯**：`ADR-023`（本文件的決策）、`ADR-001`（GitHub 唯一真相）、`ADR-010`（多 agent 團隊工具延後）、`docs/24`（複合風險治理）、`docs/29`（棕地導入）、`docs/31`（方法論入口）。

---

## 0. 一句話結論

工廠缺的不是「更聰明的 agent 編排」，而是「**流程本身可被看見、可被 diff、可被審查**」的呈現層。做法是把某個系統實際採用的流程寫成 `process.yaml`（**實例**，不是方法論），用 **React Flow** 畫成拓撲圖；OpenRig 的 TUI 值得當視覺與互動的參考實作，但**它的 agent 團隊方法論不採用**。

---

## 1. 問題與範圍

### 1.1 三個缺口

1. **流程狀態不可見。** `docs/29` §8 的 HG0–HG7 簽核記錄在「導入追蹤 Issue」的勾選清單裡（`docs/29-brownfield-adoption-playbook.md:257`），而 `src/`、`.github/`、`backstage/` 對 `HG[0-9]` **零引用**——沒有任何程式讀它、驗它、或把它畫出來。
2. **「模組」是未定義的原語。** `docs/29` 全篇以模組為單位（就緒度、P2–P4 關卡、核心模組、驗證閘門），但 `docs/GLOSSARY.md` 只在解釋「就緒度」時提到它（`GLOSSARY.md:86`），從未定義邊界與識別方式。要畫節點，第一個卡點就是「節點是什麼」。
3. **順序已有機械實作，但人看不到。** `ADR-022` 用「前置工作項」串接（`factory-run.yml:294-327` 派工前檢查），完成後留言接力，但**明文不自動派工**（`factory-stage-finalize.yml:15`）。也就是說：機器知道 A 擋住 B，人只能從 Issue 留言推敲。

### 1.2 本文件回答什麼

- 如何用 UI「制定」流程，且產物**可版控、可審查**（§6、附錄 A）。
- 拓撲圖的技術選型：React Flow／Rete.js／LiteGraph.js（§4）。
- 「模組」如何在圖上被穩定識別，並與就緒度／HG／驗證閘門對齊（§3）。

### 1.3 本文件不回答什麼

- 不做 OpenRig 的功能完整評估（僅 §5 的參考實作觀察）。
- 不裁決 `docs/29` Q29-4（規模與就緒度是否機械化為 catalog 標註）。
- 不定 v1 的實作排程與工時。

---

## 2. 證據等級

**本文件未實跑任何東西。** 證據來源：

| 等級 | 來源 | 用途 |
|---|---|---|
| A（可重現） | 本 repo 的檔案與程式碼，附 `file:line` | 工廠現況、判定邏輯、現有閘門 |
| B（原始碼） | OpenRig tag `v0.6.10` 的原始碼與官方文件頁 | §5 的機制描述 |
| C（推導） | 由上兩者推出的架構判斷 | 標註 `UNCONFIRMED` 者即屬此級 |

標記規則：**任何未經實跑驗證的行為敘述，一律標 `UNCONFIRMED`**。本文件中沒有「我試過」的敘述。

外部來源版本註記：OpenRig 官方文件頁自稱 "Documented against 0.6.6"，評估基準釘在 tag `v0.6.10`；撰寫時 `v0.6.11`（2026-10-17）已發布，僅作「發版節奏」的證據引用。

---

## 3. 模組定義草案

### 3.1 現況：三種互相衝突的語意

| 出處 | 暗示的語意 |
|---|---|
| `docs/29` §4.1 維度「repo 數／模組（bounded context）數」 | 模組 = **bounded context**（DDD 架構邊界） |
| `docs/29` §5 就緒度：可重現建置、CI 綠燈、**行覆蓋率** | 模組 = **可獨立量測的建置單元**（workspace package／目錄） |
| `docs/29` §7.1 A1／A2：模組圖、模組間相依、資料所有權、每模組一張 A2–A4 | 模組 = **架構單元**（人判定的邊界） |
| `docs/29` §9.3 大型：每張分析單處理一個 bounded context | BC 是切單單位，模組可能只是 BC 內的一部分 |

衝突的後果很具體：若同一模組在 A0 叫 `src/billing`、在 A1 叫「Billing Context」、在 A2 叫 `@app/billing-core`，圖上會出現三個節點或一個漂移的節點，而 `R0–R2`、HG2 簽核、P3 驗證閘門全部對不上。

### 3.2 定義

> **模組**是軟體工廠的**變更治理單位**：多個模組組成一個系統；**模組的任何修改都必須透過工單**（今日＝Backstage「開立 Factory 工作項」表單／GitHub Issue form）；模組的身份優先由**該模組的規格文件**錨定，沒有規格文件時才用 `<system>/<module-id>` ＋ 主要路徑 glob。

這句定義同時滿足三個面向，而不是在三個選項中挑一個：

| 面向 | 由什麼承載 |
|---|---|
| 語意（這是什麼邊界） | BC／A1 的模組圖；有規格文件時由文件錨定 |
| 量測（就緒度怎麼算） | 建置單元 ＋ 主要路徑 glob（覆蓋率、CI 狀態可機械歸屬） |
| 治理（誰能改、怎麼改） | 一律經工單；邊界變更本身就是一次流程變更 |

### 3.3 識別與錨定

識別碼統一為 **`<system>/<module-id>`**（例：`payment/billing`）。錨定順序：

1. **模組規格文件存在** → 以文件為準（`docs/business-rules/<module>.md`）。
   - 理由：`docs/29` §10.2 已指定此路徑為 write-spec 的規格來源（`docs/29-brownfield-adoption-playbook.md:641`），且它是 **HG4 人類簽核**的產物（同文件 `:265`）。只有它是「人類撰寫／逐條確認」的；arc42 文件依實作而寫，明文**不能**當規格來源（§10.2）；Quint 的 `specs/<name>/` 是驗證產物，只有核心模組才有。
2. **沒有規格文件** → `process.yaml` 的 module entry：`id` ＋ `paths`（glob）＋ `build_unit` ＋ 邊界判斷依據。
   - 由 **A1 報告**產出草案（`docs/29` §7.1 A1 已要求「模組邊界、模組間相依與資料所有權」），**HG2 簽核**後生效。
   - 這就是 `process.yaml` 的 module 段（附錄 A）。

### 3.4 邊界變更就是工單

改 `module-id`、改 `paths`、拆／併模組 = 改變「哪裡算一個治理單位」= **流程變更**，因此：

- 一律走 PR（在目標 repo 是 `factory/process.yaml`，在機制 repo 是 `processes/<system>.yaml`）。
- 不提供「UI 直接改、立即生效」的路徑。
- 這一條與 `docs/06` §4.1 的「監督只能收緊」單向棘輪同一個精神：讓變更留下 diff。

---

## 4. 圖庫選型

### 4.1 判準（先寫判準，再選）

這個圖**不是資料流，是階層 ＋ 狀態**：節點是系統／模組／工作項，邊是歸屬與前置，閘門是鎖。而**執行器在 GitHub Actions 與 `src/cli`，不在瀏覽器**。因此：

| # | 判準 | 為什麼 |
|---|---|---|
| C1 | **沒有內建執行引擎** | 有引擎會誘使判定邏輯長到前端 → 直接違反 `ADR-001`（GitHub 唯一真相） |
| C2 | **節點是 DOM** | 卡片要放 Issue 連結、三軸徽章、HG 鎖、token、hover 卡、鍵盤操作、無障礙 |
| C3 | **Astro／React 相容** | 落點是 `philipz/factory-scoreboard`（Astro ＋ Cloudflare，`ADR-015`） |
| C4 | **序列化自由** | 產物是**我們自己的** `process.yaml`，不是框架的 graph 格式 |
| C5 | **群組／巢狀** | 系統 → 模組 → 工作項三層 |
| C6 | **授權與維護** | MIT、社群規模、可長期維護 |

### 4.2 比較

| 維度 | **React Flow**（`@xyflow/react`） | **Rete.js** | **LiteGraph.js** |
|---|---|---|---|
| 授權 | MIT（Pro 為可選商業支援） | MIT | MIT |
| 框架 | **React**（另有 Svelte Flow） | 框架無關（React／Vue／Angular／Svelte 插件） | 框架無關 |
| 渲染 | **DOM 節點** | DOM（各框架綁定） | **Canvas2D**（節點不是 DOM） |
| 內建執行引擎 | **無** | **有**（dataflow／control-flow engine） | **有**（`onExecute`，亦可跑在 NodeJS） |
| 型別化接孔 | 無（本案不需要） | **有**（socket 型別檢查） | 有（slot 型別） |
| 群組／巢狀 | `parentId` 群組節點 | 有（scopes） | **subgraph（節點內含圖）** |
| 序列化 | 純 JSON，`nodes/edges/data` 自定義 | 綁 editor 狀態 | `LGraph` 自有 JSON |
| 自動佈局 | 需自接 dagre／elkjs | 有 auto-arrange 插件 | 需自寫 |
| Astro 相容 | **React island 直接可用** | 可用但較重 | 需自行包一層 |
| 代表實績 | 大量內部工具與節點式編輯器 | 視覺化程式語言 | **ComfyUI**（節點式工作流執行的大規模實證） |
| 對本案 | **✅ 相符** | ⚠️ 過重（引擎用不到、接孔語意用不到） | ❌ 方向不符（canvas、無 DOM 節點） |

來源：各專案 README（[React Flow](https://github.com/xyflow/xyflow)、[Rete.js](https://github.com/retejs/rete)、[LiteGraph.js](https://github.com/jagenjo/litegraph.js)）。

### 4.3 結論：React Flow

1. **C1 命中**：Rete 與 LiteGraph 的核心價值是「前端把圖跑起來」；本案的圖**不該跑**。帶引擎的框架會讓「判定在 CI」這條界線變模糊。
2. **C2 命中**：Canvas 畫不出可選取、可點、可嵌入元件的卡片；ComfyUI 不需要，但我們需要。
3. **C3 命中**：Astro ＋ React island 是最短路徑（`@xyflow/react`，MIT）。
4. 使用者已指定以 <https://xyflow.com/labs/react-flow-playground> 為起點，與此結論一致。

### 4.4 何時該翻盤

- **改用 Rete.js**：若未來真的需要在瀏覽器內**執行**流程（例如本地預覽 agent 節點），且願意把判定搬進前端。
- **改用 LiteGraph.js**：若節點數長期落在數千以上、且可接受 canvas 的互動與無障礙限制。
- **改用 Svelte Flow**：若 scoreboard 從 Astro/React island 改為 Svelte 生態（`ADR-015` 的既有觸發條件）。

---

## 5. OpenRig 作為參考實作（不是採用對象）

評估基準：tag `v0.6.10`（Apache-2.0）。OpenRig 是「本機 daemon ＋ CLI ＋ TUI ＋ MCP，建在 tmux 上」，狀態在 `$OPENRIG_HOME`（預設 `~/.openrig`）的 SQLite。

### 5.1 TUI 元素 → 工廠概念

| OpenRig TUI 元素 | 工廠對應 | 備註 |
|---|---|---|
| 左側 rail：`LOCAL → KERNEL / PRODUCT-TEAM / IMPLEMENTATION-PAIR` | **系統**（導入追蹤 Issue）→ **階段 P0–P5** | 系統是第一層導覽，與 `docs/29` §4.3 一致 |
| pod 框（`3 PODS / 4 AGENTS / 0 ACTIVE`） | 階段或**模組**群組（`N 模組 / M 工作項 / K 待簽核`） | pod = 群組容器，不是節點語意 |
| agent 卡片（runtime 徽章、`operator-agent@kernel`、`108k`） | **工作項**卡片（類型徽章、`#Issue`、token 用量、目前 run） | 徽章與地址的資訊密度值得照抄 |
| `human` 節點（`TTY`） | **HG 簽核節點** | OpenRig 把「人」當 destination，這是好主意 |
| `queue` 節點（`queue-worker`） | `ADR-022` 前置佇列 | 對應「這張單在等哪一張」 |
| `RUNNING` / `STOPPED` | 進行中／等待前置／`needs-human` 停手 | 狀態語彙可借 |

### 5.2 為何**不採用**它的方法論

| 原因 | 事實依據 |
|---|---|
| **Runtime 封閉且不含 DSH** | rig 的 `runtime` 是封閉列舉 `claude-code / codex / pi / omp / terminal / stub`；workflow step 的 `harness` **只准** `claude-code` 或 `codex`（`terminal` 被刻意排除）。沒有 adapter 介面，MCP 也不暴露 queue 工具。→ 要用它跑工廠 agent，等於換掉 DSH。 |
| **它不知道 PR 合併** | `blocked_on` 只接受**還活著的 qitem**；typed gate（`external:`）只是標籤，沒有任何東西輪詢 CI／PR／指令 exit code；`rig proof` 明文 advisory（"never gates"）。→ 「A 合併後 B 才能開始」表達不出來。 |
| **簽核強度不足** | gate 只指**一個** destination；human registry 是 single-human surface；`proofPolicy.judges` 取最新一筆判定即可，**沒有 quorum／`min_approvals`**；身分是 `OPENRIG_SESSION_NAME` ＋ 可選 shared bearer，**沒有簽章**。→ 大型專案 HG1／HG2／HG7 的兩人簽核與「簽核人不得為 PR 作者」做不出來。 |
| **無 GitHub Issues／PR 整合** | 文件與原始碼都沒有讀 issue／PR／merge 的路徑。→ 會變成第二個真相，違反 `ADR-001`。 |
| **成熟度** | workflow runtime 自標「PL-004 Phase D / v1 minimum」，內建 `factory-rsi` spec 標 **Untested**，官方文件頁仍寫 "against 0.6.6"，且 CLI 範例用 `.workflow.md` 而掃描器只吃 `.ya?ml`。近每日發版（0.6.1→0.6.11 約三週）。 |
| **治理衝突** | 它的預設模型是 lead agent 派工給 specialist；`docs/24` §2.1 細則 1 要求「spawn 需人類確認 ＋ 禁遞迴（深度 1）」，`ADR-010` 至今維持「不採用多 agent 團隊工具」（觸發條件 1/3）。 |

### 5.3 值得借的概念（只借概念，不借實作）

- **「必要步驟可加不可刪、不可重排」**（required steps 由 `project.yaml` 與 mission 共同編譯，mission 只能加步驟）。→ 本文件 §6 與附錄 A 的 `phases` 規則照此。
- **「人是 destination」**：把 HG 畫成節點、把「等你」變成一種可列的狀態。
- **「attention / 現在需要我什麼」視圖**：對應 `docs/31` §3 的提示卡，v1 的節點側欄就是它的圖形版。
- **closure 必須說明去向**（固定的一組 closure reasons）。→ 對應 `docs/29` 的「建議下一步」不得自動變成工作項（§1.1 前提 2）。

### 5.4 直接回答最初的問題

> **問**：OpenRig 是否可以用來協助編排 `docs/31` 與 `docs/29` 的流程——human-in-the-loop 與工單順序？

| 子問 | 答案 | 依據 |
|---|---|---|
| **HITL 可不可以用 OpenRig？** | **人類閘門的表達方式可以借鏡，採用則不建議。** 它把「人」當 destination、把「等你」變成一種狀態，這個形狀是對的；但它的 gate 只能指一個具名者、無 quorum、無簽章，且閘門的「機器證據」（PR 合併）它看不到。 | §5.1、§5.2 |
| **工單順序可不可以用 OpenRig？** | **不可取代。** 順序的機械證據在 GitHub（PR 合併、`stage/done`、`factory-stage prereqs`，`ADR-022`）；OpenRig 的 closure 是「某個 actor 說這步好了」，用它取代等於把機械判定降級為人治。 | §5.2、`factory-stage-finalize.yml:15` |
| **那真正需要的是什麼？** | **流程本身可被看見、可 diff、可審查**：`process.yaml`（實例）＋ 拓撲 UI（React Flow）。OpenRig 的 TUI 是這個 UI 的參考實作，不是替代品。 | §3、§4、§6 |

---

## 6. v1 範圍

### 6.1 做

1. **唯讀拓撲**：系統 → 模組 → 工作項三層，顏色＝三軸／就緒度，鎖＝HG 未簽。
2. **結構編輯**：新增／移除模組節點、改閘門、改順序 → 產生 `process.yaml` 的 diff → **開 PR**。
3. **節點側欄**：「這張單還缺什麼」——就緒度、缺少的 HG、未完成的前置（`docs/31` §3 提示卡的圖形版）。
4. **資料來源**：本 repo 產生 `factory-graph --json`（附錄 B），scoreboard 只負責畫。

### 6.2 不做

- **位置與縮放不進 spec**：拖動節點位置是本地狀態（存 localStorage 或 UI 偏好），不產生 PR。否則每個人拉一下就是一次 PR 噪音。
- **不可派工、不可簽核**：`HG0`（每張單由人開立）與 `ADR-022`（不自動派工下游）都未被推翻；v1 的「推進」仍發生在 GitHub。
- **不做即時執行**：圖不執行程式，也不呼叫 `factory-run`。
- **不取代 `docs/29`**：見 §6.4。

### 6.3 資料流

```
GitHub（真相）──┬─→ factory-graph --json（既有判定：scoring / stage / labels）
                │            │
                │            ├─→ scoreboard：唯讀拓撲圖（v1）
                │            └─→ 快取（靜態 JSON，選用）
                └─→ 人（HG 簽核、PR 合併、派工）
                          │
                          └─→ process.yaml 的 PR（結構變更）
```

### 6.4 兩份文件的分工（避免漂移）

| 文件 | 定義什麼 | 誰讀 |
|---|---|---|
| `docs/29` | **方法論**：有哪些可能的階段與閘門（P0–P5、HG0–HG7、A0–A4） | 人 |
| `process.yaml` | **實例**：這個系統實際採用哪些階段、哪些模組、哪些閘門、誰簽 | 機器（`factory-graph`）＋ 人（PR 審查） |

規則：`process.yaml` **只能在 `docs/29` 定義的集合內選擇**；要新增階段或閘門，先改 `docs/29`（走 PR），再改 `process.yaml`。這是「可加不可刪、不可重排」的落地方式。

---

## 7. 未解問題

| 編號 | 事項 |
|---|---|
| `Q-ORCH-1` | `process.yaml` 只作描述，或未來讓 `factory-run` 讀它否決派工（＝把 Q29-4 機械化） |
| `Q-ORCH-2` | 模組身份是否強制要求 `docs/business-rules/<module>.md`（列入 HG2 必要條件） |
| — | v1 的節點側欄要不要顯示 token 用量（`docs/26` 的事件 schema 已有此資料） |
| — | `process.yaml` 的放置（機制 repo vs 目標 repo）是否會讓 P0 之前無法視覺化；`UNCONFIRMED` |

以上前兩項已登錄於 `docs/10-open-questions.md` §1.1。

---

## 附錄 A：`process.yaml` 最小 schema 草案

> **只是草案**，本次不實作。兩個檔案、兩個層級，對應 `docs/29` 的「系統定級、模組就緒度」。

### A.1 機制 repo：`processes/<system>.yaml`（系統級）

```yaml
# 一個系統一份；由服務擁有者在 HG1/HG2 後提交，PR 審查
system: aswf-dev/payment-platform        # 對應各 repo catalog-info.yaml 的 spec.system

scale: M                                  # S | M | L —— 人類裁定（HG2），不由 UI/CI 推導
scale_evidence: docs/research/120-a0.md   # A0 報告；沒有證據不得填

phases: [P0, P1, P2, P3, P4, P5]          # 可加不可刪、不可重排；只能是 docs/29 §6 的子集

gates:                                    # HG 的簽核規則；不取代 GitHub 的 CODEOWNERS 與 PR 審查
  - id: HG1
    scope: system
    signers: [service-owner]              # 大型專案為兩人 → 見 Q-ORCH-2
    evidence: tracking-issue-comment
  - id: HG2
    scope: system
    signers: [tech-lead]
    evidence: tracking-issue-comment
  - id: HG6
    scope: phase-exit
    signers: [module-owner, tech-lead]
    evidence: tracking-issue-comment
```

### A.2 目標 repo：`factory/process.yaml`（模組級）

```yaml
# 放在目標 repo，隨程式碼版控；模組邊界變更 = 一次 PR
system: aswf-dev/payment-platform

modules:
  - id: billing                           # 識別碼 = <system>/billing
    paths: ["src/billing/**"]             # 覆蓋率與就緒度的機械歸屬
    build_unit: "@payment/billing-core"    # 可獨立建置與量測的單元
    spec: docs/business-rules/billing.md   # 存在時即為身份錨定（§3.3）
    readiness: R1                          # R0 | R1 | R2 —— 人類裁定（HG2）
    readiness_evidence: docs/research/121-a2.md
    owner: payment-team
  - id: settlement
    paths: ["src/settlement/**"]
    build_unit: "@payment/settlement"
    readiness: R0
    readiness_evidence: docs/research/122-a2.md
    owner: payment-team
```

### A.3 硬規則

1. **`scale` 與 `readiness` 只能由人填，且必須附 evidence**；UI 與 CI 只能顯示，不得推導。這是守住 `docs/29` Q29-4（尚未裁決）的邊界。
2. **`phases` 與 `gates` 可增不可刪、不可重排**，且必須是 `docs/29` 定義集合的子集。
3. **位置與縮放不入 spec**；`process.yaml` 只描述結構與語意。
4. **沒有 `spec:` 的模組仍有效**，但必須有 `paths` ＋ `build_unit` ＋ HG2 的 `readiness_evidence`。

---

## 附錄 B：`factory-graph --json` 輸出契約草稿（本次不實作）

> 用途：讓 scoreboard 只負責畫，**不重寫第二份判定邏輯**。判定全部來自既有的 `src/scoring/**`、`src/cli/factory-stage.ts`、`src/labels.ts`。

```jsonc
{
  "system": "aswf-dev/payment-platform",
  "generated_at": "2026-10-18T09:00:00+08:00",
  "source": { "github": "aswf-dev/payment-platform", "rev": "<sha>", "dirty": false },
  "nodes": [
    { "id": "payment-platform", "kind": "system", "label": "payment-platform",
      "scale": "M", "phase": "P2" },
    { "id": "payment-platform/billing", "kind": "module", "label": "billing",
      "readiness": "R1", "owner": "payment-team",
      "axes": { "business": 1, "risk": 2, "complexity": 1, "tier": "review" },
      "core": false },
    { "id": "issue:412", "kind": "workitem", "label": "#412 add-tests",
      "task_type": "agent-add-tests", "state": "waiting-prereq",
      "prereqs": ["issue:408"], "oversight": "review", "needs_human": false }
  ],
  "edges": [
    { "from": "payment-platform", "to": "payment-platform/billing", "kind": "contains" },
    { "from": "issue:408", "to": "issue:412", "kind": "prerequisite" }
  ],
  "gates": [
    { "id": "HG2", "scope": "payment-platform/billing", "state": "signed",
      "signed_by": "tech-lead", "evidence": "issue:391#comment-2" },
    { "id": "HG5", "scope": "payment-platform/billing", "state": "missing" }
  ],
  "warnings": ["readiness 缺 evidence", "module settlement 無 spec 文件"]
}
```

不變量（實作時必須遵守）：未知欄位一律忽略；`state:"missing"` 的 gate 才畫鎖；`warnings` 不得變成閘門（advisory only，比照 OpenRig 的 `proof` 與 `artifact-pool-ready` 的教訓）。

