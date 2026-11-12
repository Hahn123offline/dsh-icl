#!/usr/bin/env node
// 记忆评测 runner：fixture → formation → retrieval → 指标 → eval.json/eval.md。
//
// 契约：docs/MEMORY-EVAL-SPEC.md（§3 fixture、§5 profile、§6 runner、§7 指标、§8 自测）。
// 纪律：临时 stateDir（os.tmpdir）里跑真实产品插件；绝不读写 live state；不注册到产品工具面。
//
// 用法：
//   node tools/memory-eval.mjs --fixture tools/fixtures/memory/synthetic-alias-and-people --mode all --model echo
//   node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 --model cloud --profile raw-all --label before
//   node tools/memory-eval.mjs --fixture <dir> --mode formation --repeat 2 --model echo
//   node tools/memory-eval.mjs --fixture <dir> --mode retrieval --seed gold --gate 'retrieval.recallAt3=0.5'
//
// 退出码：0 正常；2 fixture/配置/运行错误；3 --gate 未通过。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, buildIndexes, identityConfigOf, loadFixture, normalizeFixture, sliceFixtureDays } from './memory-eval/fixture.mjs'
import { createEmbedAdapter, createModelAdapter } from './memory-eval/model.mjs'
import { closeFormation, runFormation } from './memory-eval/formation.mjs'
import { seedFormation, seedGold, runRetrieval } from './memory-eval/retrieval.mjs'
import { createEvalHost } from './memory-eval/host.mjs'
import { buildEvalJson, writeReports } from './memory-eval/report.mjs'
import { assertNotLive, assertSafeOutDir, makeTempDir } from './memory-eval/safety.mjs'
import { idempotency } from './memory-eval/metrics.mjs'

const MODES = ['all', 'formation', 'retrieval']
const PROFILES = ['raw-all', 'raw-main', 'raw-human']
const MODEL_KINDS = ['echo', 'cloud', 'local']
const SEEDS = ['gold', 'formation']
// 三源基线门控预设（docs/MEMORY-BASELINES.md §3）。CI 用 --gate-preset <focus|qq|live>。
const GATE_PRESETS = Object.freeze({
  focus: 'formation.recall>=0.75,retrieval.recallAt3>=0.65,retrieval.recallAt5>=0.75,retrieval.missRate<=0.25,retrieval.falseInjectionRate<=0',
  qq: 'formation.recall>=0.75,retrieval.recallAt5>=0.70,retrieval.missRate<=0.35',
  live: 'formation.recall>=0.75,retrieval.recallAt5>=0.80,retrieval.missRate<=0.25',
})

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.exitCode = exitCode
  }
}

/* ── 参数 ─────────────────────────────────────────────────────── */

function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) return argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const hit = argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}

/** 可选数值参数：缺省/非数字返回 null（不写进插件 config，保持产品默认）。 */
function optionalNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function tsSlug(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function parseArgs(argv, cwd = process.cwd()) {
  const options = {
    fixture: argValue(argv, 'fixture'),
    outDir: argValue(argv, 'out'),
    mode: String(argValue(argv, 'mode', 'all')),
    schema: String(argValue(argv, 'schema', 'v2')),
    rerank: String(argValue(argv, 'rerank', 'off')),
    model: String(argValue(argv, 'model', 'echo')),
    provider: argValue(argv, 'provider'),
    modelId: argValue(argv, 'model-id'),
    profile: String(argValue(argv, 'profile', 'raw-main')),
    seed: String(argValue(argv, 'seed', 'gold')),
    days: String(argValue(argv, 'days', '')).split(',').map((day) => day.trim()).filter(Boolean),
    repeat: Math.max(1, Math.min(5, Number(argValue(argv, 'repeat', 1)) || 1)),
    label: argValue(argv, 'label'),
    gate: argValue(argv, 'gate'),
    gatePreset: argValue(argv, 'gate-preset'),
    configFile: path.resolve(cwd, String(argValue(argv, 'config', path.join(REPO_ROOT, 'config', 'icl.local.json')))),
    maxCalls: Math.max(1, Number(argValue(argv, 'max-calls', 500)) || 500),
    cacheOnly: hasFlag(argv, 'cache-only'),
    fresh: hasFlag(argv, 'fresh'),
    adequacy: hasFlag(argv, 'adequacy'),
    embed: hasFlag(argv, 'embed'),
    embedProvider: argValue(argv, 'embed-provider'),
    keepTemp: hasFlag(argv, 'keep-temp'),
    recallMinSim: optionalNumber(argValue(argv, 'recall-min-sim')),
    recallMinSimNoEmbed: optionalNumber(argValue(argv, 'recall-min-sim-noembed')),
    eagerMinScore: optionalNumber(argValue(argv, 'eager-min-score')),
    eagerMinScoreNoEmbed: optionalNumber(argValue(argv, 'eager-min-score-noembed')),
    quiet: hasFlag(argv, 'quiet'),
    debug: hasFlag(argv, 'debug'),
    help: hasFlag(argv, 'help') || hasFlag(argv, 'h'),
  }
  if (options.help) return options
  if (!options.fixture) throw new CliError('缺少 --fixture（fixture 目录或 fixture.json）')
  options.fixture = path.resolve(cwd, options.fixture)
  assertNotLive(options.fixture, 'fixture 路径')
  if (!MODES.includes(options.mode)) throw new CliError(`--mode 只能是 ${MODES.join('|')}：${options.mode}`)
  if (!PROFILES.includes(options.profile)) throw new CliError(`--profile 只能是 ${PROFILES.join('|')}：${options.profile}`)
  if (!MODEL_KINDS.includes(options.model)) throw new CliError(`--model 只能是 ${MODEL_KINDS.join('|')}：${options.model}`)
  if (!['v2', 'v3'].includes(options.schema)) throw new CliError(`--schema 只能是 v2|v3：${options.schema}`)
  if (!['off', 'llm'].includes(options.rerank)) throw new CliError(`--rerank 只能是 off|llm：${options.rerank}`)
  if (!SEEDS.includes(options.seed)) throw new CliError(`--seed 只能是 ${SEEDS.join('|')}：${options.seed}`)
  if (options.gatePreset != null && !GATE_PRESETS[String(options.gatePreset)]) {
    throw new CliError(`--gate-preset 只能是 ${Object.keys(GATE_PRESETS).join('|')}：${options.gatePreset}`)
  }
  if (options.mode === 'retrieval' && options.seed === 'formation') {
    // 只跑 retrieval 时 seed=formation 仍需要先跑 formation，语义上等价于 all；明确支持。
  }
  return options
}

function printUsage(write = console.log) {
  write(`用法：
  node tools/memory-eval.mjs --fixture <dir|fixture.json> [选项]

必填：
  --fixture <path>        fixture 目录（含 fixture.json）或 fixture.json 路径

选项：
  --mode <all|formation|retrieval>   默认 all
  --schema <v2|v3>                   v3：episode 主单位（默认 v2，向后兼容）
  --rerank <off|llm>                 v3 检索后重排（默认 off；llm 需 dream-chat 槽位）
  --model <echo|cloud|local>         默认 echo（离线）；cloud/local 读 config/icl.local.json
  --model-id <id>                    覆盖 provider 的 model
  --provider <id>                    指定 chat provider id
  --profile <raw-all|raw-main|raw-human>  默认 raw-main
  --seed <gold|formation>            retrieval 的库来源，默认 gold
  --days <d1,d2,...>                 只跑指定日期（从 fixture 裁出子集，gold/probes 引用同步裁剪）
  --repeat <n>                       formation 重跑 n 次算幂等（1–5），默认 1
  --label <text>                     写进报告，用于改动前/后对照
  --gate <k=v[,k>=v][,k<=v]>         指标门槛，不过则 exit 3
  --gate-preset <focus|qq|live>      使用 docs/MEMORY-BASELINES.md 里的三源基线阈值（--gate 优先）
  --out <dir>                        默认 .state/lab/eval-harness/runs/<fixture>-<时间>
  --config <file>                    provider 配置，默认 config/icl.local.json
  --max-calls <n>                    云端调用上限，默认 500
  --cache-only                       只允许命中 <out>/cache.json（云端基线可无密钥离线复跑）
  --fresh                             忽略已有缓存、重新调用模型（用于测运行间方差）
  --adequacy                         对真负例跑 answer-adequacy judge（额外模型调用；cache-only 时跳过）
  --embed                            绑定 embed 插槽（默认关；离线 CI 不依赖 8088）
  --embed-provider <id>              指定 embedding provider（默认 config 里第一个）
  --recall-min-sim <n>               覆盖 recall.config.minSim（有嵌入时的相关度下限，标定用）
  --recall-min-sim-noembed <n>       覆盖 recall.config.minSimNoEmbed（无嵌入时下限）
  --eager-min-score <n>              覆盖 eager-recall.config.minScore
  --eager-min-score-noembed <n>      覆盖 eager-recall.config.minScoreNoEmbed
  --keep-temp                        保留临时 stateDir（调试用，打印路径）
  --quiet                            少打印
  --debug                            打印 formation 的 warn/error 日志（排查 shard/job 失败）
  -h, --help

gate 指标名：
  formation.precision / formation.recall / formation.f1 / formation.dupRate /
  formation.noiseRate / formation.selfSourceRate / formation.provenanceRate /
  formation.identity / formation.wrongIdRate /
  retrieval.recallAt1 / retrieval.recallAt3 / retrieval.recallAt5 / retrieval.mrr /
  retrieval.ndcgAt10 / retrieval.injectionPrecision / retrieval.missRate / retrieval.falseInjectionRate
  （dup/noise/selfSource/wrongId/miss/falseInjection 默认是"越低越好"≤，其余默认是"越高越好"≥）`)
}

/* ── gate ─────────────────────────────────────────────────────── */

const LOWER_IS_BETTER = new Set([
  'formation.dupRate', 'formation.noiseRate', 'formation.selfSourceRate', 'formation.wrongIdRate',
  'retrieval.missRate', 'retrieval.falseInjectionRate',
])

const GATE_PATHS = {
  'formation.precision': ['formation', 'metrics', 'overall', 'precision'],
  'formation.recall': ['formation', 'metrics', 'overall', 'recall'],
  'formation.f1': ['formation', 'metrics', 'overall', 'f1'],
  'formation.dupRate': ['formation', 'metrics', 'dedup', 'rate'],
  'formation.noiseRate': ['formation', 'metrics', 'noise', 'rate'],
  'formation.selfSourceRate': ['formation', 'metrics', 'selfSource', 'rate'],
  'formation.provenanceRate': ['formation', 'metrics', 'provenance', 'rate'],
  'formation.identity': ['formation', 'metrics', 'identity', 'identity'],
  'formation.wrongIdRate': ['formation', 'metrics', 'identity', 'wrongIdRate'],
  'retrieval.recallAt1': ['retrieval', 'metrics', 'recallAt1'],
  'retrieval.recallAt3': ['retrieval', 'metrics', 'recallAt3'],
  'retrieval.recallAt5': ['retrieval', 'metrics', 'recallAt5'],
  'retrieval.mrr': ['retrieval', 'metrics', 'mrr'],
  'retrieval.ndcgAt10': ['retrieval', 'metrics', 'ndcgAt10'],
  'retrieval.injectionPrecision': ['retrieval', 'metrics', 'injectionPrecision'],
  'retrieval.missRate': ['retrieval', 'metrics', 'missRate'],
  'retrieval.falseInjectionRate': ['retrieval', 'metrics', 'falseInjectionRate'],
}

function pathValue(object, segments) {
  let node = object
  for (const segment of segments) {
    if (node == null) return null
    node = node[segment]
  }
  return node == null ? null : node
}

export function parseGate(spec) {
  if (!spec) return null
  const checks = []
  for (const raw of String(spec).split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = /^([\w.]+)\s*(>=|<=|=)\s*(-?\d+(?:\.\d+)?)$/.exec(raw)
    if (!match) throw new CliError(`--gate 项不合法：${raw}（示例：formation.precision=0.5,formation.dupRate<=0.2）`)
    const key = match[1]
    if (!GATE_PATHS[key]) throw new CliError(`--gate 未知指标：${key}（可用见 --help）`)
    const threshold = Number(match[3])
    let direction = match[2] === '>=' ? 'min' : match[2] === '<=' ? 'max' : (LOWER_IS_BETTER.has(key) ? 'max' : 'min')
    checks.push({ key, threshold, direction })
  }
  return { enabled: true, spec: String(spec), checks }
}

/**
 * answer-adequacy（--adequacy）：对"真负例"（expected 为空且无 unresolved）让模型判断
 * recall 返回的记忆里有没有**真正回答问题**的内容。原始 falseInjection 只统计"有没有返回"，
 * 这里区分「提到但没答」与「真把相关内容当答案」。只读 retrieval 结果，不写任何记忆。
 */
export async function judgeAnswerAdequacy({ retrieval, model, cacheOnly = false }) {
  if (!retrieval?.probes) return null
  const negatives = retrieval.probes.filter((entry) => {
    const metrics = entry.metrics ?? {}
    return (metrics.expectedIds ?? []).length === 0 && !(entry.unresolvedExpected ?? []).length
  })
  const system = [
    '你是记忆检索的验收员。用户问了一个问题，记忆系统返回了若干条记忆文本。',
    '判断：这些记忆里有没有能够直接回答该问题的内容（不是"提到相关话题"，而是真的含有答案）。',
    '只输出 JSON：{"answers": true|false, "reason": "一句话"}。不要解释、不要 Markdown 围栏。',
  ].join('\n')
  const cases = []
  for (const probe of negatives) {
    const returnedText = String(probe.returnedText ?? '').trim()
    let answers = false
    let reason = '未返回任何记忆'
    if (returnedText && !cacheOnly) {
      try {
        const raw = await model.call({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `问题：${probe.query ?? probe.probe?.query ?? ''}\n\n返回的记忆：\n${returnedText.slice(0, 1500)}` },
          ],
          maxTokens: 200,
          where: 'answer-adequacy',
        })
        const match = /\{[\s\S]*\}/.exec(String(raw))
        const parsed = JSON.parse(match ? match[0] : '{}')
        answers = parsed.answers === true
        reason = String(parsed.reason ?? '').slice(0, 160)
      } catch (error) {
        reason = `judge-error：${String(error?.message ?? error).slice(0, 120)}`
      }
    } else if (returnedText && cacheOnly) {
      reason = 'cache-only：跳过 judge（用独立 answer-adequacy 工具跑）'
    }
    cases.push({
      probe: probe.probe?.id ?? probe.id,
      query: probe.query ?? probe.probe?.query ?? '',
      returned: probe.metrics?.returnedIds ?? probe.returned ?? [],
      answers,
      reason,
    })
  }
  return {
    negatives: cases.length,
    answersTrue: cases.filter((entry) => entry.answers).length,
    mentionOnly: cases.filter((entry) => !entry.answers).length,
    cases,
  }
}

export function evaluateGate(gate, evalJson) {  if (!gate) return null
  const results = gate.checks.map((check) => {
    // v3 没有 v2 的 formation P/R：formation.recall 用 episode 的 gold 证据覆盖率代替。
    let value = pathValue(evalJson, GATE_PATHS[check.key])
    if (check.key === 'formation.recall' && evalJson?.formation?.metrics?.schema === 'v3') {
      value = evalJson.formation.metrics.v3?.goldCoverage ?? null
    }
    const numeric = value == null ? null : Number(value)
    const pass = numeric != null && Number.isFinite(numeric)
      && (check.direction === 'min' ? numeric >= check.threshold : numeric <= check.threshold)
    return {
      key: check.key,
      value: numeric,
      threshold: check.threshold,
      direction: check.direction,
      pass,
      ...(numeric == null ? { reason: '指标为空，无法判定' } : {}),
    }
  })
  return { enabled: true, spec: gate.spec, checks: results, passed: results.every((check) => check.pass) }
}

/* ── 主流程 ───────────────────────────────────────────────────── */

export async function main(argv = process.argv.slice(2), io = {}) {
  const write = io.out ?? ((...args) => console.log(...args))
  const writeErr = io.err ?? ((...args) => console.error(...args))
  const cwd = io.cwd ?? process.cwd()
  let options = null
  try {
    options = parseArgs(argv, cwd)
  } catch (error) {
    writeErr(`memory-eval 参数错误：${String(error?.message ?? error)}`)
    printUsage(writeErr)
    return typeof error?.exitCode === 'number' ? error.exitCode : 2
  }
  if (options.help) { printUsage(write); return 0 }

  const started = Date.now()
  const warnings = []
  const logs = []
  let formationRun = null
  let retrievalHost = null
  let retrieval = null
  let repeats = null
  let idem = null
  try {
    const loaded = loadFixture(options.fixture)
    if (!loaded.ok) {
      writeErr(`fixture 校验失败（${loaded.path}）：`)
      for (const error of loaded.errors) writeErr(`  - ${error.path}: ${error.message}`)
      return 2
    }
    let { fixture, indexes } = loaded
    warnings.push(...loaded.warnings)
    if (options.days.length) {
      const sliced = sliceFixtureDays(fixture, options.days)
      if (!sliced.days.length) throw new CliError(`--days 在 fixture 里没有匹配到任何一天：${options.days.join(', ')}`, 2)
      fixture = normalizeFixture(sliced)
      indexes = buildIndexes(fixture)
      const missing = options.days.filter((day) => !sliced.days.some((entry) => entry.day === day))
      if (missing.length) warnings.push({ path: '$.days', message: `--days 里这些日期在 fixture 中不存在：${missing.join(', ')}` })
    }
    const outDir = options.outDir
      ? assertSafeOutDir(path.resolve(cwd, options.outDir))
      : assertSafeOutDir(path.join(REPO_ROOT, '.state', 'lab', 'eval-harness', 'runs', `${fixture.id}-${tsSlug()}`))
    if (!options.quiet) {
      write(`fixture：${fixture.id}（${fixture.kind}）${(fixture.days ?? []).length} 天 · gold ${(fixture.gold?.memories ?? []).length} 条 · probes ${(fixture.probes ?? []).length} · profile=${options.profile}`)
      write(`mode=${options.mode} model=${options.model} seed=${options.seed} out=${outDir}`)
    }

    const model = await createModelAdapter({
      kind: options.model,
      outDir,
      configFile: options.configFile,
      providerId: options.provider,
      modelId: options.modelId,
      maxCalls: options.maxCalls,
      cacheOnly: options.cacheOnly,
      fresh: options.fresh,
      echoHints: { selfNames: [String(fixture.persona?.self?.name ?? '')].filter(Boolean) },
    })
    // 嵌入是独立开关：默认关，离线 CI 不依赖本地 8088；打开后 retrieval 走真实向量+字面混合。
    const embedAdapter = options.embed
      ? await createEmbedAdapter({
          outDir,
          configFile: options.configFile,
          providerId: options.embedProvider,
        })
      : null
    if (embedAdapter && !options.quiet) write(`embed：${embedAdapter.describe().provider}/${embedAdapter.describe().model}（已绑定 embed-text 插槽）`)
    // 检索阈值覆盖：只用于标定/migration A/B，不写产品默认；报告里会记录实际生效值。
    const recallConfig = {
      ...(options.recallMinSim != null ? { minSim: options.recallMinSim } : {}),
      ...(options.recallMinSimNoEmbed != null ? { minSimNoEmbed: options.recallMinSimNoEmbed } : {}),
      ...(options.rerank !== 'off' ? { rerank: options.rerank } : {}),
    }
    const eagerConfig = {
      ...(options.eagerMinScore != null ? { minScore: options.eagerMinScore } : {}),
      ...(options.eagerMinScoreNoEmbed != null ? { minScoreNoEmbed: options.eagerMinScoreNoEmbed } : {}),
    }

    const formationStarted = Date.now()
    if (options.mode === 'formation' || options.mode === 'all') {
      formationRun = await runFormation({
        fixture,
        indexes,
        profile: options.profile,
        model,
        embedAdapter,
        keepTemp: options.keepTemp,
        schema: options.schema,
        recallConfig,
        eagerConfig,
        logs,
      })
      const failedJobs = formationRun.dayResults.flatMap((day) => (day.results ?? []).filter((job) => job.ok === false).map((job) => ({ day: day.day, ...job })))
      for (const job of failedJobs.slice(0, 8)) {
        warnings.push({ path: `formation.days[${job.day}].${job.job}`, message: `job 失败：${job.error ?? 'unknown'}` })
      }
      const runThrew = formationRun.dayResults.find((day) => day.error)
      if (runThrew) throw new CliError(`dream.run 失败（${runThrew.day}）：${runThrew.error}`, 2)
      if (formationRun.metrics.counts.extracted === 0 && failedJobs.length) {
        throw new CliError(`formation 没有产出任何块，且 ${failedJobs.length} 个 job 失败（首个：${failedJobs[0].error}）。检查模型/插槽后重试。`, 2)
      }
      for (let index = 2; index <= options.repeat; index += 1) {
        const extra = await runFormation({
          fixture,
          indexes,
          profile: options.profile,
          model,
          embedAdapter,
          keepTemp: false,
          schema: options.schema,
          recallConfig,
          eagerConfig,
          logs: [],
        })
        repeats = repeats ?? [{
          index: 1,
          extracted: formationRun.metrics.counts.extracted,
          matched: formationRun.metrics.overall.matched,
          precision: formationRun.metrics.overall.precision,
          recall: formationRun.metrics.overall.recall,
          duplicatePairs: formationRun.metrics.dedup.pairs,
          duplicateRate: formationRun.metrics.dedup.rate,
        }]
        repeats.push({
          index,
          extracted: extra.metrics.counts.extracted,
          matched: extra.metrics.overall.matched,
          precision: extra.metrics.overall.precision,
          recall: extra.metrics.overall.recall,
          duplicatePairs: extra.metrics.dedup.pairs,
          duplicateRate: extra.metrics.dedup.rate,
        })
        if (!idem) {
          idem = {
            ...idempotency(formationRun.extracted, extra.extracted),
            duplicatePairsFirst: formationRun.metrics.dedup.pairs,
            duplicatePairsSecond: extra.metrics.dedup.pairs,
            duplicatePairsDelta: extra.metrics.dedup.pairs - formationRun.metrics.dedup.pairs,
          }
        }
        await closeFormation(extra)
      }
      if (!options.quiet) {
        const m = formationRun.metrics
        write(`formation：extracted=${m.counts.extracted} matched=${m.overall.matched} P=${pct(m.overall.precision)} R=${pct(m.overall.recall)} dup=${pct(m.dedup.rate)} provenance=${pct(m.provenance.rate)} selfSource=${pct(m.selfSource.rate)}`)
      }
    }
    if (options.debug) {
      const noisy = logs.filter((row) => row.level !== 'debug' && row.msg !== 'memory.search').slice(0, 60)
      for (const entry of noisy) {
        const brief = { ...entry }
        delete brief.level
        delete brief.msg
        write(`[dream.${entry.level}] ${entry.msg ?? ''} ${JSON.stringify(brief).slice(0, 300)}`)
      }
    }
    const formationMs = Date.now() - formationStarted

    const retrievalStarted = Date.now()
    if (options.mode === 'retrieval' || options.mode === 'all') {
      let corpus = null
      if (options.seed === 'formation') {
        if (!formationRun) {
          // retrieval-only + seed=formation：先补跑一次 formation（语义上等价 all，报告里注明）。
          formationRun = await runFormation({ fixture, indexes, profile: options.profile, model, embedAdapter, keepTemp: options.keepTemp, schema: options.schema, recallConfig, eagerConfig, logs })
          warnings.push({ path: 'retrieval.seed', message: 'retrieval-only + --seed formation：为建库补跑了一次 formation' })
        }
        corpus = seedFormation(formationRun)
      } else {
        const root = makeTempDir('icl-memory-eval-seed-')
        retrievalHost = await createEvalHost({
          root,
          model,
          embedAdapter,
          timezone: indexes.timezone,
          identity: identityConfigOf(fixture),
          formationProfile: 'raw-main',
          mainRows: [],
          contextRows: [],
          recallConfig,
          eagerConfig,
          logs,
        })
        corpus = await seedGold({ hostBox: retrievalHost, fixture, indexes, logs })
      }
      retrieval = await runRetrieval({
        fixture,
        indexes,
        hostBox: options.seed === 'formation' ? formationRun.host : retrievalHost,
        corpus,
        embedding: embedAdapter
          ? `loaded（${embedAdapter.describe().provider}/${embedAdapter.describe().model}，${embedAdapter.stats().dim ?? '?'} 维）`
          : 'none（未绑定 embed 插槽：memory.search 走二元组退化路径）',
      })
      if (!options.quiet) {
        const m = retrieval.metrics
        write(`retrieval（seed=${options.seed}）：recall@1=${pct(m.recallAt1)} recall@3=${pct(m.recallAt3)} recall@5=${pct(m.recallAt5)} MRR=${m.mrr == null ? '—' : m.mrr.toFixed(3)} miss=${pct(m.missRate)} falseInjection=${pct(m.falseInjectionRate)}`)
      }
      if (options.debug) {
        const recallLogs = logs.filter((row) => String(row.msg ?? '').startsWith('recall.'))
        for (const entry of recallLogs.slice(-30)) {
          const brief = { ...entry }
          delete brief.plugin
          write(`[recall.${entry.level ?? 'info'}] ${entry.msg} ${JSON.stringify(brief).slice(0, 320)}`)
        }
      }
    }
    let answerAdequacy = null
    if (options.adequacy && retrieval) {
      answerAdequacy = await judgeAnswerAdequacy({ retrieval, model, cacheOnly: options.cacheOnly })
      if (!options.quiet && answerAdequacy) {
        write(`answer-adequacy：负例 ${answerAdequacy.negatives} 条，judge 判"有答案" ${answerAdequacy.answersTrue} 条，提到但没答 ${answerAdequacy.mentionOnly} 条`)
      }
    }
    const retrievalMs = Date.now() - retrievalStarted

    // --gate 显式优先；否则用 --gate-preset 的三源基线阈值（docs/MEMORY-BASELINES.md）。
    const effectiveGate = options.gate ?? (options.gatePreset ? GATE_PRESETS[String(options.gatePreset)] : null)
    if (options.gatePreset && !options.quiet) {
      write(`gate：使用基线预设 ${options.gatePreset}${options.gate ? '（--gate 覆盖预设）' : ''}`)
    }
    const gate = parseGate(effectiveGate)
    const evalJson = buildEvalJson({
      fixture,
      fixturePath: loaded.path,
      options: {
        ...options,
        outDir,
        modelDescribe: model.describe(),
        embeddingDescribe: embedAdapter?.describe() ?? null,
      },
      modelStats: model.stats(),
      formation: formationRun,
      repeats,
      idempotency: idem,
      retrieval,
      answerAdequacy,
      gate: null,
      cost: {
        wallMs: Date.now() - started,
        formationMs,
        retrievalMs,
        modelWallMs: model.stats().wallMs,
        embed: embedAdapter?.stats() ?? null,
      },
      warnings,
    })
    evalJson.gate = evaluateGate(gate, evalJson)
    const written = writeReports(outDir, evalJson)
    if (!options.quiet) {
      write(`报告：${written.jsonPath}`)
      write(`      ${written.mdPath}`)
      if (evalJson.gate) {
        write(`gate：${evalJson.gate.passed ? '通过' : '未通过'}（${evalJson.gate.spec}）`)
        for (const check of evalJson.gate.checks.filter((entry) => !entry.pass)) {
          write(`  ❌ ${check.key}=${check.value == null ? '—' : check.value} 需要 ${check.direction === 'min' ? '≥' : '≤'} ${check.threshold}`)
        }
      }
      if (options.keepTemp && formationRun) write(`临时 stateDir 已保留：${formationRun.tempRoot}`)
    }
    return evalJson.gate && evalJson.gate.passed === false ? 3 : 0
  } catch (error) {
    writeErr(`memory-eval 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return typeof error?.exitCode === 'number' ? error.exitCode : 2
  } finally {
    if (formationRun) await closeFormation(formationRun)
    if (retrievalHost) {
      try { await retrievalHost.dispose() } catch { /* ignore */ }
      try { fs.rmSync(retrievalHost.root, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

function pct(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`
}

const DIRECT = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch { return false }
})()

if (DIRECT) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`memory-eval 崩溃：${error?.stack ?? error}`)
    process.exitCode = 2
  })
}









