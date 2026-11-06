// E2 24h 半生产长测编排器：gate 校验 + 起 supervisor + 记忆质量监控 + 汇总报告 + 收尾。
// 用法：
//   node tools/mc-e2.mjs --phase smoke --hours 2  --run e2-<date>-smoke --gate .state/lab/E2-GATE.json
//   node tools/mc-e2.mjs --phase soak  --hours 24 --run e2-<date>       --gate .state/lab/E2-GATE.json
//   node tools/mc-e2.mjs --dry-run  ...   # 只校验 gate/参数并打印将执行的命令，不起资源
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readJson, readRunMeta, runDirOf, nowIso, tsSlug } from './lab-lib.mjs'

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const flag = (name) => process.argv.includes(name)
const phase = String(arg('--phase', 'smoke'))
const runId = String(arg('--run', `e2-${tsSlug()}`))
const hours = Number(arg('--hours', phase === 'soak' ? 24 : 2))
const gatePath = path.resolve(String(arg('--gate', '.state/lab/E2-GATE.json')))
const model = String(arg('--model', 'local'))
const serverName = String(arg('--server', 'survival'))
const serverPort = Number(arg('--server-port', 54838))
const serverDir = String(arg('--server-dir', 'C:/DSH/icl/.state/mc-survival'))
const mcUser = String(arg('--mc-user', 'ICL-e2-1'))
const labPort = Number(arg('--port', 57101))
const mcPort = Number(arg('--mc-port', 54902))
const dryRun = flag('--dry-run')
const resume = flag('--resume')
const withQuality = !flag('--no-quality')
const runDir = runDirOf(runId)
fs.mkdirSync(runDir, { recursive: true })
const logFile = path.join(runDir, 'e2.log')
const reportFile = path.join(runDir, 'e2-report.md')

function log(message) { const line = `${new Date().toISOString()} ${message}`; console.log(line); try { fs.appendFileSync(logFile, `${line}\n`) } catch { /* ignore */ } }
function fail(message) { log(`[E2] 拒绝/失败：${message}`); process.exit(2) }

/** 启动前 gate：必须先通知用户/lead，并把时间写进 gate 文件。 */
function checkGate() {
  if (dryRun) return { dryRun: true }
  if (!fs.existsSync(gatePath)) fail(`gate 文件不存在：${gatePath}\n先通知用户/lead，写入 {"userNotifiedAt":"...","approvedBy":"lead","phase":"${phase}-${hours}h"} 再启动。`)
  let gate = null
  try { gate = readJson(gatePath, null) } catch (error) { fail(`gate 文件解析失败：${String(error?.message ?? error)}`) }
  if (!gate?.userNotifiedAt) fail('gate 缺 userNotifiedAt：先通知用户/lead 并记录通知时间')
  if (!gate?.approvedBy) fail('gate 缺 approvedBy（lead）')
  const expected = phase === 'soak' ? /soak|24/i : /smoke|2h/i
  if (gate?.phase && !expected.test(String(gate.phase))) fail(`gate.phase=${gate.phase} 与 --phase ${phase} 不匹配`)
  return gate
}

async function tcpOk(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { try { socket.destroy() } catch { /* ignore */ } resolve(ok) }
    socket.setTimeout(700, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false))
  })
}

const gate = checkGate()
const supervisorArgs = [
  'tools/mc-night.mjs', '--run', runId, '--hours', String(hours), '--model', model,
  '--server-name', serverName, '--server-port', String(serverPort), '--server-dir', serverDir,
  '--mc-user', mcUser, '--mc-port', String(mcPort), '--port', String(labPort),
  '--checkpoint-min', '12', '--nudge-min', '45', '--turn-timeout-min', '20', '--stall-sec', '600',
  // E2 复杂度收敛（misc COMPLEXITY-AUDIT）：steer 预算 ≤10 条/2h，死亡/暂停提示压成一句。
  '--terse-prompts', '--playbook-min', '6', '--playbook-idle-sec', '90',
  // zero-wait（time immediate）：turn/end 后 ~1s 自检；goal 续推 0s。
  '--awake-mode', 'immediate', '--awake-min-idle-sec', '1', '--awake-idle-sec', '8', '--goal-gap-sec', '0',
]
const qualityArgs = ['tools/mc-quality.mjs', '--run', runId, '--interval', '60', '--preset', 'icl-mc-lab']

log(`[E2] phase=${phase} hours=${hours} run=${runId} model=${model} server=${serverName}:${serverPort} bot=${mcUser} gate=${gatePath}`)
if (dryRun) {
  log(`[E2] dry-run：gate=${JSON.stringify(gate)}；将执行：\n  node ${supervisorArgs.join(' ')}\n  node ${qualityArgs.join(' ')}`)
  process.exit(0)
}
log(`[E2] gate OK：userNotifiedAt=${gate.userNotifiedAt} approvedBy=${gate.approvedBy} phase=${gate.phase ?? phase}`)

async function main() {
  // 互斥：已有 lab 在跑就拒绝（除非 --resume 且就是本 run）
  const existing = readRunMeta(runId)
  if (existing?.status === 'running' && !resume) fail(`run ${runId} 已有 lab 在跑（session ${existing.sessionId}）；用 --resume 接管或换 runId`)
  if (!(await tcpOk(serverPort))) log(`[E2] 服务器 ${serverPort} 未监听，交由 supervisor ensureServer 启动`)
  const out = fs.openSync(logFile, 'a')
  log(`[E2] 启动 supervisor：node ${supervisorArgs.join(' ')}`)
  const supervisor = spawn(process.execPath, supervisorArgs, { cwd: process.cwd(), stdio: ['ignore', out, out], windowsHide: true })
  let quality = null
  if (withQuality) {
    log(`[E2] 启动质量监控：node ${qualityArgs.join(' ')}`)
    quality = spawn(process.execPath, qualityArgs, { cwd: process.cwd(), stdio: ['ignore', out, out], windowsHide: true })
  }
  const code = await new Promise((resolve) => supervisor.on('close', (value) => resolve(value)))
  log(`[E2] supervisor 退出 code=${code}`)
  if (quality) { try { quality.kill() } catch { /* ignore */ } }
  // 汇总：拼接 supervisor 早报 + 质量报告
  try {
    const morning = fs.existsSync(path.join(runDir, 'morning-report.md')) ? fs.readFileSync(path.join(runDir, 'morning-report.md'), 'utf8') : '(没有 morning-report.md)'
    const qualityText = fs.existsSync(path.join(runDir, 'quality-report.md')) ? fs.readFileSync(path.join(runDir, 'quality-report.md'), 'utf8') : '(没有 quality-report.md)'
    const lines = [
      `# E2 ${phase} 长测报告 — ${runId}`, '',
      `- 阶段：${phase} · 计划 ${hours}h · 实际结束：${nowIso()} · supervisor exit=${code}`, `- gate：${JSON.stringify(gate)}`, '', '## Supervisor 早报', '', morning, '', '## 记忆质量', '', qualityText,
    ]
    fs.writeFileSync(reportFile, `${lines.join('\n')}\n`)
    log(`[E2] 汇总报告已写：${reportFile}`)
  } catch (error) { log(`[E2] 汇总报告失败：${String(error?.message ?? error)}`) }
  process.exit(code === 0 ? 0 : 1)
}

main().catch((error) => { log(`[E2] 异常：${String(error?.stack ?? error)}`); process.exit(1) })
