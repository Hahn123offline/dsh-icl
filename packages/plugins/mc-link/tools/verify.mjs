// mc-link 真实链路自测：真 mc-body + 真 flat 服务器，不连 DSH。
//
// 覆盖 docs/MC-ACCEPTANCE.md 的 C（任务中 kill body：会话看到退出原因、能重连、不假在线）
// 与 E（leave 后未连接、goal/focus 不被自动取消），外加 A 的工具序列（servers→join→status→do）。
//
// 用法：node packages/plugins/mc-link/tools/verify.mjs [--port 54901] [--server flat]
// 产物：<repo>/.state/mc-link-verify/{report.md,link.jsonl,body.jsonl,body.stderr.log}
import fs from 'node:fs'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../../../core/src/index.mjs'
import * as mcLink from '../src/index.mjs'
import manifest from '../manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const listenPort = Number(arg('--port', 54901))
const serverName = String(arg('--server', 'flat'))
const mcHost = arg('--mc-host', null)
const mcPort = arg('--mc-port', null)
const directTarget = mcHost && mcPort ? { host: String(mcHost), port: Number(mcPort) } : null
const joinArgs = directTarget ? { ...directTarget, username: 'ICL-mclink-1' } : { server: serverName }
const targetLabel = directTarget ? `${directTarget.host}:${directTarget.port}` : '127.0.0.1:54837'
const bodyEntry = arg('--body-entry', null)
const root = path.resolve(arg('--state', path.join(import.meta.dirname, '..', '..', '..', '..', '.state', 'mc-link-verify')))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

fs.mkdirSync(root, { recursive: true })
const lines = []
const checks = []
function log(message) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`
  lines.push(line)
  console.log(line)
}
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const base = `http://127.0.0.1:${listenPort}`
const host = createHost({ log: () => {} })
host.registerPlugin(manifest, mcLink, {
  config: {
    baseUrl: `http://127.0.0.1:${listenPort}`,
    listenPort,
    pollMs: 60_000,
    logFile: path.join(root, 'link.jsonl'),
    stateDir: root,
    doTimeoutMs: 45_000,
    username: 'ICL-mclink-1',
    ...(bodyEntry ? { bodyEntry } : {}),
  },
})
await host.enable('mc-link')
const pushed = []
const adapter = createSessionAdapter({ sessionId: 'mc-link-verify', host, push: async (text) => { pushed.push(String(text)) } })
const tools = Object.fromEntries(host.services.tools.list().map((tool) => [tool.name, tool]))
const api = host.shared.get('mc-link')

async function drain() {
  await adapter.drainOnce()
  return pushed.join('\n')
}

try {
  // A. 她怎么找到服务器、怎么连上
  const servers = await tools.mcb_servers.execute({})
  log(`mcb_servers:\n${servers.text}`)
  check('servers 单一定义里有 flat 54837', /flat\s+127\.0\.0\.1:54837/.test(servers.text))

  const joined = await tools.mcb_join.execute(joinArgs)
  log(`mcb_join: ${joined.text}`)
  check('join 真的连上服务器', joined.text.includes(`已连接 ${targetLabel}`), joined.text)
  const own1 = api.supervisor()
  check('body 是本会话 spawn 的（有 pid）', own1.owns && own1.pid > 0, `pid=${own1.pid}`)

  await api.poll()
  const status = await tools.mcb_status.execute({})
  log(`mcb_status:\n${status.text}`)
  check('status 报已连接且给出位置', /已连接/.test(status.text) && /位置：[-\d]+,/.test(status.text))

  const look = await tools.mcb_look.execute({})
  log(`mcb_look: ${look.text.split('\n')[0]}`)
  check('look 返回视角文本', /位置：/.test(look.text))

  // B. 下任务，等真实任务事件回到会话
  const task = await tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { block: 'dirt', count: 2, radius: 8 } }] })
  log(`mcb_do task: ${task.text}`)
  check('task 立即返回 taskId', /任务 t-\d+（mine）已接受/.test(task.text))

  let taskEvent = ''
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await api.poll()
    const text = await drain()
    if (/任务(t-\d+)?.*(完成|失败|中断|没达成)|\[MC\] 任务/.test(text)) { taskEvent = text; break }
    await wait(600)
  }
  log(`任务事件（会话收到的原话）：\n${taskEvent}`)
  check('任务完成/失败事件回到会话且有 taskId', /任务/.test(taskEvent), taskEvent.split('\n').slice(-1)[0] ?? '')

  // S. 外部管理面 /v1/shutdown（模拟"睡眠期收身体保命"）：必须算 expected、不崩溃、不自动重启
  const extPid = api.supervisor().pid
  const beforeExt = pushed.length
  const shutdownRes = await fetch(`${base}/v1/shutdown`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'sleep-safe: verify' }),
  }).then((r) => r.json()).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
  log(`外部 /v1/shutdown → ${JSON.stringify(shutdownRes)}（body pid ${extPid}）`)
  await wait(1800)
  await api.poll()
  const extText = pushed.slice(beforeExt).join('\n')
  const extState = api.supervisor()
  check('外部 /v1/shutdown 被接受', shutdownRes?.ok === true, JSON.stringify(shutdownRes))
  check('外部干净关闭不产生崩溃告警', !/身体进程.*退出/.test(extText), extText.split('\n').slice(-1)[0] ?? '')
  check('外部干净关闭后没有自动重启（本会话无 body）', extState.owns === false, `owns=${extState.owns} pid=${extState.pid}`)
  const extStatus = await tools.mcb_status.execute({})
  log(`外部关闭后 mcb_status:\n${extStatus.text}`)
  check('mcb_status 报未连接', /未连接/.test(extStatus.text))
  check('mcb_status 说明上次退出是预期内（不是崩溃）', /上次退出：.*预期内/.test(extStatus.text), extStatus.text.split('\n').find((line) => line.startsWith('上次退出')) ?? '')
  const backAgain = await tools.mcb_join.execute(joinArgs)
  log(`外部关闭后 mcb_join: ${backAgain.text}`)
  check('外部关闭后 mcb_join 能重新起 body', backAgain.text.includes('已连接'), backAgain.text)
  const afterBack = api.supervisor()
  check('重新 join 得到新的 body 进程', afterBack.owns && afterBack.pid && afterBack.pid !== extPid, `new pid=${afterBack.pid}`)

  // C. 任务运行中 kill body：会话必须看到"进程退出 + 原因"，不能假在线
  const killPid = api.supervisor().pid
  log(`kill body pid=${killPid}`)
  process.kill(killPid, 'SIGKILL')
  await wait(1200)
  await api.poll()
  const crashText = await drain()
  log(`kill 后会话收到：\n${crashText}`)
  check('kill 后会话收到退出通知', /身体进程.*退出/.test(crashText), crashText.split('\n').slice(-1)[0] ?? '')
  check('退出通知带退出码/信号原因', /退出码|信号/.test(crashText))
  const afterCrash = await tools.mcb_status.execute({})
  log(`掉线后 mcb_status:\n${afterCrash.text}`)
  check('掉线后 status 不假在线', /未连接/.test(afterCrash.text) && !/已连接/.test(afterCrash.text))

  // C2. 能重连，且旧任务不自动续跑
  const rejoined = await tools.mcb_join.execute(joinArgs)
  log(`mcb_join（重连）: ${rejoined.text}`)
  const own2 = api.supervisor()
  check('重连起了一个新 body 进程', own2.owns && own2.pid && own2.pid !== killPid, `new pid=${own2.pid}`)
  await api.poll()
  const status2 = await tools.mcb_status.execute({})
  check('重连后状态是空闲（旧任务不自动续跑）', /任务：空闲/.test(status2.text), status2.text.split('\n').find((line) => line.startsWith('任务')) ?? '')

  // E. 退出清理：leave 后 body 进程消失、下一轮 status 未连接
  const leavePid = api.supervisor().pid
  // 挂一个模型 focus + 一条 MC 持续目标，验证 leave 的报告与 cleanup 语义（time 不在这个 driver 里，所以 goal 为空）。
  const lease = host.services.focus.enter({ label: 'mc', owner: 'focus', title: '在 MC 里玩' })
  const left = await tools.mcb_leave.execute({})
  log(`mcb_leave（默认只停 body）: ${left.text}`)
  check('leave 报告安全停止结果', /安全停止：成功/.test(left.text), left.text.split('；')[0] ?? '')
  check('leave 结论先行（第一句就说干不干净）', /^(已完全收工|收工完成但没完全干净)/.test(left.text), left.text.split('；')[0] ?? '')
  check('leave 报告进程怎么结束（pid）', /body 进程：(已结束|已正常退出)（pid/.test(left.text))
  check('leave 报告还挂着的 focus/goal', /还挂着：focus 1 个/.test(left.text))
  await wait(800)
  let dead = false
  try { process.kill(leavePid, 0); dead = false } catch { dead = true }
  check('leave 后 body 进程真的消失', dead, `pid=${leavePid}`)
  const afterLeave = await tools.mcb_status.execute({})
  log(`leave 后 mcb_status:\n${afterLeave.text}`)
  check('leave 后下一轮 status 报未连接', /未连接/.test(afterLeave.text) && !/已连接/.test(afterLeave.text))
  const cleaned = await tools.mcb_leave.execute({ cleanup: true })
  log(`mcb_leave（cleanup:true）: ${cleaned.text}`)
  check('cleanup 释放 focus 租约', /收尾清理：focus 释放 1 个/.test(cleaned.text) && host.services.focus.list().length === 0)
  check('cleanup 后结论是"已完全收工"', /已完全收工/.test(cleaned.text), cleaned.text.split('；')[0] ?? '')
  const again = await tools.mcb_leave.execute({ cleanup: true })
  check('leave 幂等（第二次没有可清的东西，不报错）', /没有启动过|没有挂着的|都空了/.test(again.text), again.text)
  check('cleanup 之后没有残留 focus 租约', host.services.focus.list().length === 0)
} catch (error) {
  check('脚本无异常', false, String(error?.stack ?? error))
} finally {
  const report = [
    '# mc-link 真实链路自测（C/E）',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- body HTTP：127.0.0.1:${listenPort}；MC 服务器：${targetLabel}${directTarget ? '' : `（${serverName}）`}`,
    `- 结果：${checks.filter((row) => row.ok).length}/${checks.length} 通过`,
    '',
    '## 检查项',
    '',
    ...checks.map((row) => `- ${row.ok ? '✅' : '❌'} ${row.name}${row.detail ? ` — ${row.detail}` : ''}`),
    '',
    '## 会话收到的消息',
    '',
    '```text',
    ...pushed,
    '```',
    '',
    '## 时间线',
    '',
    '```text',
    ...lines,
    '```',
  ].join('\n')
  fs.writeFileSync(path.join(root, 'report.md'), report, 'utf8')
  log(`report → ${path.join(root, 'report.md')}`)
  adapter.dispose()
  host.disable('mc-link')
  await api.leave?.().catch?.(() => {})
  await wait(300)
}
