/**
 * final whole-branch review 修正波 1 的 workflow 接線測試（C2／I1／I2／I3）。
 *
 * 這些都是安全屬性，不是功能：寫錯不會有功能症狀，只會在公開 log 洩漏 Issue
 * 內容、讓 agent 覆寫自己的行為準則，或讓「不 push」只停留在 prompt 層。
 * 因此除了解析 workflow 結構，關鍵步驟直接以 bash 執行（node／gh／dsh 以 stub
 * 取代），斷言捕捉到的 log。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/factory-run.yml'

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

function steps(): Step[] {
  const wf = load(readFileSync(join(ROOT, WORKFLOW), 'utf8')) as { jobs: { run: { steps: Step[] } } }
  return wf.jobs.run.steps
}

function stepByName(name: string): Step {
  const step = steps().find((s) => s.name === name)
  expect(step, `workflow 缺少步驟：${name}`).toBeDefined()
  return step as Step
}

function stepById(id: string): Step {
  const step = steps().find((s) => s.id === id)
  expect(step, `workflow 缺少 id: ${id}`).toBeDefined()
  return step as Step
}

function indexByName(name: string): number {
  return steps().findIndex((s) => s.name === name)
}

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const value = values[expr]
    if (value === undefined) throw new Error(`測試未提供 \${{ ${expr} }} 的值`)
    return value
  })
}

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  log: string
  dir: string
}

interface RunOptions {
  /** step 的 `env:`（已在呼叫端代入 `${{ }}`）。 */
  env?: Record<string, string>
  /** `${{ }}` 的值。 */
  values?: Record<string, string>
  /** node stub 的 bash 內容（`$1` 為腳本路徑）。 */
  node?: string
  /** gh stub 的 bash 內容。 */
  gh?: string
  /** 執行前的檔案配置（在暫存目錄內）。 */
  setup?: (dir: string) => void
}

/** 在暫存目錄執行一個 step 的 run script；node／gh 以 stub 取代，jq 用真的。 */
function runStep(step: Step, opts: RunOptions = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'verify-hardening-step-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'home'))
  mkdirSync(join(dir, 'runner_temp'))
  // R25：agent token 經 $RUNNER_TEMP 的 600 檔傳遞；測試預設放一個有效值。
  writeFileSync(join(dir, 'runner_temp/agent-gh-token'), 'test-agent-token')
  const stub = (name: string, body: string): void => {
    const path = join(bin, name)
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(path, 0o755)
  }
  stub('node', opts.node ?? 'exit 0')
  stub('gh', opts.gh ?? 'exit 0')
  // macOS 沒有 GNU timeout；Actions runner 有。以透明 stub 執行被包裹的命令。
  stub(
    'timeout',
    [
      'while [ $# -gt 0 ]; do',
      '  case "$1" in --signal=*|--kill-after=*|-k|--preserve-status|--foreground) shift ;; *) break ;; esac',
      'done',
      'shift || true',
      'exec "$@"',
    ].join('\n'),
  )
  opts.setup?.(dir)
  const script = substitute(step.run ?? '', opts.values ?? {})
  const env: Record<string, string> = {
    ...process.env,
    HOME: join(dir, 'home'),
    GITHUB_WORKSPACE: dir,
    GITHUB_ENV: join(dir, 'github_env'),
    GITHUB_OUTPUT: join(dir, 'github_output'),
    RUNNER_TEMP: join(dir, 'runner_temp'),
    STUB_DIR: dir,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  }
  for (const [key, value] of Object.entries(step.env ?? {})) {
    try {
      env[key] = substitute(value, opts.values ?? {})
    } catch {
      // token 等測試不需要的運算式
    }
  }
  Object.assign(env, opts.env ?? {})
  const r = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', env })
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    log: `${r.stdout}${r.stderr}`,
    dir,
  }
}

/** 寫入檔案（含父目錄）。 */
function writeFile(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

/* ------------------------------------------------------------------ C2 */

describe('C2：workflow 在 agent 之前記錄不可變 diff 基準', () => {
  const baseShaStep = (): Step => stepByName('Record immutable diff base (verify only)')

  it('只在驗證模式執行、緊接在 agent 之前，從 target 的 HEAD 取得 commit', () => {
    const base = baseShaStep()
    expect(base.if).toBe("steps.verifymode.outputs.verify == 'true'")
    const script = base.run ?? ''
    expect(script).toContain('rev-parse HEAD')
    expect(script).toContain('$GITHUB_WORKSPACE/target')
    // 寫在 target 外：agent 的 sandbox root 是 target/，寫不到這份檔案
    expect(script).toContain('$GITHUB_WORKSPACE/.factory/base-sha')
    const agent = indexByName('Run factory agent')
    expect(indexByName('Record immutable diff base (verify only)')).toBe(agent - 1)
  })

  it('crosscheck 在驗證模式以 env 傳入 --base-sha；檔案缺失即 fail closed', () => {
    const step = stepById('crosscheck')
    expect(step.env?.['VERIFY_BASE_SHA']).toBe('${{ steps.basesha.outputs.sha }}')
    const script = step.run ?? ''
    expect(script).toContain('--base-sha $VERIFY_BASE_SHA')
    expect(script).toContain('$BASE_SHA_FLAG')
    // 驗證模式缺 base-sha 檔 → exit 1（不得退回分支名）
    expect(script).toMatch(/if \[ -z "\$\{VERIFY_BASE_SHA:-\}" \][\s\S]*?\.factory\/base-sha[\s\S]*?exit 1/)
    // 非驗證模式不得帶 --base-sha
    expect(script).toMatch(/else[\s\S]*?VARIANT_FLAG=/)
  })

  it('encrypt 在驗證模式以 env 傳入 --base-sha；缺檔即 fail closed', () => {
    const step = stepById('verify-encrypt')
    expect(step.env?.['VERIFY_BASE_SHA']).toBe('${{ steps.basesha.outputs.sha }}')
    const script = step.run ?? ''
    expect(script).toContain('--base-sha "$VERIFY_BASE_SHA"')
    expect(script).toMatch(/if \[ -z "\$\{VERIFY_BASE_SHA:-\}" \][\s\S]*?exit 1/)
  })
})

/* ------------------------------------------------------------------ I2 */

describe('I2a：驗證模式的 task template 一律來自機制 repo', () => {
  const agent = (): Step => stepByName('Run factory agent')

  it('agent 以 factory-task-template CLI 選模板，傳入 verify 模式', () => {
    const script = agent().run ?? ''
    expect(script).toContain('factory-task-template.js')
    expect(script).toContain('--verify "$VERIFY_MODE"')
    expect(agent().env?.['VERIFY_MODE']).toBe('${{ steps.verifymode.outputs.verify }}')
    // 舊的「target 優先」選法不得留下（它會讀 target/.github/factory 的覆寫模板）
    expect(script).not.toContain('TEMPLATE=".github/factory/task-template-')
  })

  it('verify header 不再宣告「模板優先於 header」（模板本身就是機制端固定檔）', () => {
    const script = agent().run ?? ''
    expect(script).not.toContain('本 header 與模板衝突時，以模板為準')
    expect(script).toContain('目標 repo 的模板覆寫在本模式不生效')
  })
})

describe('I2b：驗證模式在 agent 之前把 .dsh／.agents／AGENTS.md／CLAUDE.md 移開（R25）', () => {
  const neutralize = (): Step => stepByName('Neutralize target agent instructions (verify only)')

  it('只在驗證模式執行，且在 agent 之前', () => {
    expect(neutralize().if).toBe("steps.verifymode.outputs.verify == 'true'")
    expect(indexByName('Neutralize target agent instructions (verify only)')).toBeLessThan(
      indexByName('Run factory agent'),
    )
  })

  it('planted .dsh／.agents／AGENTS.md／CLAUDE.md 在 agent 之前全部移到 RUNNER_TEMP/away（不還原）', () => {
    const r = runStep(neutralize(), {
      env: { GITHUB_RUN_ID: 'fixture-run' },
      setup: (dir) => {
        writeFile(dir, 'target/.dsh/skills/x/SKILL.md', 'rank-100 shadow\n')
        writeFile(dir, 'target/.agents/skills/y/SKILL.md', 'rank-200 shadow\n')
        writeFile(dir, 'target/AGENTS.md', 'target agent instructions\n')
        writeFile(dir, 'target/CLAUDE.md', 'target claude instructions\n')
      },
    })
    expect(r.status, r.log).toBe(0)
    for (const rel of ['.dsh', '.agents', 'AGENTS.md', 'CLAUDE.md']) {
      expect(existsSync(join(r.dir, 'target', rel)), rel).toBe(false)
      expect(existsSync(join(r.dir, 'runner_temp/away', rel)), rel).toBe(true)
    }
    expect(readFileSync(join(r.dir, 'runner_temp/away/.dsh/skills/x/SKILL.md'), 'utf8')).toContain('rank-100 shadow')
    expect(readFileSync(join(r.dir, 'runner_temp/away/AGENTS.md'), 'utf8')).toContain('target agent instructions')
    expect(r.log).toContain('.dsh moved aside')
    expect(r.log).toContain('.agents moved aside')
    expect(r.log).toContain('AGENTS.md moved aside')
    expect(r.log).toContain('CLAUDE.md moved aside')
  })

  it('target 沒有這些路徑時是 no-op（可重跑）', () => {
    const r = runStep(neutralize(), {})
    expect(r.status, r.log).toBe(0)
    for (const rel of ['.dsh', '.agents', 'AGENTS.md', 'CLAUDE.md']) {
      expect(r.log).toContain(`${rel} absent`)
    }
  })

  it('agent 之後沒有任何步驟把它們搬回去', () => {
    const after = steps().slice(indexByName('Run factory agent'))
    for (const step of after) {
      expect(step.run ?? '', step.name).not.toMatch(/mv[^\n]*target\/(\.dsh|\.agents|AGENTS\.md|CLAUDE\.md)/)
    }
  })
})

/* ------------------------------------------------------------------ I3 */

describe('I3：驗證模式只把唯讀 App token 交給 agent（R25：空值 fail closed）', () => {
  const resolveToken = (): Step => stepById('agenttoken')
  const RO = '${{ steps.agent-token.outputs.token }}'
  const WRITE = '${{ steps.app-token.outputs.token }}'

  it('第二個 installation token 只在驗證模式 mint，權限是 contents／issues／metadata read', () => {
    const token = stepById('agent-token')
    expect(token.if).toBe("steps.verifymode.outputs.verify == 'true'")
    expect(token.uses).toContain('actions/create-github-app-token')
    expect(token.with?.['permission-contents']).toBe('read')
    expect(token.with?.['permission-issues']).toBe('read')
    expect(token.with?.['permission-metadata']).toBe('read')
    // 寫入權限的 token 仍保留給 workflow-only 步驟
    const write = stepById('app-token')
    expect(write.with?.['permission-contents']).toBe('write')
    expect(write.with?.['permission-issues']).toBe('write')
    expect(write.with?.['permission-pull-requests']).toBe('write')
  })

  it('R25：不再有 `verify == true && read-only || write` 的運算式，也沒有任何 `|| app-token` 回退', () => {
    const yaml = readFileSync(join(ROOT, WORKFLOW), 'utf8')
    expect(yaml).not.toMatch(/\|\|\s*steps\.app-token\.outputs\.token/)
    expect(yaml).not.toContain("steps.verifymode.outputs.verify == 'true' && steps.agent-token.outputs.token")
    // 解析後的 env 也不得殘留舊運算式
    for (const step of steps()) {
      for (const value of Object.values(step.env ?? {})) {
        expect(String(value)).not.toMatch(/\|\|\s*steps\.app-token\.outputs\.token/)
      }
    }
  })

  it('resolve token 步驟：兩個顯式分支；驗證模式的唯讀 token 為空 → exit 1', () => {
    const step = resolveToken()
    expect(step.env?.['VERIFY_MODE']).toBe('${{ steps.verifymode.outputs.verify }}')
    expect(step.env?.['READ_ONLY_TOKEN']).toBe(RO)
    expect(step.env?.['WRITE_TOKEN']).toBe(WRITE)
    const script = step.run ?? ''
    expect(script).toContain('if [ "$VERIFY_MODE" = "true" ]; then')
    expect(script).toContain('else')
    expect(script).toContain('唯讀 agent token 為空')
    expect(script).toContain('exit 1')
    // token 走 $RUNNER_TEMP 的 600 檔，不經 step output（後者遇到 secret 會被 runner 跳過）
    expect(script).toContain('agent-gh-token')
    expect(script).not.toContain('$GITHUB_OUTPUT')

    const empty = runStep(step, { env: { VERIFY_MODE: 'true', READ_ONLY_TOKEN: '', WRITE_TOKEN: 'write' } })
    expect(empty.status).not.toBe(0)
    expect(empty.log).toContain('唯讀 agent token 為空')
    expect(existsSync(join(empty.dir, 'runner_temp/agent-gh-token'))).toBe(false)

    const readOnly = runStep(step, {
      env: { VERIFY_MODE: 'true', READ_ONLY_TOKEN: 'ghs_read_only', WRITE_TOKEN: 'ghs_write' },
    })
    expect(readOnly.status, readOnly.log).toBe(0)
    expect(readFileSync(join(readOnly.dir, 'runner_temp/agent-gh-token'), 'utf8')).toBe('ghs_read_only')
    expect(readFileSync(join(readOnly.dir, 'runner_temp/agent-gh-token'), 'utf8')).not.toContain('ghs_write')

    const plain = runStep(step, {
      env: { VERIFY_MODE: 'false', READ_ONLY_TOKEN: '', WRITE_TOKEN: 'ghs_write' },
    })
    expect(plain.status, plain.log).toBe(0)
    expect(readFileSync(join(plain.dir, 'runner_temp/agent-gh-token'), 'utf8')).toBe('ghs_write')
  })

  it('agent 與 Write agent run env 都只從 resolve 後的 600 檔讀 token（不拼運算式）', () => {
    for (const name of ['Run factory agent', 'Write agent run env (token / base / repo)']) {
      const step = stepByName(name)
      expect(step.env?.['GH_TOKEN'], name).toBeUndefined()
      expect(step.run ?? '', name).toContain('agent-gh-token')
      expect(step.run ?? '', name).not.toContain('steps.app-token')
      expect(step.run ?? '', name).not.toContain('steps.agent-token')
    }
    // 實際執行：Write agent run env 從檔案讀到的值就是寫進 gh-token 的值
    const token = 'ghs_read_only_token_value'
    const r = runStep(stepByName('Write agent run env (token / base / repo)'), {
      values: {
        'inputs.base_branch': 'main',
        'inputs.repo': 'owner/name',
        'matrix.variant': 'a',
        'inputs.nversion': 'true',
        'inputs.verify_phase': 'statements',
      },
      setup: (dir) => {
        mkdirSync(join(dir, 'target'), { recursive: true })
        writeFileSync(join(dir, 'runner_temp/agent-gh-token'), token)
      },
    })
    expect(r.status, r.log).toBe(0)
    expect(readFileSync(join(r.dir, 'target/.factory/run/gh-token'), 'utf8')).toBe(token)
  })

  it('agent token 檔不存在 → 兩個消費步驟都 fail closed', () => {
    const writeEnv = runStep(stepByName('Write agent run env (token / base / repo)'), {
      values: {
        'inputs.base_branch': 'main',
        'inputs.repo': 'owner/name',
        'matrix.variant': 'a',
        'inputs.nversion': 'true',
        'inputs.verify_phase': 'statements',
      },
      setup: (dir) => {
        mkdirSync(join(dir, 'target'), { recursive: true })
        rmSync(join(dir, 'runner_temp/agent-gh-token'), { force: true })
      },
    })
    expect(writeEnv.status, writeEnv.log).not.toBe(0)
    expect(writeEnv.log).toContain('agent token 檔不存在')

    // agent 步驟含大量 ${{ }} 輸入，靜態釘住同一道 fail-closed 檢查即可
    const agent = stepByName('Run factory agent').run ?? ''
    expect(agent).toContain('agent-gh-token')
    expect(agent).toContain('agent token 檔不存在')
    expect(agent).toMatch(/if \[ ! -s "\$AGENT_TOKEN_FILE" \]; then[\s\S]*?exit 1/)
  })

  it('write token 的 push 探針在驗證模式跳過', () => {
    expect(stepByName('Verify app token write access (target repo)').if).toBe(
      "steps.verifymode.outputs.verify != 'true'",
    )
  })
})

/* ------------------------------------------------------------------ I1 */

const SECRET = 'ISSUE_DERIVED_SECRET_9f7e'

describe('I1：驗證模式 log 不印 Issue 內容', () => {
  it('Check issue format：驗證模式只印合規 boolean 與缺欄位名；非驗證模式逐字不變', () => {
    const step = stepByName('Check issue format (central enforcement)')
    const card = `❌ **Issue 格式不合規**（factory-issue-check）：缺 \`requirement\`。\n引用 Issue 內容：${SECRET}`
    const node = [
      'case "$1" in',
      "  *factory-verify-status.js) echo '{\"comment\":\"verify-status\"}'; exit 0 ;;",
      'esac',
      `printf '%s\\n' '${card}'`,
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--summary-out" ]; then shift; printf \'%s\' \'{"ok":false,"missing":["requirement","acceptance"]}\' > "$1"; fi',
      '  shift',
      'done',
      'exit 1',
    ].join('\n')
    const gh = [
      'case "$1 $2" in',
      '  "issue comment") while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$STUB_DIR/comment.md"; shift; done ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n')
    const values = {
      'steps.tasktype.outputs.value': 'agent-verify-quint',
      'inputs.issue_number': '12',
      'inputs.verify_phase': 'statements',
      'github.run_id': '424242',
      'steps.verifymode.outputs.verify': 'true',
      'github.server_url': 'https://github.com',
      'github.repository': 'aswf-dev/software_factory',
      'inputs.base_branch': 'main',
    }
    const verify = runStep(step, { node, gh, values, env: { VERIFY_MODE: 'true', VARIANT: 'a' } })
    expect(verify.status).not.toBe(0)
    expect(verify.stdout).toBe(
      [
        'issue format: ok=false missing=requirement,acceptance',
        '::error::Issue 格式不合規（factory-issue-check）——停止派工，請依留言修正後重新 dispatch',
        '',
      ].join('\n'),
    )
    expect(verify.log).not.toContain(SECRET)
    expect(readFileSync(join(verify.dir, 'comment.md'), 'utf8')).toBe('verify-status\n')

    const plain = runStep(step, {
      node: node.replace(/ --summary-out/g, ''),
      gh,
      values: { ...values, 'steps.verifymode.outputs.verify': 'false' },
      env: { VERIFY_MODE: 'false', VARIANT: 'a' },
    })
    // 非驗證模式：卡片逐字照印（既有輸出不變——byte-identical）
    expect(plain.stdout).toBe(
      [
        card,
        '::error::Issue 格式不合規（factory-issue-check）——停止派工，請依留言修正後重新 dispatch',
        '',
      ].join('\n'),
    )
    expect(plain.stdout).toContain(SECRET)
    expect(readFileSync(join(plain.dir, 'comment.md'), 'utf8')).toBe(`${card}\n`)
  })

  it('Select model tier：驗證模式只印 tier id；非驗證模式逐字不變', () => {
    const modelJson = `{"tier":"high","complexitySource":"issue-analysis","evidence":["${SECRET}"],"chain":[{"provider":"p","model":"m"}]}`
    const node = [`case "$1" in`, `  *factory-model.js) printf '%s\\n' '${modelJson}' ;;`, 'esac'].join('\n')
    const gh = ['case "$1 $2" in', '  "issue view") echo \'{"body":"issue body"}\' ;;', '  *) exit 0 ;;', 'esac'].join('\n')
    const values = {
      'steps.specphase.outputs.phase': '',
      'steps.verifymode.outputs.requires_catalog': 'true',
      'steps.verifymode.outputs.verify': 'false',
      'inputs.issue_number': '12',
      'inputs.model_tier': 'auto',
      'inputs.model_provider': 'auto',
      'matrix.variant': 'a',
      'inputs.nversion': 'false',
    }
    const verify = runStep(stepByName('Select model tier'), {
      node,
      gh,
      values: { ...values, 'steps.verifymode.outputs.requires_catalog': 'false' },
      env: { VERIFY_MODE: 'true' },
      setup: (dir) => mkdirSync(join(dir, '.factory'), { recursive: true }),
    })
    expect(verify.status, verify.log).toBe(0)
    expect(verify.stdout).toBe(
      [
        '驗證模式：不讀初始計分（ADR-029 §6），模型 tier 由 Issue 內容判定',
        'model tier selected: high',
        'N-version 已關閉：使用 tier 原本的模型鏈',
        'variant a chain: p/m',
        'variant a prioritized chain model: p/m',
        '',
      ].join('\n'),
    )
    expect(verify.log).not.toContain(SECRET)

    const plain = runStep(stepByName('Select model tier'), {
      node,
      gh,
      values,
      env: { VERIFY_MODE: 'false' },
      setup: (dir) => mkdirSync(join(dir, '.factory'), { recursive: true }),
    })
    expect(plain.stdout).toBe(
      [
        modelJson,
        'model tier selected: high (issue-analysis)',
        'N-version 已關閉：使用 tier 原本的模型鏈',
        'variant a chain: p/m',
        'variant a prioritized chain model: p/m',
        '',
      ].join('\n'),
    )
    expect(plain.stdout).toContain(SECRET)
  })

  it('agent 失敗時：驗證模式只印 stop reason／attempt；非驗證模式仍印 ERROR_LINE', () => {
    const modelJson =
      '{"tier":"high","chain":[{"provider":"p","model":"m"}],"dual":[{"provider":"p","model":"m"},{"provider":"q","model":"n"}]}'
    const node = [
      'case "$1" in',
      '  *factory-skills-lock.js)',
      '    printf "%s" "$*" | grep -q -- "--verify" && { echo \'{"ok":true,"digest":"d","modelPins":[]}\'; exit 0; }',
      '    echo \'{"excluded":[]}\'; exit 0 ;;',
      '  *factory-task-template.js)',
      '    echo "{\\"template\\":\\"$STUB_DIR/.github/factory/task-template-fix-bug.txt\\",\\"source\\":\\"mechanism\\",\\"fallback\\":false}"; exit 0 ;;',
      '  *factory-attempt-classify.js)',
      `    echo '{"outcome":"agent-error","fallback":false,"errorLine":"${SECRET}"}'; exit 0 ;;`,
      '  *) exit 0 ;;',
      'esac',
    ].join('\n')
    const dsh = ['#!/usr/bin/env bash', `echo "${SECRET}" >&2`, 'exit 1'].join('\n')
    const values = {
      'inputs.dry_run': 'false',
      'inputs.dry_run_scenario': '',
      'inputs.issue_number': '12',
      'inputs.repo': 'owner/name',
      'inputs.base_branch': 'main',
      'matrix.variant': 'a',
      'inputs.nversion': 'false',
      'steps.specphase.outputs.phase': '',
      'steps.specphase.outputs.spec_name': '',
      'inputs.verify_phase': 'statements',
      'steps.agent-timeout.outputs.effective_minutes': '1',
      'steps.verifymode.outputs.verify': 'false',
    }
    const setup = (dir: string): void => {
      mkdirSync(join(dir, '.factory'), { recursive: true })
      writeFile(dir, '.factory/model.json', `${modelJson}\n`)
      writeFile(dir, '.github/factory/task-template-fix-bug.txt', 'DUMMY TEMPLATE\n')
      writeFile(dir, '.dsh/skills/factory-workflow/SKILL.md', '# skill\n')
      writeFile(dir, 'target/.factory/run/.keep', '')
      writeFile(dir, 'node_modules/.bin/dsh', dsh)
      chmodSync(join(dir, 'node_modules/.bin/dsh'), 0o755)
    }
    const verify = runStep(stepByName('Run factory agent'), {
      node,
      values,
      env: { VERIFY_MODE: 'true', TASK_TYPE: 'agent-fix-bug' },
      setup,
    })
    expect(verify.status, verify.log).toBe(0)
    expect(verify.log).toContain('::warning::provider=p/m 失敗（agent-error），attempt=1')
    expect(verify.log).not.toContain(SECRET)

    const plain = runStep(stepByName('Run factory agent'), {
      node,
      values,
      env: { VERIFY_MODE: 'false', TASK_TYPE: 'agent-fix-bug' },
      setup,
    })
    expect(plain.status, plain.log).toBe(0)
    expect(plain.log).toContain(`::warning::provider=p/m 失敗（agent-error）：${SECRET}`)
  })
})

/* ------------------------------------------------------------------ R25 */

describe('R25：verify 事實改由 clean repo 產生（factory-verify-facts）', () => {
  const factsStep = (): Step => stepByName('Materialise verify facts (clean repo)')

  it('步驟在 agent 之後、crosscheck／encrypt 之前，且 agent 失敗時仍可取部分事實', () => {
    expect(factsStep().if).toContain('always()')
    expect(factsStep().if).toContain("steps.verifymode.outputs.verify == 'true'")
    expect(factsStep().if).toContain("steps.agent.outcome == 'success' || steps.agent.outcome == 'failure'")
    const facts = indexByName('Materialise verify facts (clean repo)')
    expect(facts).toBeGreaterThan(indexByName('Run factory agent'))
    expect(facts).toBeLessThan(indexByName('Cross-check report vs git diff'))
    expect(facts).toBeLessThan(indexByName('Encrypt verify artifacts (age)'))
  })

  it('呼叫 factory-verify-facts，輸出在 target 外（.factory/verify-facts.json），缺 base-sha 即 fail closed', () => {
    const script = factsStep().run ?? ''
    expect(script).toContain('dist/cli/factory-verify-facts.js')
    expect(script).toContain('--target "$GITHUB_WORKSPACE/target"')
    expect(script).toContain('--base-sha "$VERIFY_BASE_SHA"')
    expect(script).toContain('--out "$GITHUB_WORKSPACE/.factory/verify-facts.json"')
    expect(script).not.toContain('--out "$GITHUB_WORKSPACE/target')
    expect(script).toMatch(/if \[ -z "\$\{VERIFY_BASE_SHA:-\}" \][\s\S]*?\.factory\/base-sha[\s\S]*?exit 1/)
    expect(factsStep().env?.['VERIFY_BASE_SHA']).toBe('${{ steps.basesha.outputs.sha }}')
  })

  it('crosscheck 在驗證模式帶 --facts（且不帶時仍維持舊相容路徑）', () => {
    const script = stepById('crosscheck').run ?? ''
    expect(script).toContain('FACTS_FLAG="--facts .factory/verify-facts.json"')
    expect(script).toContain('if [ "$VERIFY_MODE" = "true" ]; then')
    expect(script).toContain('$FACTS_FLAG')
    expect(script).toMatch(/if \[ ! -s "\$GITHUB_WORKSPACE\/\.factory\/verify-facts\.json" \][\s\S]*?exit 1/)
  })

  it('encrypt 帶 --facts，且缺 facts 檔即 fail closed（不回退 target 內的 git）', () => {
    const script = stepById('verify-encrypt').run ?? ''
    expect(script).toContain('--facts "$GITHUB_WORKSPACE/.factory/verify-facts.json"')
    expect(script).toMatch(/if \[ ! -s "\$GITHUB_WORKSPACE\/\.factory\/verify-facts\.json" \][\s\S]*?exit 1/)
  })
})
