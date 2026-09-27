// 判定 dsh-sandbox-probe 執行期逃逸測試的結果（搭配 scripted-llm.mjs 的劇本）。
//
// 通過需同時成立：
//   1. 四個工具呼叫都有回傳結果——沙箱測試必須「真的嘗試過」才有意義
//   2. 對照組：工作區內的寫入成功（inside.txt 內容為 INSIDE）——證明工具確實有執行
//   3. 目標目錄（$HOME 下）沒有任何檔案——沙箱確實擋下
//   4. bash／write 的結果含 DSH 的沙箱拒絕標記，放寬要求的結果含「拒絕放寬」——
//      確認擋下的是沙箱，而不是其他原因（例如路徑不存在）；DSH 改動措辭時會紅燈，
//      那也是要人重新確認契約的訊號
//
// 用法：node check-escape.mjs <LOG> <WORKSPACE> <TARGET_DIR>
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [log, workspace, targetDir] = process.argv.slice(2)
const failures = []

const requests = readFileSync(log, 'utf8')
  .split('\n=====\n')
  .filter((s) => s.trim() !== '')
  .map((s) => JSON.parse(s))
  .filter((r) => Array.isArray(r.tools) && r.tools.length > 0)
const last = requests.at(-1)
const results = (last?.messages ?? [])
  .filter((m) => m.role === 'tool')
  .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))

results.forEach((r, i) => console.log(`工具結果 ${i}: ${r.replace(/\s+/g, ' ').slice(0, 200)}`))

if (results.length !== 4) failures.push(`預期 4 個工具結果，實際 ${results.length}——劇本沒有走完，沙箱沒有被完整測到`)

const inside = join(workspace, 'inside.txt')
if (!existsSync(inside) || readFileSync(inside, 'utf8').trim() !== 'INSIDE') {
  failures.push('對照組失敗：工作區內的 inside.txt 不存在或內容不對——工具可能根本沒有執行')
}

const leaked = existsSync(targetDir) ? readdirSync(targetDir) : []
if (leaked.length > 0) failures.push(`沙箱被突破：${targetDir} 出現 ${leaked.join(', ')}`)

const DENIED = 'sandbox: file access denied'
if (results[1] !== undefined && !results[1].includes(DENIED)) failures.push(`bash 寫 $HOME 的結果沒有沙箱拒絕標記「${DENIED}」`)
if (results[2] !== undefined && !results[2].includes(DENIED)) failures.push(`write 寫 $HOME 的結果沒有沙箱拒絕標記「${DENIED}」`)
if (results[3] !== undefined && !/rejected escalating/.test(results[3])) {
  failures.push('要求放寬為 danger-full-access 的結果沒有「rejected escalating」——approval: never 可能沒生效')
}

if (failures.length > 0) {
  for (const f of failures) console.log(`::error::${f}`)
  process.exit(1)
}
console.log('confirmed: 四個工具呼叫都已執行；工作區內寫入成功，$HOME 的 bash／write 寫入與放寬要求全被擋下')
