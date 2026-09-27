/**
 * 把模型路由轉成 DSH 0.1.7 的 Cordis patch（`dsh --patch <file>`）。
 *
 * DSH 0.1.7 移除了 `$DSH_HOME/settings.yaml`：設定改由 Cordis patch 以 entry id
 * 覆寫（dsh-app-boot README「cordis.patch.yml」）。舊檔只會在 Loader 啟動完成後
 * 被非同步匯入一次，headless agent 建立時來不及生效——2026-09-24 升級到
 * 0.1.7-rc.1 之後，工廠寫的 `agent-default-model` 與 provider 設定全被忽略，
 * 所有 run 都跑在 dsh-base 內建的 `deepseek-official/deepseek-flash`。
 *
 * patch 覆寫兩個 entry（id 取自 dsh-base 的 cordis.patch.yml）：
 * - `agent-default-model`：本次嘗試的 provider／model／reasoningEffort；
 * - `llm-pi-ai`：provider route（settings.providers.yaml 的 `llm-pi-ai` 區段原樣）。
 * id 覆寫會**整段取代** config（不 deep-merge），所以兩段都要完整寫出。
 */

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string | undefined
}

export interface PatchRow {
  id: string
  config: Record<string, unknown>
}

export function buildModelPatch(
  piAi: { providers: Record<string, unknown> },
  selection: ModelSelection,
): PatchRow[] {
  const agentDefault: Record<string, unknown> = {
    provider: selection.provider,
    model: selection.model,
  }
  if (selection.reasoningEffort !== undefined) agentDefault['reasoningEffort'] = selection.reasoningEffort
  return [
    { id: 'agent-default-model', config: agentDefault },
    { id: 'llm-pi-ai', config: piAi },
  ]
}
