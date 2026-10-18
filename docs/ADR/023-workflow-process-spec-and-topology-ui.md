# ADR-023：流程以 `process.yaml` 描述，拓撲 UI 採 React Flow（OpenRig 僅作參考實作）

- **狀態**：已接受（2026-10-18 修訂：節點層級；「執行」語意見 `ADR-024`；租戶模板見 `ADR-025`）
- **日期**：2026-10-18
- **決定者**：平台架構（使用者經 grilling 逐題裁決，Q1–Q35）
- **對應**：`docs/research/55-workflow-topology-ui.md`（證據與詳細比較）、`ADR-001`（GitHub 唯一真相）、`ADR-010`（多 agent 團隊工具延後）、`ADR-015`（Scoreboard 平台）、`ADR-022`（前置工作項）、`docs/24` §2.1、`docs/29` §6／§8／§10、`docs/31` §2／§3、`ADR-024`（執行語意）、`docs/10`（`Q-ORCH-1/2`）

## 脈絡

`docs/31` §0 自述的缺口是「在你要動手的當下，有人告訴你這張單還缺什麼、該先做什麼」；`docs/29` §5 也自承「就緒度→允許類型的對照**沒有機械強制**」，而 HG0–HG7 只以導入追蹤 Issue 的勾選清單存在——`src/`、`.github/`、`backstage/` 對 `HG[0-9]` 零引用。

同時，`docs/29` 全篇以**模組**為單位（就緒度、P2–P4 關卡、核心模組、驗證閘門），但 `docs/29` 與 `docs/GLOSSARY.md` 都沒有定義模組的邊界與識別方式。要畫流程圖，第一個卡點就是「節點是什麼」。

因此，本決策要處理的是**流程的呈現層**，不是派工器：

- 「工單順序」已有機械實作（`ADR-022` 前置工作項、派工前檢查、完成後通知），缺的是**人看得到**。
- 「人類閘門」完全沒有機械載體，缺的是**狀態與簽核規則**。
- OpenRig（`v0.6.10`）的 TUI 提供了可參考的形狀（rig → pod → agent、`human` 節點、`queue` 節點、RUNNING/STOPPED），但它的 runtime 列舉不含 DSH、沒有 PR／merge 概念、沒有 GitHub 整合、簽核只有單一具名者且無簽章、workflow runtime 自標 v1 minimum；其「lead agent 調度 specialist」的模型與 `docs/24` §2.1 細則 1（spawn 需人類確認、禁遞迴）及 `ADR-010`（維持不採用多 agent 團隊工具）衝突。

## 決策

### 1. 流程以 `process.yaml` 描述，分兩層

- **系統級**：機制 repo 的 `processes/<system>.yaml`（規模、階段、HG 簽核規則）。
- **模組級**：目標 repo 的 `factory/process.yaml`（module id、`paths` glob、建置單元、就緒度、負責人）。
- 兩個檔案的**最小 schema 與硬規則**見研究文件附錄 A。

### 2. `process.yaml` 是描述，不是真相

- 真相仍是 GitHub（`ADR-001`）；判定邏輯仍留在 `src/cli`（三軸計分、H1–H7、`factory-stage prereqs`、`spec/approved`、`stage/done`）。
- **`scale` 與 `readiness` 只能由人填並附 evidence，UI 與 CI 不得推導**——守住 `docs/29` Q29-4 尚未裁決的邊界。
- `docs/29` 定義「有哪些可能的階段與閘門」（方法論），`process.yaml` 定義「這個系統採用哪些」（實例）；`process.yaml` 只能是 `docs/29` 集合的子集，且**可加不可刪、不可重排**。
  - **2026-10-18 修訂**：上述「不可重排」只適用於**工廠 preset（`factory/S|M|L`）**。租戶可有自己的模板（`ADR-025`），在 meta-contract 內自由排序；工廠仍保留 HG0–HG7 與 task_type 白名單。

### 3. 拓撲 UI 採 React Flow（`@xyflow/react`，MIT），落點在 Scoreboard

- 判準：①沒有內建執行引擎（避免判定邏輯長到前端）②節點是 DOM（卡片要放 Issue 連結、徽章、鎖、hover）③Astro／React island 相容④序列化自由⑤群組／巢狀⑥MIT 與社群。
- 比較與淘汰理由見研究文件 §4；Rete.js 與 LiteGraph.js 的內建執行引擎在本案是負債，LiteGraph 的 canvas 渲染無法承載 DOM 卡片。

### 4. v1 的邊界

- **可編輯結構**（模組節點、閘門、順序）→ 產生 `process.yaml` 的 diff → 開 PR。
- **位置與縮放不進 spec**（本地狀態），避免 PR 噪音。
- **不可派工、不可簽核**：`HG0`（每張單由人開立）與 `ADR-022`（不自動派工下游）未被推翻。UI 可產生「待開工作項」清單，但仍由人按下送出、走既有入口——語意見 `ADR-024`。
- 資料由本 repo 的 `factory-graph --json` 產生（本次**只定契約、不實作**），scoreboard 只負責畫，**不重寫第二份判定邏輯**。

### 5. 節點層級：步驟（step run），系統與模組是範圍（2026-10-18 第二次修訂）

第一次修訂把圖上節點定為「模組 → 工作項」。同日稍後 `processes/templates/{S,M,L}.yaml` 落地後，
這個形狀不成立：模板是 **step-based**，S10 的 `alternatives`（Quint／Hegel／豁免）、gate 的位置、
`per: module` 的範圍，都需要「步驟」這一層才表達得出來。只畫模組與工作項，等於把方法論的序列藏起來。

因此節點回到**流程步驟的一次執行**（step run）：

- **節點**：`workitem`（一次派工）／`human`（人類步驟）／`gate`（HG 簽核）／`decision`（分支）。
  同一 `task_type` 可以出現兩次（`agent-write-spec` 草案 → HG5 → 套用），所以節點需要 `step_id`，
  不能只用 `task_type` 當 key。
- **系統**＝頁面／路由的範圍（`/process/[system]`）與 `process.yaml` 的 `system:`；不畫成節點。
- **模組**＝P2–P4 的範圍（UI 以 `?module=` 切換），不是步驟的替代。工作項的模組歸屬由 PRD 宣告路徑
  比對 `factory/process.yaml` 的 `paths` glob（`moduleOfIssue`）。

**工作項的步驟歸屬（provenance）**：Issue body 的第一個 `###` 之前可帶一行
`> 流程步驟：S10`（選填、人可讀；`buildIssueBody` 支援 `processStep`）。`factory-graph` 讀它輸出
`step_id`；沒有標示者省略並產生**一則聚合 warning**，**不以 `task_type` 猜測**——`agent-analyze`
同時對應 S4／S5 與 M5／M6／M7，猜錯比不畫更糟。

`step_id` 是 advisory：只影響呈現，不影響派工、前置判定或閘門（`ADR-024` §4）。

### 6. 模組的定義

模組是工廠的**變更治理單位**：多個模組組成一個系統；模組的任何修改都必須透過工單；身份優先由 `docs/business-rules/<module>.md`（HG4 產物）錨定，沒有時才用 `<system>/<module-id>` ＋ 主要路徑 glob（A1 草案、HG2 簽核）。

## 後果

### 正面

- 流程第一次變成**可 diff、可審查**的物件；HG 的「這個系統還缺哪個簽核」有了資料結構，不再是勾選清單。
- 「模組」從未定義的原語變成有識別碼、有量測歸屬的節點；`R0–R2`、HG2、P3 驗證閘門終於對得上同一個 key。
- 判定邏輯不動，UI 只讀；錯誤的視圖不會造成錯誤的派工。
- 為 `docs/29` §13 的後續工作項（規模／就緒度機械化、導入追蹤 Issue 範本）提供落地載體，而不必先裁決 Q29-4。

### 負面

- 新增**兩份需要同步的檔案**（系統級與模組級）；`process.yaml` 與 `docs/29` 的集合關係若無人維護會漂移。
- UI 綁定 React（Scoreboard 已是 Astro，影響有限）；若生態轉向 Svelte，需改用 Svelte Flow。
- `process.yaml` 在 P0 之前不存在，因此「還沒納管的系統」無法在圖上呈現——這是刻意的（未納管＝不在工廠管轄內）。

### 中性

- `factory-graph --json` 是本決策引入的**概念**，本次不實作；實作與否是後續工作項。
- OpenRig 的 TUI 只作視覺參考；未來若其 runtime 開放、或本工廠改用其支援的 runtime，才需重評（見觸發條件）。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| **OpenRig 當工單編排層**（sidecar 或全編排） | runtime 封閉列舉不含 DSH；`blocked_on` 只吃活著的 qitem、typed gate 僅標籤、`rig proof` 明文 advisory → 「A 合併後 B 才能開始」表達不出來；gate 只指單一具名者、無 quorum、無簽章，做不到大型專案 HG1／HG2／HG7 的兩人簽核；無 GitHub Issues／PR 整合，會變成第二個真相；workflow runtime 自標 v1 minimum、內建 spec 標 Untested；其 lead-agent 模型與 `docs/24` §2.1、`ADR-010` 衝突。 |
| **OpenRig TUI 直接拿來用** | 它是終端 TUI（tmux），綁在單一機器；HG 本質上需要「別人」看到並簽核，而 TUI 無法多人共用；且仍受上述 runtime／整合限制。 |
| **Rete.js** | 核心價值是內建 dataflow／control-flow 執行引擎與型別化接孔；本案的圖不該在瀏覽器執行，接孔語意也用不到 → 過重。 |
| **LiteGraph.js** | Canvas2D 渲染，節點不是 DOM，無法承載卡片式內容與無障礙；其 `onExecute` 執行引擎在本案是負債。 |
| **Backstage plugin** | Backstage 在本 repo 只有 templates／plugins、沒有 app（`ADR-009` 局部凍結）；且模板職責是「開單」，不是「呈現流程」。 |
| **只在 Scoreboard 加一頁、不引入 spec** | UI 會退化成截圖：無法 diff、無法審查、無法回答「這個系統採用哪些閘門」。 |
| **讓 `process.yaml` 直接驅動派工** | 等於把 `docs/29` Q29-4（規模與就緒度是否機械化）偷偷裁決掉，且會讓 UI 成為派工器，違反 `HG0` 與 `ADR-022`。 |
| **不記錄本評估** | 六個月後會從零重啟同一場討論（`ADR-010` 的教訓）。 |

## 重評觸發條件（任一成立即重新檢視）

1. 需要在**瀏覽器內執行**流程（本地預覽 agent 節點）→ 重評 Rete.js。
2. 節點數長期落在**數千以上**且可接受 canvas 互動限制 → 重評 LiteGraph.js。
3. OpenRig 開放 runtime adapter、或本工廠改用其支援的 runtime，**且**其 workflow runtime 脫離 v1 minimum → 重評「OpenRig 當編排層」。
4. 同時納管的系統 ≥ 3 或審查者 ≥ 2 人 → 重評簽核模型（含 `Q-ORCH-2` 的兩人簽核與機器可驗性）。
5. Scoreboard 的前端生態由 Astro/React 轉向 Svelte → 改用 Svelte Flow。
