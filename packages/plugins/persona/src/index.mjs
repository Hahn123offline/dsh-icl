// 人格插件（M0 最小版）：只做"把人格正文作为系统提示词段交上去"。
//
// 阶段一没有动态演进：card 是内存里的字符串，改动通过 setCard 生效，
// 下一次装配就会用新的（因为段是函数求值）。
export const name = 'persona'

let card = ''

export function apply(ctx) {
  const manifest = ctx.manifest
  card = String(ctx.config?.card ?? '')
  ctx.prompt.section({
    name: 'persona',
    order: 20,
    text: () => card,
  })
  ctx.log({ msg: 'persona.ready', version: manifest.version })
  return {
    // 给宿主/测试用：换一张卡
    setCard(text) { card = String(text ?? '') },
    card() { return card },
  }
}
