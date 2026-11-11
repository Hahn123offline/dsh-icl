// 报告：<out>/eval.json（完整结构化）+ <out>/eval.md（人读）。
//
// md 只放"能决策"的东西：指标总表、按类型分组、Top 失败样本（可定位到 fixture 行/gold）、
// 成本、profile/seed/label；其余明细留在 json 里，避免报告变成日志。
import fs from 'node:fs'
import path from 'node:path'

function fmtPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return `${(Number(value) * 100).toFixed(1)}%`
}

function fmtNum(value, digits = 3) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return Number(value).toFixed(digits)
}

function clip(value, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 组装 eval.json 的结构（report 的机器可读面）。 */
export function buildEvalJson({ fixture, fixturePath, options, modelStats, formation, repeats, idempotency, retrieval, gate, cost, warnings, errors = [] }) {
  const gold = fixture.gold ?? {}
  const rowCount = (fixture.days ?? []).reduce((sum, day) => sum + (day.rows ?? []).length, 0)
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    label: options.label ?? null,
    fixture: {
      id: fixture.id,
      kind: fixture.kind,
      description: fixture.description ?? '',
      path: fixturePath,
      timezone: fixture.timezone,
      days: (fixture.days ?? []).map((day) => day.day),
      rows: rowCount,
      probes: (fixture.probes ?? []).length,
      goldMemories: (gold.memories ?? []).length,
      goldEntities: (gold.entities ?? []).length,
      noise: (gold.noise ?? []).length,
      goldEmpty: (gold.memories ?? []).length === 0,
    },
    options: {
      mode: options.mode,
      model: options.model,
      modelId: options.modelId ?? null,
      provider: options.provider ?? null,
      profile: options.profile,
      seed: options.seed,
      repeat: options.repeat,
      gate: options.gate ?? null,
      outDir: options.outDir,
      embedding: retrieval?.embedding
        ?? (options.embeddingDescribe
          ? `loaded（${options.embeddingDescribe.provider}/${options.embeddingDescribe.model}）`
          : 'none'),
    },
    model: {
      describe: options.modelDescribe ?? null,
      stats: modelStats ?? null,
      cacheFile: options.modelDescribe?.cacheFile ?? null,
    },
    formation: formation
      ? {
          metrics: formation.metrics,
          samples: formation.samples,
          days: formation.dayResults,
          repeats: repeats ?? null,
          idempotency: idempotency ?? null,
          // 完整 extracted 清单（截 500 条）：失败可定位到具体块/证据行。
          extracted: (formation.extracted ?? []).slice(0, 500).map((item) => ({
            id: item.id,
            kind: item.kindKey,
            key: item.key,
            text: item.text,
            day: item.day,
            rowIds: item.rowIds,
            unresolved: (item.unresolved ?? []).length,
            provisional: item.provisional === true,
            matchedGoldId: (formation.match?.pairs ?? []).find((pair) => String(pair.extractedId) === String(item.id))?.goldId ?? null,
          })),
          profile: {
            path: formation.profilePath ?? 'product-raw',
            mainRows: formation.rawMainCount,
            contextRows: formation.rawContextCount,
            counts: formation.profileCounts,
            notes: formation.profileNotes ?? [],
            note: '主材料与产品共用 packages/core/raw-profile.mjs 分类器（raw 源入口按 profile 过滤；产品 wash 再做一次同口径门控）',
          },
        }
      : null,
    retrieval: retrieval
      ? {
          seed: retrieval.seed,
          seededItems: retrieval.seededItems,
          seedNotes: retrieval.seedNotes,
          embedding: retrieval.embedding,
          metrics: retrieval.metrics,
          ledger: retrieval.ledger,
          probes: (retrieval.probes ?? []).map((entry) => ({
            id: entry.probe.id,
            kind: entry.probe.kind,
            rowId: entry.probe.rowId,
            query: entry.probe.query,
            path: entry.path,
            error: entry.error,
            expected: entry.metrics.expectedIds,
            returned: entry.metrics.returnedIds,
            returnedText: String(entry.returnedText ?? '').slice(0, 1200),
            debugScores: entry.debugScores ?? null,
            totals: {
              expected: entry.metrics.expectedCount,
              returned: entry.metrics.returnedCount,
              hitTopK: entry.metrics.hitTopK,
            },
            metrics: entry.metrics,
            unresolvedExpected: entry.unresolvedExpected,
          })),
        }
      : null,
    cost,
    gate: gate ?? null,
    warnings: warnings ?? [],
    errors,
  }
}

function metricTable(rows) {
  const head = '| 指标 | 值 |\n|---|---|'
  const body = rows.map(([name, value]) => `| ${name} | ${value} |`).join('\n')
  return `${head}\n${body}`
}

function formationMd(formation) {
  const m = formation.metrics
  const lines = ['## Formation（SPEC §7.1）', '']
  lines.push(metricTable([
    ['extracted', String(m.counts.extracted)],
    ['gold', String(m.overall.gold)],
    ['matched', String(m.overall.matched)],
    ['precision', fmtPct(m.overall.precision)],
    ['recall', fmtPct(m.overall.recall)],
    ['F1', fmtNum(m.overall.f1)],
    ['dupRate ↓', fmtPct(m.dedup.rate)],
    ['noiseRate ↓', fmtPct(m.noise.rate)],
    ['selfSourceRate ↓（目标 ≤15%）', fmtPct(m.selfSource.rate)],
    ['provenanceRate ↑（目标 ≥95%）', fmtPct(m.provenance.rate)],
    ['identity（person→entity）', fmtPct(m.identity.identity)],
    ['wrongIdRate ↓', fmtPct(m.identity.wrongIdRate)],
  ]))
  lines.push('', `计数：event ${m.counts.kinds.event ?? 0} · person ${m.counts.kinds.person ?? 0} · lexicon ${m.counts.kinds.lexicon ?? 0}；` +
    `note ${m.counts.aux.notes} · dayLog ${m.counts.aux.dayLogs} · 续块 ${m.counts.aux.continuationParts} · superseded ${m.counts.aux.superseded}；` +
    `证据解析 ${m.provenance.resolved}/${m.provenance.extracted} 条块、未解析证据 ${m.provenance.unresolvedEntries} 条`, '')
  if (m.goldEmpty) lines.push('> goldEmpty=true：gold.memories 为空，P/R/F1 不参与计算（结构/溯源/自源/身份指标照常报）。', '')
  if ((m.identity.wrongIdSamples ?? []).length) {
    lines.push('身份错误样本（wrongIdRate 分子）：', '')
    for (const block of m.identity.wrongIdSamples.slice(0, 5)) {
      const ids = (block.wrongIds ?? []).map((wrong) => `${wrong.kind}:${wrong.value}=${wrong.reason}`).join('、')
      lines.push(`- ${block.key ?? block.id}（${ids}）：${clip(block.text, 60)}`)
    }
    lines.push('')
  }
  const invalidation = m.invalidation
  if (invalidation && invalidation.cases) {
    lines.push('### 承诺/偏好更新（gold.invalidatedBy）', '')
    lines.push('| 旧 gold | 类型 | 旧值形成 | 新值形成 | 旧值仍存活 |\n|---|---|---|---|---|')
    for (const sample of invalidation.samples) {
      lines.push(`| ${sample.oldGoldId} → ${sample.newGoldId} | ${sample.oldType} | ${sample.oldMatched ? '是' : '否'} | ${sample.newMatched ? '是' : '否'} | ${sample.staleOldSurvives ? '⚠️ 是' : '否'} |`)
    }
    lines.push('', `小结：cases=${invalidation.cases} · 旧值匹配=${invalidation.oldMatched} · 新值匹配=${invalidation.newMatched} · 旧值仍存活=${invalidation.staleOldSurvives} · 新值近似存在但未匹配=${invalidation.newValuePresentButUnmatched}`, '')
  }
  lines.push('### 按类型', '', '| type | gold | matched | recall |\n|---|---|---|---|')
  for (const [type, row] of Object.entries(m.byType)) {
    if (!row.gold && !row.matched) continue
    lines.push(`| ${type} | ${row.gold} | ${row.matched} | ${fmtPct(row.recall)} |`)
  }
  lines.push('', '### 失败样本（可定位）', '')
  const samples = formation.samples ?? {}
  if ((samples.unmatchedGold ?? []).length) {
    lines.push('未匹配 gold：', '', '| gold | type | 正文 | 最近 extracted | overlap | textSim | 判据 |\n|---|---|---|---|---|---|---|')
    for (const row of samples.unmatchedGold.slice(0, 6)) {
      lines.push(`| ${row.goldId} | ${row.type} | ${clip(row.text, 60)} | ${row.nearest?.extractedId ?? '—'} | ${row.nearest?.overlap ?? 0}/${(row.evidence ?? []).length} | ${fmtNum(row.nearest?.textSim)} | ${row.nearest?.reason ?? '—'} |`)
    }
    lines.push('')
  }
  if ((samples.unresolvedEvidence ?? []).length) {
    lines.push('未解析证据（provenanceRate 的分母）：', '')
    for (const row of samples.unresolvedEvidence.slice(0, 5)) {
      lines.push(`- block ${row.extractedId}（${row.kindKey}）via ${row.via}：${clip(row.evidence?.line, 60)}`)
    }
    lines.push('')
  }
  if ((samples.unmatchedExtracted ?? []).length) {
    lines.push('未匹配 extracted（precision 的分母），可能是噪音或漏标 gold：', '')
    for (const row of samples.unmatchedExtracted.slice(0, 5)) {
      lines.push(`- ${row.id}（${row.kindKey}${row.provisional ? '，provisional' : ''}，证据 ${row.rowIds.length} 条）：${clip(row.text, 70)}`)
    }
    lines.push('')
  }
  if (!samples.unmatchedGold?.length && !samples.unmatchedExtracted?.length) lines.push('（无失败样本）', '')
  return lines.join('\n')
}

function idempotencyMd(idempotency, repeats) {
  if (!idempotency) return ''
  return [
    '## 幂等（--repeat）',
    '',
    metricTable([
      ['第一次 extracted', String(idempotency.first)],
      ['第二次 extracted', String(idempotency.second)],
      ['稳定块（两轮都在）', `${idempotency.stable}（${fmtPct(idempotency.stableRate)}）`],
      ['第二轮新增', String(idempotency.newInSecond)],
      ['第二轮缺失', String(idempotency.missingInSecond)],
      ['同文本但证据集合变化', String(idempotency.evidenceChanged)],
      ['重复对（第一次/第二次/增量）', `${idempotency.duplicatePairsFirst ?? '—'} / ${idempotency.duplicatePairsSecond ?? '—'} / ${idempotency.duplicatePairsDelta >= 0 ? `+${idempotency.duplicatePairsDelta}` : idempotency.duplicatePairsDelta}`],
    ]),
    '',
    ...((repeats ?? []).length > 1 ? [`各轮：${repeats.map((run) => `#${run.index} P=${fmtPct(run.precision)} R=${fmtPct(run.recall)} dup=${fmtPct(run.duplicateRate)}`).join(' · ')}`, ''] : []),
    ...((repeats ?? []).length > 1 ? ['注：云端模型重跑会命中同一 prompt-hash 缓存，因此这里测的是流水线幂等，不是模型采样随机性。', ''] : []),
  ].join('\n')
}

function retrievalMd(retrieval) {
  const m = retrieval.metrics
  const lines = ['## Retrieval（SPEC §7.2）', '']
  lines.push(`seed=${retrieval.seed} · ${retrieval.seededItems} 条 · embedding：${retrieval.embedding}`, '')
  lines.push(metricTable([
    ['probes', `${m.probes}（有 expected ${m.withExpected}）`],
    ['recall@1', fmtPct(m.recallAt1)],
    ['recall@3', fmtPct(m.recallAt3)],
    ['recall@5', fmtPct(m.recallAt5)],
    ['MRR', fmtNum(m.mrr)],
    ['NDCG@10', fmtNum(m.ndcgAt10)],
    ['injectionPrecision', fmtPct(m.injectionPrecision)],
    ['missRate ↓', fmtPct(m.missRate)],
    ['falseInjectionRate ↓', fmtPct(m.falseInjectionRate)],
    ['mustNotRecall 违规', String(m.mustNotRecallViolations)],
    ['expected 无法换算', String(m.unresolvedExpected)],
    ['返回字符均值', m.avgReturnedChars == null ? '—' : String(Math.round(m.avgReturnedChars))],
    ['注入 tokens 估算均值', m.avgInjectedTokensEst == null ? '—' : String(Math.round(m.avgInjectedTokensEst))],
    ['延迟 p50/p95 ms', `${m.latencyP50 ?? '—'} / ${m.latencyP95 ?? '—'}`],
  ]))
  lines.push('', '### 按 kind', '', '| kind | probes | recall@3 | MRR | injectionPrecision | missRate |\n|---|---|---|---|---|---|')
  for (const [kind, row] of Object.entries(m.byKind ?? {})) {
    lines.push(`| ${kind} | ${row.probes} | ${fmtPct(row.recallAt3)} | ${fmtNum(row.mrr)} | ${fmtPct(row.injectionPrecision)} | ${fmtPct(row.missRate)} |`)
  }
  const failed = (retrieval.probes ?? []).filter((entry) => entry.error || entry.metrics.miss === true || (entry.metrics.mustNotRecallViolations ?? []).length)
  if (failed.length) {
    lines.push('', '### 失败探针', '')
    for (const entry of failed.slice(0, 8)) {
      const detail = entry.error
        ? `错误：${entry.error}`
        : `expected ${JSON.stringify(entry.metrics.expectedIds)} → returned ${JSON.stringify(entry.metrics.returnedIds)}`
      lines.push(`- ${entry.id}（${entry.kind}）「${clip(entry.query, 40)}」${detail}；path=${entry.path}${entry.metrics.mustNotRecallViolations.length ? `；违规召回 ${JSON.stringify(entry.metrics.mustNotRecallViolations)}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 生成 eval.md。 */
export function buildEvalMarkdown(evalJson) {
  const fixture = evalJson.fixture
  const lines = []
  lines.push(`# 记忆评测报告：${fixture.id}`)
  lines.push('')
  lines.push(`- 生成时间：${evalJson.generatedAt}`)
  lines.push(`- label：${evalJson.label ?? '—'}`)
  lines.push(`- fixture：${fixture.kind} · ${fixture.days.length} 天 · ${fixture.rows} 行 · gold ${fixture.goldMemories} 条 · probes ${fixture.probes}${fixture.goldEmpty ? ' · **goldEmpty=true（不参与 P/R）**' : ''}`)
  lines.push(`- 描述：${clip(fixture.description, 160)}`)
  lines.push(`- mode=${evalJson.options.mode} · model=${evalJson.options.model}${evalJson.model.describe?.model ? `(${evalJson.model.describe.model})` : ''} · profile=${evalJson.options.profile} · seed=${evalJson.options.seed} · repeat=${evalJson.options.repeat}`)
  lines.push(`- 退出码语义：0 正常 / 2 fixture 或配置错误 / 3 gate 未通过${evalJson.gate ? `（当前 gate：${evalJson.gate.passed ? '通过' : '未通过'}）` : ''}`)
  lines.push('')
  if (evalJson.formation) {
    lines.push(formationMd(evalJson.formation))
    lines.push('')
    lines.push(idempotencyMd(evalJson.formation.idempotency, evalJson.formation.repeats))
  } else {
    lines.push('## Formation')
    lines.push('')
    lines.push('（本次未运行 formation）')
    lines.push('')
  }
  if (evalJson.retrieval) {
    lines.push(retrievalMd(evalJson.retrieval))
    lines.push('')
  } else {
    lines.push('## Retrieval')
    lines.push('')
    lines.push('（本次未运行 retrieval）')
    lines.push('')
  }
  lines.push('## 成本')
  lines.push('')
  lines.push(metricTable([
    ['wallMs', String(evalJson.cost.wallMs)],
    ['模型调用', String(evalJson.model.stats?.calls ?? 0)],
    ['缓存命中', String(evalJson.model.stats?.cacheHits ?? 0)],
    ['promptTokens', String(evalJson.model.stats?.promptTokens ?? 0)],
    ['completionTokens', String(evalJson.model.stats?.completionTokens ?? 0)],
    ...(evalJson.cost.embed
      ? [
          ['embed 调用', String(evalJson.cost.embed.calls ?? 0)],
          ['embedding 缓存命中', String(evalJson.cost.embed.cacheHits ?? 0)],
          ['向量维度', String(evalJson.cost.embed.dim ?? '—')],
        ]
      : []),
  ]))
  lines.push('')
  if ((evalJson.warnings ?? []).length) {
    lines.push('## 警告')
    lines.push('')
    for (const warning of evalJson.warnings.slice(0, 12)) lines.push(`- ${warning.path ?? ''} ${warning.message}`)
    lines.push('')
  }
  if (evalJson.gate) {
    lines.push('## Gate')
    lines.push('')
    lines.push('| 指标 | 值 | 阈值 | 方向 | 通过 |\n|---|---|---|---|---|')
    for (const check of evalJson.gate.checks) {
      lines.push(`| ${check.key} | ${fmtNum(check.value, 4)} | ${check.threshold} | ${check.direction} | ${check.pass ? '✅' : '❌'} |`)
    }
    lines.push('')
  }
  lines.push('## 说明（口径与已知偏差）')
  lines.push('')
  lines.push('- formation 的匹配默认完全确定性（证据行重叠 + bigram 相似 + 同 subject/同天），不调 LLM judge。')
  lines.push('- profile：与产品共用 packages/core/raw-profile.mjs 分类器；`--profile` 作为 `dream.config.formationProfile` 透传，主材料门控由产品 formationLines / people / lexicon 选择器执行（真产品路径 A/B）。')
  lines.push('- raw-all 是真正的无门控基线（产品 formationProfile=raw-all），不再是评测侧模拟。')
  lines.push(`- retrieval：${evalJson.retrieval?.embedding ?? '未运行'}。`)
  lines.push('- echo 模型是确定性离线桩，只验证链路可执行与可复现，不代表模型质量；真实基线请用 `--model cloud`（走 prompt-hash 缓存）。')
  lines.push('- cache.json 按 prompt hash 缓存；`--embed` / `--profile` 会改变形成过程中的记忆条目 id 序列，进而改变 prompt，因此不同 flag 组合的缓存不能互相复用（不是 bug，重跑同参数即可全命中）。')
  lines.push('')
  return lines.join('\n')
}

/** 落盘 eval.json / eval.md，返回路径。 */
export function writeReports(outDir, evalJson) {
  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'eval.json')
  const mdPath = path.join(outDir, 'eval.md')
  fs.writeFileSync(jsonPath, `${JSON.stringify(evalJson, null, 2)}\n`, 'utf8')
  fs.writeFileSync(mdPath, `${buildEvalMarkdown(evalJson)}\n`, 'utf8')
  return { jsonPath, mdPath }
}
