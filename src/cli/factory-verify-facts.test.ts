/**
 * factory-verify-facts（R25／R26）：在 **clean repo** 裡materialise git 事實。
 *
 * 這些測試全部使用真實 git／rsync／tar，因為要釘住的正是「target 工作樹的
 * git 設定不再參與事實計算」：clean filter、assume-unchanged、skip-worktree、
 * 自我忽略的 .gitignore、被移到一旁的 agent instruction 檔，以及 **R26** 的
 * `.git/info/attributes`（export-ignore／export-subst）與建置產物。
 * 任何一個用 fake 都可以假綠。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  countDiffLines,
  extractBaseTree,
  isArtifactPath,
  isNeutralisedPath,
  isSafeTreePath,
  loadVerifyFacts,
  main,
  materialiseVerifyFacts,
  normalizeFactsBaseSha,
  parseArgs,
  parseCatFileBatch,
  parseLsTree,
  parseNameStatus,
  type VerifyFacts,
} from './factory-verify-facts.js'
import { main as crosscheckMain, parseArgs as crosscheckParseArgs, type GitRunner } from './factory-crosscheck.js'

const created: string[] = []
const originalRunnerTemp = process.env.RUNNER_TEMP
const originalGhToken = process.env.GH_TOKEN
const originalPath = process.env.PATH

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commitAll(repo: string, message: string): void {
  gitIn(repo, 'add', '-A')
  gitIn(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message)
}

/** 建立含 base 檔與「agent 不該看到」檔案的 repo；回傳 [repo, baseSha]。 */
function makeRepo(): { repo: string; baseSha: string } {
  const repo = tempDir('factory-facts-repo-')
  gitIn(repo, 'init', '-q', '-b', 'main')
  writeFile(repo, 'README.md', '# fixture\n')
  writeFile(repo, 'src/app.ts', 'export const answer = 42\n')
  writeFile(repo, 'src/skip.ts', 'export const skip = 1\n')
  writeFile(repo, 'test/existing.test.ts', "it('existing', () => {})\n")
  writeFile(repo, '.dsh/skills/factory-workflow/SKILL.md', 'mechanism skill\n')
  writeFile(repo, '.agents/skills/x/SKILL.md', 'target agent skill\n')
  writeFile(repo, 'AGENTS.md', 'target instructions\n')
  writeFile(repo, 'CLAUDE.md', 'target claude instructions\n')
  writeFile(repo, 'docs/AGENTS.md', 'nested target instructions\n')
  writeFile(repo, 'AGENTS.local.md', 'target local instructions\n')
  writeFile(repo, 'CLAUDE.local.md', 'target local claude instructions\n')
  writeFile(repo, 'pkg/CLAUDE.md', 'nested claude instructions\n')
  writeFile(repo, 'pkg/AGENTS.local.md', 'nested local instructions\n')
  commitAll(repo, 'base')
  return { repo, baseSha: gitIn(repo, 'rev-parse', 'HEAD').trim() }
}

/** 把 clean filter 安裝到 target：舊路徑（在 target 跑 git diff/status）會執行它。 */
function installCleanFilter(repo: string, marker: string): string {
  const script = join(tempDir('factory-facts-filter-'), 'evil-clean.sh')
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "\${GH_TOKEN:-}" > '${marker}'\ncat\n`)
  chmodSync(script, 0o755)
  gitIn(repo, 'config', 'filter.evil.clean', script)
  writeFileSync(join(repo, '.git/info/attributes'), '* filter=evil\n')
  return script
}

/** 把 neutralised 路徑移出 target（workflow 的 agent 之前步驟在做的事）。 */
function moveNeutralisedAside(repo: string): void {
  for (const rel of [
    '.dsh',
    '.agents',
    'AGENTS.md',
    'CLAUDE.md',
    'AGENTS.local.md',
    'CLAUDE.local.md',
    'docs/AGENTS.md',
    'pkg/CLAUDE.md',
    'pkg/AGENTS.local.md',
  ]) {
    rmSync(join(repo, rel), { recursive: true, force: true })
  }
}

function stubPath(stubName: string, body: string): { bin: string; restore: () => void } {
  const bin = tempDir(`factory-facts-bin-${stubName}-`)
  const path = join(bin, stubName)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  return { bin, restore: () => (process.env.PATH = originalPath) }
}

/** 只讓某個 git 子命令失敗，其餘照常轉給真正的 git（維持 base 擷取可運作）。 */
function stubGitFailingOn(subcommand: string): { bin: string; restore: () => void } {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  return stubPath(
    'git',
    [
      'for arg in "$@"; do',
      `  if [ "$arg" = "${subcommand}" ]; then echo "stubbed ${subcommand} failure" >&2; exit 1; fi`,
      'done',
      `exec '${realGit}' "$@"`,
    ].join('\n'),
  )
}

function pathWithoutGit(): () => void {
  const bin = tempDir('factory-facts-empty-bin-')
  process.env.PATH = bin
  return () => (process.env.PATH = originalPath)
}

function report(changedPaths: string[], changedLines: number, assertionDelta = 2): string {
  const dir = tempDir('factory-facts-report-')
  const path = join(dir, 'report.json')
  writeFileSync(
    path,
    JSON.stringify({
      issueNumber: 12,
      invocation: { exitCode: 0, stdout: 'DONE', stderr: '' },
      changedPaths,
      changedLines,
      assertionDelta,
    }),
  )
  return path
}

const factsOf = (partial: Partial<VerifyFacts> = {}): VerifyFacts => ({
  baseSha: 'a'.repeat(40),
  changed: [],
  linesAdded: 0,
  linesDeleted: 0,
  assertionDelta: 0,
  ...partial,
})

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP
  else process.env.RUNNER_TEMP = originalRunnerTemp
  if (originalGhToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalGhToken
  process.env.PATH = originalPath
})

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('R25：clean repo 事實不受 target 的 git 設定影響', () => {
  it('clean filter 不執行；assume-unchanged／skip-worktree／自我忽略仍回報；neutralised 路徑不進事實', async () => {
    const { repo, baseSha } = makeRepo()
    const runnerTemp = tempDir('factory-facts-runner-')
    process.env.RUNNER_TEMP = runnerTemp
    const marker = join(tempDir('factory-facts-marker-'), 'clean-filter-ran')

    // agent 的變更（tracked 修改故意用 index flag 藏起來）
    writeFile(repo, 'src/app.ts', 'export const answer = 42\nexport const changed = true\n')
    writeFile(repo, 'src/skip.ts', 'export const skip = 1\nexport const skipChanged = true\n')
    writeFile(repo, 'test/existing.test.ts', "it('existing', () => { expect(1).toBe(1) })\n")
    writeFile(repo, 'test/new.test.ts', "it('new', () => { expect(2).toBe(2) })\n")
    writeFile(repo, 'src/.gitignore', '*\n')
    writeFile(repo, 'src/out-of-scope.ts', 'export const hidden = 1\n')
    gitIn(repo, 'update-index', '--assume-unchanged', 'src/app.ts')
    gitIn(repo, 'update-index', '--skip-worktree', 'src/skip.ts')
    moveNeutralisedAside(repo)
    // clean filter 必須在 index flags 設定之後才安裝：update-index 本身可能為了
    // 比對 stat 而跑 filter，那是測試 fixture 的動作，不是 facts 的事實推導。
    installCleanFilter(repo, marker)
    expect(existsSync(marker), 'before materialise').toBe(false)

    process.env.GH_TOKEN = 'ghs_sentinel_clean_filter'
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = await materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    // clean filter 從未被執行（marker 不存在），即使 target 的 .git/info/attributes 有 `* filter=evil`
    expect(existsSync(marker)).toBe(false)

    // 反向證明 fixture 有效：真的在 target 跑一次 git diff，filter 就會留下 marker。
    gitIn(repo, 'diff', '--name-only', baseSha)
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('ghs_sentinel_clean_filter')
    rmSync(marker)

    const changed = [...facts.changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    expect(changed).toEqual([
      { path: 'src/.gitignore', status: 'A' },
      { path: 'src/app.ts', status: 'M' },
      { path: 'src/out-of-scope.ts', status: 'A' },
      { path: 'src/skip.ts', status: 'M' },
      { path: 'test/existing.test.ts', status: 'M' },
      { path: 'test/new.test.ts', status: 'A' },
    ])
    expect(facts.linesAdded).toBe(6)
    expect(facts.linesDeleted).toBe(1)
    expect(facts.assertionDelta).toBe(2)
    // neutralised 路徑（tracked 的刪除）不進事實
    const paths = facts.changed.map((c) => c.path)
    for (const hidden of ['.dsh/', '.agents/', 'AGENTS.md', 'CLAUDE.md']) {
      expect(paths.some((p) => p === hidden || p.startsWith(hidden))).toBe(false)
    }

    // JSON round-trip：寫出的檔與回傳值一致
    expect(loadVerifyFacts(out)).toEqual(facts)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(facts)

    // crosscheck 只消費 facts：任何 git 呼叫都會 throw；仍看得到被 clean filter 藏的 src/app.ts
    const expectedPaths = ['src/.gitignore', 'src/app.ts', 'src/out-of-scope.ts', 'src/skip.ts', 'test/existing.test.ts', 'test/new.test.ts']
    const never: GitRunner = () => {
      throw new Error('verify 模式帶 --facts 時不得對 target 跑任何 git 命令（R25）')
    }
    const reportPath = report(expectedPaths, 6)
    const outCrosscheck = crosscheckMain(
      ['12', reportPath, '--target', repo, '--verify-only', '--base-sha', baseSha, '--facts', out],
      never,
    )
    expect(outCrosscheck.actual).toEqual({
      branches: [],
      paths: expectedPaths,
      added: 6,
      deleted: 1,
      uncommitted: [],
      assertionDelta: 2,
    })
    expect(outCrosscheck.ok).toBe(false)
    const scope = outCrosscheck.mismatches.find((m) => m.kind === 'verify-scope')
    expect(scope?.detail).toContain('src/app.ts')
    // crosscheck 也沒有再執行 clean filter
    expect(existsSync(marker)).toBe(false)
  })

  it('R20：agent 的 `git replace <base> HEAD` 不得讓 base 擷取變成 agent 的樹', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    writeFile(repo, 'src/app.ts', 'export const answer = 42\nexport const replaced = true\n')
    commitAll(repo, 'agent commit on base branch')
    const agentHead = gitIn(repo, 'rev-parse', 'HEAD').trim()
    gitIn(repo, 'replace', baseSha, agentHead)
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })
    // replace 若生效，base 擷取會等於 agent 的樹 → src/app.ts 的變更消失。
    expect(facts.changed).toContainEqual({ path: 'src/app.ts', status: 'M' })
    expect(facts.linesAdded).toBe(1)
  })

  it('tracked .dsh／.agents 的刪除不產生 scope red（crosscheck 綠）', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = await materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })
    expect(facts.changed).toEqual([])

    const outCrosscheck = crosscheckMain(
      ['12', report([], 0), '--target', repo, '--verify-only', '--base-sha', baseSha, '--facts', out],
      () => {
        throw new Error('no git')
      },
    )
    expect(outCrosscheck.mismatches).toEqual([])
    expect(outCrosscheck.ok).toBe(true)
  })

  it('crosscheck 防禦性過濾 facts 裡的 neutralised 路徑（舊 facts 也不得 red）', () => {
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    writeFileSync(
      out,
      JSON.stringify(
        factsOf({
          changed: [
            { path: '.dsh/skills/x/SKILL.md', status: 'D' },
            { path: 'AGENTS.md', status: 'D' },
            { path: 'test/new.test.ts', status: 'A' },
          ],
          linesAdded: 1,
        }),
      ),
    )
    const outCrosscheck = crosscheckMain(
      ['12', report(['test/new.test.ts'], 1), '--target', tempDir('factory-facts-target-'), '--verify-only', '--base-sha', 'a'.repeat(40), '--facts', out],
      () => {
        throw new Error('no git')
      },
    )
    expect(outCrosscheck.actual.paths).toEqual(['test/new.test.ts'])
    expect(outCrosscheck.ok).toBe(true)
  })
})

describe('R25：crosscheck 的 --base-sha 必須與 facts.baseSha 相符', () => {
  it('mismatch → CliError（不得默默採用其中一個基準）', () => {
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    writeFileSync(out, JSON.stringify(factsOf({ baseSha: 'b'.repeat(40) })))
    expect(() =>
      crosscheckMain(
        ['12', report([], 0), '--target', 'target', '--verify-only', '--base-sha', 'a'.repeat(40), '--facts', out],
        () => {
          throw new Error('no git')
        },
      ),
    ).toThrow(/base-sha.*facts|facts.*base-sha/i)
  })

  it('parseArgs：--facts 只適用於 --verify-only，且需要 --base-sha', () => {
    const out = 'facts.json'
    const sha = 'a'.repeat(40)
    expect(
      crosscheckParseArgs(['12', 'r.json', '--verify-only', '--base-sha', sha, '--facts', out]).factsPath,
    ).toBe(out)
    expect(() => crosscheckParseArgs(['12', 'r.json', '--facts', out])).toThrow(/--verify-only/)
    expect(() => crosscheckParseArgs(['12', 'r.json', '--verify-only', '--facts', out])).toThrow(/--base-sha/)
    expect(() => crosscheckParseArgs(['12', 'r.json', '--verify-only', '--base-sha', sha, '--facts'])).toThrow(
      /requires/,
    )
  })
})

describe('R25：facts 輸入的 fail closed 與純函式', () => {
  it('parseArgs：必要參數、空值、未知旗標、40-hex', () => {
    const sha = 'a'.repeat(40)
    expect(parseArgs(['--target', 't', '--base-sha', sha.toUpperCase(), '--out', 'o.json'])).toEqual({
      targetDir: 't',
      baseSha: sha,
      outFile: 'o.json',
    })
    expect(() => parseArgs(['--base-sha', sha, '--out', 'o.json'])).toThrow(/--target/)
    expect(() => parseArgs(['--target', 't', '--out', 'o.json'])).toThrow(/--base-sha/)
    expect(() => parseArgs(['--target', 't', '--base-sha', sha])).toThrow(/--out/)
    expect(() => parseArgs(['--target', '', '--base-sha', sha, '--out', 'o.json'])).toThrow(/--target/)
    expect(() => parseArgs(['--target', 't', '--base-sha', 'abc', '--out', 'o.json'])).toThrow(/40-hex/)
    expect(() => parseArgs(['--target', 't', '--base-sha', sha, '--out', 'o.json', '--nope'])).toThrow(
      /unknown/,
    )
    expect(() => parseArgs(['--target'])).toThrow(/requires/)
  })

  it('normalizeFactsBaseSha：trim／lowercase／拒絕簡短 SHA', () => {
    expect(normalizeFactsBaseSha(` ${'A'.repeat(40)} `)).toBe('a'.repeat(40))
    expect(() => normalizeFactsBaseSha('a'.repeat(39))).toThrow(/40-hex/)
  })

  it('isNeutralisedPath：任何 segment 的 .dsh／.agents 與四個 instruction 檔名', () => {
    for (const p of [
      '.dsh/skills/x/SKILL.md',
      '.agents/x',
      'nested/.dsh/x',
      'nested/AGENTS.md',
      'CLAUDE.md',
      'AGENTS.local.md',
      'nested/CLAUDE.local.md',
      'pkg/AGENTS.local.md',
    ]) {
      expect(isNeutralisedPath(p), p).toBe(true)
    }
    expect(isNeutralisedPath('src/app.ts')).toBe(false)
    expect(isNeutralisedPath('docs/agents.md')).toBe(false)
    expect(isNeutralisedPath('docs/AGENTS.md.bak')).toBe(false)
  })

  it('isArtifactPath：文件化的建置／產物目錄在任何深度；`.lake/build` 前綴', () => {
    for (const p of [
      'node_modules/pkg/index.js',
      'web/node_modules/pkg/index.js',
      '.venv/lib/python3.12/site.py',
      'venv/bin/python',
      'src/__pycache__/x.pyc',
      '.pytest_cache/v/cache/nodeids',
      '.mypy_cache/3.12/x.json',
      '.ruff_cache/0.1/x',
      '.gradle/caches/x',
      'coverage/lcov.info',
      'dist/app.js',
      'build/out.js',
      'target/debug/app',
      'specs/lean/.lake/build/lib/olean/Spec.olean',
      'nested/.lake/build/x',
    ]) {
      expect(isArtifactPath(p), p).toBe(true)
    }
    for (const p of ['src/coverage.ts', 'src/build.ts', 'docs/dist.md', 'specs/lean/.lake/packages/x', 'targets/x']) {
      expect(isArtifactPath(p), p).toBe(false)
    }
  })

  it('parseNameStatus：A/M/D/T、空輸入、未知狀態、缺 path', () => {
    expect(parseNameStatus('')).toEqual([])
    expect(parseNameStatus('A\0a\0M\0b\0D\0c\0T\0d\0')).toEqual([
      { path: 'a', status: 'A' },
      { path: 'b', status: 'M' },
      { path: 'c', status: 'D' },
      { path: 'd', status: 'M' },
    ])
    expect(() => parseNameStatus('R100\0a\0b\0')).toThrow(/未知的 diff 狀態/)
    expect(() => parseNameStatus('A\0')).toThrow(/缺 path/)
    // 沒有結尾 NUL：path token 是 undefined（不是空字串），同樣 fail closed
    expect(() => parseNameStatus('A')).toThrow(/缺 path/)
  })

  it('countDiffLines：只算 hunk 內 +/-；header 與 no-newline 不計；hunk 內的 ---/+++ 是內容', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+++ content that begins with plus plus',
      '--- content that begins with minus minus',
      '\\ No newline at end of file',
      'diff --git a/y b/y',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/y',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 3, deleted: 2 })
    expect(countDiffLines('')).toEqual({ added: 0, deleted: 0 })
    expect(countDiffLines('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual({
      added: 0,
      deleted: 0,
    })
    // hunk 外的 +/- 不計（例如 diff --git 標頭之間的雜訊）
    expect(countDiffLines('--- a/x\n+++ b/x\n')).toEqual({ added: 0, deleted: 0 })
  })

  it('loadVerifyFacts：合法檔、缺檔、非 JSON、形狀錯誤、路徑不安全、數字錯誤', () => {
    const dir = tempDir('factory-facts-load-')
    const good = join(dir, 'good.json')
    writeFileSync(good, JSON.stringify(factsOf({ changed: [{ path: 'test/x.test.ts', status: 'A' }], linesAdded: 2, assertionDelta: -1 })))
    expect(loadVerifyFacts(good)).toEqual(factsOf({ changed: [{ path: 'test/x.test.ts', status: 'A' }], linesAdded: 2, assertionDelta: -1 }))
    expect(() => loadVerifyFacts(join(dir, 'missing.json'))).toThrow(/無法讀取/)

    const bad = (value: string): string => {
      const path = join(dir, `bad-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(path, value)
      return path
    }
    expect(() => loadVerifyFacts(bad('not json'))).toThrow(/不是合法 JSON/)
    expect(() => loadVerifyFacts(bad('[]'))).toThrow(/必須是 JSON 物件/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), baseSha: 7 })))).toThrow(/baseSha/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), baseSha: 'nope' })))).toThrow(/40-hex/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), changed: {} })))).toThrow(/changed/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), changed: [7] })))).toThrow(/條目/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), changed: [{ status: 'A' }] })))).toThrow(/path/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), changed: [{ path: 'x', status: 'R' }] })))).toThrow(/status/)
    expect(() =>
      loadVerifyFacts(
        bad(
          JSON.stringify(
            factsOf({
              changed: [
                { path: 'a', status: 'A' },
                { path: 'a', status: 'M' },
              ],
            }),
          ),
        ),
      ),
    ).toThrow(/重複路徑/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), linesAdded: -1 })))).toThrow(/linesAdded/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), linesDeleted: 1.5 })))).toThrow(/linesDeleted/)
    expect(() => loadVerifyFacts(bad(JSON.stringify({ ...factsOf(), assertionDelta: 0.5 })))).toThrow(
      /assertionDelta/,
    )
    for (const unsafe of ['', '/abs', 'a\\b', 'a\0b', 'a//b', './a', 'a/../b', '.git/x']) {
      expect(
        () => loadVerifyFacts(bad(JSON.stringify(factsOf({ changed: [{ path: unsafe, status: 'A' }] })))),
        unsafe,
      ).toThrow(/path/)
    }
  })

  it('isSafeTreePath：拒絕空／絕對／NUL／空 segment／.／..／.git（含大小寫）', () => {
    expect(isSafeTreePath('src/app.ts')).toBe(true)
    expect(isSafeTreePath('a b/c\td')).toBe(true)
    for (const unsafe of ['', '/abs', 'a\0b', 'a//b', './a', 'a/../b', '.git/x', 'nested/.GIT/x']) {
      expect(isSafeTreePath(unsafe), unsafe).toBe(false)
    }
  })

  it('parseLsTree：mode／type／oid／path（含空白與 TAB 之後的 path）、空輸入、格式錯誤、不安全 path', () => {
    const oid = 'a'.repeat(40)
    expect(parseLsTree(Buffer.from(''))).toEqual([])
    expect(parseLsTree(Buffer.from(`100644 blob ${oid}\tdir/a b.ts\0`))).toEqual([
      { mode: '100644', type: 'blob', oid, path: 'dir/a b.ts' },
    ])
    expect(parseLsTree(Buffer.from(`160000 commit ${oid}\tvendor/lib\0`))).toEqual([
      { mode: '160000', type: 'commit', oid, path: 'vendor/lib' },
    ])
    expect(() => parseLsTree(Buffer.from(`100644 blob ${oid} no-tab`))).toThrow(/TAB/)
    expect(() => parseLsTree(Buffer.from(`nope\ta`))).toThrow(/格式不符/)
    expect(() => parseLsTree(Buffer.from(`100644 blob ${oid}\t../escape`))).toThrow(/不安全/)
  })

  it('parseCatFileBatch：二進位內容依 size 切、missing、格式錯誤、長度不足', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const content = Buffer.from('line1\nline2\0binary', 'utf8')
    const output = Buffer.concat([
      Buffer.from(`${a} blob ${content.length}\n`),
      content,
      Buffer.from('\n'),
      Buffer.from(`${b} blob 0\n\n`),
    ])
    expect(parseCatFileBatch(output, [a, b]).get(a)).toEqual(content)
    expect(parseCatFileBatch(output, [a, b]).get(b)).toEqual(Buffer.alloc(0))
    expect(() => parseCatFileBatch(Buffer.from(''), [a])).toThrow(/缺 header/)
    expect(() => parseCatFileBatch(Buffer.from(`${a} missing\n`), [a])).toThrow(/找不到/)
    expect(() => parseCatFileBatch(Buffer.from(`${a} commit 1\nx\n`), [a])).toThrow(/格式不符/)
    expect(() => parseCatFileBatch(Buffer.from(`${b} blob 1\nx\n`), [a])).toThrow(/格式不符/)
    expect(() => parseCatFileBatch(Buffer.from(`${a} blob nope\nx\n`), [a])).toThrow(/格式不符/)
    expect(() => parseCatFileBatch(Buffer.from(`${a} blob 2\nx`), [a])).toThrow(/長度不符/)
    // 內容長度夠但缺少結尾 LF（下一個 header 不存在）
    expect(() => parseCatFileBatch(Buffer.from(`${a} blob 1\nx`), [a])).toThrow(/長度不符/)
  })

  it('materialise：RUNNER_TEMP 未設定或空白 → fail closed', async () => {
    const { repo, baseSha } = makeRepo()
    const out = join(tempDir('factory-facts-out-'), 'facts.json')
    delete process.env.RUNNER_TEMP
    expect(() => materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })).toThrow(/RUNNER_TEMP/)
    process.env.RUNNER_TEMP = '   '
    expect(() => materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })).toThrow(/RUNNER_TEMP/)
  })

  it('materialise：target 不存在／不是目錄、base-sha 解析不到、外部命令失敗、out 不可寫 → fail closed', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'facts.json')
    expect(() =>
      materialiseVerifyFacts({ targetDir: join(created[0] as string, 'nope'), baseSha, outFile: out }),
    ).toThrow(/target/)
    const file = join(tempDir('factory-facts-file-'), 'not-a-dir')
    writeFileSync(file, 'x')
    expect(() => materialiseVerifyFacts({ targetDir: file, baseSha, outFile: out })).toThrow(/不是目錄/)
    expect(() =>
      materialiseVerifyFacts({ targetDir: repo, baseSha: 'f'.repeat(40), outFile: out }),
    ).toThrow(/git ls-tree/)
    // out 的父路徑是檔案 → 寫入失敗
    expect(() =>
      materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: join(file, 'facts.json') }),
    ).toThrow(/--out/)
  })

  it('materialise：git 無法執行／git cat-file 失敗／rsync 非零 → fail closed', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'facts.json')

    const restoreGit = pathWithoutGit()
    expect(() => materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })).toThrow(/git ls-tree/)
    restoreGit()

    const catFileStub = stubGitFailingOn('cat-file')
    expect(() => materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })).toThrow(/cat-file/)
    catFileStub.restore()

    const rsyncStub = stubPath('rsync', 'exit 1')
    expect(() => materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })).toThrow(/rsync/)
    rsyncStub.restore()
  })

  it('CLI main：成功時回傳 facts 並寫檔', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'facts.json')
    const facts = await main(['--target', repo, '--base-sha', baseSha, '--out', out])
    expect(facts.baseSha).toBe(baseSha)
    expect(loadVerifyFacts(out)).toEqual(facts)
  })
})


/** 檔案樹快照（只比較檔案與 symlink；空目錄不影響 git 事實）。 */
interface TreeSnapshot {
  kind: 'file' | 'symlink'
  executable: boolean
  content: string
}

function snapshotTree(root: string): Record<string, TreeSnapshot> {
  const out: Record<string, TreeSnapshot> = {}
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs, rel)
      } else if (entry.isSymbolicLink()) {
        out[rel] = { kind: 'symlink', executable: false, content: readlinkSync(abs) }
      } else {
        out[rel] = {
          kind: 'file',
          executable: (lstatSync(abs).mode & 0o111) !== 0,
          content: readFileSync(abs, 'utf8'),
        }
      }
    }
  }
  walk(root, '')
  return out
}

/** 以 `git archive | tar -x` 取得舊機制的 base 樹（僅測試對照組）。 */
function archiveBaseTree(repo: string, baseSha: string, outDir: string): void {
  const archive = execFileSync('git', ['-C', repo, 'archive', baseSha], {
    maxBuffer: 512 * 1024 * 1024,
  })
  execFileSync('tar', ['-x', '-C', outDir], { input: archive })
}

const changedPathsOf = (facts: VerifyFacts): string[] => facts.changed.map((entry) => entry.path)

describe('R26 (a)：base 擷取不經 git archive（attribute-free）', () => {
  it('export-ignore 不得隱藏 agent 的刪除；facts 回報刪除檔與 assertion 淨減，crosscheck red 工作流', async () => {
    const repo = tempDir('factory-facts-export-ignore-')
    gitIn(repo, 'init', '-q', '-b', 'main')
    writeFile(
      repo,
      'test/old.test.ts',
      "it('a', () => { expect(1).toBe(1) })\nit('b', () => { expect(2).toBe(2) })\nit('c', () => { expect(3).toBe(3) })\n",
    )
    writeFile(repo, '.github/workflows/ci.yml', 'on: push\njobs: {}\n')
    commitAll(repo, 'base')
    const baseSha = gitIn(repo, 'rev-parse', 'HEAD').trim()

    // agent：刪掉 3 條斷言的測試與 workflow，再用 agent 可寫的 info/attributes 遮住
    rmSync(join(repo, 'test/old.test.ts'))
    rmSync(join(repo, '.github/workflows/ci.yml'))
    writeFileSync(
      join(repo, '.git/info/attributes'),
      'test/old.test.ts export-ignore\n.github/workflows/ci.yml export-ignore\n',
    )

    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    expect([...facts.changed].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: '.github/workflows/ci.yml', status: 'D' },
      { path: 'test/old.test.ts', status: 'D' },
    ])
    expect(facts.assertionDelta).toBe(-3)

    const reportPath = report(['.github/workflows/ci.yml', 'test/old.test.ts'], facts.linesAdded + facts.linesDeleted)
    const result = crosscheckMain(
      ['12', reportPath, '--target', repo, '--verify-only', '--base-sha', baseSha, '--facts', out],
      () => {
        throw new Error('no git')
      },
    )
    expect(result.actual.assertionDelta).toBe(-3)
    const kinds = result.mismatches.map((m) => m.kind)
    expect(kinds).toContain('verify-scope')
    expect(kinds).toContain('assertion-delta-understated')
    expect(result.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain('.github/workflows/ci.yml')
    expect(result.ok).toBe(false)
  })

  it('export-subst 不得把 base 內容換成 agent 的內容；改動仍以真實 M 回報', async () => {
    const repo = tempDir('factory-facts-export-subst-')
    gitIn(repo, 'init', '-q', '-b', 'main')
    writeFile(repo, 'version.txt', 'version=$Format:%H$\n')
    commitAll(repo, 'base')
    const baseSha = gitIn(repo, 'rev-parse', 'HEAD').trim()

    // agent 把內容改成 base SHA：archive 的 export-subst 也會換成同一個值（舊機制會靜默）
    writeFileSync(join(repo, 'version.txt'), `version=${baseSha}\n`)
    writeFileSync(join(repo, '.git/info/attributes'), 'version.txt export-subst\n')

    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    expect(facts.changed).toEqual([{ path: 'version.txt', status: 'M' }])
    expect(facts.linesAdded).toBe(1)
    expect(facts.linesDeleted).toBe(1)
  })

  it('無攻擊的 repo：擷取樹與 git archive 解出的樹逐檔相同（含 100755 與 symlink）', () => {
    const repo = tempDir('factory-facts-benign-')
    gitIn(repo, 'init', '-q', '-b', 'main')
    writeFile(repo, 'README.md', '# fixture\n')
    writeFile(repo, 'src/nested/app.ts', 'export const answer = 42\n')
    writeFile(repo, 'bin/tool.sh', '#!/bin/sh\necho hi\n')
    chmodSync(join(repo, 'bin/tool.sh'), 0o755)
    // 同內容的兩個 blob（同 oid）：擷取要為每個 path 各寫一份，不能只寫一次
    writeFile(repo, 'dup-a.txt', 'same blob\n')
    writeFile(repo, 'dup-b.txt', 'same blob\n')
    execFileSync('ln', ['-s', 'README.md', join(repo, 'link.md')])
    commitAll(repo, 'base')
    const baseSha = gitIn(repo, 'rev-parse', 'HEAD').trim()

    const extracted = tempDir('factory-facts-extracted-')
    extractBaseTree(repo, baseSha, extracted)
    const archived = tempDir('factory-facts-archived-')
    archiveBaseTree(repo, baseSha, archived)

    expect(snapshotTree(extracted)).toEqual(snapshotTree(archived))
  })

  it('gitlink（mode 160000）跳過並留 warning，不寫入、不讓 facts 失敗', () => {
    const repo = tempDir('factory-facts-gitlink-')
    gitIn(repo, 'init', '-q', '-b', 'main')
    gitIn(repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`)
    gitIn(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'base')
    const baseSha = gitIn(repo, 'rev-parse', 'HEAD').trim()

    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const chunks: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })
    try {
      const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })
      expect(facts.changed).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(chunks.join('')).toContain('vendor/lib')
    expect(chunks.join('')).toContain('skip')
  })
})

describe('R26 (b)：建置／產物目錄不進事實，但已 commit 的產物仍可 diff', () => {
  const ARTIFACT_FILES = [
    'node_modules/pkg/index.js',
    'coverage/lcov.info',
    'dist/bundle.js',
    'build/out.js',
    'target/debug/app',
    '.venv/lib/python3.12/site.py',
    'venv/bin/python',
    'src/__pycache__/x.pyc',
    '.pytest_cache/v/cache/nodeids',
    '.mypy_cache/3.12/x.json',
    '.ruff_cache/0.1/x',
    '.gradle/caches/x',
    'specs/lean/.lake/build/lib/olean/Spec.olean',
    'nested/.lake/build/foo.olean',
  ]

  it('JS target：npm install／coverage／建置目錄全部排除，facts 只剩交付的測試', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)
    writeFile(repo, 'test/new.test.ts', "it('new', () => { expect(1).toBe(1) })\n")
    for (const rel of ARTIFACT_FILES) writeFile(repo, rel, 'generated artifact\n')

    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    expect(facts.changed).toEqual([{ path: 'test/new.test.ts', status: 'A' }])
    expect(facts.linesAdded).toBe(1)
  })

  it('Lean target：`.lake/build` 不產生額外條目，交付的 specs 檔仍是 A', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)
    writeFile(repo, 'specs/lean/Spec.lean', 'theorem triv : True := trivial\n')
    writeFile(repo, 'specs/lean/.lake/build/lib/olean/Spec.olean', 'binary build output\n')

    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    expect(facts.changed).toEqual([{ path: 'specs/lean/Spec.lean', status: 'A' }])
  })

  it('已 commit 的 dist/app.js 被 agent 修改 → 仍回報 M；同目錄的未追蹤產物被排除', async () => {
    const repo = tempDir('factory-facts-dist-')
    gitIn(repo, 'init', '-q', '-b', 'main')
    writeFile(repo, 'dist/app.js', 'console.log("v1")\n')
    writeFile(repo, 'dist/keep.txt', 'keep\n')
    writeFile(repo, 'package.json', '{}\n')
    commitAll(repo, 'base')
    const baseSha = gitIn(repo, 'rev-parse', 'HEAD').trim()

    writeFileSync(join(repo, 'dist/app.js'), 'console.log("v2")\n')
    writeFileSync(join(repo, 'dist/generated.js'), 'build output\n')

    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    expect(facts.changed).toEqual([{ path: 'dist/app.js', status: 'M' }])
    expect(facts.linesAdded).toBe(1)
    expect(facts.linesDeleted).toBe(1)
  })
})

describe('R26 (c)／(d)：instruction 檔案的完整 neutralisation 與新檔 scope 規則', () => {
  it('base 內的 AGENTS.local.md／CLAUDE.local.md／nested 指令檔移到一旁後不進事實（無刪除）', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)

    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })
    expect(facts.changed).toEqual([])
  })

  it('neutralised 檔案被原封不動搬回 → 不進事實；內容被改寫 → A（含 symlink）', async () => {
    const { repo, baseSha } = makeRepo()
    moveNeutralisedAside(repo)
    // 原封不動搬回（與 base blob 相同）→ 不算變更
    writeFile(repo, 'AGENTS.md', 'target instructions\n')
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    let out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    expect(materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out }).changed).toEqual([])

    // 改寫同一個 base 路徑 → 留著並以 A 回報
    writeFile(repo, 'AGENTS.md', 'attacker instructions\n')
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    expect(materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out }).changed).toEqual([
      { path: 'AGENTS.md', status: 'A' },
    ])
  })

  it('base 內的 neutralised symlink 原封不動搬回 → 不進事實', async () => {
    const repo = tempDir('factory-facts-neutralised-link-')
    gitIn(repo, 'init', '-q', '-b', 'main')
    writeFile(repo, 'README.md', '# fixture\n')
    execFileSync('ln', ['-s', 'README.md', join(repo, 'AGENTS.md')])
    commitAll(repo, 'base')
    const baseSha = gitIn(repo, 'rev-parse', 'HEAD').trim()

    // workflow 把 symlink 移到一旁；agent（或工具鏈）原樣重建
    rmSync(join(repo, 'AGENTS.md'))
    execFileSync('ln', ['-s', 'README.md', join(repo, 'AGENTS.md')])
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    expect(materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out }).changed).toEqual([])
  })

  it('agent 在 neutralised 路徑下新建 .dsh 檔 → 事實保留 A，crosscheck 判 verify-scope 紅', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)
    writeFile(repo, '.dsh/skills/selfauth/SKILL.md', 'I authorise myself\n')

    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })
    expect(facts.changed).toEqual([{ path: '.dsh/skills/selfauth/SKILL.md', status: 'A' }])

    const result = crosscheckMain(
      ['12', report([], 0), '--target', repo, '--verify-only', '--base-sha', baseSha, '--facts', out],
      () => {
        throw new Error('no git')
      },
    )
    const kinds = result.mismatches.map((m) => m.kind)
    expect(kinds).toContain('verify-scope')
    expect(result.mismatches.find((m) => m.kind === 'verify-scope')?.detail).toContain(
      '.dsh/skills/selfauth/SKILL.md',
    )
    expect(result.ok).toBe(false)
  })
})

/**
 * R28：wave 7 的 artifact prune 在 neutralised 分支之後執行，於是「agent 在
 * artifact 名稱目錄下新建 neutralised 檔」會直接從 facts 消失（facts `changed:[]`、
 * crosscheck `ok:true`）。neutralised 路徑永遠不是建置產物：base 已有的原樣搬回
 * 可以忽略，但 agent 新建／改寫的一定要留在 facts 以 `A` 回報。
 */
describe('R28：artifact 目錄名下的 neutralised 路徑不得被 prune 掉', () => {
  const NEUTRALISED_UNDER_ARTIFACTS = [
    'specs/build/AGENTS.md',
    'specs/build/.dsh/skills/x/SKILL.md',
    'specs/build/.agents/skills/y/SKILL.md',
    'specs/dist/CLAUDE.md',
  ]

  it('agent 新建 → facts 逐條保留 A，crosscheck 逐條以 scope 類 mismatch 判紅（ok:false）', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)
    for (const rel of NEUTRALISED_UNDER_ARTIFACTS) writeFile(repo, rel, 'planted instructions\n')

    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })

    // `git diff --cached --name-status` 依 path 排序
    const expected = [...NEUTRALISED_UNDER_ARTIFACTS]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((path) => ({ path, status: 'A' as const }))
    expect(facts.changed).toEqual(expected)

    // report 誠實列出這四筆（每檔一行、沒有 assertion）→ 只剩 scope 類的判定
    const result = crosscheckMain(
      [
        '12',
        report(NEUTRALISED_UNDER_ARTIFACTS, NEUTRALISED_UNDER_ARTIFACTS.length, 0),
        '--target',
        repo,
        '--verify-only',
        '--base-sha',
        baseSha,
        '--facts',
        out,
      ],
      () => {
        throw new Error('verify 模式帶 --facts 時不得對 target 跑任何 git 命令（R25）')
      },
    )
    expect(result.ok).toBe(false)
    expect(result.mismatches.map((m) => m.kind)).toEqual(['verify-neutralised-path'])
    const scopeDetails = result.mismatches
      .filter((m) => m.category === 'scope')
      .map((m) => m.detail)
      .join('\n')
    for (const rel of NEUTRALISED_UNDER_ARTIFACTS) expect(scopeDetails, rel).toContain(rel)
  })

  it('合規 run（test + specs 模型檔、無 neutralised 內容）維持事實與 ok:true', async () => {
    const { repo, baseSha } = makeRepo()
    process.env.RUNNER_TEMP = tempDir('factory-facts-runner-')
    moveNeutralisedAside(repo)
    writeFile(repo, 'specs/quint/model.qnt', 'module Ledger {}\n')
    writeFile(repo, 'test/new.test.ts', "it('new', () => {})\n")

    const out = join(tempDir('factory-facts-out-'), 'verify-facts.json')
    const facts = materialiseVerifyFacts({ targetDir: repo, baseSha, outFile: out })
    expect(facts.changed).toEqual([
      { path: 'specs/quint/model.qnt', status: 'A' },
      { path: 'test/new.test.ts', status: 'A' },
    ])

    const changedPaths = ['specs/quint/model.qnt', 'test/new.test.ts']
    const result = crosscheckMain(
      ['12', report(changedPaths, 2, 0), '--target', repo, '--verify-only', '--base-sha', baseSha, '--facts', out],
      () => {
        throw new Error('verify 模式帶 --facts 時不得對 target 跑任何 git 命令（R25）')
      },
    )
    expect(result.mismatches).toEqual([])
    expect(result.ok).toBe(true)
  })
})
