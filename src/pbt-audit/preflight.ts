/**
 * agent-pbt-audit 前置作業的機械檢查（ADR-019 修訂記錄「前置作業」、Q17／Q31）。
 *
 * 依 SR5，agent 不得新增依賴；白名單也只放測試檔。所以 Hegel 依賴與 `.hegel/`
 * 忽略規則必須由人類先放進目標 repo 的 trunk。沒做好時 agent 一定會在 SR5 停下，
 * 跑下去只是浪費整個 agent 預算——因此這裡是**硬性失敗**，不是 quint preflight
 * 那種警告（write-spec 沒裝 quint 也能部分完成，audit 沒有這種情況）。
 *
 * 只檢查能從 manifest 機械判讀的部分。jest transform、settings helper、C++／OCaml
 * 的測試 target 等由 agent 第一步的 smoke property 驗證。
 *
 * 「精確釘版」沿用 docs/11 §3：不接受 `^`、`~`、範圍、tag 或萬用字元。
 */
import { languageSpec, type PbtLanguage } from './languages.js'

/** 讀目標 repo 內相對路徑的文字內容；不存在回傳 undefined。 */
export type ReadRepoFile = (relPath: string) => string | undefined

export interface PbtPreflightResult {
  ok: boolean
  language: PbtLanguage
  /** true＝此語言無法機械檢查依賴，只檢查 .gitignore，其餘交給 smoke property。 */
  smokeOnly: boolean
  errors: string[]
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** `.gitignore` 是否忽略 `.hegel/`（接受 `.hegel`、`.hegel/`、`/.hegel/`、`**\/.hegel/`）。 */
export function ignoresHegelDir(gitignore: string | undefined): boolean {
  if (gitignore === undefined) return false
  return gitignore
    .split('\n')
    .map((l) => l.trim())
    .some((l) => /^(\/|\*\*\/)?\.hegel\/?$/.test(l))
}

function checkTypescript(read: ReadRepoFile): string[] {
  const raw = read('package.json')
  if (raw === undefined) return ['找不到 `package.json`']
  let pkg: unknown
  try {
    pkg = JSON.parse(raw)
  } catch {
    return ['`package.json` 不是合法 JSON']
  }
  const deps = (pkg as { devDependencies?: Record<string, unknown> }).devDependencies ?? {}
  const prod = (pkg as { dependencies?: Record<string, unknown> }).dependencies ?? {}
  const v = deps['@hegeldev/hegel']
  if (v === undefined) {
    return prod['@hegeldev/hegel'] !== undefined
      ? ['`@hegeldev/hegel` 在 `dependencies`——只允許放在 `devDependencies`（ADR-019 §8：不得進入產品執行期相依）']
      : ['`package.json` 的 `devDependencies` 缺 `@hegeldev/hegel`']
  }
  if (typeof v !== 'string' || !EXACT_SEMVER.test(v)) {
    return [`\`@hegeldev/hegel\` 必須精確釘版（例如 \`0.4.7\`），目前是 \`${String(v)}\``]
  }
  return []
}

/** 抽出 pom.xml 中每個 `<dependency>` 區塊。 */
function pomDependencies(pom: string): string[] {
  return [...pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map((m) => m[1] as string)
}

function tag(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1]
}

function checkJava(read: ReadRepoFile): string[] {
  const pom = read('pom.xml')
  if (pom !== undefined) {
    const dep = pomDependencies(pom).find(
      (b) => tag(b, 'groupId') === 'dev.hegel' && /^hegel(-jna)?$/.test(tag(b, 'artifactId') ?? ''),
    )
    if (dep === undefined) return ['`pom.xml` 缺 `dev.hegel:hegel`（Java 22+）或 `dev.hegel:hegel-jna`（Java 17–21）']
    const errors: string[] = []
    if (tag(dep, 'scope') !== 'test') errors.push('`dev.hegel` 依賴必須是 `<scope>test</scope>`')
    const version = tag(dep, 'version')
    if (version === undefined || !EXACT_SEMVER.test(version)) {
      errors.push(`\`dev.hegel\` 依賴必須寫死版本（例如 \`0.10.0\`），目前是 \`${version ?? '（未寫）'}\``)
    }
    return errors
  }
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    const gradle = read(file)
    if (gradle === undefined) continue
    const m = gradle.match(/testImplementation\s*\(?\s*["']dev\.hegel:hegel(?:-jna)?:([^"']+)["']/)
    if (m === null) return [`\`${file}\` 缺 \`testImplementation("dev.hegel:hegel[-jna]:x.y.z")\``]
    return EXACT_SEMVER.test(m[1] as string) ? [] : [`\`dev.hegel\` 依賴必須寫死版本，目前是 \`${m[1] as string}\``]
  }
  return ['找不到 `pom.xml` 或 `build.gradle(.kts)`']
}

function checkGo(read: ReadRepoFile): string[] {
  const mod = read('go.mod')
  if (mod === undefined) return ['找不到 `go.mod`']
  return /(^|\s)hegel\.dev\/go\/hegel\s+v\d/m.test(mod) ? [] : ['`go.mod` 缺 `require hegel.dev/go/hegel`']
}

/** 取出 Cargo.toml 的 `[dev-dependencies]` 段落。 */
function cargoDevDeps(toml: string): string | undefined {
  const m = toml.match(/^\[dev-dependencies\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)
  return m?.[1]
}

function checkRust(read: ReadRepoFile): string[] {
  const toml = read('Cargo.toml')
  if (toml === undefined) return ['找不到 `Cargo.toml`']
  const dev = cargoDevDeps(toml)
  const line = dev?.match(/^\s*hegeltest\s*=\s*(.+)$/m)?.[1]
  if (line === undefined) return ['`Cargo.toml` 的 `[dev-dependencies]` 缺 `hegeltest`']
  const version = line.match(/^"([^"]*)"/)?.[1] ?? line.match(/version\s*=\s*"([^"]*)"/)?.[1]
  if (version === undefined || !/^=\d+\.\d+\.\d+/.test(version)) {
    return [`\`hegeltest\` 必須精確釘版（例如 \`"=0.48.1"\`），目前是 \`${version ?? line.trim()}\``]
  }
  return []
}

const CHECKS: Partial<Record<PbtLanguage, (read: ReadRepoFile) => string[]>> = {
  typescript: checkTypescript,
  java: checkJava,
  go: checkGo,
  rust: checkRust,
}

export function checkPbtPrerequisites(language: PbtLanguage, read: ReadRepoFile): PbtPreflightResult {
  const spec = languageSpec(language)
  const check = CHECKS[language]
  const errors = spec.mechanicalPreflight && check !== undefined ? check(read) : []
  if (!ignoresHegelDir(read('.gitignore'))) {
    errors.push('`.gitignore` 缺 `.hegel/`（Hegel 的本機失敗資料庫，不得進版控）')
  }
  return { ok: errors.length === 0, language, smokeOnly: !spec.mechanicalPreflight, errors }
}
