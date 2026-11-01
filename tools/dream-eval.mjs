// 做梦质量评测：用一份固定的"一天"喂进去，量三件事。
//
// 1. 结构：块的数量/长度/重复度（不需要模型判断）
// 2. 覆盖：预设的"应该被记住的事实"有多少进了块（子串命中，粗但有用）
// 3. 找回：用几个探针查询去 recall，期望的块有没有出现在前几条（recall@k）
//
// 用法：
//   node tools/dream-eval.mjs                    # 用内置假模型（不需要网络）
//   node tools/dream-eval.mjs --real             # 用 ICL_LLM_* 环境变量里的真模型
//   node tools/dream-eval.mjs --real --json      # 机器可读输出
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

const args = new Set(process.argv.slice(2))
const REAL = args.has('--real')
const AS_JSON = args.has('--json')

const DAY = {
  notes: [
    { kind: 'event', text: '下午他给我看了一条 B 站视频，讲的是给盲人做导航，我看了评论区' },
    { kind: 'event', text: '他说那视频里有个定位方案挺好的，可惜要手机本地跑' },
    { kind: 'event', text: '他问我要不要晚上开黑，我说看情况' },
    { kind: 'event', text: '我自己记一下：他今天情绪一般，说工作很烦，别去拱火' },
    { kind: 'person', qq: '3429502459', text: '他说他怕水，但又一直想去看海' },
    { kind: 'person', qq: '3429502459', text: '他今天提到舍友叫曾嘉睿' },
    { kind: 'slang', text: '今天群里一直有人说"难绷"，意思是绷不住了' },
    { kind: 'slang', text: '"典"今天出现很多次，是"经典"的缩写' },
  ],
  // 应该被沉淀进块的事实（子串命中即算覆盖）
  facts: [
    '盲人', '导航', '看海', '怕水', '曾嘉睿', '难绷', '典',
  ],
  // 探针：query → 期望在返回里出现的关键词
  probes: [
    { query: '他想去哪里', expect: '看海' },
    { query: '他怕什么', expect: '怕水' },
    { query: '群里最近说什么梗', expect: '难绷' },
  ],
}

function fakeModel() {
  // 一个"理想但笨"的模型：按 job 返回预设 JSON，用来验证流程与结构
  return async ({ messages }) => {
    const system = String(messages?.[0]?.content ?? '')
    if (system.includes('事件块')) {
      return JSON.stringify([
        { summary: '看了给盲人做导航的视频', body: '下午他给我看了一条讲盲人导航的视频，评论区我也翻了。', people: ['3429502459'], tags: ['视频'] },
        { summary: '他说要晚上开黑', body: '他问要不要晚上开黑，我说看情况。', people: ['3429502459'], tags: ['约定'] },
        { summary: '他工作很烦', body: '他说工作很烦，我没去拱火。', people: ['3429502459'], tags: ['情绪'] },
      ])
    }
    if (system.includes('人物档案')) {
      return JSON.stringify({ summary: '怕水，但想去看海', narrative: '他说他怕水，可一直惦记着海。舍友叫曾嘉睿。', facts: [{ text: '怕水', since: '2026-11-01' }, { text: '想去看海', since: '2026-11-01' }] })
    }
    if (system.includes('新梗')) {
      return JSON.stringify([
        { term: '难绷', meaning: '绷不住了', usage: '看到离谱的事', examples: ['难绷'] },
        { term: '典', meaning: '经典', usage: '评价老套的事', examples: ['太典了'] },
      ])
    }
    return '[]'
  }
}

function realModel() {
  const base = String(process.env.ICL_LLM_BASE ?? '').replace(/\/+$/, '')
  const model = String(process.env.ICL_LLM_MODEL ?? '')
  if (!base || !model) throw new Error('--real 需要 ICL_LLM_BASE 与 ICL_LLM_MODEL')
  const apiKey = String(process.env.DEEPSEEK_API_KEY ?? '')
  return async ({ messages, maxTokens }) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens ?? 1200, stream: false }),
    })
    if (!res.ok) throw new Error(`模型返回 ${res.status}`)
    const data = await res.json()
    return String(data?.choices?.[0]?.message?.content ?? '')
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-eval-'))
  const host = createHost({ log: () => {} })
  // 写一份时间固定的"今天"：用真实 now，笔记都写进今天
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 'eval' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'rhythm.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'eval', personaFile: path.join(import.meta.dirname, '..', 'prompts', 'dream.md') } })
  host.registerPlugin(managerManifest, manager, { config: { providers: [] } })
  await host.enable('model-manager')
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')

  // 有嵌入服务就接上（recall 的语义检索靠它）
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
        const data = await res.json()
        return (data?.data ?? []).map((d) => d.embedding)
      },
    })
    host.services.slots.autoBind()
  }

  const chat = REAL ? realModel() : fakeModel()
  host.services.slots.bind('dream-chat', { provider: REAL ? 'real' : 'fake', call: chat })

  const remember = host.services.tools.list().find((t) => t.name === 'remember')
  for (const note of DAY.notes) await remember.execute(note)

  const result = await host.shared.get('dream').run({ now: Date.now() })
  const mem = host.shared.get('memory')
  const blocks = mem.query({ namespace: 'event', kind: 'block', limit: 200 })
  const people = mem.query({ namespace: 'person', kind: 'block', limit: 200 })
  const slang = mem.query({ namespace: 'slang', kind: 'block', limit: 200 })
  const all = [...blocks, ...people, ...slang]

  // 结构指标
  const lengths = all.map((b) => `${b.text}\n${b.data?.body ?? b.data?.narrative ?? ''}`.length)
  const avg = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0
  const dup = duplicateRate(all)

  // 覆盖：事实是否出现在任意块里
  const haystack = all.map((b) => `${b.text}\n${JSON.stringify(b.data ?? {})}`).join('\n')
  const covered = DAY.facts.filter((f) => haystack.includes(f))
  const coverage = DAY.facts.length ? covered.length / DAY.facts.length : 1

  // 找回：探针 recall@3（没有嵌入时只能字面匹配，不代表语义能力）
  const embedded = Boolean(mem.stats().embedded)
  const recallTool = host.services.tools.list().find((t) => t.name === 'recall')
  const hits = []
  let recallAt3 = null
  if (embedded) {
    const recallSvc = host.shared.get('recall')
    for (const probe of DAY.probes) {
      recallSvc?.resetCursor?.() // 探针之间互不影响（真实场景是不同回合）
      const out = await recallTool.execute({ query: probe.query, limit: 3 })
      hits.push({ ...probe, hit: String(out.text ?? '').includes(probe.expect) })
    }
    recallAt3 = hits.filter((h) => h.hit).length / Math.max(1, hits.length)
  }

  const report = {
    mode: REAL ? 'real' : 'fake',
    ok: result.ok,
    jobs: result.results,
    blocks: { event: blocks.length, person: people.length, slang: slang.length },
    avgChars: avg,
    duplicateRate: Number(dup.toFixed(2)),
    coverage: Number(coverage.toFixed(2)),
    missingFacts: DAY.facts.filter((f) => !covered.includes(f)),
    recallAt3: recallAt3 == null ? null : Number(recallAt3.toFixed(2)),
    embedded,
    probes: hits,
  }

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); return report }

  console.log(`\n=== 做梦评测（${report.mode}）===`)
  console.log('任务结果：', report.jobs.map((j) => `${j.job}:${j.skipped ?? (j.ok ? `ok+${j.blocks ?? 0}` : `fail(${j.error ?? '?'})`)}`).join('  '))
  console.log('块数量：', `事件 ${blocks.length} / 人物 ${people.length} / 梗 ${slang.length}`)
  console.log('平均字符数：', report.avgChars)
  console.log('重复度（块之间）：', report.duplicateRate, '（越低越好，>0.5 说明切块重复）')
  console.log('事实覆盖：', `${Math.round(report.coverage * 100)}%`, report.missingFacts.length ? `缺：${report.missingFacts.join('、')}` : '')
  if (report.recallAt3 == null) console.log('探针 recall@3：（未连接嵌入服务，跳过语义找回）')
  else console.log('探针 recall@3：', `${Math.round(report.recallAt3 * 100)}%`)
  for (const p of report.probes) console.log(`  · ${p.hit ? '✓' : '✗'} 「${p.query}」→ 期望含「${p.expect}」`)
  console.log('\n样例块：')
  for (const b of all.slice(0, 5)) console.log(`  - [${b.namespace}] ${b.text}`)
  return report
}

/** 块与块之间的近似重复率：按二元组 Jaccard 取最大值再平均。 */
function duplicateRate(blocks) {
  if (blocks.length < 2) return 0
  const grams = (s) => {
    const set = new Set()
    const t = String(s).replace(/\s+/g, '')
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
    return set
  }
  const sets = blocks.map((b) => grams(`${b.text}${b.data?.body ?? ''}`))
  const pairs = []
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i], b = sets[j]
      let inter = 0
      for (const g of a) if (b.has(g)) inter++
      const union = a.size + b.size - inter
      pairs.push(union ? inter / union : 0)
    }
  }
  return pairs.reduce((x, y) => x + y, 0) / pairs.length
}

const report = await main()
if (report) {
  const failed = report.coverage < 0.6 || (report.recallAt3 != null && report.recallAt3 < 0.6) || report.duplicateRate > 0.5
  process.exit(failed ? 1 : 0)
}
