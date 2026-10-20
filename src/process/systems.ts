/**
 * 真實租戶系統的發現（snapshot workflow 與 systems.test 共用的單一真相來源）。
 *
 * 系統的「登記」就是機制 repo 的 `processes/<owner>/<repo>.yaml`——aswf.dev 後台以
 * 「存檔＝開 PR」建立它、人類審核合併後即生效。快照 workflow 不再逐一寫死系統，
 * 新增租戶也就不必改 `.github/workflows/**`（H5）。
 *
 * `processes/samples/` 是合成系統（離線 fixture），不在此列。
 */

export interface DiscoveredSystem {
  owner: string
  repo: string
  /** `<owner>/<repo>`，必須等於 spec 內的 `system`（systems.test 會驗）。 */
  system: string
  /** 相對 repo 根目錄的 spec 路徑。 */
  spec: string
}

/** 讀目錄的最小介面（測試以 fake 注入）。 */
export interface DirReader {
  readdir(path: string): string[]
  isDirectory(path: string): boolean
}

export interface DiscoverResult {
  systems: DiscoveredSystem[]
  /** 名稱不合法而略過的路徑（workflow 以 ::warning:: 呈現）。 */
  skipped: string[]
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SPEC_FILE = /\.ya?ml$/
const SAMPLES = 'samples'

export function discoverSystems(reader: DirReader, root = 'processes'): DiscoverResult {
  const systems: DiscoveredSystem[] = []
  const skipped: string[] = []
  for (const owner of [...reader.readdir(root)].sort()) {
    const dir = `${root}/${owner}`
    if (owner === SAMPLES || !reader.isDirectory(dir)) continue
    for (const file of [...reader.readdir(dir)].sort()) {
      if (!SPEC_FILE.test(file)) continue
      const repo = file.replace(SPEC_FILE, '')
      // 名稱會進入 App token 的 owner／repositories 與 artifact 名稱：只收合法 slug。
      if (!OWNER.test(owner) || !REPO.test(repo)) {
        skipped.push(`${dir}/${file}`)
        continue
      }
      systems.push({ owner, repo, system: `${owner}/${repo}`, spec: `${dir}/${file}` })
    }
  }
  return { systems, skipped }
}

/** 快照檔名：`<owner>--<repo>.json`（不同 owner 的同名 repo 不會互相覆蓋）。 */
export function snapshotFileName(system: Pick<DiscoveredSystem, 'owner' | 'repo'>): string {
  return `${system.owner}--${system.repo}.json`
}
