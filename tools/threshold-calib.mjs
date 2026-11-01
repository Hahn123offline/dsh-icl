// 阈值标定：拿一批"消息 → 期望命中的关键词"试样，量不同阈值下的注入率与命中率。
//
//   node tools/threshold-calib.mjs                       # 假嵌入（只验流程）
//   node tools/threshold-calib.mjs --real                # 真嵌入（bge-m3）
//   node tools/threshold-calib.mjs --sample x.json --real
//
// 指标：
//   injectRate  有多少条消息会被注入（越低越省上下文）
//   hitRate     该命中的消息里，真的命中了的比例（越高越好）
//   falseInject 不该命中的消息里，被注入了的比例（越低越好）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const REAL = args.includes('--real')
const sampleArg = args.indexOf('--sample')
const samplePath = sampleArg >= 0 ? args[sampleArg + 1] : path.join(import.meta.dirname, 'fixtures', 'calib-small.json')
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-calib-'))
const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'calib' } })
await host.enable('memory')
await host.enable('recall')

if (REAL) {
  const base = String(process.env.ICL_EMBED_BASE ?? '').replace(/\/+$/, '')
  const model = String(process.env.ICL_EMBED_MODEL ?? '')
  if (!base || !model) throw new Error('--real 需要 ICL_EMBED_BASE / ICL_EMBED_MODEL')
  host.services.slots.registerProvider({
    id: 'calib-embed', kind: 'embedding', shape: { dim: 1024 },
    call: async ({ input }) => {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
      })
      if (!res.ok) throw new Error(`embedding ${res.status}`)
      return ((await res.json())?.data ?? []).map((d) => d.embedding)
    },
  })
} else {
  // 假嵌入：字符频率哈希，足够让流程跑起来，但不代表真实语义
  const dim = 1024
  host.services.slots.registerProvider({
    id: 'calib-fake', kind: 'embedding', shape: { dim },
    call: async ({ input }) => {
      const text = String(input)
      const vec = new Array(dim).fill(0)
      for (const ch of text) vec[ch.codePointAt(0) % dim] += 1
      const norm = Math.sqrt(vec.reduce((n, x) => n + x * x, 0)) || 1
      return [vec.map((x) => x / norm)]
    },
  })
}
host.services.slots.autoBind()

const mem = host.shared.get('memory')
for (const m of sample.memories) {
  mem.put({
    namespace: m.namespace, kind: m.kind, key: m.key, text: m.text,
    data: { tags: m.tags ?? [], body: m.text },
  })
}
// 让块进向量索引
for (const item of mem.missingVectors({ limit: 100 })) await mem.index(item.id, item.text)

const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]
const rows = []
for (const threshold of thresholds) {
  let injected = 0
  let hit = 0
  let expected = 0
  let falseInject = 0
  let negatives = 0
  for (const message of sample.messages) {
    const hits = await mem.search({ query: message.text, limit: 2, minScore: threshold })
    const text = hits.map((h) => h.item.text).join('\n')
    const did = hits.length > 0
    if (did) injected += 1
    if (message.expect) {
      expected += 1
      if (did && text.includes(message.expect)) hit += 1
    } else {
      negatives += 1
      if (did) falseInject += 1
    }
  }
  rows.push({
    threshold,
    injectRate: injected / sample.messages.length,
    hitRate: expected ? hit / expected : null,
    falseInject: negatives ? falseInject / negatives : null,
    injected,
    hit,
    expected,
  })
}

const fmt = (x) => (x == null ? '  -  ' : `${Math.round(x * 100)}%`.padStart(5))
console.log(`\n=== 阈值标定（${REAL ? 'real' : 'fake'} 嵌入，${sample.messages.length} 条消息 / ${sample.memories.length} 条记忆）===`)
console.log('阈值   注入率   命中率   误注入')
for (const r of rows) console.log(`${r.threshold.toFixed(2)}  ${fmt(r.injectRate)}   ${fmt(r.hitRate)}   ${fmt(r.falseInject)}`)

// 推荐：命中率优先，误注入与注入率作为惩罚
const scored = rows
  .filter((r) => r.hitRate != null)
  .map((r) => ({ ...r, score: r.hitRate - 0.5 * (r.falseInject ?? 0) - 0.2 * r.injectRate }))
  .sort((a, b) => b.score - a.score)
const best = scored[0]
if (best) {
  console.log(`\n建议阈值：${best.threshold.toFixed(2)}（命中 ${fmt(best.hitRate)}，误注入 ${fmt(best.falseInject)}，注入率 ${fmt(best.injectRate)}）`)
  console.log('注意：样本只有几条，只当方向；真实标定要用几百条真实消息。')
}
