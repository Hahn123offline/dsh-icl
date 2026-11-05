import test from 'node:test'
import assert from 'node:assert/strict'
import { audit, renderAudit } from '../../../tools/mc-audit-lib.mjs'

test('mc-claim-audit：有 task 证据的声明 verified，无证据的标 ?', () => {
  const events = [
    { payload: { event: { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '任务 t-1 完成了。' }] } } } } },
    { payload: { event: { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '我挖到了钻石。' }] } } } } },
  ]
  const bodyEvents = [{ type: 'task_done', data: { task: { id: 't-1' } } }]
  const result = audit({ events, bodyEvents })
  assert.equal(result.verified, 1)
  assert.equal(result.unverified, 1)
  assert.match(renderAudit(result), /body:task_done/)
})
