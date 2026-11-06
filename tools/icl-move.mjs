#!/usr/bin/env node
// ICL 整体迁移：把旧 ICL 根下的目录搬到新根，校验字节数，失败回滚，并写迁移记录。
//
// 典型用法（先 dry-run，再 apply）：
//   node tools/icl-move.mjs --from C:/DSH/icl/.state --to D:/icl-data --dry-run
//   node tools/icl-move.mjs --from C:/DSH/icl/.state --to D:/icl-data --apply
//
// 旧安装（还没有 ICL_ROOT 时）的 state 在 $DSH_HOME/icl/state，用 --legacy-state 折叠进新根：
//   node tools/icl-move.mjs --to D:/icl-data --legacy-state C:/Users/me/.dsh/icl/state --apply
//
// 目录约定见 docs/PATHS.md。迁移顺序（每一步都可回滚）：
//   1. 校验：源可读、目标可写、源/目标不重叠、目标目录不存在（不覆盖）
//   2. 复制到 <to>/.icl-move-staging-*，逐文件核对大小与文件数
//   3. 全部核对通过后才 rename 到最终位置（中途失败会删掉已提交的目标目录）
//   4. 写 <to>/icl-move.json 迁移记录
//   5. 最后才删源目录（--keep-source 可保留）；删一半失败不影响新根数据完整性
//
// 退出码：0 = dry-run 通过 / 迁移成功；1 = 校验失败或迁移失败（已回滚）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { iclPaths } from '../packages/core/src/icl-paths.mjs'

export const SCHEMA_VERSION = 1
export const DEFAULT_KINDS = Object.freeze(['state', 'home', 'media', 'album', 'inbox', 'video-tmp'])
export const RECORD_FILE = 'icl-move.json'

function isDir(target) {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}

function exists(target) {
  try { fs.lstatSync(target); return true } catch { return false }
}

function inside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 递归列出目录里的普通文件（不跟随符号链接）。
 * @returns {{files: Map<string,{bytes:number,mtimeMs:number}>, warnings: string[]}}
 */
export function walkTree(root, { exclude = [] } = {}) {
  const files = new Map()
  const warnings = []
  if (!isDir(root)) return { files, warnings }
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      throw new Error(`读不了 ${dir}：${String(error?.message ?? error)}`)
    }
    for (const entry of entries) {
      if (dir === root && exclude.includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { warnings.push(`跳过符号链接（不跟随）：${full}`); continue }
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) { warnings.push(`跳过特殊文件：${full}`); continue }
      const st = fs.statSync(full)
      files.set(path.relative(root, full), { bytes: st.size, mtimeMs: st.mtimeMs })
    }
  }
  walk(root)
  return { files, warnings }
}

function copyTree(src, dst, { exclude = [], afterCopy } = {}) {
  fs.mkdirSync(dst, { recursive: true })
  const copied = []
  const walk = (dir, outDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === src && exclude.includes(entry.name)) continue
      const from = path.join(dir, entry.name)
      const to = path.join(outDir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); walk(from, to); continue }
      if (!entry.isFile()) continue
      fs.copyFileSync(from, to)
      const st = fs.statSync(from)
      try { fs.utimesSync(to, st.atime, st.mtime) } catch { /* 时间戳保不住不影响数据 */ }
      copied.push(path.relative(src, from))
      if (typeof afterCopy === 'function') afterCopy(path.relative(src, from), to)
    }
  }
  walk(src, dst)
  return copied
}

function compareTrees(expected, actual) {
  const problems = []
  for (const [rel, meta] of expected) {
    const got = actual.get(rel)
    if (!got) problems.push(`缺少文件：${rel}`)
    else if (got.bytes !== meta.bytes) problems.push(`大小不符：${rel}（源 ${meta.bytes} / 目标 ${got.bytes}）`)
  }
  for (const rel of actual.keys()) if (!expected.has(rel)) problems.push(`多出文件：${rel}`)
  return problems
}

function targetFor(to, relative) {
  return path.join(to, relative)
}

/**
 * 生成迁移计划（纯函数，除读取源目录大小外不写盘）。
 *
 * @param {object} options
 * @param {string} [options.from]             旧 ICL 根（默认当前解析出的 ICL_ROOT）
 * @param {string} options.to                新 ICL 根
 * @param {string[]} [options.kinds]         要搬的根内目录（默认全部）
 * @param {string[]} [options.legacyStateDirs] 旧 $DSH_HOME/icl/state 目录，折叠进 <to>/state 等
 * @param {string} [options.recordFile]      记录文件（默认 <to>/icl-move.json）
 * @returns {object} plan
 */
export function planMove(options = {}) {
  const from = path.resolve(String(options.from ?? iclPaths().root))
  const toRaw = String(options.to ?? '').trim()
  const to = toRaw ? path.resolve(toRaw) : ''
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds.map(String) : [...DEFAULT_KINDS]
  const unknownKinds = kinds.filter((kind) => !DEFAULT_KINDS.includes(kind))
  const legacyStateDirs = (Array.isArray(options.legacyStateDirs) ? options.legacyStateDirs : []).map((dir) => path.resolve(String(dir)))
  const recordFile = path.resolve(String(options.recordFile ?? path.join(to || '.', RECORD_FILE)))
  const errors = []
  const warnings = []
  const entries = []

  if (unknownKinds.length) errors.push(`未知的 --kinds：${unknownKinds.join('、')}（可选：${DEFAULT_KINDS.join('、')}）`)

  if (!toRaw) errors.push('缺少 --to（新根目录）')
  if (!toRaw || from === to) errors.push('新根不能和旧根相同')
  if (to && path.parse(to).root === to) errors.push(`新根不能是盘符根：${to}`)
  if (!exists(from)) errors.push(`旧根不存在：${from}`)
  if (to && (inside(from, to) || inside(to, from))) errors.push(`旧根与新根不能互相包含：${from} ↔ ${to}`)
  if (to && exists(to) && !isDir(to)) errors.push(`新根已存在但不是目录：${to}`)

  const specs = []
  const wanted = new Set(kinds)
  const add = (kind, fromDir, toDir, extra = {}) => {
    specs.push({ kind, from: path.resolve(fromDir), to: path.resolve(toDir), ...extra })
  }

  // 1) 旧根下的标准布局（新/旧 ICL_ROOT 都适用）。
  if (wanted.has('state')) add('state', path.join(from, 'state'), targetFor(to || from, 'state'))
  if (wanted.has('home')) add('home', path.join(from, 'home'), targetFor(to || from, 'home'))
  if (wanted.has('album')) add('album', path.join(from, 'album'), targetFor(to || from, 'album'))
  if (wanted.has('inbox')) add('inbox', path.join(from, 'inbox'), targetFor(to || from, 'inbox'))
  if (wanted.has('video-tmp')) add('video-tmp', path.join(from, 'video-tmp'), targetFor(to || from, 'video-tmp'))
  if (wanted.has('media')) {
    const mediaExclude = []
    // repo .state 时代的 QQ 入站目录在 media/inbox/qq：单独搬到新根 inbox/qq，避免搬两遍。
    if (wanted.has('inbox') && isDir(path.join(from, 'media', 'inbox', 'qq')) && !isDir(path.join(from, 'inbox'))) {
      mediaExclude.push('inbox')
      add('qq-inbox-legacy', path.join(from, 'media', 'inbox', 'qq'), targetFor(to || from, path.join('inbox', 'qq')))
    }
    add('media', path.join(from, 'media'), targetFor(to || from, 'media'), { exclude: mediaExclude })
  }

  // 2) 旧 dsh-icl stateDir（$DSH_HOME/icl/state）：拆成 state / album / inbox / stickers。
  for (const legacy of legacyStateDirs) {
    if (wanted.has('state')) add('legacy-state', legacy, targetFor(to || from, 'state'), { exclude: ['media'] })
    if (wanted.has('album')) add('legacy-album', path.join(legacy, 'media'), targetFor(to || from, 'album'), { exclude: ['inbox', 'stickers'], optional: true })
    if (wanted.has('inbox')) add('legacy-inbox', path.join(legacy, 'media', 'inbox'), targetFor(to || from, 'inbox'), { optional: true })
    if (wanted.has('media')) add('legacy-stickers', path.join(legacy, 'media', 'stickers'), targetFor(to || from, path.join('media', 'stickers')), { optional: true })
  }

  // 3) 逐项检查：存在性、目标冲突、大小。
  const targetOwner = new Map()
  for (const spec of specs) {
    const entry = {
      kind: spec.kind,
      from: spec.from,
      to: spec.to,
      exclude: spec.exclude ?? [],
      optional: spec.optional === true,
      status: 'ready',
      files: 0,
      bytes: 0,
      warnings: [],
    }
    if (!isDir(spec.from)) {
      entry.status = spec.optional ? 'absent-optional' : 'absent'
      if (!spec.optional) warnings.push(`${spec.kind}：源目录不存在，跳过（${spec.from}）`)
      entries.push(entry)
      continue
    }
    if (targetOwner.has(spec.to)) {
      entry.status = 'target-collision'
      errors.push(`两个来源指向同一目标：${spec.to}（${targetOwner.get(spec.to)} 与 ${spec.kind}）`)
      entries.push(entry)
      continue
    }
    targetOwner.set(spec.to, spec.kind)
    if (exists(spec.to)) {
      entry.status = 'target-exists'
      errors.push(`目标已存在，拒绝覆盖：${spec.to}（先移走或换新根）`)
      entries.push(entry)
      continue
    }
    try {
      const { files, warnings: walkWarnings } = walkTree(spec.from, { exclude: spec.exclude })
      entry.files = files.size
      entry.bytes = [...files.values()].reduce((sum, file) => sum + file.bytes, 0)
      entry.warnings.push(...walkWarnings)
    } catch (error) {
      entry.status = 'unreadable'
      errors.push(String(error?.message ?? error))
    }
    entries.push(entry)
  }

  const totals = entries.reduce((acc, entry) => ({
    files: acc.files + (entry.status === 'ready' ? entry.files : 0),
    bytes: acc.bytes + (entry.status === 'ready' ? entry.bytes : 0),
  }), { files: 0, bytes: 0 })

  // 权限预检（dry-run 也做，避免"跑完才发现没权限"）。
  const checks = { sourceReadable: true, targetWritable: null }
  for (const entry of entries) {
    if (entry.status !== 'ready') continue
    try { fs.accessSync(entry.from, fs.constants.R_OK) } catch {
      checks.sourceReadable = false
      errors.push(`源目录不可读：${entry.from}`)
    }
  }
  if (to && !errors.some((error) => error.startsWith('新根'))) {
    checks.targetWritable = probeWritable(to)
    if (checks.targetWritable.ok === false) errors.push(`新根不可写：${to}（${checks.targetWritable.error}）`)
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'tools/icl-move.mjs',
    from,
    to,
    kinds,
    legacyStateDirs,
    recordFile,
    checks,
    entries,
    totals,
    errors,
    warnings,
  }
}

/** 目标可写探测：目标已存在就写一个临时文件再删；还不存在则只检查最近祖先的写权限
 *  （dry-run 不创建新根目录）。apply 时真正的 mkdir 失败会走回滚。 */
export function probeWritable(dir) {
  if (!dir) return { ok: false, error: '没有目标目录' }
  if (isDir(dir)) {
    try {
      const probe = path.join(dir, `.icl-move-probe-${process.pid}-${Date.now()}`)
      fs.writeFileSync(probe, 'ok', 'utf8')
      fs.rmSync(probe, { force: true })
      return { ok: true, method: 'probe-file', checked: dir, error: null }
    } catch (error) {
      return { ok: false, method: 'probe-file', checked: dir, error: String(error?.message ?? error) }
    }
  }
  let ancestor = path.dirname(dir)
  while (ancestor !== path.dirname(ancestor) && !exists(ancestor)) ancestor = path.dirname(ancestor)
  try {
    fs.accessSync(ancestor, fs.constants.W_OK)
    return { ok: true, method: 'ancestor-access', checked: ancestor, error: null }
  } catch (error) {
    return { ok: false, method: 'ancestor-access', checked: ancestor, error: String(error?.message ?? error) }
  }
}

function writeRecord(file, record) {
  if (!file) return null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return file
  } catch {
    return null
  }
}

function recordOf(plan, { mode, status, startedAt, finishedAt, committed, sourcesDeleted, rollback, warnings, error }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: plan.tool,
    mode,
    status,
    startedAt,
    finishedAt,
    from: plan.from,
    to: plan.to,
    kinds: plan.kinds,
    legacyStateDirs: plan.legacyStateDirs,
    checks: plan.checks,
    entries: plan.entries.map((entry) => ({
      kind: entry.kind,
      from: entry.from,
      to: entry.to,
      exclude: entry.exclude,
      status: entry.status,
      files: entry.files,
      bytes: entry.bytes,
      warnings: entry.warnings,
    })),
    totals: plan.totals,
    committed: committed ?? [],
    sourcesDeleted: sourcesDeleted ?? [],
    rollback: rollback ?? { performed: false, removed: [] },
    warnings: warnings ?? [],
    error: error ? String(error?.message ?? error) : null,
    next: '把 ICL_ROOT 指向新根（env 或 preset config.iclRoot）后重启 ICL 会话；确认无误再删旧根备份。',
  }
}

/**
 * 执行迁移（copy → verify → commit → record → delete source）。
 * 任一步失败都回滚本次已写入的目标目录；源目录在最后一步之前保持完整。
 *
 * @param {object} plan  planMove() 的结果
 * @param {{keepSource?:boolean, recordFile?:string,
 *   hooks?:{afterCopy?:(entry:object, relative:string, full:string)=>void, afterCommit?:(entry:object)=>void}}} [options]
 */
export function applyMove(plan, { keepSource = false, recordFile = plan.recordFile, hooks = {} } = {}) {
  const startedAt = new Date().toISOString()
  const mode = 'apply'
  if (!plan || !Array.isArray(plan.entries)) {
    return { ok: false, record: null, error: '缺少迁移计划' }
  }
  if (plan.errors.length) {
    const record = recordOf(plan, { mode, status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: plan.errors.join('；') })
    return { ok: false, record: writeRecord(recordFile, record), plan, error: record.error }
  }

  const ready = plan.entries.filter((entry) => entry.status === 'ready')
  const stagings = []
  const committed = []
  const sourcesDeleted = []
  const warnings = []
  /** @type {{performed:boolean, removed:string[], failures:string[]}} */
  const rollback = { performed: false, removed: [], failures: [] }
  const stampId = stamp()

  const cleanup = (targets) => {
    rollback.performed = true
    for (const target of targets) {
      try { fs.rmSync(target, { recursive: true, force: true }); rollback.removed.push(target) } catch (error) {
        rollback.failures.push(`${target}: ${String(error?.message ?? error)}`)
      }
    }
  }

  try {
    for (const entry of ready) {
      const staging = path.join(plan.to, `.icl-move-staging-${entry.kind}-${process.pid}-${stampId}-${stagings.length}`)
      // 先登记再复制：复制中途抛错时 catch 才能把这个半成品 staging 清掉。
      const record = { entry, staging }
      stagings.push(record)
      fs.mkdirSync(plan.to, { recursive: true })
      copyTree(entry.from, staging, {
        exclude: entry.exclude,
        // 第三个参数是复制出来的完整路径：测试用它注入"复制后大小不对"，验证回滚。
        afterCopy: (relative, full) => { if (typeof hooks.afterCopy === 'function') hooks.afterCopy(entry, relative, full) },
      })
      // 逐文件核对大小 + 文件数：不信任 copyFile 的返回值。
      const { files: sourceFiles } = walkTree(entry.from, { exclude: entry.exclude })
      const { files: copiedFiles } = walkTree(staging)
      const problems = compareTrees(sourceFiles, copiedFiles)
      if (problems.length) throw new Error(`校验失败（${entry.kind}）：${problems.slice(0, 5).join('；')}`)
    }
    // 全部复制并核对通过后，才 commit（rename 同盘原子）。
    for (const { entry, staging } of stagings) {
      // 目标可能嵌套在别的目标目录里（media/stickers），父目录要先就位。
      fs.mkdirSync(path.dirname(entry.to), { recursive: true })
      fs.renameSync(staging, entry.to)
      committed.push(entry.to)
      if (typeof hooks.afterCommit === 'function') hooks.afterCommit(entry)
    }
    // 源目录最后才删；删失败只警告，新根数据已经完整。
    if (!keepSource) {
      const uniqueSources = [...new Set(ready.map((entry) => entry.from))]
        .sort((a, b) => b.length - a.length) // 先删深的，避免父目录先删导致子目录失败
      for (const source of uniqueSources) {
        try { fs.rmSync(source, { recursive: true, force: true }); sourcesDeleted.push(source) } catch (error) {
          warnings.push(`源目录删除失败（新根数据不受影响）：${source}：${String(error?.message ?? error)}`)
        }
      }
    }
    const record = recordOf(plan, {
      mode, status: 'ok', startedAt, finishedAt: new Date().toISOString(),
      committed, sourcesDeleted, rollback, warnings,
    })
    const file = writeRecord(recordFile, record)
    return { ok: true, record: file, plan, summary: record }
  } catch (error) {
    // 回滚：先删已提交的目标（它们本次之前不存在），再删 staging。
    cleanup(committed)
    cleanup(stagings.map(({ staging }) => staging))
    const record = recordOf(plan, {
      mode, status: 'failed', startedAt, finishedAt: new Date().toISOString(),
      committed: [], sourcesDeleted, rollback, warnings,
      error: String(error?.message ?? error),
    })
    const file = writeRecord(recordFile, record)
    return {
      ok: false,
      record: file,
      plan,
      error: String(error?.message ?? error),
      rollback,
    }
  }
}

/** dry-run 的人类可读摘要。 */
export function formatPlan(plan, { mode = 'dry-run' } = {}) {
  const lines = []
  const state = plan.errors.length ? '失败' : '通过'
  lines.push(`ICL 迁移 ${mode === 'dry-run' ? '预演' : '执行'}（校验${state}）`)
  lines.push(`  旧根：${plan.from}`)
  lines.push(`  新根：${plan.to}`)
  lines.push(`  记录：${plan.recordFile}`)
  for (const entry of plan.entries) {
    const size = entry.status === 'ready' ? `${entry.files} 个文件 / ${entry.bytes} B` : entry.status
    lines.push(`  - ${entry.kind}: ${entry.from} → ${entry.to}  [${size}]`)
    for (const warning of entry.warnings) lines.push(`      ! ${warning}`)
  }
  lines.push(`  合计：${plan.totals.files} 个文件 / ${plan.totals.bytes} B`)
  for (const warning of plan.warnings) lines.push(`  ! ${warning}`)
  for (const error of plan.errors) lines.push(`  ✗ ${error}`)
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = [...argv]
  const flag = (name) => args.includes(name)
  const value = (name, fallback = null) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback
  }
  const values = (name) => {
    const out = []
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== name || args[i + 1] == null) continue
      for (const item of String(args[i + 1]).split(',')) if (item.trim()) out.push(item.trim())
      args.splice(i, 2)
      i -= 1
    }
    return out
  }
  const legacyStateDirs = values('--legacy-state')
  const kindsRaw = value('--kinds', null)
  const parsed = {
    from: value('--from', null),
    to: value('--to', null),
    recordFile: value('--record', null),
    legacyStateDirs,
    kinds: kindsRaw ? String(kindsRaw).split(',').map((item) => item.trim()).filter(Boolean) : null,
    apply: flag('--apply'),
    dryRun: flag('--dry-run'),
    keepSource: flag('--keep-source'),
    json: flag('--json'),
    help: flag('--help') || flag('-h'),
  }
  if (parsed.apply && parsed.dryRun) parsed.error = '--apply 与 --dry-run 只能选一个'
  return parsed
}

/** CLI 入口；返回退出码（测试可直接 import 其余导出，不会触发）。 */
export function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    stdout([
      '用法：node tools/icl-move.mjs --to <新根> [--from <旧根>] [--legacy-state <旧stateDir>]...',
      '       [--kinds state,home,media,album,inbox,video-tmp] [--apply|--dry-run]',
      '       [--keep-source] [--record <file>] [--json]',
      '',
      '默认 dry-run（只预演，不写盘）；--apply 才真正复制并在最后删除源目录。',
      '详见 docs/PATHS.md。',
    ].join('\n'))
    return 0
  }
  if (options.error) { stderr(options.error); return 1 }

  let plan
  try {
    plan = planMove({
      from: options.from ?? iclPaths().root,
      to: options.to,
      kinds: options.kinds ?? undefined,
      legacyStateDirs: options.legacyStateDirs,
      recordFile: options.recordFile ?? undefined,
    })
  } catch (error) {
    stderr(`生成迁移计划失败：${String(error?.message ?? error)}`)
    return 1
  }

  if (!options.apply) {
    if (options.json) stdout(JSON.stringify({ ...plan, mode: 'dry-run' }, null, 2))
    else stdout(formatPlan(plan, { mode: 'dry-run' }))
    return plan.errors.length ? 1 : 0
  }

  const result = applyMove(plan, { keepSource: options.keepSource, recordFile: plan.recordFile })
  if (options.json) {
    stdout(JSON.stringify(result.summary ?? { ok: result.ok, error: result.error, rollback: result.rollback }, null, 2))
  } else if (result.ok) {
    stdout(`迁移完成：${plan.totals.files} 个文件 / ${plan.totals.bytes} B`)
    stdout(`记录：${result.record}`)
    stdout(`下一步：把 ICL_ROOT 指向 ${plan.to}（环境变量或 preset config.iclRoot），重启 ICL 会话；确认无误后再清理旧根备份。`)
  } else {
    stderr(`迁移失败：${result.error}`)
    if (result.rollback?.performed) stderr(`已回滚：${result.rollback.removed.length} 个目录${result.rollback.failures.length ? `；另有失败：${result.rollback.failures.join('；')}` : ''}`)
    if (result.record) stderr(`失败记录：${result.record}`)
  }
  return result.ok ? 0 : 1
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()
if (isMain) process.exitCode = main()
