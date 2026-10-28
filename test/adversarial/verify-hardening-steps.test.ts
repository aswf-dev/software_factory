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

describe('I2b：驗證模式在 agent 之前把 target/.dsh 移開', () => {
  const dsh = (): Step => stepByName('Neutralize target workspace skills (verify only)')

  it('只在驗證模式執行，且在 agent 之前', () => {
    expect(dsh().if).toBe("steps.verifymode.outputs.verify == 'true'")
    expect(indexByName('Neutralize target workspace skills (verify only)')).toBeLessThan(
      indexByName('Run factory agent'),
    )
  })

  it('planted target/.dsh/skills/x/SKILL.md 在 agent 之前消失（移到 RUNNER_TEMP，不還原）', () => {
    const r = runStep(dsh(), {
      env: { GITHUB_RUN_ID: 'fixture-run' },
      setup: (dir) => writeFile(dir, 'target/.dsh/skills/x/SKILL.md', 'rank-100 shadow\n'),
    })
    expect(r.status, r.log).toBe(0)
    expect(existsSync(join(r.dir, 'target/.dsh'))).toBe(false)
    expect(existsSync(join(r.dir, 'runner_temp/target-dsh-fixture-run'))).toBe(true)
    expect(readFileSync(join(r.dir, 'runner_temp/target-dsh-fixture-run/skills/x/SKILL.md'), 'utf8')).toContain(
      'rank-100 shadow',
    )
    expect(r.log).toContain('target .dsh moved aside')
  })

  it('target 沒有 .dsh 時是 no-op（可重跑）', () => {
    const r = runStep(dsh(), {})
    expect(r.status, r.log).toBe(0)
    expect(r.log).toContain('target .dsh absent')
  })

  it('agent 之後沒有任何步驟把它搬回去', () => {
    const after = steps().slice(indexByName('Run factory agent'))
    for (const step of after) {
      expect(step.run ?? '', step.name).not.toMatch(/mv[^\n]*target\/\.dsh/)
    }
  })
})

/* ------------------------------------------------------------------ I3 */

describe('I3：驗證模式只把唯讀 App token 交給 agent', () => {
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

  it('agent 的 gh-token 在驗證模式來自唯讀 token；非驗證模式維持寫入 token', () => {
    const step = stepByName('Write agent run env (token / base / repo)')
    const expr = step.env?.['GH_TOKEN'] ?? ''
    expect(expr).toContain('steps.agent-token.outputs.token')
    expect(expr).toContain('steps.app-token.outputs.token')
    expect(expr).toContain("steps.verifymode.outputs.verify == 'true'")

    // 實際執行：step 拿到的 GH_TOKEN 就是寫進 gh-token 的值（read-only 版本由上面的運算式決定）
    const token = 'ghs_read_only_token_value'
    const r = runStep(step, {
      env: { GH_TOKEN: token },
      values: {
        'inputs.base_branch': 'main',
        'inputs.repo': 'owner/name',
        'matrix.variant': 'a',
        'inputs.nversion': 'true',
        'inputs.verify_phase': 'statements',
      },
      setup: (dir) => mkdirSync(join(dir, 'target'), { recursive: true }),
    })
    expect(r.status, r.log).toBe(0)
    expect(readFileSync(join(r.dir, 'target/.factory/run/gh-token'), 'utf8')).toBe(token)
  })

  it('write token 的 push 探針在驗證模式跳過', () => {
    expect(stepByName('Verify app token write access (target repo)').if).toBe(
      "steps.verifymode.outputs.verify != 'true'",
    )
  })

  it('agent 步驟的 GH_TOKEN 在驗證模式也是唯讀 token', () => {
    const expr = stepByName('Run factory agent').env?.['GH_TOKEN'] ?? ''
    expect(expr).toContain('steps.agent-token.outputs.token')
    expect(expr).toContain("steps.verifymode.outputs.verify == 'true'")
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
