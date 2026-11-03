// wash 只做一件事：去掉结构化 JSON，留下自然语言。不抽取、不裁剪。
import test from 'node:test'
import assert from 'node:assert/strict'
import { stripStructured } from '../../plugins/dream/src/index.mjs'

test('纯自然语言原样留下', () => {
  assert.equal(stripStructured('周子涵：白饭！'), '周子涵：白饭！')
})

test('整条 JSON 直接丢掉', () => {
  assert.equal(stripStructured('{"keyword":"科普","count":2}'), '')
  assert.equal(stripStructured('[{"bvid":"BV1"}]'), '')
})

test('行内嵌的 JSON 被去掉，中文留下', () => {
  const input = '看了《深夜食堂》 {"bvid":"BV1","title":"深夜食堂"} 评论区很有意思'
  const out = stripStructured(input)
  assert.match(out, /深夜食堂/)
  assert.match(out, /评论区很有意思/)
  assert.doesNotMatch(out, /bvid/)
})

test('围栏里的 JSON 被去掉，围栏里的普通代码保留', () => {
  const jsonFence = stripStructured('结果：\n```json\n{"a":1}\n```\n完')
  assert.doesNotMatch(jsonFence, /"a"/)
  const codeFence = stripStructured('看看这段：\n```\nGet-ChildItem\n```\n就行')
  assert.match(codeFence, /Get-ChildItem/)
})
