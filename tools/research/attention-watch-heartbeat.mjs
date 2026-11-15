// 观察下一次 live 心跳：醒来后 90 秒内发生了什么（只读）。
// 用法：node watch-heartbeat.mjs [timeoutMin]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const file = path.join(os.homedir(), '.dsh', 'icl', 'state', 'session-events.jsonl')
const timeoutMin = Number(process.argv[2] ?? 30)
const start = Date.now()
const startSize = fs.statSync(file).size

function readNew() {
  const size = fs.statSync(file).size
  if (size <= startSize) return []
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(size - startSize)
  fs.readSync(fd, buf, 0, buf.length, startSize)
  fs.closeSync(fd)
  return buf.toString('utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

let seen = 0
let rows = []
while ((Date.now() - start) / 60000 < timeoutMin) {
  const fresh = readNew().filter((row) => Number(row.seq) > seen)
  if (fresh.length) {
    for (const row of fresh) seen = Math.max(seen, Number(row.seq) || 0)
    rows.push(...fresh)
  }
  const hb = rows.findLast?.((row) => row.type === 'user/message' && /^【心跳】/.test(String(row.text ?? '')))
  if (hb) {
    console.log(`heartbeat at ${new Date(hb.time).toISOString()}:\n${String(hb.text).slice(0, 1200)}`)
    // 等这一轮结束（下一条 user/message 或 90s）
    const hbIdx = rows.indexOf(hb)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await sleep(3000)
      const now = readNew().filter((row) => Number(row.seq) > seen)
      if (now.length) {
        for (const row of now) seen = Math.max(seen, Number(row.seq) || 0)
        rows.push(...now)
      }
      const after = rows.slice(hbIdx + 1)
      if (after.some((row) => row.type === 'user/message')) break
    }
    const after = rows.slice(hbIdx + 1)
    const tools = after.filter((row) => row.type === 'tool/result').map((row) => String(row.text ?? ''))
    const assistant = after.filter((row) => row.type === 'assistant/message').map((row) => String(row.text ?? ''))
    console.log(JSON.stringify({
      decision: {
        toolCount: tools.length,
        toolSamples: tools.slice(0, 5).map((t) => t.slice(0, 120)),
        assistant: assistant.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300),
        qqSent: tools.some((t) => /^已发出去/.test(t)),
        checkedBacklog: tools.some((t) => /未读|积压|群 |群\s|私聊/.test(t)),
        enteredFocus: tools.some((t) => /进入了专注空间/.test(t)),
      },
    }, null, 2))
    process.exit(0)
  }
  await sleep(5000)
}
console.log('timeout: no heartbeat observed')
