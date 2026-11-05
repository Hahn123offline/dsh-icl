// focus：把"注意力"从数据结构变成真行为。
//
// 硬约束（来自第二代 DESIGN-activity-focus.md）：
//   · 同一时刻最多一个由模型声明的 focus；换 focus = 主动进入另一件
//   · 只有显式工具调用才算进入，口头说不算
//   · 别处的事不切走她：普通消息进积压，只有 pierce 规则允许的才进模型
//   · focus 跨 turn 存活；系统不替她离开
import { randomUUID } from 'node:crypto'

export const name = 'focus'

const DEFAULT_PIERCE = Object.freeze({})

/** 事实状态的粒度：分钟一抖会把前缀缓存整段打掉，所以按 5 分钟取整。 */
const MINUTES_BUCKET = 5
/** 提示词段上限：契约要求每段 1–2 行、实现里必须截断。 */
const SECTION_MAX_CHARS = 200

function minutesSince(lease, now) {
  if (!lease?.since) return 0
  return Math.max(0, Math.round((now - Number(lease.since)) / 60_000))
}

export function apply(ctx) {
  const api = () => ctx.focus
  const now = () => ctx.now()

  function modelLeases() {
    return api().list().filter((lease) => lease.owner === 'focus')
  }

  function current() {
    return api().current()
  }

  function leave() {
    const leases = modelLeases()
    for (const lease of leases) { try { lease.release() } catch { /* 已释放 */ } }
    return leases.length
  }

  function enter({ title, reason = '', interruptible = true, goal = null, minutes = null, activity = null, pierce = null } = {}) {
    const label = String(activity ?? `act:${randomUUID().slice(0, 8)}`)
    // 模型侧一次只留一个 focus：进入新的 = 离开旧的
    leave()
    const lease = api().enter({
      label,
      owner: 'focus',
      reason,
      title: title ?? label,
      kind: 'task',
      interruptible: interruptible !== false,
      goal,
      pierce: pierce ?? DEFAULT_PIERCE,
      ttlMs: minutes == null ? null : Math.max(1, Number(minutes) || 1) * 60_000,
    })
    return lease
  }

  function statusText() {
    const lease = current()
    const backlog = api().backlog()
    const lines = []
    if (lease) {
      const mins = Math.floor(minutesSince(lease, now()) / MINUTES_BUCKET) * MINUTES_BUCKET
      const sacred = lease.interruptible === false ? '（勿扰：只有管理员和闹钟能打断）' : ''
      // 不足一档就不说"已 0 分钟"：既没信息，又让每段文本无谓地变长。
      const elapsed = mins >= MINUTES_BUCKET ? `，已 ${mins} 分钟` : ''
      lines.push(`你现在在：${lease.title}${sacred}${lease.reason ? ` —— ${lease.reason}` : ''}${elapsed}。`)
    } else {
      lines.push('你不在任何专注空间里（自己的时间）。')
    }
    const total = backlog.reduce((sum, row) => sum + row.count, 0)
    if (total) {
      lines.push(`别处积压：${backlog.map((row) => `${row.focus} +${row.count}`).join('，')}。`)
    }
    return lines.join('\n')
  }

  function backlogText() {
    const rows = api().backlog()
    if (!rows.length) return '没有积压。'
    const total = rows.reduce((sum, row) => sum + row.count, 0)
    return [`别处积压 ${total} 条：`, ...rows.map((row) => `· ${row.focus} +${row.count}${row.lastText ? `：${row.lastText}` : ''}`)].join('\n')
  }

  const tools = [
    {
      name: 'focus_status',
      summary: 'See what you are focused on right now, and how much is waiting elsewhere.',
      when: ['you want to know where your attention is'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() { return { text: statusText() } },
    },
    {
      name: 'focus_enter',
      summary: 'Declare that you are focusing on one thing. While focused, other places only reach you when they are urgent enough. When you no longer need this focus, call focus_leave (and time_cancel for any goal) so you are not kept awake.',
      when: ['you are about to do one specific thing and do not want to be pulled away'],
      avoid: ['just mentioning it in conversation — only this call counts'],
      parameters: {
        type: 'object', additionalProperties: false, required: ['title'],
        properties: {
          title: { type: 'string', description: 'What you are doing, in one short phrase.' },
          reason: { type: 'string', description: 'Why you are doing it (shown to you later).' },
          interruptible: { type: 'boolean', description: 'Allow other places to interrupt you. Default true.' },
          goal: { type: 'string', description: 'What you want to finish.' },
          minutes: { type: 'number', description: 'Optional expected duration in minutes.' },
          activity: { type: 'string', description: 'Optional stable id for this activity, e.g. qq:group:123.' },
        },
      },
      async execute(args) {
        const lease = enter(args ?? {})
        return { text: `进入了专注空间：${lease.title}（${lease.label}）。` }
      },
    },
    {
      name: 'focus_leave',
      summary: 'Leave the thing you are focused on and go back to your own time.',
      when: ['the thing is done', 'you want to switch to something else with focus_enter'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        const n = leave()
        return { text: n ? '离开了专注空间。' : '你本来就不在专注空间里。' }
      },
    },
    {
      name: 'focus_backlog',
      summary: 'See what happened in other places while you were focused, without leaving.',
      when: ['you want a quick look at what you missed'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() { return { text: backlogText() } },
    },
  ]
  for (const tool of tools) ctx.tools.register(tool)

  // 事实状态段：order 875 让它排在人格/仿真（20/25）之后、world（890）之前。
  // 它随焦点变化，放到前缀前面会把整段人格一起打掉（实测 firstDiff 从第 1 字符开始）。
  ctx.prompt.section({
    name: 'focus',
    order: 875,
    text: () => {
      const text = current() || api().backlog().length ? statusText() : ''
      return text.length > SECTION_MAX_CHARS ? `${text.slice(0, SECTION_MAX_CHARS - 1)}…` : text
    },
  })

  ctx.log({ msg: 'focus.ready' })
  return { enter, leave, statusText, backlogText }
}
