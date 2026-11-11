// fixture 装载与校验：schema（tools/fixtures/memory/schemas/fixture.schema.json）+ 引用完整性。
//
// 输出一份标准化 fixture（days/rows 按时间排序）和索引；runner 只认这里出来的对象，
// 这样"fixture 有问题"永远在开跑前以 exit 2 报出来，而不是跑一半挂掉。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSchema } from './schema.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FIXTURE_SCHEMA_PATH = path.join(REPO_ROOT, 'tools', 'fixtures', 'memory', 'schemas', 'fixture.schema.json')

const SOURCE_KINDS = ['human', 'qq_envelope', 'agent_visible', 'agent_internal', 'tool', 'env', 'memory', 'unknown']
const SELF_SOURCE_KINDS = new Set(['agent_visible', 'agent_internal', 'tool', 'env'])
const PROBE_KINDS = ['recall', 'eager', 'person', 'overview']

/** 时区里的年月日（YYYY-MM-DD）。 */
export function ymdInTz(ms, timezone = 'Asia/Hong_Kong') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Number(ms)))
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 某时区相对 UTC 的偏移（分钟，东为正）。只用于构造"当天 12:00"这类整点。 */
export function offsetMinutes(ms, timezone = 'Asia/Hong_Kong') {
  const instant = Number(ms)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return Math.round((asUtc - instant) / 60_000)
}

/** fixture 的某一天中午 12:00（该时区）的毫秒时间戳；dream.run 用它作为整理时刻。 */
export function dayAtNoon(day, timezone = 'Asia/Hong_Kong') {
  const [year, month, date] = String(day).split('-').map(Number)
  const utcNoon = Date.UTC(year, month - 1, date, 12, 0, 0)
  // 先按 UTC 粗算偏移，再用该时刻的偏移校正一次（DST 不会有影响，但保持通用）。
  const guess = utcNoon - offsetMinutes(utcNoon, timezone) * 60_000
  return utcNoon - offsetMinutes(guess, timezone) * 60_000
}

/** 解析行时间；解析失败返回 NaN（由校验报错）。 */
export function rowAtMs(row) {
  return Date.parse(String(row?.at ?? ''))
}

function fail(errors, where, message) {
  errors.push({ path: where, message })
}

function readJsonFile(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { error: `读不到 fixture 文件：${file}（${String(error?.message ?? error)}）` }
  }
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return { error: `fixture 不是合法 JSON：${file}（${String(error?.message ?? error)}）` }
  }
}

/**
 * 装载并校验 fixture。
 * @param {string} input fixture 目录或 fixture.json 路径
 * @returns {{ok:boolean, fixture:object|null, indexes:object|null, errors:Array, warnings:Array, path:string|null, schemaPath:string}}
 */
export function loadFixture(input) {
  const errors = []
  const warnings = []
  const schemaResult = readJsonFile(FIXTURE_SCHEMA_PATH)
  if (schemaResult.error) {
    return { ok: false, fixture: null, indexes: null, errors: [{ path: '$', message: schemaResult.error }], warnings, path: null, schemaPath: FIXTURE_SCHEMA_PATH }
  }
  let fixturePath = path.resolve(String(input ?? ''))
  try {
    if (fs.statSync(fixturePath).isDirectory()) fixturePath = path.join(fixturePath, 'fixture.json')
  } catch {
    // 交给下面的读文件错误统一报
  }
  const loaded = readJsonFile(fixturePath)
  if (loaded.error) {
    return { ok: false, fixture: null, indexes: null, errors: [{ path: '$', message: loaded.error }], warnings, path: fixturePath, schemaPath: FIXTURE_SCHEMA_PATH }
  }

  const schemaCheck = validateSchema(loaded.value, schemaResult.value)
  errors.push(...schemaCheck.errors)
  if (!schemaCheck.ok) {
    return { ok: false, fixture: null, indexes: null, errors, warnings, path: fixturePath, schemaPath: FIXTURE_SCHEMA_PATH }
  }

  const fixture = normalizeFixture(loaded.value, fixturePath)
  try {
    const indexes = buildIndexes(fixture)
    integrityCheck(fixture, indexes, errors, warnings)
    return { ok: errors.length === 0, fixture, indexes, errors, warnings, path: fixturePath, schemaPath: FIXTURE_SCHEMA_PATH }
  } catch (error) {
    fail(errors, '$', `fixture 结构异常，引用完整性检查失败：${String(error?.message ?? error)}`)
    return { ok: false, fixture: null, indexes: null, errors, warnings, path: fixturePath, schemaPath: FIXTURE_SCHEMA_PATH }
  }
}

/** 标准化：days 按日期升序、rows 按 at 升序（同一毫秒保持原顺序），并标上所属天。 */
export function normalizeFixture(raw, fixturePath = null) {
  const days = (raw.days ?? [])
    .map((day, dayIndex) => ({
      ...day,
      dayIndex,
      rows: (day.rows ?? []).map((row, rowIndex) => ({ ...row, __rowIndex: rowIndex, __day: row.day })),
    }))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
  for (const day of days) {
    day.rows = day.rows
      .map((row) => ({ ...row, atMs: rowAtMs(row) }))
      .sort((a, b) => (Number.isFinite(a.atMs) ? a.atMs : 0) - (Number.isFinite(b.atMs) ? b.atMs : 0) || a.__rowIndex - b.__rowIndex)
  }
  return { ...raw, days, fixturePath }
}

/** 建索引：runner 全程只用这些 Map/Set，避免到处 find。 */
export function buildIndexes(fixture) {
  const timezone = String(fixture.timezone ?? 'Asia/Hong_Kong')
  const rowsById = new Map()
  const rowsByDay = new Map()
  const dayList = []
  for (const day of fixture.days ?? []) {
    const rows = []
    for (const row of day.rows ?? []) {
      if (rowsById.has(row.id)) continue
      const enriched = {
        ...row,
        day: day.day,
        atMs: Number.isFinite(row.atMs) ? row.atMs : rowAtMs(row),
        source: String(row.source ?? 'unknown'),
      }
      rowsById.set(String(row.id), enriched)
      rows.push(enriched)
    }
    dayList.push(day.day)
    rowsByDay.set(day.day, rows)
  }
  const entitiesById = new Map()
  const memoryById = new Map()
  const probeById = new Map()
  for (const entity of fixture.gold?.entities ?? []) entitiesById.set(String(entity.id), entity)
  for (const memory of fixture.gold?.memories ?? []) memoryById.set(String(memory.id), memory)
  for (const probe of fixture.probes ?? []) probeById.set(String(probe.id), probe)
  const noiseRowIds = new Set()
  for (const noise of fixture.gold?.noise ?? []) for (const rowId of noise.rowIds ?? []) noiseRowIds.add(String(rowId))
  // 身份声明：用于 person block 的 identity / wrongIdRate。
  const declaredIdPairs = new Set()
  const declaredIdValues = new Set()
  const declaredNames = new Set()
  for (const entity of fixture.gold?.entities ?? []) {
    for (const id of entity.ids ?? []) {
      declaredIdPairs.add(`${id.kind}:${id.value}`)
      declaredIdValues.add(String(id.value))
    }
    if (entity.name) { declaredNames.add(String(entity.name)); declaredIdValues.add(String(entity.name)) }
    for (const alias of entity.aliases ?? []) { declaredNames.add(String(alias)); declaredIdValues.add(String(alias)) }
  }
  for (const actor of [fixture.persona?.self, fixture.persona?.owner]) {
    if (!actor) continue
    for (const id of actor.ids ?? []) declaredIdPairs.add(`${id.kind}:${id.value}`)
    if (actor.name) { declaredNames.add(String(actor.name)); declaredIdValues.add(String(actor.name)) }
    for (const alias of actor.aliases ?? []) { declaredNames.add(String(alias)); declaredIdValues.add(String(alias)) }
  }
  // QQ 群号（被当成 QQ 号写进 person 档案是已知错误口径）。
  const groupIds = new Set()
  for (const rows of rowsByDay.values()) {
    for (const row of rows) {
      const m = /^qq:group:(\d+)$/.exec(String(row.channel ?? ''))
      if (m) groupIds.add(m[1])
    }
  }
  const selfIds = new Set((fixture.persona?.self?.ids ?? []).map((id) => String(id.value)))
  // subject 写法兼容：`person:<qq>` 可能等于 entity.id，也可指 entity.ids 里的账号值。
  const entityIdBySubject = new Map()
  for (const entity of fixture.gold?.entities ?? []) {
    entityIdBySubject.set(String(entity.id), String(entity.id))
    for (const id of entity.ids ?? []) {
      entityIdBySubject.set(`person:${id.value}`, String(entity.id))
      entityIdBySubject.set(String(id.value), String(entity.id))
    }
  }
  const goldEmpty = (fixture.gold?.memories ?? []).length === 0
  return {
    timezone, rowsById, rowsByDay, dayList, entitiesById, memoryById, probeById,
    noiseRowIds, declaredIdPairs, declaredIdValues, declaredNames, groupIds, selfIds, entityIdBySubject,
    goldEmpty, allRowIds: [...rowsById.keys()],
    entityIdOfSubject(subject) {
      const text = String(subject ?? '')
      return entityIdBySubject.get(text) ?? null
    },
  }
}

function integrityCheck(fixture, indexes, errors, warnings) {
  const timezone = indexes.timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    fail(errors, '$.timezone', `不是合法 IANA 时区：${timezone}`)
  }
  if (!fixture.description) warnings.push({ path: '$.description', message: '缺 description（报告可读性会差）' })

  // persona：自己与主人必须有名字/身份
  for (const [role, actor] of [['self', fixture.persona?.self], ['owner', fixture.persona?.owner]]) {
    if (!actor) { fail(errors, `$.persona.${role}`, '缺少 persona'); continue }
    if (!String(actor.name ?? '').trim()) fail(errors, `$.persona.${role}.name`, 'name 不能为空')
    if (!Array.isArray(actor.ids) || !actor.ids.length) warnings.push({ path: `$.persona.${role}.ids`, message: '没有声明 ids，身份指标会退化' })
  }

  // rows：id 全 fixture 唯一、at 可解析、day 与 at 的时区日期一致、非 assistant 必须 visible
  const seenRowIds = new Set()
  const seenDays = new Set()
  for (const day of fixture.days ?? []) {
    if (seenDays.has(day.day)) fail(errors, `$.days[${day.day}]`, `日期重复：${day.day}`)
    seenDays.add(day.day)
    if (!(day.rows ?? []).length) warnings.push({ path: `$.days[${day.day}]`, message: '这一天没有行，wash 会跳过' })
    for (const row of day.rows ?? []) {
      const where = `$.days[${day.day}].rows[${row.id}]`
      if (seenRowIds.has(row.id)) fail(errors, where, `row id 重复：${row.id}`)
      seenRowIds.add(row.id)
      const atMs = rowAtMs(row)
      if (!Number.isFinite(atMs)) { fail(errors, where, `at 不是合法时间：${row.at}`); continue }
      const rowYmd = ymdInTz(atMs, timezone)
      if (rowYmd !== day.day) {
        warnings.push({ path: where, message: `at=${row.at} 在 ${timezone} 属于 ${rowYmd}，但被归在 ${day.day} 天；wash 会把它漏掉` })
      }
      if (row.role !== 'assistant' && row.visible !== true) {
        fail(errors, where, '非 assistant 行必须 visible=true（SPEC §3）')
      }
    }
  }

  // gold 引用完整性
  const entityIds = new Set((fixture.gold?.entities ?? []).map((entity) => String(entity.id)))
  const seenEntityIds = new Set()
  for (const entity of fixture.gold?.entities ?? []) {
    const where = `$.gold.entities[${entity.id}]`
    if (seenEntityIds.has(entity.id)) fail(errors, where, `entity id 重复：${entity.id}`)
    seenEntityIds.add(entity.id)
  }
  const seenMemoryIds = new Set()
  for (const memory of fixture.gold?.memories ?? []) {
    const where = `$.gold.memories[${memory.id}]`
    if (seenMemoryIds.has(memory.id)) fail(errors, where, `memory id 重复：${memory.id}`)
    seenMemoryIds.add(memory.id)
    const subject = String(memory.subject ?? '')
    const personSubject = /^person:(.+)$/.exec(subject)
    if (personSubject && !indexes.entityIdOfSubject(subject)) {
      fail(errors, where, `subject 指向不存在的 entity：${subject}`)
    }
    const evidence = Array.isArray(memory.evidence) ? memory.evidence : []
    if (String(memory.type) === 'person' && !personSubject) {
      fail(errors, `${where}.subject`, 'person 类型 gold memory 的 subject 必须是 person:<entityId>')
    }
    if (!evidence.length) {
      if (fixture.kind !== 'synthetic') fail(errors, `${where}.evidence`, '真实 fixture 的 gold memory 必须有证据行')
      else if (String(memory.note ?? '') !== 'negative') warnings.push({ path: `${where}.evidence`, message: '证据为空（仅 synthetic negative 允许）' })
    }
    for (const rowId of evidence) {
      if (!indexes.rowsById.has(String(rowId))) fail(errors, `${where}.evidence`, `证据行不存在：${rowId}`)
    }
  }
  for (const noise of fixture.gold?.noise ?? []) {
    for (const rowId of noise.rowIds ?? []) {
      if (!indexes.rowsById.has(String(rowId))) fail(errors, `$.gold.noise[${noise.reason}]`, `noise 行不存在：${rowId}`)
    }
  }

  // probes 引用完整性
  const seenProbeIds = new Set()
  for (const probe of fixture.probes ?? []) {
    const where = `$.probes[${probe.id}]`
    if (seenProbeIds.has(probe.id)) fail(errors, where, `probe id 重复：${probe.id}`)
    seenProbeIds.add(probe.id)
    if (!indexes.rowsById.has(String(probe.rowId))) fail(errors, `${where}.rowId`, `探针时刻行不存在：${probe.rowId}`)
    if (probe.kind === 'person' && !String(probe.query ?? '').trim()) {
      fail(errors, `${where}.query`, 'person 探针必须给 query（QQ 号或名字）')
    }
    if (probe.kind === 'overview' && String(probe.query ?? '').trim()) {
      warnings.push({ path: `${where}.query`, message: 'overview 探针的 query 不会被使用（无 query 的最近视图）' })
    }
    for (const field of ['expectedMemoryIds', 'expectedAny', 'mustNotRecall']) {
      for (const memoryId of probe[field] ?? []) {
        if (!indexes.memoryById.has(String(memoryId))) fail(errors, `${where}.${field}`, `引用了不存在的 gold memory：${memoryId}`)
      }
    }
    const expected = [...(probe.expectedMemoryIds ?? []), ...(probe.expectedAny ?? [])]
    if (!expected.length && probe.kind !== 'overview' && !String(probe.note ?? '').includes('empty-ok')) {
      warnings.push({ path: where, message: '没有 expectedMemoryIds/expectedAny：用于测 falseInjectionRate（若不希望如此请写 note:"empty-ok"）' })
    }
  }
}

/** 把 fixture persona 转成 dream 的身份链配置（selfQQ/ownerQQ/别名），产品与评测共用同一事实。 */
export function identityConfigOf(fixture) {
  const qqOf = (actor) => String((actor?.ids ?? []).find((id) => String(id.kind) === 'qq')?.value ?? '').trim()
  const self = fixture.persona?.self ?? {}
  const owner = fixture.persona?.owner ?? {}
  return {
    selfQQ: qqOf(self),
    ownerQQ: qqOf(owner),
    ownerNames: [owner.name, ...(owner.aliases ?? [])].map((name) => String(name ?? '').trim()).filter(Boolean),
    selfNames: [self.name, ...(self.aliases ?? [])].map((name) => String(name ?? '').trim()).filter(Boolean),
  }
}

/** 只保留指定日期（用于"某几天的基线"）；gold/noise/probes 引用同步裁剪，避免引用完整性报警。 */
export function sliceFixtureDays(fixture, dayList) {
  const wanted = new Set((dayList ?? []).map((day) => String(day).trim()).filter(Boolean))
  if (!wanted.size) return fixture
  const days = (fixture.days ?? []).filter((day) => wanted.has(day.day))
  const rowIds = new Set(days.flatMap((day) => (day.rows ?? []).map((row) => String(row.id))))
  const entities = fixture.gold?.entities ?? []
  const entityIds = new Set(entities.map((entity) => String(entity.id)))
  const subjectEntityOf = (subject) => {
    const text = String(subject ?? '')
    if (!text.startsWith('person:')) return null
    const exact = entityIds.has(text) ? text : null
    if (exact) return exact
    const tail = text.slice('person:'.length)
    const byId = entities.find((entity) => (entity.ids ?? []).some((id) => String(id.value) === tail))
    return byId ? String(byId.id) : null
  }
  const memories = []
  for (const memory of fixture.gold?.memories ?? []) {
    const personOk = !String(memory.subject ?? '').startsWith('person:') || subjectEntityOf(memory.subject) != null
    if (!personOk) continue
    const evidence = (memory.evidence ?? []).map(String).filter((rowId) => rowIds.has(rowId))
    if (!evidence.length) continue
    memories.push({ ...memory, evidence })
  }
  const memoryIds = new Set(memories.map((memory) => String(memory.id)))
  const probes = []
  for (const probe of fixture.probes ?? []) {
    if (!rowIds.has(String(probe.rowId))) continue
    const expected = (probe.expectedMemoryIds ?? []).map(String).filter((id) => memoryIds.has(id))
    const expectedAny = (probe.expectedAny ?? []).map(String).filter((id) => memoryIds.has(id))
    // 原来有期望、裁剪后一条都不剩的探针没有意义（会变成 falseInjection 样本），直接丢掉。
    if (((probe.expectedMemoryIds ?? []).length || (probe.expectedAny ?? []).length) && !expected.length && !expectedAny.length) continue
    probes.push({
      ...probe,
      expectedMemoryIds: expected,
      expectedAny,
      mustNotRecall: (probe.mustNotRecall ?? []).map(String).filter((id) => memoryIds.has(id)),
    })
  }
  const noise = []
  for (const entry of fixture.gold?.noise ?? []) {
    const kept = (entry.rowIds ?? []).map(String).filter((rowId) => rowIds.has(rowId))
    if (kept.length) noise.push({ ...entry, rowIds: kept })
  }
  return {
    ...fixture,
    days,
    gold: { entities, memories, noise },
    probes,
    description: `${fixture.description ?? ''}（day 子集：${[...wanted].join(',')}）`,
  }
}

/** 把 fixture 的某一行展开成 raw 服务行（wash 只需要 time/text/sender，其余给产品侧 profile 用）。 */
export function rawRowOf(row, fixture) {
  const speaker = row.speaker ?? {}
  const owner = fixture.persona?.owner
  const self = fixture.persona?.self
  let sender = ''
  if (row.role === 'assistant') sender = String(self?.name ?? '我')
  else if (speaker.kind === 'owner') sender = String(owner?.name ?? '主人')
  else if (speaker.kind === 'self') sender = String(self?.name ?? '我')
  else if (speaker.kind === 'person') sender = String(speaker.value ?? '某人')
  else if (speaker.kind === 'system') sender = '系统'
  else sender = String(row.role ?? '')
  return {
    id: String(row.id),
    rowId: String(row.id),
    time: row.atMs,
    at: row.at,
    role: row.role,
    channel: row.channel,
    speaker,
    text: String(row.text ?? ''),
    source: String(row.source ?? 'unknown'),
    sender,
    visible: row.visible !== false,
  }
}

export { SOURCE_KINDS, SELF_SOURCE_KINDS, PROBE_KINDS }
