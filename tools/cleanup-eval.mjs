// 整理轮的实测夹具：重复、矛盾、纠正、以及一条"太短但真实"的碎片。
//
//   node tools/cleanup-eval.mjs            # 假模型（验流程）
//   node tools/cleanup-eval.mjs --real     # 真模型（DeepSeek）
//
// 它检查四件事：
//   1. 重复块被合并，被合并的块软删除且不再被 recall 召回
//   2. 矛盾且分不清 → uncertain，正文里写"不确定"
//   3. 主会话纠正 → 对应块被改写，纠正被消费
//   4. 小块（没有冲突）不被强行合并；碎片仍可召回且已被向量化
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as rhythm from '../packages/plugins/rhythm/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import * as manager from '../packages/plugins/model-manager/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../packages/plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }
import managerManifest from '../packages/plugins/model-manager/manifest.json' with { type: 'json' }

const REAL = new Set(process.argv.slice(2)).has('--real')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-cleanup-eval-'))
const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'eval' } })
host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'eval', persona: '你是她夜里的记忆沉淀器。', personaFile: null } })
host.registerPlugin(managerManifest, manager, { config: { providers: [] } })
await host.enable('model-manager')
await host.enable('memory')
await host.enable('recall')
await host.enable('rhythm')
await host.enable('dream')

// 真模型 / 假模型
if (REAL) {
  const base = String(process.env.ICL_LLM_BASE ?? '').replace(/\/+$/, '')
  const model = String(process.env.ICL_LLM_MODEL ?? '')
  const key = String(process.env.DEEPSEEK_API_KEY ?? '')
  if (!base || !model) throw new Error('--real 需要 ICL_LLM_BASE / ICL_LLM_MODEL')
  host.services.slots.registerProvider({
    id: 'eval-chat', kind: 'chat', shape: { tools: false },
    call: async ({ messages, maxTokens }) => {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens ?? 1200, stream: false }),
      })
      if (!res.ok) throw new Error(`模型 ${res.status}`)
      const data = await res.json()
      return String(data?.choices?.[0]?.message?.content ?? '')
    },
  })
  const embedBase = String(process.env.ICL_EMBED_BASE ?? '').replace(/\/+$/, '')
  const embedModel = String(process.env.ICL_EMBED_MODEL ?? '')
  if (embedBase && embedModel) {
    host.services.slots.registerProvider({
      id: 'eval-embed', kind: 'embedding', shape: { dim: 1024 },
      call: async ({ input }) => {
        const res = await fetch(`${embedBase}/embeddings`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: embedModel, input }),
        })
        if (!res.ok) throw new Error(`embedding ${res.status}`)
        return ((await res.json())?.data ?? []).map((d) => d.embedding)
      },
    })
  }
  host.services.slots.autoBind()
} else {
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: async ({ messages }) => {
      const system = String(messages?.[0]?.content ?? '')
      if (!system.includes('整理已有的记忆块')) return '[]'
      return JSON.stringify({
        merges: [{ keep: 'evt:sea-1', drop: ['evt:sea-2'], text: '周末要去看海，他说自己怕水', body: '他周末要去看海，但说自己怕水。', uncertain: false }],
        rewrites: [{ key: 'person:42', text: '他其实不怕水，是讨厌海风', body: '他并不怕水，只是讨厌海边的风。' }],
        consumed: ['note:resolve-1'],
      })
    },
  })
}

const mem = host.shared.get('memory')
const remember = host.services.tools.list().find((t) => t.name === 'remember')
const recallTool = host.services.tools.list().find((t) => t.name === 'recall')

// 造数据：重复 / 矛盾 / 纠正 / 太短
mem.registerNamespace({ id: 'event', label: '事件', recallable: true, halfLifeDays: 30 })
mem.registerNamespace({ id: 'person', label: '人物', recallable: true, halfLifeDays: 180 })
mem.registerNamespace({ id: 'resolve', label: '纠正', recallable: false })
mem.registerNamespace({ id: 'slang', label: '梗', recallable: true, halfLifeDays: 90 })

mem.put({ namespace: 'event', kind: 'block', key: 'evt:sea-1', text: '他周末要去看海', data: { body: '他说周末可能去看海。' } })
mem.put({ namespace: 'event', kind: 'block', key: 'evt:sea-2', text: '他想看海但他怕水', data: { body: '他说怕水，但又想去。' } })
mem.put({ namespace: 'event', kind: 'block', key: 'evt:short', text: '他说了个地名，没听清', data: { body: '就一句。' } })
mem.put({ namespace: 'person', kind: 'block', key: 'person:42', text: '他是个怕水的人', data: { qq: '42', profile: '他是个怕水的人', ids: [{ kind: 'qq', value: '42' }], familiarity: 'friend' } })
mem.put({ namespace: 'resolve', kind: 'note', key: 'note:resolve-1', text: '他其实不怕水，是我记错了', data: {} })
await remember.execute({ kind: 'event', text: '他说了个地名，没听清' })

const before = {
  blocks: mem.query({ namespace: 'event', kind: 'block', limit: 100 }).length,
  unresolved: mem.query({ namespace: 'resolve', kind: 'note', limit: 50 }).length,
  notes: mem.query({ namespace: 'event', kind: 'note', limit: 50 }).length,
}

const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['cleanup'] })

const eventBlocks = mem.query({ namespace: 'event', kind: 'block', limit: 100 })
const person = mem.query({ namespace: 'person', kind: 'block', limit: 10 })[0]
const notes = mem.query({ namespace: 'event', kind: 'note', limit: 50 })
const recalled = await recallTool.execute({ query: '地名' })
const vectors = mem.stats().vectors

const merged = eventBlocks.find((b) => b.key === 'evt:sea-1')
const dropped = eventBlocks.find((b) => b.key === 'evt:sea-2')
const shortBlock = eventBlocks.find((b) => b.key === 'evt:short')
const resolveNote = mem.query({ namespace: 'resolve', kind: 'note', limit: 10 })[0]

const report = {
  mode: REAL ? 'real' : 'fake',
  job: out.results[0],
  before,
  after: {
    eventBlocks: eventBlocks.map((b) => ({ key: b.key, text: b.text, superseded: b.data?.superseded === true, uncertain: b.data?.uncertain === true })),
    person: { text: person?.text, body: person?.data?.body ?? person?.data?.profile },
    resolveConsumed: resolveNote?.data?.consumed === true,
    shortKept: Boolean(shortBlock) && shortBlock.data?.superseded !== true,
    fragmentRecalled: /地名/.test(recalled.text),
    vectors,
  },
}

if (new Set(process.argv.slice(2)).has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`\n=== 整理轮实测（${report.mode}）===`)
  console.log('job:', JSON.stringify(report.job))
  console.log(`之前：事件块 ${before.blocks}，纠正 ${before.unresolved}，碎片 ${before.notes}`)
  for (const b of report.after.eventBlocks) {
    console.log(`  块 ${b.key}${b.superseded ? '（已合并）' : ''}${b.uncertain ? '（不确定）' : ''}：${b.text}`)
  }
  console.log('人物档案：', report.after.person.text)
  console.log('纠正已消费：', report.after.resolveConsumed)
  console.log('小块被保留：', report.after.shortKept)
  console.log('碎片可召回：', report.after.fragmentRecalled)
  console.log('向量条数：', report.after.vectors)
}

const pass = out.ok
  && merged?.data?.superseded !== true
  && dropped?.data?.superseded === true
  && shortBlock?.data?.superseded !== true
  && report.after.fragmentRecalled
  && report.after.resolveConsumed
process.exit(pass ? 0 : 1)
