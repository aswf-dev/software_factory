/**
 * 模板目錄（`templates/index.json`；ADR-025 §2）。
 *
 * 「系統釘 `<tenant>/<name>` ＋ `template_version`」需要一個地方回答「這個 id 的檔案在哪」。
 * 沒有目錄，consumer 只能掃資料夾或硬編路徑——兩者都會在租戶變多時失效。
 *
 * 目錄是**機械的事實來源**：`factory-template` CLI 讀它，CI 檢查它與 `templates/**` 一致。
 */
import { z } from 'zod'
import { TEMPLATE_ID_PATTERN, TemplateSchema } from './spec.js'
import type { Template } from './spec.js'

const TENANT = /^[a-z][a-z0-9-]*$/
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/
const TEMPLATE_PATH = /^templates\/[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9-]*\.yaml$/

export const TemplateEntrySchema = z.object({
  id: z.string().regex(TEMPLATE_ID_PATTERN, 'id 必須是 <tenant>/<name>'),
  tenant: z.string().regex(TENANT, 'tenant 只允許小寫英數與連字號'),
  name: z.string().regex(NAME, 'name 只允許英數與連字號'),
  /** 發布後不可變（ADR-025 §2）。 */
  version: z.number().int().positive(),
  path: z.string().regex(TEMPLATE_PATH, 'path 必須是 templates/<tenant>/<name>.yaml'),
  source: z.string().min(1).optional(),
  /**
   * 模板本體（與 `path` 的檔案相同）。consumer（Scoreboard）只需抓一份 JSON 就能畫圖，
   * 不必在瀏覽器／Worker 裡解析 YAML；CI 以 `validateRegistry` 釘住兩者相等。
   */
  template: TemplateSchema,
})

export const TemplateRegistrySchema = z.object({
  schema_version: z.literal(1),
  templates: z.array(TemplateEntrySchema).min(1),
})

export type TemplateEntry = z.infer<typeof TemplateEntrySchema>
export type TemplateRegistry = z.infer<typeof TemplateRegistrySchema>

export interface RegistryResult {
  ok: boolean
  errors: string[]
  registry?: TemplateRegistry
}

function schemaErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
}

/** 解析並做目錄自身的檢查：id 唯一、`id === tenant/name`、path 與 id 一致。 */
export function loadRegistry(text: string): RegistryResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['目錄 JSON 無法解析'] }
  }
  const parsed = TemplateRegistrySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error.issues) }

  const errors: string[] = []
  const seen = new Set<string>()
  const paths = new Set<string>()
  for (const entry of parsed.data.templates) {
    if (seen.has(entry.id)) errors.push(`${entry.id}: id 重複`)
    seen.add(entry.id)
    if (paths.has(entry.path)) errors.push(`${entry.path}: path 重複`)
    paths.add(entry.path)
    if (entry.id !== `${entry.tenant}/${entry.name}`) {
      errors.push(`${entry.id}: id 與 tenant/name（${entry.tenant}/${entry.name}）不一致`)
    }
    if (entry.path !== `templates/${entry.tenant}/${entry.name}.yaml`) {
      errors.push(`${entry.id}: path 必須是 templates/${entry.tenant}/${entry.name}.yaml`)
    }
  }
  return errors.length === 0
    ? { ok: true, errors: [], registry: parsed.data }
    : { ok: false, errors }
}

/** 決定性序列化：物件鍵排序，讓「內容相同、鍵序不同」不被誤判。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 依 id 找目錄項（`<tenant>/<name>`；版本由系統釘選，不在 id 裡）。 */
export function findTemplate(registry: TemplateRegistry, id: string): TemplateEntry | undefined {
  return registry.templates.find((entry) => entry.id === id)
}

/**
 * 目錄與實際模板檔的一致性。
 *
 * `templates` 以 id 為 key（CLI 掃 `templates/**` 後用檔內宣告的 tenant/name 建表）。
 * 檢查：每個目錄項都有模板、宣告的 tenant/name/version 相符、每個模板檔都被列出。
 */
export function validateRegistry(
  registry: TemplateRegistry,
  templates: ReadonlyMap<string, Template>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const listed = new Set<string>()

  for (const entry of registry.templates) {
    listed.add(entry.id)
    const template = templates.get(entry.id)
    if (template === undefined) {
      errors.push(`${entry.id}: 目錄有但找不到模板檔 ${entry.path}`)
      continue
    }
    if (template.tenant !== entry.tenant || template.name !== entry.name) {
      errors.push(`${entry.id}: 模板檔宣告 ${template.tenant}/${template.name}，與目錄不一致`)
    }
    if (template.version !== entry.version) {
      errors.push(`${entry.id}: 目錄 version ${entry.version}，模板檔是 ${template.version}`)
    }
    if (canonical(entry.template) !== canonical(template)) {
      errors.push(`${entry.id}: 目錄內嵌的 template 與 ${entry.path} 不一致（請用 factory-template 重新產生）`)
    }
  }

  for (const id of templates.keys()) {
    if (!listed.has(id)) errors.push(`${id}: 模板檔未列入目錄`)
  }

  return { ok: errors.length === 0, errors }
}
