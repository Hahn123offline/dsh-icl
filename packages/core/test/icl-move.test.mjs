// 整体迁移契约：dry-run 不写盘；apply 复制→校验→提交→删源；失败回滚；记录可查。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_KINDS, applyMove, formatPlan, planMove, walkTree } from '../../../tools/icl-move.mjs'
import { iclPaths } from '../src/icl-paths.mjs'

const BASELINE_HOME = path.join(os.tmpdir(), 'icl-move-no-such-home')

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icl-move-${tag}-`))
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

/** 造一个标准的旧 ICL 根：state/home/media/album/inbox/video-tmp 都有内容。 */
function seedRoot(from) {
  write(path.join(from, 'state', 'time.json'), '{"phase":"awake"}')
  write(path.join(from, 'state', 'focus.json'), '{"focus":"mc"}')
  write(path.join(from, 'home', 'notes', 'a.md'), '# a')
  write(path.join(from, 'media', 'stickers', 's.png'), 'png-bytes')
  write(path.join(from, 'album', 'media.db'), 'sqlite-bytes')
  write(path.join(from, 'inbox', 'qq', '2026-11-06', 'm.jpg'), 'jpeg-bytes')
  write(path.join(from, 'video-tmp', 'work', 'f.png'), 'frame-bytes')
  return from
}

test('dry-run：列出每个目录的文件数/字节数，不创建新根、不改源目录', () => {
  const from = seedRoot(tmp('from-dry'))
  const parent = tmp('to-parent-dry')
  const to = path.join(parent, 'icl-root')
  const plan = planMove({ from, to, kinds: DEFAULT_KINDS })

  assert.deepEqual(plan.errors, [])
  assert.equal(plan.checks.targetWritable.ok, true)
  assert.equal(fs.existsSync(to), false, 'dry-run 不能创建新根')

  const ready = plan.entries.filter((entry) => entry.status === 'ready')
  assert.ok(ready.length >= 6, `应该覆盖 6 类目录，实际 ${ready.length}`)
  assert.equal(plan.totals.files, 7)
  assert.ok(plan.totals.bytes > 0)
  assert.ok(plan.totals.bytes >= fs.statSync(path.join(from, 'album', 'media.db')).size)

  const text = formatPlan(plan)
  assert.match(text, /预演/)
  assert.match(text, /合计/)
  // 源目录没有被 dry-run 碰过。
  assert.ok(fs.existsSync(path.join(from, 'state', 'time.json')))
})

test('apply：内容逐字节搬过去、源目录删除、迁移记录写在新根', () => {
  const from = seedRoot(tmp('from-apply'))
  const to = path.join(tmp('to-parent-apply'), 'icl-root')
  const plan = planMove({ from, to })
  const result = applyMove(plan)

  assert.equal(result.ok, true, result.error)
  assert.equal(fs.readFileSync(path.join(to, 'state', 'time.json'), 'utf8'), '{"phase":"awake"}')
  assert.equal(fs.readFileSync(path.join(to, 'album', 'media.db'), 'utf8'), 'sqlite-bytes')
  assert.equal(fs.readFileSync(path.join(to, 'inbox', 'qq', '2026-11-06', 'm.jpg'), 'utf8'), 'jpeg-bytes')
  assert.equal(fs.readFileSync(path.join(to, 'media', 'stickers', 's.png'), 'utf8'), 'png-bytes')
  assert.equal(fs.readFileSync(path.join(to, 'video-tmp', 'work', 'f.png'), 'utf8'), 'frame-bytes')
  assert.equal(fs.readFileSync(path.join(to, 'home', 'notes', 'a.md'), 'utf8'), '# a')

  // 源目录在确认复制后被删除；新根没有残留 staging。
  assert.equal(fs.existsSync(path.join(from, 'state')), false)
  assert.deepEqual(fs.readdirSync(to).filter((name) => name.startsWith('.icl-move-staging-')), [])

  const recordFile = path.join(to, 'icl-move.json')
  assert.ok(fs.existsSync(recordFile))
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  assert.equal(record.status, 'ok')
  assert.equal(record.mode, 'apply')
  assert.equal(record.from, path.resolve(from))
  assert.equal(record.to, path.resolve(to))
  assert.equal(record.totals.files, plan.totals.files)
  assert.ok(Array.isArray(record.sourcesDeleted) && record.sourcesDeleted.length > 0)

  // 迁移后的新根就是新的 ICL_ROOT：路径解析直接指向搬过去的数据。
  const resolved = iclPaths({ root: to, env: {}, dshHomeDir: BASELINE_HOME, legacy: false })
  assert.equal(resolved.stateDir, path.join(path.resolve(to), 'state'))
  assert.equal(resolved.albumDir, path.join(path.resolve(to), 'album'))
  assert.equal(resolved.qqInboxDir, path.join(path.resolve(to), 'inbox', 'qq'))
  assert.equal(resolved.videoTmpDir, path.join(path.resolve(to), 'video-tmp'))
})

test('旧 dsh-icl stateDir（$DSH_HOME/icl/state）折叠进新根：state/album/inbox/stickers 各就各位', () => {
  const legacy = path.join(tmp('legacy-home'), 'icl', 'state')
  write(path.join(legacy, 'memory.db'), 'memory')
  write(path.join(legacy, 'time.json'), '{"phase":"sleep"}')
  write(path.join(legacy, 'media', 'media.db'), 'album-db')
  write(path.join(legacy, 'media', 'inbox', 'qq', 'x.jpg'), 'jpg')
  write(path.join(legacy, 'media', 'stickers', 's.png'), 'sticker')

  const emptyFrom = tmp('empty-from') // 新布局的旧根可以是空的
  const to = path.join(tmp('to-parent-legacy'), 'icl-root')
  const plan = planMove({ from: emptyFrom, to, legacyStateDirs: [legacy], kinds: DEFAULT_KINDS })
  assert.deepEqual(plan.errors, [])

  const result = applyMove(plan, { keepSource: true })
  assert.equal(result.ok, true, result.error)
  assert.equal(fs.readFileSync(path.join(to, 'state', 'memory.db'), 'utf8'), 'memory')
  assert.equal(fs.readFileSync(path.join(to, 'state', 'time.json'), 'utf8'), '{"phase":"sleep"}')
  assert.equal(fs.existsSync(path.join(to, 'state', 'media')), false, 'media 不应重复拷进 state')
  assert.equal(fs.readFileSync(path.join(to, 'album', 'media.db'), 'utf8'), 'album-db')
  assert.equal(fs.readFileSync(path.join(to, 'inbox', 'qq', 'x.jpg'), 'utf8'), 'jpg')
  assert.equal(fs.readFileSync(path.join(to, 'media', 'stickers', 's.png'), 'utf8'), 'sticker')
  // --keep-source：旧目录原样保留，便于对账后再手工删。
  assert.equal(fs.existsSync(path.join(legacy, 'memory.db')), true)
})

test('回滚：复制后校验大小不符 → 删除本次已写入的目标/staging，源目录完整', () => {
  const from = seedRoot(tmp('from-rollback'))
  const to = path.join(tmp('to-parent-rollback'), 'icl-root')
  const plan = planMove({ from, to })
  const result = applyMove(plan, {
    hooks: {
      afterCopy: (entry, relative, full) => {
        // 只破坏一次，模拟"复制成功但字节数不对"。
        if (relative === 'time.json') fs.writeFileSync(full, 'truncated', 'utf8')
      },
    },
  })

  assert.equal(result.ok, false)
  assert.match(String(result.error), /校验失败/)
  assert.equal(fs.existsSync(path.join(to, 'state')), false, '失败后不能留下半截目标')
  assert.deepEqual(fs.readdirSync(to).filter((name) => name.startsWith('.icl-move-staging-')), [])
  assert.ok(fs.existsSync(path.join(from, 'state', 'time.json')), '源目录必须完整')
  assert.equal(fs.readFileSync(path.join(from, 'state', 'time.json'), 'utf8'), '{"phase":"awake"}')
  const record = JSON.parse(fs.readFileSync(path.join(to, 'icl-move.json'), 'utf8'))
  assert.equal(record.status, 'failed')
  assert.equal(record.rollback.performed, true)
})

test('回滚：提交阶段失败也会把已 rename 的目标删掉', () => {
  const from = seedRoot(tmp('from-commit-fail'))
  const to = path.join(tmp('to-parent-commit-fail'), 'icl-root')
  const plan = planMove({ from, to })
  const result = applyMove(plan, {
    hooks: {
      afterCommit: (entry) => {
        if (entry.kind === 'album') throw new Error('提交阶段注入失败')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /提交阶段注入失败/)
  assert.equal(fs.existsSync(path.join(to, 'album')), false)
  assert.equal(fs.existsSync(path.join(to, 'state')), false, '已提交的 state 也要回滚')
  assert.ok(fs.existsSync(path.join(from, 'state', 'time.json')))
  assert.ok(fs.existsSync(path.join(from, 'album', 'media.db')))
})

test('预检：目标已存在 / 新旧根互相包含 / 缺 --to 都拒绝，且不写盘', () => {
  const from = seedRoot(tmp('from-preflight'))
  const parent = tmp('to-parent-preflight')
  const to = path.join(parent, 'icl-root')
  fs.mkdirSync(path.join(to, 'state'), { recursive: true })
  write(path.join(to, 'state', 'keep.json'), 'keep')

  const exists = planMove({ from, to })
  assert.ok(exists.errors.some((error) => error.includes('目标已存在')))
  const blocked = applyMove(exists)
  assert.equal(blocked.ok, false)
  assert.equal(fs.readFileSync(path.join(to, 'state', 'keep.json'), 'utf8'), 'keep', '不能覆盖已有目标')
  assert.ok(fs.existsSync(path.join(from, 'state', 'time.json')))

  const overlap = planMove({ from, to: path.join(from, 'nested') })
  assert.ok(overlap.errors.some((error) => error.includes('互相包含')))

  const missing = planMove({ from, to: '' })
  assert.ok(missing.errors.some((error) => error.includes('缺少 --to')))
})

test('校验辅助：walkTree 不跟随符号链接，并把文件数/字节数算全', () => {
  const root = tmp('walk')
  write(path.join(root, 'a.txt'), '12345')
  write(path.join(root, 'sub', 'b.txt'), '67')
  const { files } = walkTree(root)
  assert.deepEqual([...files.keys()].sort(), ['a.txt', path.join('sub', 'b.txt')])
  assert.equal(files.get('a.txt').bytes, 5)
  assert.equal([...files.values()].reduce((sum, item) => sum + item.bytes, 0), 7)
})
