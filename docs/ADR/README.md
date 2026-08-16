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
| [ADR-001](001-github-as-source-of-truth.md) | GitHub 為唯一事實來源，Backstage 為入口 | 已接受 | D1 |
| [ADR-002](002-dsh-headless-execution.md) | agent 執行走 DSH headless 一次性呼叫 | 已接受 | D2 |
| [ADR-003](003-stacked-pr.md) | 一個工作項 = 一疊 stacked PR | 已接受 | D3 |
| [ADR-004](004-dual-layer-guardrails.md) | 雙層 guardrail（DSH 層 + GitHub 層） | 已接受 | D4 |
| [ADR-005](005-autonomy-ceiling.md) | 自主性上限設為 on-the-loop 低風險類別 | 已接受 | D5 |
| [ADR-006](006-github-app-identity.md) | agent 以 GitHub App 身分行動 | 已接受 | D6 |
| [ADR-007](007-github-actions-ci.md) | CI 平台採用 GitHub Actions | 已接受 | D7 |

## 何時該寫新的 ADR

- 決策會影響多個模組或平面
- 決策難以逆轉，或逆轉成本高
- 曾認真考慮過其他選項
- 未來的人可能會問「當初為什麼這樣做？」

反之，可逆的、局部的、顯而易見的決定不需要 ADR。
