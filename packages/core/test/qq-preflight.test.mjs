// preflight 判定：shadow 前"一条命令出结论"的可复跑取证。
// 只测纯函数（classifyPreflight / findRunningShadows），真机采集由 tools/preflight.mjs 负责。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyPreflight, findRunningShadows, renderUserBrief } from '../../plugins/qq/tools/preflight.mjs'

const NOW = 1_800_000_000_000

function cleanData(overrides = {}) {
  return {
    at: NOW,
    processes: { ok: true, rows: [] },
    tasks: { ok: true, rows: [] },
    established: { ok: true, rows: [] },
    ports: [{ port: 3000, listening: false }, { port: 3001, listening: false }],
    desktop: { ok: true, enabled: false, lines: [] },
    startup: { exists: false },
    snowluma: {
      endpoint: { ok: true, uin: '2593621742', wsUrl: 'ws://127.0.0.1:3001/', token: 'x' },
      lastLog: { name: 'snowluma-x.log', mtime: NOW },
      recentSends: 0,
    },
    shadows: [],
    ...overrides,
  }
}

test('preflight：干净机器 → CLEAR', () => {
  const out = classifyPreflight(cleanData())
  assert.equal(out.verdict, 'CLEAR')
  assert.equal(out.blocks, 0)
})

test('preflight：focus-core 旧应用在跑 → BLOCK（会连会发）', () => {
  const out = classifyPreflight(cleanData({
    processes: { ok: true, rows: [{ pid: 12232, name: 'node.exe', cmd: 'node  apps\\dsh-icl\\src\\main.js' }] },
  }))
  assert.equal(out.verdict, 'BLOCK')
  const row = out.checks.find((c) => c.id === 'processes')
  assert.equal(row.level, 'block')
  assert.match(row.detail, /12232/)
  assert.match(row.detail, /会发=true/)
})

test('preflight：dsh-qq 桥/接口平台在跑 → BLOCK', () => {
  for (const cmd of ['node C:\\DSH\\qwenstuff\\dsh-qq\\src\\bridge.js', 'node interface-platform/src/index.mjs']) {
    const out = classifyPreflight(cleanData({
      processes: { ok: true, rows: [{ pid: 333, name: 'node.exe', cmd }] },
    }))
    assert.equal(out.verdict, 'BLOCK', cmd)
  }
})

test('preflight：3000/3001 已在监听 → BLOCK', () => {
  const out = classifyPreflight(cleanData({
    ports: [{ port: 3000, listening: true }, { port: 3001, listening: true }],
  }))
  assert.equal(out.verdict, 'BLOCK')
  assert.match(out.checks.find((c) => c.id === 'ports').detail, /3000.*3001/)
})

test('preflight：desktop profile 还有启用的 snowluma 行 → BLOCK', () => {
  const out = classifyPreflight(cleanData({
    desktop: { ok: true, enabled: true, lines: ['- id: mcp-snowluma'] },
  }))
  assert.equal(out.verdict, 'BLOCK')
  assert.equal(out.checks.find((c) => c.id === 'desktop').level, 'block')
})

test('preflight：拿不到进程列表 → WARN（不能报 CLEAR）', () => {
  const out = classifyPreflight(cleanData({
    processes: { ok: false, rows: [], error: 'powershell 不可用' },
  }))
  assert.equal(out.verdict, 'WARN')
  assert.equal(out.checks.find((c) => c.id === 'processes').level, 'unknown')
})

test('preflight：已有真实 shadow 在跑 → BLOCK', () => {
  const out = classifyPreflight(cleanData({ shadows: [{ runId: 'qq-shadow-1', pid: 444, url: 'ws://127.0.0.1:3001/' }] }))
  assert.equal(out.verdict, 'BLOCK')
  assert.match(out.checks.find((c) => c.id === 'shadows').detail, /qq-shadow-1/)
})

test('findRunningShadows：只认进程还活着的；被 kill 的陈旧状态文件不算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-preflight-'))
  const makeRun = (id, { connected = true, pid = process.pid }) => {
    const runDir = path.join(dir, '.state', 'lab', id)
    fs.mkdirSync(path.join(runDir, 'qq-shadow'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'lab.json'), JSON.stringify({ pids: { dsh: pid } }), 'utf8')
    fs.writeFileSync(path.join(runDir, 'qq-shadow', 'status.json'), JSON.stringify({
      at: NOW,
      enabled: true,
      connection: { connected, url: 'ws://127.0.0.1:3001/' },
    }), 'utf8')
  }
  makeRun('live', { pid: process.pid })
  makeRun('dead', { pid: 999999 })
  const found = findRunningShadows(dir, NOW, (pid) => pid === process.pid)
  assert.deepEqual(found.map((row) => row.runId), ['live'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('给用户的一页说明：BLOCK 时讲清是谁、会做什么、怎么回滚', () => {
  const data = cleanData({
    processes: { ok: true, rows: [{ pid: 12232, name: 'node.exe', cmd: 'node  apps\\dsh-icl\\src\\main.js' }] },
  })
  const report = { ...classifyPreflight(data), data }
  const brief = renderUserBrief(report)
  assert.match(brief, /BLOCK/)
  assert.match(brief, /pid 12232/)
  assert.match(brief, /旧人格/)
  assert.match(brief, /回滚/)
  assert.match(brief, /只收不发|零出站/)
  assert.match(brief, /只收你的 QQ 私聊/)
})

test('给用户的一页说明：CLEAR 时直接给可开始的结论', () => {
  const data = cleanData()
  const report = { ...classifyPreflight(data), data }
  const brief = renderUserBrief(report)
  assert.match(brief, /CLEAR/)
  assert.match(brief, /可以按下面步骤开始/)
  assert.doesNotMatch(brief, /旧人格/)
})
