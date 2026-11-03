// DSH 会话控制：列会话、建会话、选模型、发消息。
//
//   node tools/dsh-session.mjs list
//   node tools/dsh-session.mjs create --preset icl-live --workspace C:/tmp/icl-agent --title "ICL 测试"
//   node tools/dsh-session.mjs prompt --session <id> --text "去刷吧"
//   node tools/dsh-session.mjs model --session <id> --provider llama-swap --model coder390-27b-q3-df2-4x500
//
// base 默认取 DSH_BASE_URL，否则 http://127.0.0.1:<GUI 端口>（用 --base 指定）。
// token 默认取 DSH_LAUNCH_TOKEN，否则从 DSH 日志里发现。
import fs from 'node:fs'
import path from 'node:path'
import { NodeApiClient, discoverDshLaunchToken, unwrap } from '../packages/adapters/dsh-client.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }

const base = String(arg('--base', process.env.DSH_BASE_URL ?? 'http://127.0.0.1:64874')).replace(/\/+$/, '')
const token = process.env.DSH_LAUNCH_TOKEN ?? process.env.DSH_AUTH_TOKEN ?? discoverDshLaunchToken() ?? ''
const api = new NodeApiClient(base, Number(arg('--timeout', '30000')), { token })

async function list() {
  const value = unwrap(await api.sessions.list({}), 'session/list')
  const items = value?.sessions ?? value?.items ?? (Array.isArray(value) ? value : [])
  if (!Array.isArray(items)) { console.log(JSON.stringify(value).slice(0, 1200)); return [] }
  for (const s of items) console.log(`${s.sessionId}\t${s.agentPreset ?? ''}\t${s.title ?? ''}`)
  return items
}

async function create() {
  const preset = String(arg('--preset', 'icl-live'))
  const dir = String(arg('--workspace', path.join(process.cwd(), 'state', 'dsh-agent')))
  fs.mkdirSync(dir, { recursive: true })
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace/create')
  const workspaceId = ws?.workspace?.workspaceId ?? ws?.workspaceId
  const title = arg('--title', null)
  if (title && workspaceId) {
    try { await api.workspace.rename({ workspaceId, title }) } catch { /* 改名失败不影响 */ }
  }
  const created = unwrap(await api.sessions.create({ workspaceId, agentPreset: preset }), 'session/create')
  const sessionId = created?.sessionId ?? created?.id
  console.log(JSON.stringify({ workspaceId, sessionId, preset }, null, 1))
  return sessionId
}

async function prompt() {
  const sessionId = String(arg('--session', ''))
  const text = String(arg('--text', ''))
  if (!sessionId || !text) throw new Error('prompt 需要 --session 和 --text')
  const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  if (!accepted?.result?.ok) throw new Error(`prompt 被拒：${JSON.stringify(accepted?.result?.error ?? accepted)}`)
  console.log('已投递')
}

async function model() {
  const sessionId = String(arg('--session', ''))
  if (!sessionId) throw new Error('model 需要 --session')
  const params = {}
  if (arg('--provider')) params.provider = arg('--provider')
  if (arg('--model')) params.model = arg('--model')
  const out = unwrap(await api.sessions.selectModel({ sessionId, ...params }), 'session/selectModel')
  console.log(JSON.stringify(out, null, 1))
}

try {
  if (cmd === 'list') await list()
  else if (cmd === 'create') await create()
  else if (cmd === 'prompt') await prompt()
  else if (cmd === 'model') await model()
  else {
    console.error('用法：node tools/dsh-session.mjs <list|create|prompt|model> [options]')
    process.exit(2)
  }
} catch (error) {
  console.error('失败：', String(error?.message ?? error))
  process.exit(1)
}
