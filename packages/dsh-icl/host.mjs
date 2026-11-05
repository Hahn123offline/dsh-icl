// 空的 Host 侧挂载：让 bundle 的包在 profile 进程里被加载，
// 同时给以后真正的 Host 能力（如 focus 持久化）留一个入口。
export const name = 'icl-host'

export function apply() {
  return () => {}
}
