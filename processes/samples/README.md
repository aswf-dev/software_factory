# Sample systems (synthetic)

這些檔案讓 `factory-snapshot` 管線可以端到端跑通，**不是**真實納管：

| 檔案 | 用途 |
|---|---|
| `payment-platform.yaml` | 系統級 `process.yaml`（scale M、template M，對應 canonical fixture） |
| `payment-platform.modules.yaml` | 模組級清單（billing／settlement，readiness 附 evidence） |
| `payment-platform.issues.json` | 離線模式用的 `gh issue list` 等價資料（3 張工單，含 `> 流程步驟：M10/M11/M12`） |
| `payment-platform.comments.json` | 離線模式用的 tracking issue 留言（HG2 signed） |
| `example-portal.yaml` | 採用範例租戶模板 `example/review-first@1` 的系統（示範租戶流程） |
| `example-portal.modules.yaml` | 範例系統的模組清單（accounts／notifications） |
| `example-portal.issues.json` | 離線工單（3 張，`> 流程步驟：E1/E3/E4`） |
| `example-portal.comments.json` | 離線留言（HG2 signed＋自訂閘門 `EXAMPLE-SECURITY` signed） |

規則：

1. `scale`／`readiness` 仍是**人類宣告**的欄位；這裡的值直接對應
   `docs/research/fixtures/factory-graph.sample.json`，不由程式推導。
2. 真實系統的 process spec 放 `processes/<system>.yaml`（不是 `samples/`），
   模組清單放目標 repo 的 `factory/process.yaml`。
3. `.github/workflows/factory-snapshot.yml` 發佈時會在 `index.json` 標 `sample: true`。
