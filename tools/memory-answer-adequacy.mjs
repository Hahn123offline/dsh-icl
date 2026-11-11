#!/usr/bin/env node
// answer-adequacy 审计（2026-11-11 第 14 轮）：读 eval.json，对**负例 probe**（期望为空且无 unresolved）
// 让模型判断"recall 返回的这些记忆里，有没有真的回答了问题的内容"。
// 用途：区分"提到≠回答"（返回了相关记忆但没答案）与真正的假注入；只读 eval.json，不写任何记忆。
//
// 用法：
//   $env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
//   node tools/memory-answer-adequacy.mjs --eval <eval.json> [--fixture <fixture>] [--out <dir>] [--cache-only]
//
// 输出：<out>/answer-adequacy.md / .json；模型调用走 eval 的 prompt-hash 缓存（可无密钥复跑）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModelAdapter } from './memory-eval/model.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) return argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const hit = argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const hasFlag = (argv, name) => argv.includes(`--${name}`)

const evalPath = argValue(process.argv, 'eval')
if (!evalPath) {
  console.error('用法：node tools/memory-answer-adequacy.mjs --eval <eval.json> [--out <dir>] [--cache-only]')
  process.exit(2)
}
const evalFile = path.resolve(evalPath)
const evalJson = JSON.parse(fs.readFileSync(evalFile, 'utf8'))
const retrieval = evalJson.retrieval
if (!retrieval?.probes) {
  console.error('eval.json 里没有 retrieval.probes（先用 --mode all/retrieval 跑一次）')
  process.exit(2)
}

const outDir = path.resolve(argValue(process.argv, 'out', path.join(REPO_ROOT, '.state', 'lab', 'lead', 'answer-adequacy')))
fs.mkdirSync(outDir, { recursive: true })
const model = await createModelAdapter({
  kind: 'cloud',
  outDir,
  configFile: path.resolve(argValue(process.argv, 'config', path.join(REPO_ROOT, 'config', 'icl.local.json'))),
  cacheOnly: hasFlag(process.argv, 'cache-only'),
  maxCalls: Number(argValue(process.argv, 'max-calls', 40)) || 40,
  echoHints: {},
})

const JUDGE_SYSTEM = [
  '你是记忆检索的验收员。用户问了一个问题，记忆系统返回了若干条记忆文本。',
  '判断：这些记忆里**有没有能够直接回答该问题的内容**（不是"提到相关话题"，而是真的含有答案）。',
  '输出 JSON：{"answers": true|false, "reason": "一句话"}。不要解释、不要 Markdown 围栏。',
].join('\n')

const cases = []
for (const probe of retrieval.probes) {
  const unresolved = probe.unresolvedExpected ?? []
  const expected = probe.expected ?? probe.metrics?.expectedIds ?? []
  if (expected.length > 0 || unresolved.length > 0) continue
  const returnedText = String(probe.returnedText ?? '').trim()
  const returned = probe.returned ?? probe.metrics?.returnedIds ?? []
  if (!returnedText && !returned.length) {
    cases.push({ probe: probe.id, query: probe.query, returned: [], verdict: { answers: false, reason: '未返回任何记忆' } })
    continue
  }
  let verdict = { answers: false, reason: 'judge-failed' }
  try {
    const raw = await model.call({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: `问题：${probe.query}\n\n返回的记忆：\n${returnedText.slice(0, 1500)}` },
      ],
      maxTokens: 200,
      where: 'answer-adequacy',
    })
    const match = /\{[\s\S]*\}/.exec(String(raw))
    verdict = JSON.parse(match ? match[0] : '{}')
    if (typeof verdict.answers !== 'boolean') verdict = { answers: false, reason: `坏输出：${String(raw).slice(0, 80)}` }
  } catch (error) {
    verdict = { answers: false, reason: `judge-error：${String(error?.message ?? error).slice(0, 120)}` }
  }
  cases.push({ probe: probe.id, query: probe.query, returned, verdict })
}

const summary = {
  negatives: cases.length,
  answersTrue: cases.filter((entry) => entry.verdict.answers === true).length,
  mentionOnly: cases.filter((entry) => entry.verdict.answers !== true).length,
  cases,
}
const lines = ['# answer-adequacy 审计（负例）', '', `- eval：${evalFile}`]
lines.push(`- 真负例（期望为空、无 unresolved）：**${summary.negatives}**；judge 判"有答案"：**${summary.answersTrue}**；` +
  `"提到但没答"：**${summary.mentionOnly}**`, '')
lines.push('| probe | 问句 | 返回条数 | 有答案？ | 理由 |', '|---|---|---:|---|---|')
for (const entry of cases) {
  lines.push(`| ${entry.probe} | ${String(entry.query ?? '').slice(0, 50)} | ${(entry.returned ?? []).length} | ${entry.verdict.answers === true ? '⚠️ 是' : '否'} | ${String(entry.verdict.reason ?? '').slice(0, 80)} |`)
}
lines.push('', '> 口径：judge 判"有答案"才算真·假注入；判"否"说明 recall 返回的是相关的历史，不是答案。', '')
const base = String(evalJson.fixture?.id ?? 'eval').replace(/[^\w.-]+/g, '-')
fs.writeFileSync(path.join(outDir, `${base}.md`), `${lines.join('\n')}\n`, 'utf8')
fs.writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify({ eval: evalFile, summary }, null, 2)}\n`, 'utf8')
console.log(path.join(outDir, `${base}.md`))
console.log(path.join(outDir, `${base}.json`))
