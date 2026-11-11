// 记忆评测工具的离线自测（SPEC §8）：不联网、不开 live、每个用例自带临时 fixture。
//
//   node --test tools/memory-eval.test.mjs
//
// 覆盖：schema/引用完整性、metrics 纯函数手算、profile 行选择、echo 模型 formation+retrieval smoke、
// 幂等（--repeat 2）、CLI 退出码/gate、rank 文本解析、live 路径护栏。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateGate, main, parseArgs, parseGate } from './memory-eval.mjs'
import { invalidationMetrics } from './memory-eval/formation.mjs'
import { renderGoldReview, reviewGold } from './memory-gold-review.mjs'
import { buildIndexes, loadFixture, normalizeFixture, sliceFixtureDays } from './memory-eval/fixture.mjs'
import { validateSchema } from './memory-eval/schema.mjs'
import { createEmbedAdapter, createModelAdapter, echoRespond, promptHash, resolveEmbedProvider, resolveProvider } from './memory-eval/model.mjs'
import { selectProfileRows } from './memory-eval/profile.mjs'
import { createProvenance } from './memory-eval/provenance.mjs'
import { parseRankedIds } from './memory-eval/retrieval.mjs'
import { assertNotLive, assertSafeOutDir, isInside, LIVE_STATE_ROOT } from './memory-eval/safety.mjs'
import { inferRawSource, isFormationSource } from '../packages/core/src/index.mjs'
import {
  duplicateRate, identityMetrics, idempotency, mrr, ndcgAtK, noiseRate, personBlockWrongIds,
  prf, provenanceRate, recallAtK, retrievalProbeMetrics, selfSourceRate,
} from './memory-eval/metrics.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-memory-eval-test-'))

function tmpDir(name) {
  const dir = path.join(TMP_ROOT, `${name}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/* ── 共用：3 天 tiny fixture（中英混排、含 tool/env/agent_internal 噪音）────── */

function row(id, at, role, source, text, extra = {}) {
  return {
    id,
    at: `2026-02-0${at.day}T${at.time}+08:00`,
    role,
    channel: extra.channel ?? 'web',
    speaker: extra.speaker ?? { kind: role === 'user' ? 'owner' : role === 'assistant' ? 'self' : 'unknown', value: '' },
    text,
    source,
    visible: extra.visible ?? true,
  }
}

function makeTinyFixture() {
  return {
    schema: 1,
    id: 'tiny-test',
    kind: 'synthetic',
    description: '自测用 3 天占位 fixture',
    timezone: 'Asia/Hong_Kong',
    persona: {
      self: { name: '鱼鱼', ids: [{ kind: 'qq', value: '2590000001' }] },
      owner: { name: '主人', ids: [{ kind: 'qq', value: '3420000001' }], aliases: ['小主'] },
    },
    days: [
      {
        day: '2026-02-01',
        rows: [
          row('r-101', { day: 1, time: '17:45:00' }, 'user', 'human', '我最近在维护 dsh-icl，天天熬夜调插件。'),
          row('r-102', { day: 1, time: '17:46:00' }, 'assistant', 'agent_visible', '我记下了。', { speaker: { kind: 'self', value: '2590000001' } }),
          row('r-103', { day: 1, time: '17:47:00' }, 'tool', 'tool', 'tool.result npm test：27 passed'),
          row('r-104', { day: 1, time: '17:48:00' }, 'env', 'env', '【心跳】状态正常'),
          row('r-105', { day: 1, time: '17:49:00' }, 'assistant', 'agent_internal', 'Let me check the config first.', { visible: false, speaker: { kind: 'self', value: '2590000001' } }),
          row('r-106', { day: 1, time: '20:11:00' }, 'user', 'human', '他怕水，但一直想去看海。', { speaker: { kind: 'person', value: '3420000001' } }),
        ],
      },
      {
        day: '2026-02-02',
        rows: [
          row('r-201', { day: 2, time: '11:20:00' }, 'user', 'human', '今天买了一个青轴机械键盘。'),
          row('r-202', { day: 2, time: '11:21:00' }, 'assistant', 'agent_visible', '青轴会吵到别人。', { speaker: { kind: 'self', value: '2590000001' } }),
          row('r-203', { day: 2, time: '16:00:00' }, 'user', 'human', '他把键盘退货了，换成静音红轴。'),
          row('r-204', { day: 2, time: '16:01:00' }, 'tool', 'tool', 'mc body status: connected'),
          row('r-205', { day: 2, time: '17:00:00' }, 'user', 'qq_envelope', 'QQ 还有没看过的消息：他说周末一起吃饭。', {
            channel: 'qq:private:8000001',
            speaker: { kind: 'person', value: '8000001' },
          }),
        ],
      },
      {
        day: '2026-02-03',
        rows: [
          row('r-301', { day: 3, time: '09:10:00' }, 'user', 'human', '主人说下周要去看海，已经请好假了。'),
          row('r-302', { day: 3, time: '09:11:00' }, 'assistant', 'agent_visible', '记得带防晒。', { speaker: { kind: 'self', value: '2590000001' } }),
          row('r-303', { day: 3, time: '21:05:00' }, 'user', 'human', '他说那本《海边的卡夫卡》看完了。'),
          row('r-304', { day: 3, time: '21:06:00' }, 'env', 'env', 'Alarm fired: nightly'),
        ],
      },
    ],
    gold: {
      entities: [
        { id: 'person:3420000001', kind: 'person', name: '主人', aliases: ['小主'], ids: [{ kind: 'qq', value: '3420000001' }], importance: 5 },
      ],
      memories: [
        { id: 'm-0001', type: 'fact', subject: 'person:3420000001', text: '主人在维护 dsh-icl，常熬夜调插件', evidence: ['r-101'], validFrom: '2026-02-01', invalidatedBy: null, note: 'test' },
        { id: 'm-0002', type: 'person', subject: 'person:3420000001', text: '主人：维护 dsh-icl 的人，怕水但一直想去看海', evidence: ['r-101', 'r-106'], validFrom: '2026-02-01', invalidatedBy: null, note: 'test' },
        { id: 'm-0003', type: 'event', subject: 'person:3420000001', text: '主人买了青轴键盘觉得太吵，退货换成静音红轴', evidence: ['r-201', 'r-203'], validFrom: '2026-02-02', invalidatedBy: null, note: 'test' },
      ],
      noise: [
        { rowIds: ['r-103', 'r-204'], reason: 'tool-output' },
        { rowIds: ['r-104', 'r-304'], reason: 'env' },
        { rowIds: ['r-105'], reason: 'agent-plan' },
      ],
    },
    probes: [
      { id: 'p-01', rowId: 'r-303', query: '主人在维护什么插件？', kind: 'recall', expectedMemoryIds: ['m-0001'], expectedAny: [], mustNotRecall: [], note: '事实' },
      { id: 'p-02', rowId: 'r-303', query: '主人', kind: 'person', expectedMemoryIds: ['m-0002'], expectedAny: [], mustNotRecall: [], note: '人名查档案' },
      { id: 'p-03', rowId: 'r-303', query: '量子计算怎么入门？', kind: 'recall', expectedMemoryIds: [], expectedAny: [], mustNotRecall: [], note: 'empty-ok' },
      { id: 'p-04', rowId: 'r-303', query: '主人怕什么？', kind: 'eager', expectedMemoryIds: ['m-0002'], expectedAny: [], mustNotRecall: [], note: 'eager' },
    ],
  }
}

function writeFixture(fixture, dir = tmpDir('fixture')) {
  const file = path.join(dir, 'fixture.json')
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  return file
}

function mutate(fixture, mutateFn) {
  const copy = JSON.parse(JSON.stringify(fixture))
  mutateFn(copy)
  return copy
}

function capture() {
  const out = []
  const err = []
  return { out, err, io: { cwd: REPO, out: (...args) => out.push(args.join(' ')), err: (...args) => err.push(args.join(' ')) } }
}

/* ── 1. fixture schema / 引用完整性（SPEC §8.1）───────────────── */

test('fixture 校验：缺字段 / 引用断裂 / evidence 指向不存在的行都要报错', () => {
  const fixture = makeTinyFixture()
  const file = writeFixture(fixture)
  const ok = loadFixture(file)
  assert.equal(ok.ok, true, `正常 fixture 应通过：${JSON.stringify(ok.errors)}`)

  const missing = loadFixture(writeFixture(mutate(fixture, (copy) => { delete copy.gold }) ))
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((error) => error.path.startsWith('$.gold')), '缺 gold 要报必填')

  const badEvidence = loadFixture(writeFixture(mutate(fixture, (copy) => { copy.gold.memories[0].evidence = ['r-404'] })))
  assert.equal(badEvidence.ok, false)
  assert.ok(badEvidence.errors.some((error) => error.message.includes('证据行不存在')), 'evidence 指向不存在行要报错')

  const badProbeRow = loadFixture(writeFixture(mutate(fixture, (copy) => { copy.probes[0].rowId = 'r-404' })))
  assert.equal(badProbeRow.ok, false)
  assert.ok(badProbeRow.errors.some((error) => error.message.includes('探针时刻行不存在')))

  const badExpected = loadFixture(writeFixture(mutate(fixture, (copy) => { copy.probes[0].expectedMemoryIds = ['m-9999'] })))
  assert.equal(badExpected.ok, false)
  assert.ok(badExpected.errors.some((error) => error.message.includes('不存在的 gold memory')))

  const realNoEvidence = loadFixture(writeFixture(mutate(fixture, (copy) => {
    copy.kind = 'real'
    copy.gold.memories[0].evidence = []
  })))
  assert.equal(realNoEvidence.ok, false, '真实 fixture 的 gold 必须有证据行')
  assert.ok(realNoEvidence.errors.some((error) => error.message.includes('必须有证据行')))
})

test('--days 裁剪：只保留指定日期，gold/noise/probes 引用同步裁剪', () => {
  const fixture = normalizeFixture(makeTinyFixture())
  const sliced = sliceFixtureDays(fixture, ['2026-02-02'])
  assert.equal(sliced.days.length, 1)
  assert.equal(sliced.days[0].day, '2026-02-02')
  assert.ok(sliced.gold.memories.every((memory) => memory.evidence.every((rowId) => rowId.startsWith('r-2'))))
  assert.ok(sliced.gold.memories.some((memory) => memory.id === 'm-0003'), '跨天记忆 m-0002 应被裁掉，单天 m-0003 保留')
  assert.ok(!sliced.gold.memories.some((memory) => memory.id === 'm-0002'))
  assert.ok(sliced.gold.noise.every((entry) => entry.rowIds.every((rowId) => rowId.startsWith('r-2'))))
  assert.ok(sliced.probes.every((probe) => probe.rowId.startsWith('r-2')), '探针时刻不在子集里的 probe 应被裁掉')
  assert.equal(sliced.gold.entities.length, fixture.gold.entities.length, 'entities 是身份真值，保留')
})

test('schema 校验器：类型/枚举/必填/additionalProperties/$ref 子集', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2, pattern: '^[a-z]+$' },
      count: { type: 'integer', minimum: 1 },
      tags: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1 },
      ref: { $ref: '#/$defs/thing' },
    },
    $defs: { thing: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }
  assert.equal(validateSchema({ name: 'ok', count: 2, tags: ['a'], ref: { id: 'x' } }, schema).ok, true)
  const result = validateSchema({ name: 'X', count: 0, tags: [], ref: {} }, schema)
  assert.equal(result.ok, false)
  const paths = result.errors.map((error) => error.path)
  assert.ok(paths.includes('$.name'), 'pattern/type 失败')
  assert.ok(paths.includes('$.count'), 'minimum 失败')
  assert.ok(paths.includes('$.tags'), 'minItems 失败')
  assert.ok(paths.includes('$.ref.id'), '$ref 递归校验失败')
})

/* ── 2. metrics 纯函数手算（SPEC §8.2）─────────────────────────── */

test('metrics：P/R/F1 手算', () => {
  const value = prf({ matched: 2, extracted: 4, gold: 5 })
  assert.equal(value.precision, 0.5)
  assert.equal(value.recall, 0.4)
  assert.ok(Math.abs(value.f1 - 2 * 0.5 * 0.4 / 0.9) < 1e-12)
  assert.equal(prf({ matched: 0, extracted: 0, gold: 0 }).precision, null, '0/0 不能伪装成 0 分')
})

test('metrics：dupRate / noiseRate / selfSourceRate / provenanceRate 手算', () => {
  const extracted = [
    { id: 'a', kindKey: 'event', text: '一起去看了海', rowIds: ['r1'] },
    { id: 'b', kindKey: 'event', text: '一起去看了海', rowIds: ['r1'] },
    { id: 'c', kindKey: 'event', text: '买了个键盘', rowIds: ['r2'] },
    { id: 'd', kindKey: 'event', text: '没有证据的块', rowIds: [] },
  ]
  const dup = duplicateRate(extracted)
  assert.equal(dup.pairs, 1)
  assert.equal(dup.involved, 2)
  assert.ok(Math.abs(dup.rate - 2 / 4) < 1e-12)

  const noise = noiseRate(extracted, new Set(['r1']))
  assert.equal(noise.count, 3, '证据全在 noise 行或没有证据的块算噪音')
  assert.ok(Math.abs(noise.rate - 3 / 4) < 1e-12)

  const selfRate = selfSourceRate(
    [{ id: 'x', rowIds: ['r1'] }, { id: 'y', rowIds: ['r2'] }, { id: 'z', rowIds: ['r1', 'r2'] }],
    new Set(['tool', 'env']),
    (rowId) => (rowId === 'r1' ? 'tool' : 'human'),
  )
  assert.ok(Math.abs(selfRate.rate - 1 / 3) < 1e-12, '只有 x 全部来自自源')

  const provenance = provenanceRate([
    { id: 'x', rowIds: ['r1'], unresolved: [] },
    { id: 'y', rowIds: [], unresolved: [{ via: 'unresolved' }] },
  ])
  assert.equal(provenance.rate, 0.5)
  assert.equal(provenance.unresolvedEntries, 1)
})

test('metrics：dupRate 口径 —— lexicon 排除 / 空证据不算重合 / 短文本要求 0.9', () => {
  // lexicon 同文本不参与 dup
  const lexicon = [
    { id: 'l1', kindKey: 'lexicon', text: '难绷', rowIds: [] },
    { id: 'l2', kindKey: 'lexicon', text: '难绷', rowIds: [] },
  ]
  assert.equal(duplicateRate(lexicon).involved, 0)
  // event 空证据：不算"证据 100% 重合"
  const emptyEvidence = [
    { id: 'e1', kindKey: 'event', text: '今天完全不同的第一件事', rowIds: [] },
    { id: 'e2', kindKey: 'event', text: '今天完全不同的第二件事', rowIds: [] },
  ]
  assert.equal(duplicateRate(emptyEvidence).pairs, 0)
  // 长文本相似度不够也不算；短文本（<12 字）要求 0.9，所以"海"和"看海"不是 dup
  const shortText = [
    { id: 's1', kindKey: 'event', text: '看海', rowIds: [] },
    { id: 's2', kindKey: 'event', text: '海', rowIds: [] },
  ]
  assert.equal(duplicateRate(shortText).pairs, 0)
  // 证据集合重合 ≥0.8 仍算 dup
  const evid = [
    { id: 'v1', kindKey: 'event', text: '完全不同的正文一', rowIds: ['r1', 'r2', 'r3', 'r4', 'r5'] },
    { id: 'v2', kindKey: 'event', text: '完全不同的正文二', rowIds: ['r1', 'r2', 'r3', 'r4'] },
  ]
  assert.equal(duplicateRate(evid).pairs, 1)
})

test('metrics：person wrongIdRate 的三个口径', () => {
  const block = {
    ids: [
      { kind: 'qq', value: '1050000001' }, // 群号
      { kind: 'qq', value: '2590000001' }, // 她自己的 QQ
      { kind: 'qq', value: '9999999' }, // 没声明
      { kind: 'qq', value: '3420000001' }, // 正常
    ],
  }
  const wrong = personBlockWrongIds(block, {
    declaredIdPairs: new Set(['qq:3420000001', 'qq:2590000001']),
    declaredIdValues: new Set(['3420000001', '2590000001']),
    selfIds: new Set(['2590000001']),
    groupIds: new Set(['1050000001']),
    selfEntityValues: [],
  })
  const reasons = wrong.map((entry) => entry.reason).sort()
  assert.deepEqual(reasons, ['group-id-as-qq', 'self-id-on-other-person', 'undeclared-id'])
  const metrics = identityMetrics([
    { id: '1', matchedEntityId: 'person:3420000001', wrongIds: [] },
    { id: '2', matchedEntityId: null, wrongIds: wrong },
  ])
  assert.equal(metrics.identity, 0.5)
  assert.equal(metrics.wrongIdRate, 0.5)
})

test('metrics：recall@k / MRR / NDCG 手算', () => {
  assert.equal(recallAtK(['a', 'b', 'c'], ['c'], 1), 0)
  assert.equal(recallAtK(['a', 'b', 'c'], ['c'], 3), 1)
  assert.equal(recallAtK(['a', 'b'], ['a', 'b'], 3), 1)
  assert.equal(recallAtK(['a'], [], 3), null)
  assert.equal(mrr(['x', 'y', 'z'], ['y']), 0.5)
  assert.equal(mrr(['x'], ['y']), 0)
  // 相关集只有 1 条：IDCG = 1/log2(2) = 1；命中在第 2 位 → DCG = 1/log2(3)
  assert.equal(ndcgAtK(['y'], ['y'], 10), 1)
  const two = ndcgAtK(['x', 'y'], ['y'], 10)
  assert.ok(Math.abs(two - 1 / Math.log2(3)) < 1e-12)
})

test('metrics：retrievalProbeMetrics 的 miss/falseInjection/mustNotRecall', () => {
  const miss = retrievalProbeMetrics({ id: 'p', kind: 'recall', query: 'q' }, ['x'], ['y'], { topK: 5 })
  assert.equal(miss.miss, true)
  assert.equal(miss.falseInjection, null)
  const falseInjection = retrievalProbeMetrics({ id: 'p', kind: 'recall', query: 'q' }, ['x'], [], { topK: 5 })
  assert.equal(falseInjection.falseInjection, true)
  const violation = retrievalProbeMetrics({ id: 'p', kind: 'recall', query: 'q' }, ['x', 'z'], ['x'], { topK: 5, mustNotRecallIds: ['z'] })
  assert.deepEqual(violation.mustNotRecallViolations, ['z'])
})

test('metrics：idempotency 能区分新增与证据漂移', () => {
  const a = [{ id: '1', kindKey: 'event', text: '同一件事', rowIds: ['r1'] }, { id: '2', kindKey: 'event', text: '另一件', rowIds: ['r2'] }]
  const same = idempotency(a, a.map((item) => ({ ...item })))
  assert.equal(same.stableRate, 1)
  assert.equal(same.newInSecond, 0)
  const drifted = idempotency(a, [{ id: '1', kindKey: 'event', text: '同一件事', rowIds: ['r9'] }, { id: '2', kindKey: 'event', text: '另一件', rowIds: ['r2'] }])
  assert.equal(drifted.evidenceChanged, 1)
  assert.equal(drifted.stable, 1)
})

/* ── 3. profile 行选择（SPEC §8.4）────────────────────────────── */

test('profile：与产品共用分类器，fixture source 原样透传，profile 由 formationProfile 传给产品', () => {
  const fixture = normalizeFixture(makeTinyFixture())
  const indexes = buildIndexes(fixture)
  const all = selectProfileRows(fixture, indexes, 'raw-all')
  const main = selectProfileRows(fixture, indexes, 'raw-main')
  const human = selectProfileRows(fixture, indexes, 'raw-human')
  const totalRows = fixture.days.reduce((sum, day) => sum + day.rows.length, 0)
  for (const selection of [all, main, human]) {
    assert.equal(selection.profilePath, 'product-raw')
    assert.equal(selection.main.length, totalRows, '全部行都交给 raw 源，主材料门控在产品侧')
    assert.equal(selection.context.length, 0)
    assert.equal(selection.main.length, selection.rows.length)
  }
  // source 原样透传（不再有 wire-source 改写）；qq_envelope 等新来源也保留
  assert.equal(all.main.find((item) => item.id === 'r-103').source, 'tool')
  assert.equal(all.main.find((item) => item.id === 'r-104').source, 'env')
  assert.equal(all.main.find((item) => item.id === 'r-105').source, 'agent_internal')
  assert.equal(all.main.find((item) => item.id === 'r-205').source, 'qq_envelope')
  assert.equal(selectProfileRows(fixture, indexes, 'raw-main').profile, 'raw-main')
  // 分类器本身来自产品（唯一实现）
  assert.equal(isFormationSource('human'), true)
  assert.equal(isFormationSource('qq_envelope'), true)
  assert.equal(isFormationSource('agent_visible'), true)
  assert.equal(isFormationSource('tool'), false)
  assert.equal(isFormationSource('env'), false)
  assert.equal(inferRawSource({ role: 'user', text: '【心跳】x' }), 'env')
  assert.equal(inferRawSource({ role: 'tool', text: 'x' }), 'tool')
  assert.equal(inferRawSource({ role: 'assistant', text: 'Let me check the config file and then run the tests carefully.' }), 'agent_internal')
})

/* ── 4. echo 模型 / 插件文本解析 ──────────────────────────────── */

test('echo 模型确定性：同 prompt 同输出；乱码 prompt 给合法空 JSON', () => {
  const eventsSystem = '你是记忆沉淀器\n\n把今天的笔记整理成若干"事件块"'
  const messages = [
    { role: 'system', content: eventsSystem },
    { role: 'user', content: '[1] 17:45 主人：我最近在维护 dsh-icl。\n[2] 17:46 鱼鱼：我记下了。' },
  ]
  const first = echoRespond(messages, { selfNames: ['鱼鱼'] })
  const second = echoRespond(JSON.parse(JSON.stringify(messages)), { selfNames: ['鱼鱼'] })
  assert.equal(first, second)
  const blocks = JSON.parse(first)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map((block) => block.evidence), [[1], [2]])
  assert.equal(echoRespond([{ role: 'system', content: '你在整理已有的记忆块' }, { role: 'user', content: 'x' }]), '{}')
  assert.ok(Array.isArray(JSON.parse(echoRespond([{ role: 'system', content: '未知 job' }, { role: 'user', content: 'x' }]))))
})

test('parseRankedIds：recall 标签 / eager 截断 / overview 前缀都能对回条目', () => {
  const items = [
    { id: '1', kindKey: 'event', text: '主人在维护 dsh-icl，常熬夜调插件' },
    { id: '2', kindKey: 'event', text: '主人怕水，但一直想去看海' },
    { id: '3', kindKey: 'person', text: '主人：维护 dsh-icl 的人' },
  ]
  assert.deepEqual(
    parseRankedIds('[事件 · 今天] 主人在维护 dsh-icl，常熬夜调插件\n[人物 · 3 天前] 主人：维护 dsh-icl 的人', items, 'recall'),
    ['1', '3'],
  )
  assert.deepEqual(
    parseRankedIds('你可能记得（检索结果，仅供参考）：\n· [event] 主人怕水，但一直想去看…', items, 'eager'),
    ['2'],
  )
  assert.deepEqual(
    parseRankedIds('事件 · 昨天 主人怕水，但一直想去看海\n人物 · 昨天 主人：维护 dsh-icl 的人', items, 'overview'),
    ['2', '3'],
  )
  assert.deepEqual(parseRankedIds('这个范围里没有相关记忆（全局还有 3 条）。', items, 'recall'), [])
})

/* ── 5. 溯源 / 模型适配（缓存、provider 选择）────────────────── */

test('provenance：优先 day log rowIds；旧数据没有 rowIds 时按 day+正文+时间唯一匹配', () => {
  const fixture = normalizeFixture(makeTinyFixture())
  const indexes = buildIndexes(fixture)
  const at = Date.parse('2026-02-01T17:45:00+08:00')

  // A) 产品 wash 的 data.rowIds：行号 → fixture rowId
  const withRowIds = [
    {
      id: 1, namespace: 'day', kind: 'log', key: 'day:2026-02-01', text: '[1] 17:45 主人：我最近在维护 dsh-icl，天天熬夜调插件。',
      data: { day: '2026-02-01', rowIds: ['r-101', 'r-102'], times: [at, at + 60_000] },
    },
    {
      id: 2, namespace: 'event', kind: 'block', key: 'evt:1', text: '维护 dsh-icl',
      data: { day: '2026-02-01', evidence: [{ type: 'day', id: 1, line: '我最近在维护 dsh-icl', at }] },
    },
  ]
  const mapped = createProvenance(fixture, indexes, withRowIds).mapItem(withRowIds[1])
  assert.deepEqual(mapped.rowIds, ['r-101'])
  assert.equal(mapped.entries[0].via, 'daylog.rowIds')

  // B) 无 rowIds（旧产品）：用 day + 正文快照 + at 唯一匹配
  const noRowIds = [
    {
      id: 2, namespace: 'event', kind: 'block', key: 'evt:2', text: '维护 dsh-icl',
      data: { day: '2026-02-01', evidence: [{ type: 'day', id: 7, line: '我最近在维护 dsh-icl，天天熬夜调插件。', at }] },
    },
  ]
  const fallback = createProvenance(fixture, indexes, noRowIds).mapItem(noRowIds[0])
  assert.deepEqual(fallback.rowIds, ['r-101'])
  assert.equal(fallback.entries[0].via, 'text.at')

  // C) 完全对不上：记 unresolved，不猜
  const maxAt = Math.max(...indexes.rowsByDay.get('2026-02-01').map((row) => row.atMs))
  const bogusEvidence = { type: 'day', id: 9, line: '完全不存在的一句话', at: maxAt + 999_999 }
  const unresolvedItem = {
    id: 3, namespace: 'event', kind: 'block', key: 'evt:3', text: 'x',
    data: { day: '2026-02-01', evidence: [bogusEvidence] },
  }
  const unresolved = createProvenance(fixture, indexes, [unresolvedItem]).mapItem(unresolvedItem)
  assert.deepEqual(unresolved.rowIds, [])
  assert.equal(unresolved.unresolved.length, 1)
})

test('模型适配：provider 选择 / prompt-hash 缓存 / cache-only 无密钥可离线复跑 / 缓存不含密钥', async () => {
  const dir = tmpDir('model')
  const outDir = path.join(dir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const configFile = path.join(dir, 'providers.json')
  fs.writeFileSync(configFile, `${JSON.stringify({
    providers: [
      { id: 'deepseek', kind: 'chat', baseUrl: 'https://example.invalid/v1', model: 'deepseek-chat', apiKeyEnv: 'ICL_EVAL_TEST_KEY' },
      { id: 'llama-swap-chat', kind: 'chat', baseUrl: 'http://127.0.0.1:8088/v1', model: 'qwen35-9b' },
    ],
  })}\n`, 'utf8')
  assert.equal(resolveProvider(configFile, 'cloud').id, 'deepseek')
  assert.equal(resolveProvider(configFile, 'local').id, 'llama-swap-chat')

  process.env.ICL_EVAL_TEST_KEY = 'test-secret-key'
  let networkCalls = 0
  const fakeFetch = async () => {
    networkCalls += 1
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const adapter = await createModelAdapter({ kind: 'cloud', outDir, configFile, fetchImpl: fakeFetch })
    const messages = [{ role: 'user', content: '同一个 prompt' }]
    assert.equal(await adapter.call({ messages }), 'ok')
    assert.equal(await adapter.call({ messages }), 'ok')
    assert.equal(networkCalls, 1, '第二次相同 prompt 必须命中缓存')
    assert.equal(adapter.stats().calls, 1)
    assert.equal(adapter.stats().cacheHits, 1)
    const cacheText = fs.readFileSync(path.join(outDir, 'cache.json'), 'utf8')
    assert.ok(!cacheText.includes('test-secret-key'), 'cache.json 绝不能存密钥')
    assert.ok(!cacheText.includes('同一个 prompt'), '缓存只存返回文本，不存 prompt 原文')
    const expectedKey = promptHash({ provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: '同一个 prompt' }], maxTokens: null })
    assert.deepEqual(Object.keys(JSON.parse(cacheText)), [expectedKey], '缓存 key 必须是 prompt hash')
  } finally {
    delete process.env.ICL_EVAL_TEST_KEY
  }

  // cache-only：无密钥、无网络也能离线复跑云端基线
  const offlineFetch = async () => { throw new Error('cache-only 不应联网') }
  const cached = await createModelAdapter({ kind: 'cloud', outDir, configFile, cacheOnly: true, fetchImpl: offlineFetch })
  assert.equal(await cached.call({ messages: [{ role: 'user', content: '同一个 prompt' }] }), 'ok')
  assert.equal(cached.stats().cacheHits, 1)
})

test('嵌入适配（--embed）：provider 选择 + 向量缓存 + 缓存不含原文/密钥', async () => {
  const dir = tmpDir('embed')
  const outDir = path.join(dir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const configFile = path.join(dir, 'providers.json')
  fs.writeFileSync(configFile, `${JSON.stringify({
    providers: [
      { id: 'deepseek', kind: 'chat', baseUrl: 'https://example.invalid/v1', model: 'deepseek-chat' },
      { id: 'bge-m3', kind: 'embedding', baseUrl: 'https://example.invalid/v1', model: 'embed-bge-m3' },
      { id: 'bge-other', kind: 'embedding', baseUrl: 'https://example.invalid/v1', model: 'other' },
    ],
  })}\n`, 'utf8')
  assert.equal(resolveEmbedProvider(configFile).id, 'bge-m3')
  assert.equal(resolveEmbedProvider(configFile, 'bge-other').id, 'bge-other')
  let networkCalls = 0
  const fakeFetch = async (url, init) => {
    networkCalls += 1
    assert.match(String(url), /\/embeddings$/)
    const body = JSON.parse(String(init.body))
    assert.equal(body.model, 'embed-bge-m3')
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  const adapter = await createEmbedAdapter({ outDir, configFile, fetchImpl: fakeFetch })
  assert.deepEqual(await adapter.embed('你好'), [0.1, 0.2, 0.3])
  assert.deepEqual(await adapter.embed('你好'), [0.1, 0.2, 0.3])
  assert.equal(networkCalls, 1, '相同文本第二次应命中嵌入缓存')
  assert.equal(adapter.stats().dim, 3)
  const cacheText = fs.readFileSync(path.join(outDir, 'embed-cache.json'), 'utf8')
  assert.ok(!cacheText.includes('你好'), 'embed-cache.json 不应存原文')
})

/* ── 6. formation + retrieval smoke（SPEC §8.3）────────────────── */

test('echo + 3 天 fixture：formation/retrieval 跑通、报告落地、幂等、退出码 0', async () => {
  const fixtureFile = writeFixture(makeTinyFixture())
  const outDir = tmpDir('out')
  const capture1 = capture()
  const code = await main([
    '--fixture', fixtureFile,
    '--mode', 'all',
    '--model', 'echo',
    '--seed', 'formation',
    '--repeat', '2',
    '--out', outDir,
    '--label', 'self-test',
  ], capture1.io)
  assert.equal(code, 0, `exit=${code}\n${capture1.err.join('\n')}`)
  const jsonPath = path.join(outDir, 'eval.json')
  const mdPath = path.join(outDir, 'eval.md')
  assert.ok(fs.existsSync(jsonPath), 'eval.json 必须生成')
  assert.ok(fs.existsSync(mdPath), 'eval.md 必须生成')
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(report.fixture.id, 'tiny-test')
  assert.equal(report.label, 'self-test')
  assert.equal(report.options.profile, 'raw-main')
  assert.equal(report.model.describe.kind, 'echo')
  assert.ok(report.formation, '应有 formation 段')
  assert.ok(report.formation.metrics.counts.extracted >= 3, `应产出块，实际 ${report.formation.metrics.counts.extracted}`)
  assert.equal(report.formation.metrics.counts.kinds.event > 0, true)
  assert.equal(report.formation.metrics.provenance.rate, 1, 'echo 的证据行号应全部能映射回 fixture rowId')
  assert.ok(report.formation.metrics.overall.matched >= 2, `gold 命中不足：${report.formation.metrics.overall.matched}`)
  assert.equal(report.formation.days.length, 3)
  assert.equal(report.formation.idempotency.stableRate, 1, 'echo 确定性应产生稳定提取')
  assert.equal(report.formation.idempotency.newInSecond, 0)
  assert.ok(report.retrieval, '应有 retrieval 段')
  assert.equal(report.retrieval.probes.length, 4)
  assert.ok(report.retrieval.metrics.recallAt1 != null)
  const markdown = fs.readFileSync(mdPath, 'utf8')
  assert.match(markdown, /Formation/)
  assert.match(markdown, /Retrieval/)
  assert.match(markdown, /provenanceRate/)
})

test('echo + seed gold retrieval：命中预期、falseInjection 受控、退出码 0', async () => {
  const fixtureFile = writeFixture(makeTinyFixture())
  const outDir = tmpDir('out-gold')
  const capture1 = capture()
  const code = await main(['--fixture', fixtureFile, '--mode', 'retrieval', '--seed', 'gold', '--model', 'echo', '--out', outDir], capture1.io)
  assert.equal(code, 0, capture1.err.join('\n'))
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'eval.json'), 'utf8'))
  assert.equal(report.formation, null, 'retrieval-only 不跑 formation')
  const recallProbe = report.retrieval.probes.find((probe) => probe.id === 'p-01')
  assert.ok(recallProbe.returned.includes('1'), 'p-01 应召回播种的 m-0001 块')
  assert.deepEqual(recallProbe.expected, ['1'])
  const emptyProbe = report.retrieval.probes.find((probe) => probe.id === 'p-03')
  assert.equal(emptyProbe.metrics.falseInjection, false, '不相关 query 不应硬凑')
  const personProbe = report.retrieval.probes.find((probe) => probe.id === 'p-02')
  assert.ok(personProbe.returned.length > 0, 'whois 人名路径应返回档案')
})

test('formationProfile 透传：raw-all 把 tool/env/agent_internal 行纳入材料，raw-main 不纳入', async () => {
  const fixtureFile = writeFixture(makeTinyFixture())
  const runProfile = async (profile) => {
    const outDir = tmpDir(`out-${profile}`)
    const capture1 = capture()
    const code = await main(['--fixture', fixtureFile, '--mode', 'formation', '--model', 'echo', '--profile', profile, '--out', outDir], capture1.io)
    assert.equal(code, 0, capture1.err.join('\n'))
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'eval.json'), 'utf8'))
    const rowIds = new Set((report.formation.extracted ?? []).flatMap((item) => item.rowIds))
    return { report, rowIds }
  }
  const rawAll = await runProfile('raw-all')
  const rawMain = await runProfile('raw-main')
  assert.ok(rawAll.rowIds.has('r-103'), 'raw-all 应把 tool 行纳入材料')
  assert.ok(rawAll.rowIds.has('r-104'), 'raw-all 应把 env 行纳入材料')
  assert.ok(rawAll.rowIds.has('r-105'), 'raw-all 应把 agent_internal 行纳入材料')
  assert.ok(rawMain.rowIds.has('r-101'), 'raw-main 保留 human 行')
  assert.ok(!rawMain.rowIds.has('r-103'), 'raw-main 应剔除 tool 行')
  assert.ok(!rawMain.rowIds.has('r-104'), 'raw-main 应剔除 env 行')
  assert.ok(!rawMain.rowIds.has('r-105'), 'raw-main 应剔除 agent_internal 行')
  assert.equal(rawMain.report.formation.profile.path, 'product-raw')
})

test('goldEmpty fixture：不参与 P/R，但结构/溯源指标照常报', async () => {
  const fixture = mutate(makeTinyFixture(), (copy) => {
    copy.gold = { entities: [], memories: [], noise: [] }
    for (const probe of copy.probes) {
      probe.expectedMemoryIds = []
      probe.expectedAny = []
      probe.mustNotRecall = []
      probe.note = 'empty-ok'
    }
  })
  const outDir = tmpDir('out-goldempty')
  const capture1 = capture()
  const code = await main(['--fixture', writeFixture(fixture), '--mode', 'formation', '--model', 'echo', '--out', outDir], capture1.io)
  assert.equal(code, 0, capture1.err.join('\n'))
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'eval.json'), 'utf8'))
  assert.equal(report.fixture.goldEmpty, true)
  assert.equal(report.formation.metrics.goldEmpty, true)
  assert.equal(report.formation.metrics.overall.precision, null)
  assert.equal(report.formation.metrics.overall.recall, null)
  assert.ok(report.formation.metrics.provenance.rate != null, '结构/溯源指标仍要计算')
})

test('invalidation：旧值仍存活 / 新值形成 / 新值近似存在但未匹配', () => {
  const fixture = {
    gold: {
      memories: [
        { id: 'old', type: 'preference', subject: 'person:1', text: '主人以前每天喝美式咖啡', evidence: ['r1'], invalidatedBy: 'new' },
        { id: 'new', type: 'preference', subject: 'person:1', text: '主人现在改喝豆浆', evidence: ['r2'], invalidatedBy: null },
      ],
    },
  }
  const oldBlock = { id: '1', kindKey: 'event', text: '主人以前每天喝美式咖啡', body: '' }
  const oldTyped = { id: '3', kindKey: 'preference', text: '主人以前每天喝美式咖啡', body: '' }
  const newBlock = { id: '2', kindKey: 'event', text: '主人现在改喝豆浆了', body: '' }
  const both = invalidationMetrics({ fixture, extracted: [oldBlock, newBlock], match: { pairs: [{ goldId: 'old', extractedId: '1' }, { goldId: 'new', extractedId: '2' }] } })
  assert.equal(both.cases, 1)
  assert.equal(both.oldMatched, 1)
  assert.equal(both.newMatched, 1)
  assert.equal(both.oldHistoricalOnly, 1, '只有历史事件块匹配 → 不算当前认知没更新')
  assert.equal(both.staleOldSurvives, 0)
  // 同类型 typed 记录还活着，才是真正的'旧值仍存活'。
  const typedAlive = invalidationMetrics({ fixture, extracted: [oldTyped, newBlock], match: { pairs: [{ goldId: 'old', extractedId: '3' }, { goldId: 'new', extractedId: '2' }] } })
  assert.equal(typedAlive.staleOldSurvives, 1, '同类型 typed 旧值没被 superseded → stale')
  const unmatchedNew = invalidationMetrics({ fixture, extracted: [oldBlock, newBlock], match: { pairs: [{ goldId: 'old', extractedId: '1' }] } })
  assert.equal(unmatchedNew.newMatched, 0)
  assert.equal(unmatchedNew.newValuePresentButUnmatched, 1, '新值以近似正文存在但没被确定性匹配')
})

/* ── 6. CLI 退出码 / gate / live 护栏（SPEC §8.5）──────────────── */

test('gate：方向与退出码 3；参数错误与 fixture 错误退出码 2', async () => {
  const checks = parseGate('formation.precision=0.5,retrieval.missRate<=0.1')
  assert.equal(checks.checks.length, 2)
  assert.equal(checks.checks[0].direction, 'min')
  assert.equal(checks.checks[1].direction, 'max', 'missRate 默认越低越好')
  const passed = evaluateGate(checks, {
    formation: { metrics: { overall: { precision: 0.6 } } },
    retrieval: { metrics: { missRate: 0.05 } },
  })
  assert.equal(passed.passed, true)
  const failed = evaluateGate(checks, {
    formation: { metrics: { overall: { precision: 0.4 } } },
    retrieval: { metrics: { missRate: 0.2 } },
  })
  assert.equal(failed.passed, false)
  assert.throws(() => parseGate('nope=0.5'), /未知指标/)

  const fixtureFile = writeFixture(makeTinyFixture())
  const capture1 = capture()
  assert.equal(await main(['--fixture', fixtureFile, '--mode', 'formation', '--model', 'echo', '--gate', 'formation.precision=1', '--out', tmpDir('out-gate')], capture1.io), 3, 'gate 不过应 exit 3')

  const capture2 = capture()
  assert.equal(await main(['--fixture', fixtureFile, '--mode', 'bogus'], capture2.io), 2)
  assert.ok(capture2.err.join('\n').includes('--mode'))
  assert.equal(await main(['--fixture', path.join(TMP_ROOT, 'missing')], capture().io), 2, 'fixture 不存在应 exit 2')
})

test('live 护栏：live state 路径被拒绝，临时/仓库 lab 路径放行（只做字符串判断）', () => {
  assert.equal(isInside(path.join(LIVE_STATE_ROOT, 'memory.db'), LIVE_STATE_ROOT), true)
  assert.throws(() => assertNotLive(LIVE_STATE_ROOT), /live state/)
  assert.throws(() => assertSafeOutDir(path.join(LIVE_STATE_ROOT, 'runs', 'x')), /live state/)
  assert.ok(assertNotLive(path.join(os.tmpdir(), 'icl-eval-ok')))
  assert.ok(assertSafeOutDir(path.join(REPO, '.state', 'lab', 'eval-harness', 'runs', 'x')))
  assert.equal(isInside(REPO, LIVE_STATE_ROOT), false)
})

test('--help 退出码 0，并列出 CLI 契约', async () => {
  const capture1 = capture()
  const code = await main(['--help'], capture1.io)
  assert.equal(code, 0)
  const text = capture1.out.join('\n')
  assert.match(text, /--fixture/)
  assert.match(text, /--mode/)
  assert.match(text, /--profile/)
  assert.match(text, /--gate/)
})

test('临时目录都建在 os.tmpdir 下，不碰仓库 state（评测写路径纪律）', () => {
  assert.ok(TMP_ROOT.startsWith(os.tmpdir()))
  assert.equal(isInside(TMP_ROOT, LIVE_STATE_ROOT), false)
  // 默认输出目录在仓库 .state/lab/eval-harness/runs 下（assertSafeOutDir 能过），不是 live。
  assert.ok(assertSafeOutDir(path.join(REPO, '.state', 'lab', 'eval-harness', 'runs', 'tiny')))
})



/* ── gold 抽审（不调模型） ─────────────────────────────────── */

test('gold-review：证据缺失/非法引用/过短/近重复/未覆盖 probe 都能报出来', () => {
  const fixture = {
    id: 'gold-review-test',
    days: [{ day: '2026-01-01', rows: [{ id: 'r1', at: '2026-01-01T10:00:00+08:00', text: '一起去爬山' }] }],
    gold: {
      memories: [
        { id: 'm1', type: 'event', text: '今天一起去爬山，六点在山脚集合，记得带水', evidence: ['r1'] },
        { id: 'm2', type: 'event', text: '今天一起去爬山，六点在山脚集合，记得带水', evidence: ['r-missing'] },
        { id: 'm3', type: 'fact', text: '短', evidence: [] },
      ],
    },
    probes: [
      { id: 'p1', rowId: 'r1', kind: 'recall', query: '爬山', expectedMemoryIds: ['m1'] },
      { id: 'p2', rowId: 'r1', kind: 'recall', query: '完全无关的天气问题', expectedMemoryIds: ['m1'] },
    ],
  }
  const review = reviewGold({ fixture })
  assert.equal(review.gold, 3)
  assert.equal(review.missingEvidence.length, 1, 'm3 无证据')
  assert.equal(review.invalidEvidence.length, 1, 'm2 引用不存在的 raw 行')
  assert.equal(review.shortText.length, 1, 'm3 正文过短')
  assert.ok(review.duplicatePairs.some((pair) => pair.a === 'm1' && pair.b === 'm2'), 'm1/m2 近重复')
  assert.equal(review.unprobed.length, 2, 'm2/m3 没被 probe 引用')
  assert.ok(review.probeIssues.some((item) => item.reason), 'p2 与 expected gold 零内容词交集应被标出')
  const markdown = renderGoldReview(review)
  assert.match(markdown, /gold-review-test/)
  assert.match(markdown, /未被任何 probe 引用的 gold：\*\*2\*\*/)
})



test('gate-preset：三源基线阈值（focus/qq/live）与非法预设', () => {
  const fixture = 'tools/fixtures/memory/synthetic-alias-and-people'
  const plain = parseArgs(['--fixture', fixture])
  assert.equal(plain.gatePreset, null)
  const focus = parseArgs(['--fixture', fixture, '--gate-preset', 'focus'])
  assert.equal(focus.gatePreset, 'focus')
  const qq = parseArgs(['--fixture', fixture, '--gate-preset', 'qq'])
  assert.equal(qq.gatePreset, 'qq')
  assert.throws(() => parseArgs(['--fixture', fixture, '--gate-preset', 'nope']), /gate-preset/)
})
