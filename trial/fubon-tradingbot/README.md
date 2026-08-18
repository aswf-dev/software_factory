# T8 試點草稿：philipz/fubon-tradingbot 的工廠設定（Phase 2 T8 預備）
#
# 這是給 fubon-tradingbot 的 `software-factory` 分支使用的設定草稿（依該 repo
# 實際結構 2026-08-18 盤點）。T8 人類步驟完成後（① 開 software-factory 分支
# ② App 安裝至該 repo）即可複製上傳：
#
#   catalog-info.yaml                       → repo 根
#   .github/factory/risk-paths.yml          → repo 根（.github/factory/ 下）
#   CODEOWNERS                              → repo 根
#   .github/factory/task-template-*.txt     → 直接複製本 repo 同名檔（已通用化，T4）
#   .dsh/skills/factory-*                   → 直接複製本 repo 同名 skill 目錄（已通用化，T4）
#
# ⚠️ 安全約束（Q-P2-1）：這些檔案只會進 `software-factory` 分支；main 絕不觸碰。
# ⚠️ 複製後請人工審查 risk-paths 是否涵蓋該 repo 所有高風險路徑（H1–H7 定義見
#     .github/factory/risk-paths.yml 註解與 docs/06 §3.2）。
