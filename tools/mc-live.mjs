// 实时观察：把 body 事件 + DSH 会话事件（含 reasoning/工具调用）写成一本人读日志。
// 用法：node tools/mc-live.mjs --events <run/events.jsonl> --body <body.jsonl> --out <log>
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const eventsFile = path.resolve(String(arg('--events')))
const bodyFile = path.resolve(String(arg('--body')))
const outFile = path.resolve(String(arg('--out', 'C:/DSH/icl/.state/mc-live.log')))
const follow = !args.includes('--once')

function write(line) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.appendFileSync(outFile, `${line}\n`, 'utf8')
  console.log(line)
}
function textOf(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map((b) => {
    if (b?.type === 'text') return b.text ?? ''
    if (b?.type === 'reasoning') return `[思维] ${b.text ?? ''}`
    if (b?.type === 'tool-call') return `[工具] ${b.name ?? ''} ${b.arguments ?? ''}`
    return ''
  }).filter(Boolean).join('\n')
}
function tail(file, label, onLine) {
  if (!fs.existsSync(file)) { write(`${label}: 文件不存在 ${file}`); return null }
  let offset = 0
  if (args.includes('--from-end')) { try { offset = fs.statSync(file).size } catch { /* ignore */ } }
  const pump = () => {
    try {
      const size = fs.statSync(file).size
      if (size <= offset) return
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      fs.closeSync(fd)
      offset = size
      for (const line of buf.toString('utf8').split(/\r?\n/).filter(Boolean)) onLine(line)
    } catch (error) { write(`${label}: ${error?.message ?? error}`) }
  }
  pump()
  if (!follow) return pump
  const timer = setInterval(pump, 1000)
  return () => clearInterval(timer)
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, '\uFEFF', 'utf8')
write(`# MC live log ${new Date().toISOString()}`)
write(`events=${eventsFile}`)
write(`body=${bodyFile}`)
tail(eventsFile, 'ds h', (line) => {
  let item
  try { item = JSON.parse(line) } catch { return }
  const e = item?.payload?.event ?? item
  if (!e) return
  if (e.type === 'assistant/message') {
    const text = textOf(e.data?.message ?? e.data)
    if (text.trim()) write(`\n[assistant #${e.seq}]\n${text}`)
  } else if (e.type === 'user/message') {
    const source = e.data?.source?.kind ?? 'user'
    const text = textOf({ content: e.data?.content })
    if (text.trim()) write(`\n[${source} #${e.seq}] ${text.slice(0, 500)}`)
  } else if (e.type === 'tool/result') {
    const text = textOf({ content: e.data?.content }) || JSON.stringify(e.data).slice(0, 600)
    write(`[tool result #${e.seq}] ${String(text).slice(0, 800)}`)
  }
})
tail(bodyFile, 'body', (line) => {
  let e
  try { e = JSON.parse(line) } catch { return }
  if (!e?.type) return
  if (['task_queued', 'task_started', 'task_done', 'task_failed', 'task_interrupted', 'safety_stop', 'emergency', 'death', 'respawn', 'chat', 'join', 'leave', 'idle_disconnect', 'disconnected', 'health_drop'].includes(e.type)) {
    write(`[body ${e.type}] ${JSON.stringify(e.data ?? {}).slice(0, 500)}`)
  }
})
