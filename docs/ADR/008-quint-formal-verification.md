# ADR-008：Quint 正式方法整合（Phase A）

## 狀態

已接受（2026-08-17）

## 決策

以 Quint 驗證工廠自身的計分邏輯：**規格即神諭（oracle bridge）**。

- Quint 官方 agent skills vendor 至 `.dsh/skills/`，鎖定來源 commit：**`4e6a580ef40d96914fcebe4e1b4ae95f34c2a75e`**（quint-co/quint，2026-07-20）。
- **官方 `skills/` 目錄僅含 `quint-lang` 與 `quint-modeling` 兩個 skill**；`quint-execute-spec` 不在官方 repo 中（本 session 的 skill 目錄另有來源），故只 vendor 官方存在的兩個，並在計畫中記錄此差異。
- 橋接機制（R2-Q2=D、R2-Q5=C）：Phase A 自建最小神諭 harness——`quint run --out-itf` 產生 ITF traces，vitest 解析後與 TS 實作逐一比對（`test/quint/scoring-oracle.test.ts`）。`quint-connect-ts` 留待 Phase B 評估（供應鏈最小化）。
- 正式驗證（R2-Q2=A）：`specs/scoring/score.qnt` 由**人類撰寫**，以 `quint verify`（Apalache）model-check 6 個不變量（fail-safe、tier 範圍、automerge 條件）。
- 宣告機制（R2-Q3=D）：`.github/factory/quint-paths.yml` 宣告「觸及 `src/scoring/**` 等路徑的 PR 必須通過 `quint-verify` required check」；repo 級 `factory.io/quint-spec` annotation 指向規格根目錄。
- agent 撰寫 .qnt 草稿（Q6=B）：草稿隨 stacked PR 交人類審查，**合併後才生效**；同一 run 內 agent 不得用自己寫的 .qnt 驗證自己的 code（docs/06 §4.3）。

## 理由

- docs/06 的計分是 agent 權限的唯一來源，最值得先被正式驗證（dogfooding，與 docs/11 一致）。
- Quint 不能直接驗證 TS 程式碼；神諭橋讓「規格書」成為機器可讀、可執行比對的 oracle。
- `quint verify` 狀態空間小（27 種輸入組合 + 邊界），Apalache 秒級完成。

## 後果

- 新增 `specs/scoring/score.qnt`、`.github/factory/quint-paths.yml`、`.github/workflows/quint-verify.yml`（required check `quint-verify`）、`test/quint/scoring-oracle.test.ts`。
- `@informalsystems/quint@0.32.0` 加入 devDependencies（精確鎖版）。
- Phase B（驗證 agent 產出的工作項）隨第 2 期另立計畫；屆時評估 quint-connect-ts 與 ITF 測試向量兩種橋。

## 補記（2026-09-26）：Phase B 方向與 UPPAAL 例外路徑

- **Phase B 方向由 ADR-018 決定**：`agent-write-spec` 改為規格書驅動，拆成「不變量」與「as-is 模型」兩張工單；目標 repo 的 `.qnt` 由 factory-run 依 `specs/<name>/verify.yml` 集中驗證。本 ADR 的原則維持不變：同一個 run 內，agent 不得以自撰規格驗證自撰程式碼；vendored 的 `quint-lang`、`quint-modeling` 仍鎖在上述官方 commit，不修改。
- **UPPAAL 為人工例外路徑，不納入 CI**：時間性質（時鐘跳躍、多個獨立時鐘）如果 Quint 的單一時鐘表達不了，可以由人使用 UPPAAL 時間自動機加上 TCTL 查詢。先例是 agent-playground/node-redlock 的 F9（`specs/uppaal/`）。write-spec 工單**不得**要求 agent 使用 UPPAAL。
