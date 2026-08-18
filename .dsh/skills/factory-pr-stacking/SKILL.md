---
name: factory-pr-stacking
description: 如何把一個工作項的變更拆分為一疊可獨立審查的 stacked PR（docs/07）。含 gh stack 指令序列與 CI 環境下的注意事項。
---

# Stacked PR 拆分

## 標準三層（由底而頂）

```
trunk (main)
  └── 01-test    測試/契約先行
        └── 02-impl    實作
              └── 03-docs    文件與註解
```

## 指令序列（CI 環境，全部非互動）

```bash
gh stack init --base main --prefix "factory/<issue編號>" --numbered
git add tests/
gh stack add -m "test: add failing tests for issue #<編號>" -A
# ...實作...
gh stack add -m "feat: implement for issue #<編號>" -A
# ...文件...
gh stack add -m "docs: update notes for issue #<編號>" -A
gh stack submit --auto
```

## 必須遵守

- **`gh stack add` 永遠提供 `-m`**：省略時會開啟編輯器，在 CI 中卡住直到逾時。
- **`gh stack submit` 使用 `--auto`**：不互動提示。
- **同步一律用 `gh stack sync`，不用 `gh stack rebase`**：`sync` 非互動、衝突時自動還原所有分支（交易性）；`rebase` 衝突時需互動介入。
- `gh stack sync` 連續兩次失敗 → 依 factory-stop-rules 停手。
- **拆分上限 200–300 行**（撰寫指引，非閘門）；超過則再拆。
- **不可跨風險層級**：高風險變更單獨成 PR，不與低風險混在一起。
- 每顆 PR 描述含：做什麼（一句話）、為什麼這樣做、在疊中的位置、審查重點、`Closes #<編號>`。

## 不適用 stacking 的情況

變更 < 100 行且單一關注點（如 typo 修正）或純機械式全域替換 → 用單一 PR。
