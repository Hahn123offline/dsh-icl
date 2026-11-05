#!/usr/bin/env node
// QQ 只读影子的"进程内 lab 演练"：不启动 SnowLuma、不连真 QQ、不建 DSH 会话。
//
//   node packages/plugins/qq/tools/qq-shadow-host.mjs [--out .state/qq-shadow/fake-<ts>]
//
// 它装配真实的 focus + time + qq 插件，接一个假 OneBot WS，然后按固定剧本走一遍：
//   私聊 → signals → delivery           （进模型的那条通道）
//   重复 / 群 / 陌生人                  （闸门挡掉）
//   睡觉（time gate）→ 私聊被拦下        （time 自己的 backlog 接住）
//   醒来                                  （time 把积压重放成一条 plugin:time 通知）
// 产出：<out>/report.md + <out>/delivery.jsonl + <out>/inbound.jsonl（qq 插件自己的影子记录）。
// 全程断言：qq 客户端发出 0 帧；一条群消息都没有进记录。
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHost } from '../../../core/src/index.mjs'
import { createFakeOneBot } from './fake-onebot.mjs'
import * as focusModule from '../../focus/src/index.mjs'
import * as timeModule from '../../time/src/index.mjs'
import * as qqModule from '../src/index.mjs'
import focusManifest from '../../focus/manifest.json' with { type: 'json' }
import timeManifest from '../../time/manifest.json' with { type: 'json' }
import qqManifest from '../manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback
}
const root = path.resolve(arg('out', path.join('.state', 'qq-shadow', `fake-${new Date().toISOString().replace(/[:.]/g, '-')}`)))
fs.mkdirSync(root, { recursive: true })

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const fake = await createFakeOneBot({ port: 0, token: 'shadow-token' })
const host = createHost({ log: () => {} })
const upstream = `ws://127.0.0.1:${fake.port}/`

host.registerPlugin(focusManifest, focusModule)
host.registerPlugin(timeManifest, timeModule, { config: { stateFile: path.join(root, 'time.json'), tickMs: 3_600_000 } })
host.registerPlugin(qqManifest, qqModule, {
  config: {
    enabled: true,
    url: upstream,
    token: 'shadow-token',
    selfId: '2593621742',
    allowPrivate: ['10001'],
    retryTickMs: 20,
    recordFile: path.join(root, 'inbound.jsonl'),
    dedupeFile: path.join(root, 'dedupe.json'),
  },
})
for (const id of ['focus', 'time', 'qq']) await host.enable(id)
const qq = host.shared.get('qq')
const time = host.shared.get('time')

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

try {
  check('连接假 OneBot', await waitFor(() => qq.status().connection.connected), upstream)
  fake.lifecycle()
  fake.heartbeat()

  const batches = []
  function drain() {
    const out = host.services.delivery.drain('session')
    for (const batch of out) {
      batches.push({ key: batch.key, text: batch.text })
      host.services.delivery.ack(batch.id)
    }
    return out
  }

  // 1) 正常私聊
  fake.privateMessage({ from: 10001, name: '主人', text: '在吗', messageId: 1001 })
  await waitFor(() => host.services.delivery.pendingCount() > 0)
  const first = drain()
  check('私聊进了 delivery', first.length === 1 && first[0].text.includes('主人：在吗'), first[0]?.text ?? '(空)')

  // 2) 闸门：重复 / 群 / 陌生人
  fake.privateMessage({ from: 10001, name: '主人', text: '在吗', messageId: 1001 })
  fake.groupMessage({ text: '（群消息，必须整类忽略）' })
  fake.privateMessage({ from: 999999, name: '陌生人', text: '（不在白名单）', messageId: 1002 })
  await sleep(150)
  const gate = qq.status().gate
  check('重复被去重', gate.byCode.duplicate >= 1, `duplicate=${gate.byCode.duplicate}`)
  check('群消息整类忽略', gate.byCode.group >= 1, `group=${gate.byCode.group}`)
  check('白名单外被拒', gate.byCode['not-allowlisted'] >= 1, `not-allowlisted=${gate.byCode['not-allowlisted']}`)
  drain()

  // 3) 睡觉时来私聊：time gate 拦下并进它自己的 backlog
  await time.sleep({ durationMin: 3 })
  drain() // 先清掉 time 自己"到整理时间了"的通知，别和 QQ 的断言混在一起
  fake.privateMessage({ from: 10001, name: '主人', text: '睡着时来的', messageId: 1003 })
  await sleep(150)
  let qqStatus = qq.status()
  check('睡眠锁拦下私聊', qqStatus.stats.blocked >= 1 && (qqStatus.stats.blockedReasons.sleeping ?? 0) >= 1, JSON.stringify(qqStatus.stats.blockedReasons))
  check('被拦下时不进 delivery', drain().length === 0)
  check('time 侧确实记了积压', time.queue().length >= 1, `queue=${time.queue().length}`)

  // 4) 醒来：time 把积压重放成一条 plugin:time 通知
  await time.wake()
  await waitFor(() => host.services.delivery.pendingCount() > 0)
  const replay = drain()
  check('time 醒来后重放积压', replay.length === 1 && replay[0].text.includes('睡着时来的'), replay[0]?.text?.replace(/\s+/g, ' ') ?? '(空)')

  // 5) 只读不变量
  qqStatus = qq.status()
  check('qq 客户端零出站帧', qqStatus.readOnlyInvariant.framesSent === 0)
  check('假服务器没收到客户端字节', fake.clientDataChunks() === 0, `chunks=${fake.clientDataChunks()}`)
  const raw = fs.readFileSync(path.join(root, 'inbound.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  check('影子记录不含群文本', !raw.some((row) => String(row.text ?? '').includes('群消息，必须整类忽略')))

  fs.writeFileSync(path.join(root, 'delivery.jsonl'), batches.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8')
  const ok = checks.every((c) => c.ok)
  const summary = { at: new Date().toISOString(), upstream, ok, gate: qqStatus.gate, stats: qqStatus.stats, batches, checks }
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8')
  fs.writeFileSync(path.join(root, 'report.md'), [
    '# QQ 只读影子：假 OneBot 演练',
    '',
    `- 时间：${summary.at}`,
    `- 上游：${upstream.replace(/access_token=[^&]+/, 'access_token=<redacted>')}`,
    `- 结果：${ok ? '全过' : '有失败'}`,
    '',
    '| 检查 | 结果 | 证据 |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail).replace(/\|/g, '\\|')} |`),
    '',
    '## 投递到模型的批次',
    '',
    '```text',
    ...batches.map((b) => `[${b.key}]\n${b.text}`),
    '```',
    '',
    `闸门计数：\`${JSON.stringify(qqStatus.gate.byCode)}\``,
    '',
  ].join('\n'), 'utf8')
  console.log(`\n报告：${path.join(root, 'report.md')}`)
  console.log(JSON.stringify({ ok, delivered: qqStatus.stats.delivered, blocked: qqStatus.stats.blocked, report: path.join(root, 'report.md') }))
  process.exitCode = ok ? 0 : 1
} finally {
  for (const id of ['qq', 'time', 'focus']) { try { host.disable(id) } catch { /* 已停 */ } }
  await fake.close()
}
