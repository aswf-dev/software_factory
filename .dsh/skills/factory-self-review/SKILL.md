---
name: factory-self-review
description: 提交 stacked PR 前必須執行的自審清單。任何一項未過即修正，不得帶著已知問題提交。
---

# 提交前自審

## 測試層（01-test）

- [ ] 測試真的驗證了驗收條件，不是為了好過而寫的弱測試
- [ ] 沒有刪除或弱化任何既有斷言（斷言數不得淨減少）
- [ ] 測試在修改前能呈現紅燈（若無法執行，說明原因）

## 實作層（02-impl）

- [ ] 只做一件事，一句話可描述
- [ ] 沒有未經測試涵蓋的副作用
- [ ] 未觸及 guardrail 路徑（`.github/**`、`CODEOWNERS`、`catalog-info.yaml`、`.dsh/skills/**`）
- [ ] 未新增未在既有相依清單中的套件

## 文件層（03-docs）

- [ ] 文件與實作一致
- [ ] 沒有把金鑰、token 或個人資料寫入任何檔案

## PBT 稽核（僅 agent-pbt-audit）

- [ ] 逐條跑過 `.dsh/skills/hegel-review/SKILL.md` 的 12 點，每個 PBT 測試都對照過；違反者依該清單的最小修正改好再提交
- [ ] 每個 property 上方都有 `// source:` 依據，且依據不是本次產出（ADR-019 §4）
- [ ] 進 PR 的 property 都在 `CI=true`＋20 個隨機 seed × 5000 cases 下通過；失敗的寫進 `pbtAudit.findings`，沒有 skip、沒有被刪掉
- [ ] diff 只含 PBT 測試檔的新增或修改，沒有產品程式碼、既有範例測試、設定或依賴，沒有刪除
- [ ] 每條候選發現都附 draws、seed、Hegel 版本與固定輸入的紅燈測試，紅燈測試實際跑過是紅的

## 一般

- [ ] 變更行數合計 ≤ 200–300（超過則再拆）
- [ ] PR 描述包含「為什麼這樣做」（docs/07 §5）
