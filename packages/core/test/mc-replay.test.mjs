// MC L1 回放器单测：两个真实示例 PASS + 断言失败/缺事件/terminal 不符/forbidden 命中等差异必须报错。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCheckpoint, replayCheckpoint, getPath, eventMatches } from '../../../tools/mc-replay.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const EXAMPLES = path.join(ROOT, 'docs', 'examples', 'mc-local3-examples')

function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replay-'))
  fs.cpSync(path.join(EXAMPLES, name), dir, { recursive: true })
  return dir
}
function editJson(file, edit) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  edit(data)
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

test('L1 回放：shelter-3x3 失败样本 PASS（terminal/verify/事件）', () => {
  const report = replayCheckpoint(path.join(EXAMPLES, 'shelter-3x3'))
  assert.equal(report.pass, true, report.errors.join(';'))
  assert.equal(report.taskAssertions.length, 1)
  assert.equal(report.taskAssertions[0].pass, true)
  assert.equal(report.eventAssertions.find((item) => item.type === 'shelter_place_fail').matched, 24)
})

test('L1 回放：collect-resource 成功样本 PASS（done/net=8）', () => {
  const report = replayCheckpoint(path.join(EXAMPLES, 'collect-resource'))
  assert.equal(report.pass, true, report.errors.join(';'))
  assert.equal(report.taskAssertions[0].pass, true)
})

test('L1 回放：terminal 不符 → FAIL 并给出差异', () => {
  const dir = copyFixture('shelter-3x3')
  editJson(path.join(dir, 'expected-events.json'), (expected) => { expected.taskAssertions[0].terminal = 'done' })
  const report = replayCheckpoint(dir)
  assert.equal(report.pass, false)
  assert.ok(report.errors.some((error) => /terminal 期望 done/.test(error)), report.errors.join(';'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('L1 回放：缺必须事件 / 缺 result 字段 → FAIL', () => {
  const dir = copyFixture('shelter-3x3')
  editJson(path.join(dir, 'expected-events.json'), (expected) => {
    expected.taskAssertions[0].events.push('home_set')
    expected.taskAssertions[0].result.require.push('home')
  })
  const report = replayCheckpoint(dir)
  assert.equal(report.pass, false)
  assert.ok(report.errors.some((error) => /任务事件缺 home_set/.test(error)))
  assert.ok(report.errors.some((error) => /result.require 缺字段 home/.test(error)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('L1 回放：eventAssertions min 不足 / forbidden 命中 → FAIL', () => {
  const dir = copyFixture('shelter-3x3')
  editJson(path.join(dir, 'expected-events.json'), (expected) => {
    expected.eventAssertions.push({ type: 'shelter_done', where: {}, min: 1 })
    expected.forbidden = [{ type: 'shelter_place_fail' }]
  })
  const report = replayCheckpoint(dir)
  assert.equal(report.pass, false)
  assert.ok(report.errors.some((error) => /事件 shelter_done/.test(error)), report.errors.join(';'))
  assert.ok(report.errors.some((error) => /forbidden shelter_place_fail/.test(error)), report.errors.join(';'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('L1 回放：缺文件 → 明确报错（不静默 PASS）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replay-bad-'))
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
  assert.throws(() => loadCheckpoint(dir), /checkpoint 缺文件/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('L1 回放：world.json 可选；缺省时仍可 PASS 并说明不依赖 world', () => {
  const report = replayCheckpoint(path.join(EXAMPLES, 'shelter-3x3'))
  assert.equal(report.pass, true)
  assert.ok(report.notes.some((note) => /未提供 world\.json/.test(note)))
})

test('路径/事件匹配语义：点分路径 + where 子集 + 不存在字段', () => {
  assert.deepEqual(getPath({ verify: { walls: { missing: 9 } } }, 'verify.walls.missing'), { found: true, value: 9 })
  assert.deepEqual(getPath({ verify: {} }, 'verify.walls.missing'), { found: false })
  const event = { type: 'shelter_place_fail', seq: 7, data: { stage: 'repair-walls', detail: { face: 'north' } } }
  assert.equal(eventMatches(event, 'shelter_place_fail', { stage: 'repair-walls' }), true)
  assert.equal(eventMatches(event, 'shelter_place_fail', { 'detail.face': 'north' }), true)
  assert.equal(eventMatches(event, 'shelter_place_fail', { stage: 'other' }), false)
  assert.equal(eventMatches(event, 'task_done', { stage: 'repair-walls' }), false)
})
