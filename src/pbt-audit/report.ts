/**
 * report.json 的 `pbtAudit` 欄位（ADR-019 R4、R10）：agent **自報**的稽核結果。
 *
 * 只用於機制留言，**不參與任何判定**（與 skillGap、usage 同立場）：讓自報的數字
 * 影響終態，等於給 agent 一個施力點；而 agent 自填的量測值本來就不具量測意義
 * （factory-push-event 也因此不讀自報欄位，ADR-019 R10：不推 scoreboard）。
 *
 * ReportSchema 對這個欄位只收 `unknown`：格式不符時，crosscheck 與 judge 不該因為
 * 一個不參與判定的欄位就整份 report 判壞、讓 run 失敗。格式在留言時才嚴格驗證，
 * 不符就在留言裡明說「自報格式不符」，候選發現的原文仍在 artifact 的 report.json。
 */
import { z } from 'zod'

const count = z.number().int().nonnegative()

export const PbtFindingSchema = z.object({
  /** property 名稱或測試名稱。 */
  property: z.string().min(1),
  /** 依據標註（ADR-019 §4），例如 `generic/roundtrip`、`Issue #42 AC-2`、`src/x.ts:31`。 */
  source: z.string().min(1),
  /** Hegel 縮減後印出的 draws，原樣貼上。 */
  draws: z.string().min(1),
  /** 重現用的 HEGEL_SEED。 */
  seed: z.union([z.number().int(), z.string().min(1)]),
  /** @hegeldev/hegel 等函式庫的版本。 */
  hegelVersion: z.string().min(1),
  /** 固定輸入的紅燈範例測試（可直接貼上）。 */
  reproTest: z.string().min(1),
  /** 修正後要加回的 property（選填）。 */
  propertyToRestore: z.string().optional(),
})

export const PbtAuditReportSchema = z.object({
  seeds: z.array(z.union([z.number().int(), z.string().min(1)])).optional(),
  testCasesPerSeed: count.optional(),
  properties: count.optional(),
  passed: count.optional(),
  failed: count.optional(),
  timeouts: count.optional(),
  findings: z.array(PbtFindingSchema).optional(),
})

export type PbtFinding = z.infer<typeof PbtFindingSchema>
export type PbtAuditReport = z.infer<typeof PbtAuditReportSchema>

export type ParsedPbtAudit =
  | { status: 'absent' }
  | { status: 'invalid'; detail: string }
  | { status: 'ok'; value: PbtAuditReport }

export function parsePbtAudit(raw: unknown): ParsedPbtAudit {
  if (raw === undefined || raw === null) return { status: 'absent' }
  const r = PbtAuditReportSchema.safeParse(raw)
  if (r.success) return { status: 'ok', value: r.data }
  return {
    status: 'invalid',
    detail: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  }
}
