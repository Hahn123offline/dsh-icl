// dsh-icl：本仓库唯一的 DSH 接线插件。
//
// 它是一个普通的 cordis 插件：apply 同步返回清理函数，异步初始化在内部的 boot()。
// 既能挂在 preset 里（工具/提示词按 preset 作用域隔离），也能作为 Host 行做 headless 冒烟。
import { createIclPlugin } from './src/plugin.mjs'

export const name = 'dsh-icl'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  const plugin = createIclPlugin({ ctx, config })
  return () => plugin.dispose()
}
