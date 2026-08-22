/**
 * FactoryWorkItemDraftField — scaffold 表單的「LLM 草稿助手」客製欄位
 * （docs/ADR/009 的生成模式：可選釐清 + 一次生成 + 品質標示）。
 *
 * 掛在 template.yaml 的 `requirement`（需求描述 PRD）欄位上（ui:field）。
 * 使用 Backstage new frontend system 的 FormFieldBlueprint 模式（v1.53 實測：
 * 內建欄位如 RepoUrlPicker 亦用 FormFieldBlueprint.make + createFormField）。
 *
 * ⚠️ 待實作驗證（Q03-2 模式，backstage/versions.md）：
 * - FormFieldBlueprint.make / createFormField 簽章已對照
 *   @backstage/plugin-scaffolder-react/alpha（v2.0.2）實測；
 * - rjsf 的 formData（整份表單）跨欄位讀取 parameters.taskType——若該 prop
 *   在執行期名稱不同，本欄位仍可運作，只是少了草稿上下文。
 */
import React from 'react'
import { useApi, fetchApiRef, discoveryApiRef } from '@backstage/core-plugin-api'
import { createFrontendModule } from '@backstage/frontend-plugin-api'
import { makeStyles, useTheme } from '@material-ui/core/styles'
import { WarningPanel } from '@backstage/core-components'
import {
  TextField,
  Button,
  Typography,
  Box,
  CircularProgress,
} from '@material-ui/core'
import {
  createFormField,
  FormFieldBlueprint,
  type FieldExtensionComponentProps,
} from '@backstage/plugin-scaffolder-react/alpha'

const useStyles = makeStyles({
  root: { width: '100%' },
  row: { display: 'flex', gap: 8, marginBottom: 8 },
})

type DraftProps = FieldExtensionComponentProps<string, Record<string, unknown>>

function DraftFieldComponent(props: DraftProps) {
  const { onChange, rawErrors, formData, value, schema, required } = props
  const classes = useStyles()
  const theme = useTheme()
  const fetchApi = useApi(fetchApiRef)
  const discoveryApi = useApi(discoveryApiRef)
  const [busy, setBusy] = React.useState(false)
  const [chat, setChat] = React.useState<Array<{ q: string; a: string }>>([])
  const [round, setRound] = React.useState(1)
  const [answer, setAnswer] = React.useState('')
  const [notes, setNotes] = React.useState<string[]>([])
  const [error, setError] = React.useState<string | null>(null)

  // RJSF 客製欄位的「本欄值」在 formData（FieldProps.formData = 此欄資料），
  // 不保證有 value prop（2026-08-21 實測：讀 value 永遠 undefined → 無法輸入）。
  // 雙保險：value 或 formData（字串時）皆可。
  const current: string = typeof value === 'string' ? value : typeof formData === 'string' ? formData : ''
  const requirementText = current ?? ''

  // 前端逾時：backend 可能正常處理 20–60 秒；超過 120 秒強制結束轉圈並提示重試
  const POST_TIMEOUT_MS = 120_000

  const post = async (path: string, body: unknown) => {
    // discoveryApi 解析 backend 的絕對 URL（相對路徑會打到 frontend → 404）；
    // fetchApi 附上使用者認證 token（raw fetch 會 401）
    const baseUrl = await discoveryApi.getBaseUrl('factory-draft')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetchApi.fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error('LLM 回應逾時，請重試')
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as {
        error?: string | { message?: string }
      }
      const msg =
        typeof j.error === 'string'
          ? j.error
          : (j.error?.message ?? `HTTP ${res.status}`)
      throw new Error(msg)
    }
    return (await res.json()) as Record<string, unknown>
  }

  const clarify = async () => {
    if (requirementText.trim().length === 0) {
      setError('請先在「需求描述」輸入內容，再按「🎯 釐清需求」')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await post('clarify', {
        requirement: requirementText,
        round,
        history: chat.map((c) => ({ question: c.q, answer: c.a })),
      })
      setChat((prev) => [...prev, { q: String(r.questions ?? ''), a: '' }])
      setRound((prev) => prev + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitAnswer = async () => {
    if (answer.trim().length === 0) return
    setChat((prev) => {
      const next = [...prev]
      if (next.length > 0) next[next.length - 1] = { ...next[next.length - 1]!, a: answer }
      return next
    })
    setAnswer('')
    // UX 提示：釐清只收集答案，不會自動填 PRD——要按「✨ 一次生成」產出草稿
    setError('✅ 已回答——按「✨ 一次生成」用這些答案產生 PRD 草稿')
  }

  const generate = async () => {
    if (requirementText.trim().length === 0) {
      setError('請先在「需求描述」輸入內容，再按「✨ 一次生成」')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await post('generate', {
        requirement: requirementText,
        history: chat.filter((c) => c.a.length > 0).map((c) => ({ question: c.q, answer: c.a })),
      })
      if (typeof r.requirement === 'string') {
        onChange(r.requirement)
      }
      setNotes(Array.isArray(r.notes) ? (r.notes as string[]) : [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box className={classes.root}>
      {/* 客製欄位不會自動帶出欄位標題——自行渲染 schema.title（2026-08-21 UX 修正） */}
      <Typography variant="subtitle2" gutterBottom>
        {String(schema?.title ?? '')}
        {required ? ' *' : ''}
      </Typography>
      <Box className={classes.row}>
        <Button variant="outlined" size="small" onClick={clarify} disabled={busy}>
          🎯 釐清需求
        </Button>
        <Button variant="contained" size="small" color="primary" onClick={generate} disabled={busy}>
          ✨ 一次生成
        </Button>
      </Box>
      <TextField
        multiline
        minRows={8}
        fullWidth
        variant="outlined"
        value={requirementText}
        onChange={(e) => onChange(e.target.value)}
        error={Boolean(rawErrors?.length)}
        helperText={rawErrors?.length ? rawErrors.join('、') : 'PRD 四段：目標模組/檔案、做什麼、為什麼、範圍'}
      />
      {busy && (
        <Box className={classes.row} style={{ alignItems: 'center' }}>
          <CircularProgress size={16} />
          <Typography variant="caption">正在呼叫 LLM（可能需 20–60 秒，請稍候）…</Typography>
        </Box>
      )}
      {chat.map((c, i) => (
        <Box key={i} marginTop={1} padding={1} style={{ background: theme.palette.background.default }}>
          <Typography variant="body2" component="pre" style={{ whiteSpace: 'pre-wrap' }}>
            {c.q}
          </Typography>
          {c.a.length === 0 && (
            <Box className={classes.row}>
              <TextField
                size="small"
                fullWidth
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="回答這輪問題（可留空直接按「✨ 一次生成」跳過）"
              />
              <Button size="small" variant="outlined" onClick={submitAnswer} disabled={busy}>
                送出答案
              </Button>
            </Box>
          )}
        </Box>
      ))}
      {notes.length > 0 && (
        <WarningPanel title="推測與未確認事項（請逐項確認後再送出）">
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </WarningPanel>
      )}
      {error && (
        <Typography color="error" variant="caption">
          {error}
        </Typography>
      )}
    </Box>
  )
}

export const FactoryWorkItemDraftField = createFormField({
  name: 'FactoryWorkItemDraftField',
  component: DraftFieldComponent,
})

/**
 * new frontend system 客製欄位擴充。
 *
 * 根因（2026-08-21 實測，讀 frontend-app-api resolveAppNodeSpecs 原始碼確認）：
 * `features` 只接受 FrontendPlugin 或 FrontendModule——**裸的 ExtensionDefinition
 * 會被靜默丟棄**（不進 app tree，loadFormFields 永遠拿不到 → RJSF 退回預設欄位）。
 * 正確做法：用 `createFrontendModule` 包裝（app 的 signInPage 即此模式），
 * pluginId 對應宿主插件（scaffolder）以取得 plugin 上下文與 attachTo 解析。
 *
 * 使用方式：features: [factoryDraftModule, ...]
 */
const factoryWorkItemDraftField = FormFieldBlueprint.make({
  name: 'factory-work-item-draft',
  params: {
    field: () => Promise.resolve(FactoryWorkItemDraftField),
  },
})

const factoryDraftModule = createFrontendModule({
  pluginId: 'scaffolder',
  extensions: [factoryWorkItemDraftField],
})

export default factoryDraftModule
