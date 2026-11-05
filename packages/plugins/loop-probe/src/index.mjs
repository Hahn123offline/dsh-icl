// 闭环测试专用的外部信号注入器。**不要放进默认插件列表**。
//
// 闭环需要验证 focus：别处的普通消息在焦点期间应该进积压，而不是打断。
// 真实 QQ/B 站连接器还没有接上；这里用文件邮箱模拟一个外部来源：
//
//   {"id":"s1","from":"qq","kind":"content","text":"别处消息","focus":"qq:group:1"}
//
// 结果写到 outbox：accepted/blocked + gate 给出的 reason。工具面不注册任何工具，
// 模型不知道它存在，控制完全在 driver 一侧。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'loop-probe'

export function apply(ctx) {
  const inboxFile = String(ctx.config.inboxFile ?? path.join(String(ctx.config.root ?? '.'), 'state', 'loop.inbox.jsonl'))
  const outboxFile = String(ctx.config.outboxFile ?? path.join(path.dirname(inboxFile), 'loop.outbox.jsonl'))
  // 重启后不要重放历史命令；只处理本次进程启动之后新追加的行。
  let offset = 0
  try { offset = fs.statSync(inboxFile).size } catch { offset = 0 }

  function resetState() {
    const done = {}
    try { done.delivery = ctx.delivery.clear() } catch { done.delivery = null }
    try { ctx.focus.clear(); done.focus = true } catch { done.focus = false }
    try {
      const time = ctx.services.get('time')
      if (time?.runCommand) done.time = time.runCommand({ cmd: 'reset', args: {} })
    } catch { done.time = null }
    try { done.raw = ctx.services.get('icl')?.resetRaw?.() ?? null } catch { done.raw = null }
    try {
      const mem = ctx.services.get('memory')
      let removed = 0
      for (const namespace of ['event', 'person', 'slang', 'note', 'lexicon', 'day', 'dream-run', 'recall-cursor', 'resolve', 'compaction']) {
        for (const row of mem.query({ namespace, limit: 500, order: 'desc' })) {
          mem.remove({ namespace, id: row.id })
          removed += 1
        }
      }
      done.memoryRemoved = removed
    } catch { done.memoryRemoved = null }
    return done
  }

  function readInbox() {
    let text = ''
    try { text = fs.readFileSync(inboxFile, 'utf8') } catch { return 0 }
    if (text.length < offset) offset = 0
    if (text.length <= offset) return 0
    const chunk = text.slice(offset)
    offset = text.length
    let processed = 0
    for (const line of chunk.split('\n')) {
      const raw = line.trim()
      if (!raw) continue
      let cmd
      try { cmd = JSON.parse(raw) } catch { continue }
      let result
      try {
        if (cmd.op === 'reset') {
          result = { ok: true, result: resetState() }
        } else {
          const out = ctx.signals.offer({
            from: { plugin: String(cmd.from ?? 'loop-probe'), activity: String(cmd.activity ?? 'probe') },
            kind: String(cmd.kind ?? 'content'),
            text: String(cmd.text ?? ''),
            focus: cmd.focus == null ? null : String(cmd.focus),
            tags: Array.isArray(cmd.tags) ? cmd.tags.map(String) : [],
          })
          result = { ok: true, result: out }
        }
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) }
      }
      try {
        fs.mkdirSync(path.dirname(outboxFile), { recursive: true })
        fs.appendFileSync(outboxFile, `${JSON.stringify({ id: cmd.id ?? null, at: ctx.now(), ...result })}\n`, 'utf8')
      } catch { /* ignore */ }
      processed += 1
    }
    return processed
  }

  const timer = setInterval(() => {
    try { readInbox() } catch (error) { ctx.log({ level: 'warn', msg: 'loop-probe.read', error: String(error?.message ?? error) }) }
  }, Math.max(100, Number(ctx.config.tickMs) || 200))
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => clearInterval(timer))
  let startupReset = null
  if (ctx.config.resetOnStart !== false) {
    try { startupReset = resetState() } catch (error) { ctx.log({ level: 'warn', msg: 'loop-probe.reset-start', error: String(error?.message ?? error) }) }
  }
  const api = { readInbox, reset: resetState, startupReset, inboxFile, outboxFile }
  ctx.services.provide('loop-probe', api)
  ctx.log({ msg: 'loop-probe.ready', inboxFile, outboxFile, startupReset: Boolean(startupReset) })
  return api
}
