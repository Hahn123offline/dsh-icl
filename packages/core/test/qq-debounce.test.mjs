// 入站防抖：纯函数 + 注入 timer。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInboundDebouncer, mergeSignals, normalizeDebounceConfig } from '../../plugins/qq/src/debounce.mjs'

function signal(seq, text, extra = {}) {
  return {
    id: `s${seq}`,
    from: { plugin: 'qq', activity: 'qq:private:3429502459' },
    kind: 'content',
    text: `[QQ私聊·主人] ${text}`,
    tags: ['qq', 'private'],
    expiresAt: 1_000_000 + seq,
    meta: {
      qq: {
        envelope: { senderKind: 'owner', peerId: '3429502459', activity: 'qq:private:3429502459', at: 1000 + seq, messageId: String(seq) },
        ledger: { activity: 'qq:private:3429502459', seq },
      },
    },
    ...extra,
  }
}

test('mergeSignals：同一发送者连发合成一批，保留顺序/seq/图片', () => {
  const image = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg', name: 'a.jpg' }
  const batch = mergeSignals([signal(1, '在吗'), signal(2, '今天有空吗', { images: [image] }), signal(3, '想问你个事')])
  assert.equal(batch.meta.qq.batch.count, 3)
  assert.deepEqual(batch.meta.qq.batch.seqs, [1, 2, 3])
  assert.match(batch.text, /^\[QQ私聊·主人\]（连发 3 条）/)
  assert.match(batch.text, /· 在吗/)
  assert.match(batch.text, /· 今天有空吗/)
  assert.equal(batch.images.length, 1)
  assert.equal(batch.expiresAt, 1_000_003)
})

test('normalizeDebounceConfig：默认关，数值夹紧', () => {
  assert.equal(normalizeDebounceConfig().enabled, false)
  const cfg = normalizeDebounceConfig({ enabled: true, quietMs: 1, maxHoldMs: 999999, maxBatchMessages: 0 })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.quietMs, 1000)
  assert.equal(cfg.maxHoldMs, 300_000)
  assert.equal(cfg.maxBatchMessages, 1)
})

test('debouncer 关闭时同步直投，不攒批', () => {
  const out = []
  const d = createInboundDebouncer({ config: { enabled: false }, onFlush: (s) => out.push(s) })
  d.push(signal(1, '一'))
  d.push(signal(2, '二'))
  assert.equal(out.length, 2)
  d.dispose()
})

test('debouncer：quiet 到点后合成一批；新消息重置 quiet', () => {
  let timerId = 0
  const timers = new Map()
  const setTimer = (fn, ms) => { timerId += 1; const id = timerId; timers.set(id, { fn, ms }); return id }
  const clearTimer = (id) => timers.delete(id)
  const out = []
  const d = createInboundDebouncer({
    config: { enabled: true, quietMs: 8000, maxHoldMs: 20000, maxBatchMessages: 20 },
    onFlush: (s) => out.push(s), setTimer, clearTimer,
  })
  d.push(signal(1, '一'))
  d.push(signal(2, '二'))
  assert.equal(out.length, 0, '窗口内不投递')
  // 最后排的 quiet timer 是被第二条重置的那一个
  const quiet = [...timers.values()].filter((t) => t.ms === 8000).at(-1)
  quiet.fn()
  assert.equal(out.length, 1)
  assert.equal(out[0].meta.qq.batch.count, 2)
  d.dispose({ flushPending: false })
})

test('debouncer：超过 maxBatchMessages 立即 flush', () => {
  const out = []
  const d = createInboundDebouncer({
    config: { enabled: true, quietMs: 8000, maxHoldMs: 20000, maxBatchMessages: 2 },
    onFlush: (s) => out.push(s), setTimer: () => 0, clearTimer: () => {},
  })
  d.push(signal(1, '一'))
  assert.equal(out.length, 0)
  d.push(signal(2, '二'))
  assert.equal(out.length, 1)
  assert.equal(out[0].meta.qq.batch.count, 2)
  d.dispose({ flushPending: false })
})
