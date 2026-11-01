// 诊断：一条事实是在哪一层丢的？
//
//   node tools/recall-diagnose.mjs
//
// 对冻结题库里的每一题，沿链路逐层检查：
//   raw      原文里有没有
//   note     抽取成了 note 没有
//   block    成块了没有
//   candidate 进入检索候选集（search 前 50）没有
//   ranked   排进前 4 没有
//   recall   recall 的输出里有没有
//
// 第一个为 false 的层，就是这一题的"责任层"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }

const QQ_DB = 'C:/DSH/qwenstuff/dsh-qq/state/memory.db'
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'bench-qq.json')
const K = 4
const norm = (s) => String(s ?? '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/g, '').replace(/\s+/g, '')
const has = (haystack, needle) => norm(haystack).includes(norm(needle))

const questions = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('icl-replay-')).map((d) => path.join(os.tmpdir(), d))
dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
const root = dirs[0]

const rawDb = new DatabaseSync(QQ_DB, { readOnly: true })
const rawText = rawDb.prepare('SELECT text FROM messages').all().map((r) => r.text).join('\n')
rawDb.close()

const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'diag' } })
await host.enable('memory')
await host.enable('recall')
const mem = host.shared.get('memory')
const recallTool = host.services.tools.list().find((t) => t.name === 'recall')
const recallSvc = host.shared.get('recall')

const notesText = ['event', 'person', 'slang']
  .flatMap((ns) => mem.query({ namespace: ns, kind: 'note', limit: 500 }))
  .map((n) => `${n.text}\n${JSON.stringify(n.data ?? {})}`).join('\n')
const blocksText = ['event', 'person', 'slang']
  .flatMap((ns) => mem.query({ namespace: ns, kind: 'block', limit: 500 }))
  .map((b) => `${b.text}\n${b.data?.body ?? b.data?.profile ?? ''}`).join('\n')

const rows = []
for (const item of questions) {
  const stages = {
    raw: has(rawText, item.expect),
    note: has(notesText, item.expect),
    block: has(blocksText, item.expect),
  }
  // 候选集：search 前 50（与 recall 的内部调用一致）
  const hits = await mem.search({ query: item.q, limit: 50 })
  stages.candidate = hits.some((h) => has(`${h.item.text}\n${h.item.data?.body ?? h.item.data?.profile ?? ''}`, item.expect))
  const rank = hits.findIndex((h) => has(`${h.item.text}\n${h.item.data?.body ?? h.item.data?.profile ?? ''}`, item.expect))
  stages.ranked = rank >= 0 && rank < K
  recallSvc?.resetCursor?.()
  const out = await recallTool.execute({ query: item.q, limit: K })
  stages.recall = has(out.text, item.expect)

  const order = ['raw', 'note', 'block', 'candidate', 'ranked', 'recall']
  const blame = order.find((s) => !stages[s]) ?? 'none'
  rows.push({ q: item.q, level: item.level, expect: item.expect, rank, stages, blame })
}

const stageNames = ['raw', 'note', 'block', 'candidate', 'ranked', 'recall']
console.log(`\n=== 责任层诊断（${rows.length} 题，库：${path.basename(root)}）===`)
for (const s of stageNames) {
  const ok = rows.filter((r) => r.stages[s]).length
  console.log(`${s.padEnd(10)} ${String(ok).padStart(3)}/${rows.length}`)
}

const blameCount = new Map()
for (const r of rows) blameCount.set(r.blame, (blameCount.get(r.blame) ?? 0) + 1)
console.log('\n责任层分布：')
for (const [k, v] of [...blameCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)

console.log('\n逐题：')
for (const r of rows) {
  if (r.blame === 'none') continue
  console.log(`  [${r.level}] ${r.q}`)
  console.log(`     期望「${r.expect}」 责任=${r.blame} rank=${r.rank}`)
}

fs.writeFileSync(path.join(import.meta.dirname, '..', 'recall-diagnose.json'), JSON.stringify({ root, rows }, null, 2))
console.log('\n报告：recall-diagnose.json')
