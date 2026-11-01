// 上下文契约：读历史、装配前贡献、注册压缩实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from '../src/index.mjs'

test('适配器提供历史，插件能读到', async () => {
  const host = createHost({ log: () => {} })
  host.services.context.provideHistory(async ({ limit }) => [
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第二句' },
  ].slice(0, limit))
  const history = await host.services.context.history({ limit: 2 })
  assert.equal(history.length, 2)
  assert.equal(history[0].text, '第一句')
})

test('装配前策略能看到历史并贡献上下文', async () => {
  const host = createHost({ log: () => {} })
  host.services.context.provideHistory(async () => [{ role: 'user', text: '我们要做记忆系统' }])
  host.services.context.onAssemble({
    name: 'summarise', order: 10,
    apply: ({ history }) => (history.some((m) => m.text.includes('记忆')) ? '早前聊过记忆系统的设计。' : null),
  })
  const text = await host.services.context.assemble({ message: '继续' })
  assert.match(text, /记忆系统/)
})

test('策略可以停用（disposer）', async () => {
  const host = createHost({ log: () => {} })
  host.services.context.provideHistory(async () => [])
  const off = host.services.context.onAssemble({ name: 'tmp', apply: () => '注入' })
  assert.equal(await host.services.context.assemble({}), '注入')
  off()
  assert.equal(await host.services.context.assemble({}), '')
})

test('压缩实现可注册、可调用；没注册时明确失败', async () => {
  const host = createHost({ log: () => {} })
  assert.deepEqual(await host.services.context.compact({ history: [] }), { ok: false, error: 'no-compactor' })
  let called = null
  host.services.context.onCompact({ id: 'old', compact: (input) => { called = input; return { ok: true, kept: 3 } } })
  const out = await host.services.context.compact({ history: [1, 2, 3, 4] })
  assert.deepEqual(out, { ok: true, kept: 3 })
  assert.equal(called.history.length, 4)
})

test('装配有总预算', async () => {
  const host = createHost({ log: () => {} })
  host.services.context.provideHistory(async () => [])
  host.services.context.onAssemble({ name: 'big', apply: () => 'x'.repeat(5000) })
  const text = await host.services.context.assemble({ maxChars: 100 })
  assert.ok(text.length <= 100)
})
