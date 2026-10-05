import { describe, expect, it } from 'vitest'
import { checkPbtPrerequisites, ignoresHegelDir, type ReadRepoFile } from './preflight.js'

const GITIGNORE = 'node_modules/\n.hegel/\n'
function files(map: Record<string, string>): ReadRepoFile {
  return (p) => map[p]
}
const pkg = (dev: Record<string, string>, prod: Record<string, string> = {}): string =>
  JSON.stringify({ devDependencies: dev, dependencies: prod })

describe('ignoresHegelDir', () => {
  it.each(['.hegel/', '.hegel', '/.hegel/', '**/.hegel/', '  .hegel/  '])('接受 %s', (line) => {
    expect(ignoresHegelDir(`dist/\n${line}\n`)).toBe(true)
  })
  it.each([undefined, '', '# .hegel/\n', '.hegel/*.db\n', 'hegel/\n'])('拒絕 %s', (g) => {
    expect(ignoresHegelDir(g)).toBe(false)
  })
})

describe('checkPbtPrerequisites：TypeScript', () => {
  it('精確釘版 devDependency＋.gitignore → ok', () => {
    const r = checkPbtPrerequisites('typescript', files({ 'package.json': pkg({ '@hegeldev/hegel': '0.4.7' }), '.gitignore': GITIGNORE }))
    expect(r).toEqual({ ok: true, language: 'typescript', smokeOnly: false, errors: [] })
  })
  it.each(['^0.4.7', '~0.4.7', '>=0.4.0', 'latest', '0.4.x', '*'])('非精確版本 %s → error', (v) => {
    const r = checkPbtPrerequisites('typescript', files({ 'package.json': pkg({ '@hegeldev/hegel': v }), '.gitignore': GITIGNORE }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('精確釘版')
  })
  it('預發布版本 0.5.0-rc.1 視為精確', () => {
    expect(checkPbtPrerequisites('typescript', files({ 'package.json': pkg({ '@hegeldev/hegel': '0.5.0-rc.1' }), '.gitignore': GITIGNORE })).ok).toBe(true)
  })
  it('放在 dependencies → error（不得進產品執行期）', () => {
    const r = checkPbtPrerequisites('typescript', files({ 'package.json': pkg({}, { '@hegeldev/hegel': '0.4.7' }), '.gitignore': GITIGNORE }))
    expect(r.errors[0]).toContain('只允許放在 `devDependencies`')
  })
  it('缺依賴／缺 package.json／壞 JSON／無 devDependencies 欄位', () => {
    expect(checkPbtPrerequisites('typescript', files({ 'package.json': pkg({}), '.gitignore': GITIGNORE })).errors[0]).toContain('缺 `@hegeldev/hegel`')
    expect(checkPbtPrerequisites('typescript', files({ '.gitignore': GITIGNORE })).errors[0]).toContain('找不到 `package.json`')
    expect(checkPbtPrerequisites('typescript', files({ 'package.json': '{', '.gitignore': GITIGNORE })).errors[0]).toContain('不是合法 JSON')
    expect(checkPbtPrerequisites('typescript', files({ 'package.json': '{}', '.gitignore': GITIGNORE })).errors[0]).toContain('缺 `@hegeldev/hegel`')
  })
  it('版本不是字串 → error', () => {
    const r = checkPbtPrerequisites('typescript', files({ 'package.json': JSON.stringify({ devDependencies: { '@hegeldev/hegel': 1 } }), '.gitignore': GITIGNORE }))
    expect(r.errors[0]).toContain('目前是 `1`')
  })
  it('缺 .hegel/ 忽略規則 → error（與依賴錯誤一併列出）', () => {
    const r = checkPbtPrerequisites('typescript', files({ 'package.json': pkg({}) }))
    expect(r.errors).toHaveLength(2)
    expect(r.errors[1]).toContain('.hegel/')
  })
})

describe('checkPbtPrerequisites：Java', () => {
  const dep = (artifact: string, scope?: string, version?: string): string =>
    `<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency>` +
    `<dependency>\n  <groupId>dev.hegel</groupId>\n  <artifactId>${artifact}</artifactId>` +
    `${version === undefined ? '' : `<version>${version}</version>`}${scope === undefined ? '' : `<scope>${scope}</scope>`}</dependency></dependencies></project>`
  it.each(['hegel', 'hegel-jna'])('pom：%s test scope 固定版本 → ok', (a) => {
    expect(checkPbtPrerequisites('java', files({ 'pom.xml': dep(a, 'test', '0.10.0'), '.gitignore': GITIGNORE })).ok).toBe(true)
  })
  it('pom：scope 不是 test、版本是屬性 → 兩個錯誤', () => {
    const r = checkPbtPrerequisites('java', files({ 'pom.xml': dep('hegel', 'compile', '${hegel.version}'), '.gitignore': GITIGNORE }))
    expect(r.errors).toHaveLength(2)
  })
  it('pom：缺版本', () => {
    expect(checkPbtPrerequisites('java', files({ 'pom.xml': dep('hegel', 'test'), '.gitignore': GITIGNORE })).errors[0]).toContain('（未寫）')
  })
  it('pom：dev.hegel 區塊缺 artifactId → 視為沒有依賴', () => {
    const pom = '<dependency><groupId>dev.hegel</groupId><version>0.10.0</version><scope>test</scope></dependency>'
    expect(checkPbtPrerequisites('java', files({ 'pom.xml': pom, '.gitignore': GITIGNORE })).ok).toBe(false)
  })
  it('pom：沒有 dev.hegel 依賴', () => {
    expect(checkPbtPrerequisites('java', files({ 'pom.xml': dep('hegel-lowlevel', 'test', '0.10.0'), '.gitignore': GITIGNORE })).errors[0]).toContain('缺 `dev.hegel:hegel`')
  })
  it.each(['build.gradle.kts', 'build.gradle'])('%s：testImplementation 固定版本 → ok；浮動 → error；缺 → error', (f) => {
    expect(checkPbtPrerequisites('java', files({ [f]: 'dependencies {\n  testImplementation("dev.hegel:hegel-jna:0.10.0")\n}', '.gitignore': GITIGNORE })).ok).toBe(true)
    expect(checkPbtPrerequisites('java', files({ [f]: "testImplementation 'dev.hegel:hegel:0.+'", '.gitignore': GITIGNORE })).errors[0]).toContain('寫死版本')
    expect(checkPbtPrerequisites('java', files({ [f]: 'implementation("dev.hegel:hegel:0.10.0")', '.gitignore': GITIGNORE })).errors[0]).toContain('testImplementation')
  })
  it('沒有建置檔 → error', () => {
    expect(checkPbtPrerequisites('java', files({ '.gitignore': GITIGNORE })).errors[0]).toContain('找不到 `pom.xml`')
  })
})

describe('checkPbtPrerequisites：Go／Rust', () => {
  it('go.mod require → ok；缺 → error；無 go.mod → error', () => {
    expect(checkPbtPrerequisites('go', files({ 'go.mod': 'module x\n\nrequire (\n\thegel.dev/go/hegel v0.9.13\n)\n', '.gitignore': GITIGNORE })).ok).toBe(true)
    expect(checkPbtPrerequisites('go', files({ 'go.mod': 'require hegel.dev/go/hegel v0.9.13', '.gitignore': GITIGNORE })).ok).toBe(true)
    expect(checkPbtPrerequisites('go', files({ 'go.mod': 'module x\n', '.gitignore': GITIGNORE })).errors[0]).toContain('hegel.dev/go/hegel')
    expect(checkPbtPrerequisites('go', files({ '.gitignore': GITIGNORE })).errors[0]).toContain('找不到 `go.mod`')
  })
  const cargo = (dev: string): string => `[package]\nname = "x"\n\n[dependencies]\nhegeltest = "=0.48.1"\n\n[dev-dependencies]\n${dev}\n`
  it('Cargo：= 精確版本（字串或 table）→ ok', () => {
    expect(checkPbtPrerequisites('rust', files({ 'Cargo.toml': cargo('hegeltest = "=0.48.1"'), '.gitignore': GITIGNORE })).ok).toBe(true)
    expect(checkPbtPrerequisites('rust', files({ 'Cargo.toml': cargo('hegeltest = { version = "=0.48.1" }'), '.gitignore': GITIGNORE })).ok).toBe(true)
  })
  it('Cargo：非精確版本、只在 [dependencies]、無 Cargo.toml、table 無 version', () => {
    expect(checkPbtPrerequisites('rust', files({ 'Cargo.toml': cargo('hegeltest = "0.48"'), '.gitignore': GITIGNORE })).errors[0]).toContain('精確釘版')
    expect(checkPbtPrerequisites('rust', files({ 'Cargo.toml': cargo('serde = "1"'), '.gitignore': GITIGNORE })).errors[0]).toContain('缺 `hegeltest`')
    expect(checkPbtPrerequisites('rust', files({ 'Cargo.toml': '[package]\nname="x"\n', '.gitignore': GITIGNORE })).errors[0]).toContain('缺 `hegeltest`')
    expect(checkPbtPrerequisites('rust', files({ '.gitignore': GITIGNORE })).errors[0]).toContain('找不到 `Cargo.toml`')
    expect(checkPbtPrerequisites('rust', files({ 'Cargo.toml': cargo('hegeltest = { path = "../h" }'), '.gitignore': GITIGNORE })).errors[0]).toContain('{ path')
  })
})

describe('checkPbtPrerequisites：C++／OCaml（smoke only）', () => {
  it.each(['cpp', 'ocaml'] as const)('%s 只檢查 .gitignore，smokeOnly=true', (lang) => {
    expect(checkPbtPrerequisites(lang, files({ '.gitignore': GITIGNORE }))).toEqual({ ok: true, language: lang, smokeOnly: true, errors: [] })
    expect(checkPbtPrerequisites(lang, files({})).ok).toBe(false)
  })
})
