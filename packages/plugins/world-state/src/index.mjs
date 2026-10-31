// 世界状态插件（M0 最小版）：默认只投递"现在几点"，外加一个看一眼的工具。
//
// 分层、筛选器、多来源计数是 M1 的事；M0 只证明两件事：
//   · 插件能注册工具（卸载后消失）
//   · 插件能往系统提示词里加一段会随时间的文本
export const name = 'world-state'

function stamp(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function apply(ctx) {
  ctx.prompt.section({
    name: 'world:time',
    order: 10,
    text: () => `现在是 ${stamp(ctx.now())}。`,
  })

  ctx.tools.register({
    name: 'world_now',
    description: 'Return the current local time. Use when you need to know when it is.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { text: `现在是 ${stamp(ctx.now())}。` }
    },
  })
}
