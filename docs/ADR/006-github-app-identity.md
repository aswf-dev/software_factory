# ADR-006：agent 以 GitHub App 身分行動

- **狀態**：已接受
- **日期**：2026-08-16
- **決定者**：使用者裁決
- **對應**：`02-architecture.md` D6、`05-guardrails-governance.md` §3

## 脈絡

工廠 agent 需要一個 GitHub 身分來讀取 Issue、建立分支與 PR、留言回報。可選方案有三：個人 PAT、GitHub App、或 Actions 內建的 `GITHUB_TOKEN`。

`00-source-summary.md` §5 的前提是「**agents are new insiders**」——內部人風險的治理首要條件是**能分辨誰做了什麼**。

## 決策

**使用專屬的 GitHub App**（安裝於目標 repo）作為 agent 身分。不使用個人 PAT，不共用人類帳號。

### 權限設定（最小化，且刻意排除自我修改能力）

| 權限 | 等級 | 理由 |
|---|---|---|
| Contents | Read & write | 建立分支、推送 commit |
| Pull requests | Read & write | 建立與更新 PR |
| Issues | Read & write | 讀取工作項、回報進度與 `needs-human` |
| Actions | Read | 讀取自身 run 狀態 |
| Metadata | Read | 必要基礎權限 |
| **Administration** | **不授予** | 否則 agent 可改 branch protection |
| **Workflows** | **不授予** | 否則 agent 可改 CI 定義 |

## 後果

### 正面
- **稽核可辨識**：Issue 留言、commit、PR 都能明確區分「人做的」與「agent 做的」。
- **權限可收斂**：以安裝範圍授予，與任何個人的權限脫鉤。
- **憑證短效**：以 installation token 運作，隨 run 結束失效，不需長期存放高權限密鑰。
- **身分屬於系統而非個人**：成員離職或換人不影響工廠運作。
- **機制執行 ADR-004 的核心不變量**：排除 Administration 與 Workflows 使 agent 在**機制上**無法修改 guardrail，不依賴提示層的自律。

### 負面
- 建立與安裝 App **必須由人類手動完成，不可自動化**（`09` 第 1 期工作項 1.1）。
- App 的 private key 是本系統**最敏感的單一密鑰**——持有者可取得 agent 全部權限。
- CI 中需多一步換取 installation token。

### 中性
- private key 只存於 GitHub Secrets，不存於任何開發者本機；疑似外洩時立即撤銷重簽。

## 替代方案

### A. 個人 PAT（如 `philipz` 的 token）
**未採用的理由**：
- **稽核失效**——`philipz` 的操作與 agent 的操作在歷程中無法分辨，這使 `00` §5 的追責前提直接崩潰。
- 權限與個人綁定，難以最小化（PAT 的範圍通常遠大於所需）。
- 個人離職或輪替 token 時工廠即中斷。

### B. Actions 內建 `GITHUB_TOKEN`
**未採用的理由**：
- 權限受限於單一 workflow run 的範圍，**無法觸發其他 workflow**（GitHub 的刻意設計，防止遞迴）。工廠的 PR 需要觸發 CI 檢查，此限制是硬阻塞。
- 身分顯示為 `github-actions[bot]`，與其他自動化混雜，稽核辨識度低於專屬 App。

### C. 專屬機器人使用者帳號（machine user）
**未採用的理由**：需佔用一個付費席次；且仍是「使用者」，權限模型不如 App 精細；token 為長效，輪替負擔較高。

## 實作注意

CI 中以標準做法換取短效 token：

```yaml
- name: Mint app token
  id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.FACTORY_APP_ID }}
    private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
```

> ⚠️ action 版本與輸出欄位名稱待實作驗證（Q04-4 相關）。
