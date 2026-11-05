#!/usr/bin/env node
// 在真实 lab（独立 DSH web 实例）里验证 QQ 只读入站接缝。
//
// 两种模式：
//   1. 假上游（默认，零风险）：OneBot(假服务) → qq 插件 → signals → delivery → agent.steer → user/message(plugin:qq)
//      node packages/plugins/qq/tools/lab-shadow.mjs --port 57108 --run qq-1
//   2. 真实 SnowLuma（只在该用户批准的时间窗内用）：连 127.0.0.1:3001 的 OneBot WS，只收不发。
//      node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --wait-ms 900000
//      前置条件见 docs/QQ.md §10 shadow runbook（必须先停掉会自动抢连接的旧消费者）。
//
// 两条路线都不启动 SnowLuma、不碰 3000/3120、不写 SnowLuma 文件、不发任何 QQ 消息。
// 产出一律落 <runDir>/（.state/lab/<runId>/，gitignored）：report.md / events.jsonl / transcript.md / qq-shadow/。
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO_ROOT, STATE_ROOT, apiFor, clearCurrent, createLabSession, discoverDshBin, ensureDir,
  isPidAlive, killPidTree, materializePatch, portBusy, readJson, readJsonl, rebuildTranscript,
  saveCurrent, sleep, spawnDsh, spawnObserver, tsSlug, waitApiReady, writeJson, writeRunMeta,
} from '../../../../tools/lab-lib.mjs'
import { createFakeOneBot } from './fake-onebot.mjs'

const args = process.argv.slice(2)
const dash = (name) => (String(name).startsWith('--') ? String(name) : `--${name}`)
const arg = (name, fallback = null) => {
  const i = args.indexOf(dash(name))
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback
}
const flag = (name) => args.includes(dash(name))

const REAL = flag('real')
const APPROVAL = String(arg('--approval', ''))
const PORT = Number(arg('--port', 57108))
const RUN_ID = String(arg('--run', `${REAL ? 'qq-real' : 'qq-fake'}-${tsSlug()}`))
const PRESET = 'icl-lab'
const TOKEN = 'lab-shadow-token'
const PEER = String(arg('--peer', REAL ? '3429502459' : '10001'))
const SNOWLUMA_HOME = String(arg('--home', 'C:/Users/ai_admin/Downloads/SnowLuma-v2.1.1-win-x64-lite'))
const BOT_UIN = String(arg('--bot', '2593621742'))
const WAIT_MS = Number(arg('--wait-ms', REAL ? 900_000 : 45_000))
const DRY_RUN = flag('dry-run')

if (REAL && APPROVAL !== 'lead-approved') {
  console.error('[qq-lab] 拒绝：--real 需要 --approval lead-approved（真实影子要 lead 与用户明确批准）')
  process.exit(2)
}
if (await portBusy(PORT)) {
  console.error(`[qq-lab] 端口 ${PORT} 已被占用；先确认没有别的 lab 在跑`)
  process.exit(1)
}

const runDir = path.join(STATE_ROOT, RUN_ID)
const posix = (p) => p.replace(/\\/g, '/')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const fake = REAL ? null : await createFakeOneBot({ port: 0, token: TOKEN })
let meta = null
let dsh = null
let observer = null
let api = null
let sessionId = null

function qqPluginBlock() {
  const common = [
    '                qq:',
    '                  enabled: true',
    `                  selfId: '${BOT_UIN}'`,
    '                  allowPrivate:',
    `                    - '${PEER}'`,
    `                  recordFile: '${posix(path.join(runDir, 'qq-shadow', 'inbound.jsonl'))}'`,
    `                  statusFile: '${posix(path.join(runDir, 'qq-shadow', 'status.json'))}'`,
    `                  statusIntervalMs: 1000`,
    `                  dedupeFile: '${posix(path.join(runDir, 'qq-shadow', 'dedupe.json'))}'`,
    '                  retryTickMs: 20',
  ]
  if (REAL) {
    // 端点与 token 由插件在运行时从 SnowLuma 的 onebot_<uin>.json 只读发现；
    // patch 里只有目录与账号，没有密钥。
    common.push(`                  snowlumaHomeDir: '${posix(SNOWLUMA_HOME)}'`)
    common.push(`                  accountUin: '${BOT_UIN}'`)
  } else {
    common.push(`                  url: 'ws://127.0.0.1:${fake.port}/'`)
    common.push(`                  token: '${TOKEN}'`)
  }
  return common.join('\n') + '\n'
}

function patchText(file) {
  // 模板可能带 CRLF：先归一成 LF，再按行注入（YAML 对行尾不敏感）
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  // 只在 icl-lab 的插件列表里加 qq（icl-mc-lab 那段保持原样）
  text = text.replace('                - bili\n', '                - bili\n                - qq\n')
  const block = `              pluginConfig:\n${qqPluginBlock()}`
  text = text.replace('              timeTickMs: 1000\n', `              timeTickMs: 1000\n${block}`)
  if (!/                - qq\n/.test(text) || !text.includes('pluginConfig:')) throw new Error('patch 注入 qq 失败')
  fs.writeFileSync(file, text, 'utf8')
  return text
}

function findPluginMessage(eventsFile, text) {
  for (const envelope of readJsonl(eventsFile)) {
    const event = envelope?.payload?.event ?? envelope?.event
    if (!event || event.type !== 'user/message') continue
    const data = event.data ?? {}
    if (String(data?.source?.kind ?? '') !== 'plugin:qq') continue
    if (text != null && !JSON.stringify(data).includes(text)) continue
    return event
  }
  return null
}

try {
  ensureDir(runDir)
  const patch = materializePatch({ runDir })
  const patchSource = patchText(patch)
  const dshBin = discoverDshBin()
  if (!dshBin) throw new Error('找不到 dsh bin.js')

  if (DRY_RUN) {
    console.log(`[qq-lab] dry-run：patch 已物化到 ${patch}`)
    console.log(patchSource.split('\n').filter((line) => /qq|snowlumaHomeDir|accountUin|allowPrivate|recordFile|dedupeFile|pluginConfig/.test(line)).join('\n'))
    process.exitCode = 0
  } else {
    meta = { runId: RUN_ID, mode: REAL ? 'real-shadow' : 'fake-upstream', port: PORT, preset: PRESET, worktree: REPO_ROOT, dshBin, patch, runDir, startedAt: new Date().toISOString(), status: 'booting', pids: {} }
    writeRunMeta(RUN_ID, meta)
    saveCurrent({ runId: RUN_ID, port: PORT, preset: PRESET, runDir, startedAt: meta.startedAt, pids: {} })

    dsh = spawnDsh({ bin: dshBin, patch, port: PORT, logDir: runDir })
    meta.pids.dsh = dsh.pid
    writeRunMeta(RUN_ID, meta)
    saveCurrent({ runId: RUN_ID, port: PORT, preset: PRESET, runDir, startedAt: meta.startedAt, pids: { dsh: dsh.pid } })

    api = apiFor(PORT)
    await waitApiReady(api, { timeoutMs: 180_000, shouldAbort: () => !isPidAlive(dsh.pid) })
    const created = await createLabSession(api, { preset: PRESET, workspace: path.join(runDir, 'workspace'), title: `QQ shadow lab ${RUN_ID}` })
    sessionId = created.sessionId
    meta.sessionId = sessionId
    meta.workspaceId = created.workspaceId
    meta.status = 'running'
    writeRunMeta(RUN_ID, meta)

    observer = spawnObserver({ runDir, port: PORT, sessionId, logDir: runDir })
    meta.pids.observer = observer.pid
    writeRunMeta(RUN_ID, meta)
    saveCurrent({ runId: RUN_ID, port: PORT, preset: PRESET, runDir, startedAt: meta.startedAt, pids: { dsh: dsh.pid, observer: observer.pid } })
    const observerDeadline = Date.now() + 25_000
    while (Date.now() < observerDeadline) {
      if (readJson(path.join(runDir, 'observer.status.json'), null)?.connected) break
      await sleep(200)
    }
    check('lab 会话建立', Boolean(sessionId), `session=${sessionId} port=${PORT} mode=${meta.mode}`)

    // 影子状态文件（插件自己原子写）：不看进程也能判断"在不在听、发了多少帧"
    const statusFile = path.join(runDir, 'qq-shadow', 'status.json')
    const outDeadline = Date.now() + 25_000
    let shadowStatus = null
    while (Date.now() < outDeadline) {
      shadowStatus = readJson(statusFile, null)
      if (shadowStatus?.connection?.connected) break
      await sleep(200)
    }
    check('qq 插件完成装配并上报状态', Boolean(shadowStatus), statusFile.replace(REPO_ROOT, '.'))
    check('qq 上游连接已打开', shadowStatus?.connection?.connected === true, shadowStatus ? `state=${shadowStatus.connection.state} url=${shadowStatus.connection.url ?? '?'}` : '无状态文件')
    check('零出站帧（插件自报）', shadowStatus?.readOnlyInvariant?.framesSent === 0, `framesSent=${shadowStatus?.readOnlyInvariant?.framesSent ?? '?'}；出站=${shadowStatus?.sendEnabled ? '开' : '关闭'}`)

    const eventsFile = path.join(runDir, 'events.jsonl')
    let hit = null
    if (REAL) {
      // 真实影子：不注入任何消息，等用户在这个时间窗里发一条私聊
      console.log(`[qq-lab] 真实影子运行中：${Math.round(WAIT_MS / 1000)} 秒内请用 owner QQ（${PEER}）给机器人（${BOT_UIN}）发一条私聊；只收不发。`)
      const deadline = Date.now() + WAIT_MS
      while (Date.now() < deadline && !hit) {
        hit = findPluginMessage(eventsFile, null)
        if (!hit) await sleep(500)
      }
    } else {
      fake.lifecycle()
      fake.heartbeat()
      const messageId = Date.now() % 1e9
      const text = 'lab 里的第一条 QQ 私聊'
      fake.privateMessage({ from: Number(PEER), name: '主人', text, messageId })
      fake.privateMessage({ from: Number(PEER), name: '主人', text, messageId }) // 同 id 重复
      fake.groupMessage({ text: '（群消息必须整类忽略）' })
      fake.privateMessage({ from: 999999, name: '陌生人', text: '（白名单外）', messageId: (messageId + 1) % 1e9 })
      const deadline = Date.now() + WAIT_MS
      while (Date.now() < deadline && !hit) {
        hit = findPluginMessage(eventsFile, text)
        if (!hit) await sleep(300)
      }
    }
    check(`QQ 消息以 plugin:qq user/message 进入 DSH 会话`, Boolean(hit), hit ? `seq=${hit.seq ?? '?'} type=${hit.type}` : `${Math.round(WAIT_MS / 1000)}s 内没等到`)
    if (hit) {
      const summary = String(hit?.data?.source?.summary ?? '')
      check('notice 的 summary 可追溯来源', summary.includes('QQ') || summary.includes('外部消息'), summary.slice(0, 120))
    }

    // qq 插件自己的影子记录
    const recordFile = path.join(runDir, 'qq-shadow', 'inbound.jsonl')
    const rows = readJsonl(recordFile)
    const accepted = rows.filter((row) => row.kind === 'accepted')
    if (REAL) {
      check('影子记录里只有白名单私聊（没有群/陌生人）', !rows.some((row) => ['group', 'not-allowlisted'].includes(row.code)), `accepted=${accepted.length} rows=${rows.length}`)
      check('影子记录不含群文本', !rows.some((row) => String(row.text ?? '').includes('群消息')))
    } else {
      check('影子记录：accepted 只有 1 条（重复被去重）', accepted.length === 1, `accepted=${accepted.length} rows=${rows.length}`)
      check('影子记录不含群文本', !rows.some((row) => String(row.text ?? '').includes('群消息必须整类忽略')))
      check('客户端零出站字节', fake.clientDataChunks() === 0, `chunks=${fake.clientDataChunks()}`)
    }
    if (hit) {
      const transcript = rebuildTranscript(runDir)
      const transcriptText = fs.readFileSync(transcript.file, 'utf8')
      check('transcript 能看到这条插件消息', transcriptText.includes('插件消息') && /qq/.test(transcriptText), path.basename(transcript.file))
      writeJson(path.join(runDir, 'checks.json'), { ok: checks.every((c) => c.ok), mode: meta.mode, checks })
      fs.writeFileSync(path.join(runDir, 'report.md'), [
        '# QQ 只读影子：真实 lab 验证',
        '',
        `- 时间：${new Date().toISOString()}`,
        `- 模式：${meta.mode}（${REAL ? `上游=真实 SnowLuma（只读发现），等待用户私聊 ${PEER}` : `上游=假 OneBot ws://127.0.0.1:${fake.port}/`}）`,
        `- lab：port=${PORT} preset=${PRESET} session=${sessionId}`,
        `- 结果：${checks.every((c) => c.ok) ? '全过' : '有失败'}`,
        '',
        '| 检查 | 结果 | 证据 |',
        '|---|---|---|',
        ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail).replace(/\|/g, '\\|')} |`),
        '',
        `- 事件账本：${posix(eventsFile)}`,
        `- 影子记录：${posix(recordFile)}`,
        '',
        '> 真实模式的安全口径：不启动 SnowLuma、不调任何 OneBot 动作、不发任何 QQ 消息；',
        '> 群消息在本地闸门整类拒绝并只计数。零出站帧由代码不变量与单元测试保证（见 docs/QQ.md §10）。',
        '',
      ].join('\n'), 'utf8')
      console.log(`\n报告：${path.join(runDir, 'report.md')}`)
      console.log(JSON.stringify({ ok: checks.every((c) => c.ok), runId: RUN_ID, sessionId, runDir, checks }))
      process.exitCode = checks.every((c) => c.ok) ? 0 : 1
    } else {
      writeJson(path.join(runDir, 'checks.json'), { ok: false, mode: meta.mode, checks })
      process.exitCode = 1
    }
  }
} catch (error) {
  console.error(`[qq-lab] 失败：${String(error?.stack ?? error)}`)
  process.exitCode = 1
} finally {
  if (meta) {
    meta.status = process.exitCode === 0 ? 'done' : 'failed'
    meta.endedAt = new Date().toISOString()
    meta.pids = meta.pids ?? {}
    try { writeRunMeta(RUN_ID, meta) } catch { /* 已写不进就放弃 */ }
  }
  if (!DRY_RUN && !flag('keep')) {
    if (observer?.pid) await killPidTree(observer.pid)
    if (dsh?.pid) await killPidTree(dsh.pid)
    try { clearCurrent(RUN_ID) } catch { /* 已清 */ }
  } else if (!DRY_RUN) {
    console.log(`--keep：dsh pid=${dsh?.pid} observer pid=${observer?.pid}；停：node tools/lab.mjs down --run ${RUN_ID}`)
  }
  await fake?.close()
}

