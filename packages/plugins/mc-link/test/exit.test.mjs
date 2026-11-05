// 退出归因文案：reason 分类 → 人话；同因累计建议；describeExit 的无符号码归一。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EXIT_REASON_TEXT, exitReasonText, sameReasonAdvice } from '../src/exit.mjs'
import { describeExit } from '../src/lifecycle.mjs'

test('exit：有 body-exit.json 的 reason 时用人话，旧 body 退回退出码/信号', () => {
  assert.match(exitReasonText({ code: 0, exitInfo: { reason: 'api-shutdown' } }), /主动停止/)
  assert.match(exitReasonText({ code: 0, exitInfo: { reason: 'idle-timeout' } }), /暂停太久/)
  assert.match(exitReasonText({ code: 1, exitInfo: { reason: 'uncaught-exception' } }), /未捕获异常/)
  assert.match(exitReasonText({ code: 1, signal: null }), /被强制结束/)
  assert.match(exitReasonText({ code: null, signal: 'SIGTERM' }), /SIGTERM/)
  assert.match(exitReasonText({ code: 0 }), /正常退出/)
  for (const key of Object.keys(EXIT_REASON_TEXT)) assert.ok(EXIT_REASON_TEXT[key].length >= 4, key)
})

test('exit：同因第 2 次起的建议按原因分类（崩溃/连接/启动/被外部结束）', () => {
  assert.match(sameReasonAdvice('uncaught-exception'), /别在原地重下同类任务|换区域/)
  assert.match(sameReasonAdvice('unhandled-rejection'), /换区域/)
  assert.match(sameReasonAdvice('reconnect-exhausted'), /确认服务器开着/)
  assert.match(sameReasonAdvice('startup-error'), /别反复 join/)
  assert.match(sameReasonAdvice('signal:SIGKILL'), /不是身体自己报的错/)
  assert.equal(sameReasonAdvice('some-new-reason'), '')
})

test('exit：Windows 强杀的 4294967295 归一成 -1，正常退出说清楚', () => {
  assert.match(describeExit(4294967295, null), /-1.*被强制结束/)
  assert.match(describeExit(1, null), /退出码 1/)
  assert.match(describeExit(0, null), /正常退出/)
  assert.match(describeExit(null, 'SIGTERM'), /SIGTERM/)
})
