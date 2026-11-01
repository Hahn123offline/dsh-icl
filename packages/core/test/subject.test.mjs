// 人物身份是通用的：qq / mc / discord / 自定义都能查。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as whois from '../../plugins/whois/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import whoisManifest from '../../plugins/whois/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-subj-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(whoisManifest, whois, {})
  await host.enable('memory')
  await host.enable('whois')
  host.shared.get('memory').registerNamespace({ id: 'person', label: '人物', recallable: true })
  const mem = host.shared.get('memory')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { mem, tools }
}

test('按通用 subject 查人：mc 账号也能命中', async () => {
  const { mem, tools } = await setup()
  mem.put({
    namespace: 'person', kind: 'block', key: 'person:steve',
    text: 'Steve，一起玩 MC 的人。',
    data: { subject: { kind: 'mc', value: 'Steve' }, ids: [{ kind: 'mc', value: 'Steve' }], profile: 'Steve，一起玩 MC 的人。' },
  })
  const out = await tools.whois.execute({ subjectKind: 'mc', value: 'Steve' })
  assert.match(out.text, /一起玩 MC/)
})

test('旧档案（只有 qq 字段）仍然能查', async () => {
  const { mem, tools } = await setup()
  mem.put({
    namespace: 'person', kind: 'block', key: 'person:42',
    text: '老周，同事。', data: { qq: '42', ids: [{ kind: 'qq', value: '42' }], profile: '老周，同事。' },
  })
  const out = await tools.whois.execute({ qq: '42' })
  assert.match(out.text, /老周/)
})

test('findPerson 同时接受 subject 与旧的 qq', async () => {
  const { mem } = await setup()
  mem.put({ namespace: 'person', kind: 'block', key: 'person:d', text: 'Discord 上认识的人。', data: { subject: { kind: 'discord', value: 'x#1' } } })
  assert.equal(mem.findPerson({ subject: { kind: 'discord', value: 'x#1' } }).people.length, 1)
})
