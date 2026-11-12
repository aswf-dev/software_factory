# ADR-032：流程頁的 BPMN 圖改用 `@bpmnkit/canvas`（瀏覽器端渲染）

- **狀態**：已接受（2026-11-12，使用者經 grilling 逐題裁決 Q1–Q35 並確認決策摘要）
- **日期**：2026-11-12
- **決定者**：使用者
- **修訂**：`ADR-030` §6「圖形伺服器端產生 SVG（不引入前端繪圖套件）」→ 改由 `@bpmnkit/canvas` 在瀏覽器端渲染。§6 的其他內容不變，包括版面（P0–P4 總覽＋階段圖）與「手機可橫向捲動」。
- **補記**：`ADR-028` PoC 驗收項目 #9（檢視器 `@bpmnkit/canvas` 支援 overlay／marker）——通過，見下方 PoC。
- **對應**：`ADR-027`（BPMN 編排）、`ADR-028`（技術選型：檢視器為 `@bpmnkit/canvas`）、`ADR-030`（S 流程執行與狀態頁）、`ADR-015`（Worker bundle 門檻）
- **實作**：factory-scoreboard `docs/decisions/2026-11-12-bpmn-canvas-renderer.md`（PoC 截圖與補救細節）；第一步 PR：factory-scoreboard `feat/system-page-bpmn`

## 脈絡

- `ADR-028` 選定 bpmnkit 全家，**監控檢視器規劃為 `@bpmnkit/canvas`**，前提是 PoC 證明它支援狀態 overlay／marker。這個 PoC 一直沒做。
- `ADR-030` §6 實作狀態頁時改走 verify 的路：**伺服器端用 `@bpmnkit/core` 解析 DI、自己畫 rect／circle／polygon**。理由寫在程式註解裡：Worker bundle（R6：不加 runtime 依賴、不 hydrate）。
- 結果：
  - 圖只有方框、圓、菱形，**看不出 BPMN 語意**（user task、multi-instance、callActivity、message catch 都畫成一樣的框）；
  - 2026-11-12 還發現 HG 閘門（intermediate catch event）被誤畫成方框，start／end 顯示原始 id；
  - 樣本拓撲頁（`/scoreboard/process/[system]`）仍是另一套 React Flow 節點圖，和 S 狀態頁長得完全不同。
- R6 管的是**伺服器** bundle；`client:only`／`<script>` 的瀏覽器資產不計入 Worker 體積（`scripts/check-bundle-size.mjs` 只量 `dist/server`）。

## 決策

1. **流程頁的 BPMN 圖由 `@bpmnkit/canvas` 在瀏覽器端渲染**，版本釘死（目前 `1.0.2`）。伺服器只算「元素 id → 狀態」、雙語標籤與 tooltip，連同模板 XML 一起交給頁面。
2. **導入順序**：每一步都經使用者確認並合併後，才開始下一步。
   1. 樣本拓撲頁的 S 流程（`/scoreboard/process/[system]`）。
   2. S 狀態頁（`/scoreboard/process/s/{id}`）與 S 流程預覽（`/scoreboard/process/flows/S`），完成後移除伺服器端 SVG 元件。
   3. M。
   4. L。

   `/verify` 的圖不在範圍內。
3. **補救 canvas 1.0.2 的四個問題**（PoC 實測），集中在一個可測的模組：
   - 中文沒有空白，整段被當成一個字硬切、行尾補 `-` → 拿掉中文後的 `-`。
   - 長標籤溢出、蓋到活動標記 → 最多 3 行加「…」，完整文字放 `<title>`。
   - 沒有 i18n → 載入前依 `<html lang>` 改寫 `name`，切換語言時重載。
   - 滾輪一律縮放、頁面捲不動 → 只有按 Ctrl／⌘ 才縮放。手機上把 `touch-action` 交還瀏覽器，圖保持最小寬度、外框橫向捲動（維持 §6「手機可橫向捲動」）。
4. **沒有 JavaScript 時圖不出現**：`<noscript>` 指向伺服器端渲染的摘要表（資料相同）。點圖上的節點會捲到摘要表的同一列。
5. **安全網**：補救依賴 canvas 的 DOM 結構，所以 factory-scoreboard CI 新增必過的 Playwright（headless Chromium）job；canvas 升級時由它把關。

## PoC（factory-scoreboard 分支 `prototype-bpmn-canvas`）

同一頁切換「伺服器端 SVG／canvas 原樣／canvas＋補救」三種畫法，以 Playwright 實測：

- canvas 的狀態 marker（`addMarker`）可行，**`ADR-028` #9 通過**。注意：每次載入或換 plane 都會清掉 marker，要在 `diagram:load`／`plane:change` 時重新套用。
- 原樣的 canvas 有四個問題（決策 3），補救後全部通過。
- 瀏覽器端成本：約 74 KB gzip（含 core），只在用到圖的頁面載入；Worker bundle 不變。

## 後果

- **好處**：
  - 圖面是標準 BPMN 符號，和 `ADR-028` 規劃的編輯器同一套渲染；
  - 內建點擊與鍵盤（Tab／Enter）事件，之後要做節點互動很便宜；
  - 樣本頁、狀態頁、預覽頁最終只剩一套 BPMN 渲染。
- **代價**：
  - 需要 JavaScript；
  - 每頁多約 74 KB；
  - 依賴單一維護者的套件（1.0.x），補救碰到它的內部 DOM。
  - 這些代價由「版本釘死＋CI e2e」與「摘要表為無 JS 的完整替代」承擔。
- **過渡期**：第 2 步完成前，S 狀態頁仍是伺服器端 SVG，兩頁外觀不一致。

## 替代方案

- **維持伺服器端 SVG（`ADR-030` §6 原案）**：無 JS、無新依賴，但符號仍是簡化版，正確的 BPMN 語意要自己一個個畫。未採用：使用者要的是「BPMN 顯示方式」。
- **canvas 原樣、不補救**：中文斷字、無 i18n、滾輪攔截，三項在 PoC 都不合格。
- **bpmn-js NavigatedViewer**（`ADR-028` 的備案）：canvas 的 marker 可行，所以不需要備案；另外它要保留 bpmn.io 浮水印，方言也和引擎不同。

## 重評觸發條件

- canvas 升級後 e2e 失敗，而且補救無法在合理成本內修好。
- canvas 停止維護。
- 出現必須在無 JS 環境顯示圖形的需求（例如嵌入 email 或 PDF 報告）。
- 流程頁的瀏覽器端資產成為效能瓶頸。
