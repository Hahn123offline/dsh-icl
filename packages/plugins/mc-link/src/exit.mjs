// body 退出原因 → 人话 + 同因累计建议。
//
// mc-body 新版会写 <stateDir>/body-exit.json（reason 分类 + status 快照）与 stderr 一行
// `[mc-body] exit reason=...`；旧 body / 被硬杀时没有归因，只能按退出码/信号说。
// 这里只管"翻译"，读文件在 lifecycle.mjs。
import { describeExit } from './lifecycle.mjs'

export const EXIT_REASON_TEXT = Object.freeze({
  sigterm: '收到 SIGTERM（外部要求停止，不是崩溃）',
  sigint: '收到 SIGINT（Ctrl-C）',
  'api-shutdown': '通过 /v1/shutdown 主动停止',
  'clean-exit': '正常退出',
  'idle-timeout': '暂停太久被自动下线',
  'reconnect-exhausted': '重连次数耗尽，服务器可能没开/被踢',
  'uncaught-exception': '未捕获异常崩溃（body 自己的 bug）',
  'unhandled-rejection': '未处理的 Promise 拒绝（body 自己的 bug）',
  'exit-code': '被非正常路径结束（没有栈；可能是依赖里直接 process.exit）',
  'startup-error': '启动失败（连不上/参数错）',
})

export function exitReasonText(event) {
  const reason = event?.exitInfo?.reason
  if (reason) return EXIT_REASON_TEXT[String(reason)] ?? `退出原因 ${reason}`
  if (event?.signal) return describeExit(event.code, event.signal)
  if (event?.code === 0) return '正常退出（code 0，没有归因文件）'
  return '被强制结束/崩溃（body 没留下退出归因）'
}

/** 同因第 2 次起给差异化建议：别再原样重试，先把这一类死因处理掉。 */
export function sameReasonAdvice(reasonKey) {
  const bucket = String(reasonKey ?? '')
  if (/uncaught-exception|unhandled-rejection/.test(bucket)) {
    return '：body 自己的 bug 在同一类地方反复崩，先别在原地重下同类任务，换区域/换手动做法（dig/place），并把最后日志发出来排查'
  }
  if (/reconnect-exhausted|idle-timeout/.test(bucket)) {
    return '：服务器/连接问题连续出现，先确认服务器开着、端口对、没有同名 bot，再 mcb_join'
  }
  if (/startup-error/.test(bucket)) {
    return '：启动就失败，先看 mcb_status 的进程/日志，别反复 join'
  }
  if (/exit-code/.test(bucket)) {
    return '：body 被非正常路径结束且没有栈——多半是依赖里直接退的，先看 body-exit.json 的 stderrTail，换个做法比反复重试有用'
  }
  if (/signal:|code:/.test(bucket)) {
    return '：这次不是身体自己报的错（被外部结束），如果总在同一处发生，先 mcb_status 看背包/位置，换做法再试'
  }
  return ''
}
