// Layout 体检：对比两次 lab run 的"第一屏/提示词布局"是否守住 cache 语义（不动模型、不占 GPU）。
//
//   node tools/cache-layout-audit.mjs --run <baseRunDir> --run <afterRunDir>
//
// 每个 run 只需要 lab 产物：events.jsonl（必需）、context/system-*.txt（可选）。
// 输出每 run：
//   system/message：append/replace 次数、字符/字节、首两行、是否含 persona/工程脚手架/动态事实；
//   tools：数量、规范化 JSON 字符数、toolsHash（name+description+parameters，按 name 排序）；
//   facts：runtime-context 快照条数/字符/每条是否带 facts、快照 source.sections；
//   turns/steps。
// 判据（CACHE-MODEL §7 附录 B）：①相邻 turn firstDiff=-1 ②体积/toolsHash 记录 ③facts 仍在
// runtime-context（systemHasDynamicFacts=false）。脚本只读，不写 run 目录。

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const argAll = (name) => {
  const out = []
  process.argv.forEach((token, index) => { if (token === name && process.argv[index + 1]) out.push(process.argv[index + 1]) })
  return out
}
const runDirs = argAll('--run')
if (!runDirs.length) {
  console.error('用法：node tools/cache-layout-audit.mjs --run <baseRunDir> --run <afterRunDir>')
  process.exit(2)
}

function readEvents(runDir) {
  const file = path.join(runDir, 'events.jsonl')
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`)
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .map((row) => (row.payload?.event ?? row.payload ?? row))
}

function textOf(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : []).map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
}

function audit(runDir) {
  const events = readEvents(runDir)
  let systemAppend = 0
  let systemReplace = 0
  const systems = []
  let turns = 0
  let steps = 0
  let toolsHeader = null
  const snapshots = []
  for (const event of events) {
    if (!event?.type) continue
    if (event.type === 'turn/start') turns += 1
    if (event.type === 'step/start') steps += 1
    if (event.type === 'system/message') {
      const text = textOf(event.data?.message ?? event.data)
      const op = event.surfaceOp
      const replace = Boolean(op && typeof op === 'object' && op.op === 'replace')
      if (replace) systemReplace += 1; else systemAppend += 1
      systems.push({ seq: event.seq, replace, text })
    }
    if (event.type === 'request/header' && !toolsHeader) toolsHeader = event.data?.header?.tools ?? event.data?.tools ?? null
    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      if (message?.source?.kind !== 'runtime-context') continue
      const text = textOf(message)
      snapshots.push({ seq: event.seq, chars: text.length, hasFacts: /时间：|阶段：/.test(text), sections: (message.source.sections ?? []).map((section) => section.name) })
    }
  }
  const systemText = systems.at(-1)?.text ?? ''
  const canonicalTools = (toolsHeader ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const toolsJson = JSON.stringify(canonicalTools)
  return {
    runDir,
    system: {
      appends: systemAppend,
      replaces: systemReplace,
      chars: systemText.length,
      bytes: Buffer.byteLength(systemText, 'utf8'),
      // 相邻 system 事件之间是否恒等（只有 1 条 system 事件时视为 -1；replace 链按内容比较）
      allSystemTextsIdentical: systems.every((entry) => entry.text === systems[0].text),
      firstLine: systemText.split('\n')[0]?.slice(0, 80) ?? '',
      hasPersona: /你是小千/.test(systemText),
      hasHarnessIdentity: /You are an AI agent powered by DeepSeek Harness/.test(systemText),
      hasEngineeringScaffold: /deliverable|Harness implementation checkout|Web GUI at/i.test(systemText),
      hasDynamicFacts: /时间：|阶段：/.test(systemText),
      charsPerEvent: systems.map((entry) => entry.text.length),
    },
    tools: { count: canonicalTools.length, chars: toolsJson.length, hash: createHash('sha1').update(toolsJson).digest('hex').slice(0, 12) },
    facts: {
      snapshots: snapshots.length,
      snapshotsPerTurn: turns ? +(snapshots.length / turns).toFixed(2) : null,
      chars: snapshots.map((entry) => entry.chars),
      allHaveFacts: snapshots.every((entry) => entry.hasFacts),
      sectionSets: [...new Set(snapshots.map((entry) => entry.sections.join(',')))],
    },
    turns,
    steps,
  }
}

const results = runDirs.map((runDir) => audit(runDir))
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), runs: results }, null, 1))
if (results.length === 2) {
  const [base, after] = results
  console.log('\n== 三场景对照（CACHE-MODEL §7 附录 B）==')
  console.log('① firstDiff：system append/replace =', base.system.appends + '/' + base.system.replaces, '→', after.system.appends + '/' + after.system.replaces,
    '；system 文本恒等 =', base.system.allSystemTextsIdentical, '→', after.system.allSystemTextsIdentical)
  console.log('② 体积：system', base.system.chars + 'ch/' + base.system.bytes + 'B →', after.system.chars + 'ch/' + after.system.bytes + 'B',
    '；tools', base.tools.count + '/' + base.tools.hash, '→', after.tools.count + '/' + after.tools.hash)
  console.log('③ facts：systemHasDynamicFacts =', base.system.hasDynamicFacts, '→', after.system.hasDynamicFacts,
    '；快照', base.facts.snapshots, '→', after.facts.snapshots, '（/轮', base.facts.snapshotsPerTurn, '→', after.facts.snapshotsPerTurn + '）',
    '；section sets', JSON.stringify(base.facts.sectionSets), '→', JSON.stringify(after.facts.sectionSets))
}
