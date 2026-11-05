// 言行审计：把 assistant 的 MC 声明与同 run 的 tool/body 事件对齐。
// 只做“有没有证据”的检查，不判断自然语言对错。
const CLAIM_RE = /(MC|mc|mcb_|t-\d+|挖|矿区|矿|方块|任务|卡住|死亡|怪|mob|mine|goto|patrol)/i

function textOfMessage(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
}

function taskIdOf(text) {
  const match = String(text).match(/\bt-\d+\b/)
  return match ? match[0] : null
}

export function audit({ events = [], bodyEvents = [] } = {}) {
  const assistants = []
  const tools = []
  for (const [index, item] of events.entries()) {
    const event = item?.payload?.event ?? item
    if (!event) continue
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data?.message ?? event.data)
      if (text.trim()) assistants.push({ index, seq: event.seq, text })
    }
    if (event.type === 'tool/call') tools.push({ index, seq: event.seq, name: String(event.data?.name ?? event.data?.tool ?? '') })
    if (event.type === 'tool/result') tools.push({ index, seq: event.seq, name: String(event.data?.name ?? event.data?.tool ?? ''), result: true })
  }
  const bodyTaskEvents = (bodyEvents ?? []).filter((e) => String(e?.type ?? '').startsWith('task_'))
  const claims = []
  for (const assistant of assistants) {
    const lines = assistant.text.split(/\n|(?<=[。！？.!?])\s+/).map((s) => s.trim()).filter(Boolean)
    for (const line of lines) {
      if (!CLAIM_RE.test(line)) continue
      const taskId = taskIdOf(line)
      const nearbyTools = tools.filter((t) => Math.abs(t.index - assistant.index) <= 3)
      const taskEvents = taskId ? bodyTaskEvents.filter((e) => String(e?.data?.task?.id ?? '') === taskId) : []
      const hasTool = nearbyTools.length > 0
      const hasTask = taskEvents.length > 0
      claims.push({
        seq: assistant.seq,
        text: line,
        taskId,
        verified: hasTool || hasTask,
        evidence: [...nearbyTools.map((t) => `${t.result ? 'result' : 'call'}:${t.name || '?'}`), ...taskEvents.map((e) => `body:${e.type}`)],
      })
    }
  }
  return {
    claims,
    verified: claims.filter((c) => c.verified).length,
    unverified: claims.filter((c) => !c.verified).length,
  }
}

export function renderAudit(result) {
  const rows = result.claims.map((c) => `- [${c.verified ? '✓' : '?'}] #${c.seq} ${c.text}${c.taskId ? `（task ${c.taskId}）` : ''}${c.evidence.length ? ` — ${c.evidence.join(', ')}` : ''}`)
  return ['# MC claim audit', '', `- verified: ${result.verified}`, `- unverified: ${result.unverified}`, '', ...rows].join('\n')
}
