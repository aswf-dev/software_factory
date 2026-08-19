# Java/Spring Boot 試點草稿：philipz/spring-modulith-orders（Phase 2 語言無關性驗證）
#
# 這是給 spring-modulith-orders 的 `software-factory` 分支使用的設定草稿
#（依該 repo 實際結構 2026-08-18 盤點：Spring Boot 3.5.5 / Java 21 / Maven mvnw /
# Spring Modulith 多模組訂單服務）。T8 模式人類步驟完成後（① 開 software-factory
# 分支 ② App 安裝至該 repo）即可複製上傳：
#
#   catalog-info.yaml                       → repo 根
#   .github/factory/risk-paths.yml          → repo 根（.github/factory/ 下）
#   .github/workflows/test.yml              → repo 根（**該 repo 目前無 CI，需新建**）
#   CODEOWNERS                              → repo 根
#   .github/factory/task-template-*.txt     → 直接複製 software_factory 同名檔（已通用化）
#   .dsh/skills/factory-*                   → 直接複製 software_factory 同名 skill（已通用化）
#
# ⚠️ 安全約束（Q-P2-1）：這些檔案只會進 `software-factory` 分支；main 絕不觸碰。
#
# ⚠️ Java 特定注意：
# 1. **CI 需新建**：此 repo 無任何 workflow（fubon 是改既有 test.yml；這裡從零建，
#    觸發條件必須涵蓋 software-factory 與 factory/**——試點 #3 教訓）。
# 2. **JDK 21**：Spring Boot 3.5.5 要求 Java 21。ubuntu-latest runner 預設含
#    Temurin 21（/usr/lib/jvm/...）；agent 驗證前先 `java -version` 確認，
#    沒有則 `sudo apt-get install -y openjdk-21-jdk`。
# 3. **測試耗時**：mvn 首次含依賴下載可能 5–15 分；工作項驗收條件建議限定
#    測試範圍（如 `./mvnw test -Dtest=OrderServiceUnitTests`）避免 E2E 全跑逾時。
# 4. 此 repo 的 E2E/整合測試（OrdersEndToEndTests、OrdersGrpcServiceNetworkIntegrationTest）
#    可能需要外部服務（RabbitMQ/gRPC）——工作項不要以它們為驗收條件。
