import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, pickResumeSession } from '../../dsh-icl/host.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('icl-host：只恢复最近一个 icl 顶层持久会话', () => {
  const headers = [
    { id: 'old', agentPreset: 'icl', createdAt: 1 },
    { id: 'sub', agentPreset: 'icl', createdAt: 9, origin: 'subagent' },
    { id: 'new', agentPreset: 'icl', createdAt: 5 },
    { id: 'other', agentPreset: 'standard', createdAt: 8 },
  ]
  assert.equal(pickResumeSession(headers).id, 'new')
  assert.equal(pickResumeSession(headers, { sessionId: 'old' }).id, 'old')
  assert.equal(pickResumeSession([], {}), null)
})

test('icl-host：没有 live agent 时自动 resume 并挂 preset', async () => {
  let resumed = null
  const ctx = {
    logger: () => ({}),
    inject: (_deps, callback) => {
      callback({
        agents: {
          get: () => undefined,
          resume: async (options) => {
            resumed = options
            return { dispose: () => {} }
          },
        },
        sessionPersistence: { list: async () => [{ id: 's1', agentPreset: 'icl', createdAt: 1 }] },
        agentPresets: { mount: async () => {} },
      })
    },
  }
  const dispose = apply(ctx, { autoResumeDelayMs: 0, autoResumeAttempts: 1, diag: false })
  await sleep(10)
  assert.equal(resumed?.resumeSessionId, 's1')
  assert.equal(typeof resumed?.setup, 'function')
  dispose()
})

test('icl-host：提供 iclHost.prompt，内部走 apiProxy.sessions.prompt', async () => {
  let provided = null
  let request = null
  const ctx = {
    logger: () => ({}),
    provide: (name, value) => { if (name === 'iclHost') provided = value },
    inject: (_deps, callback) => callback({ apiProxy: { sessions: { prompt: async (value) => { request = value; return { result: { ok: true } } } } } }),
  }
  const dispose = apply(ctx, { autoResume: false, diag: false })
  assert.ok(provided?.prompt)
  const out = await provided.prompt({ sessionId: 's1', text: 'hello' })
  assert.equal(out.ok, true)
  assert.equal(request?.payload?.sessionId, 's1')
  assert.equal(request?.payload?.content?.[0]?.text, 'hello')
  dispose()
})
