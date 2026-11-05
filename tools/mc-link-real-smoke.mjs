// Real body + real mc-link plugin (no DSH): verify the 11 tool contract end-to-end.
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHost, createSessionAdapter } from '../packages/core/src/index.mjs'
import * as mcLink from '../packages/plugins/mc-link/src/index.mjs'
import manifest from '../packages/plugins/mc-link/manifest.json' with { type: 'json' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const base = 'http://127.0.0.1:54838'
const child = spawn(process.execPath, [
  path.join('C:/DSH/icl/packages/mc-body/src/cli.mjs'),
  '--host', '127.0.0.1', '--port', '54837', '--listen', '54838',
  '--name', 'ICL-LinkSmoke', '--allow-task',
  '--state', path.join('C:/DSH/icl/.state/mc-link-smoke', 'tasks.json'),
  '--log', path.join('C:/DSH/icl/.state/mc-link-smoke', 'body.jsonl'),
], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function waitBody() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${base}/v1/status`); const j = await r.json(); if (j.adapter?.connected) return j } catch { /* wait */ }
    await sleep(500)
  }
  throw new Error('body not connected')
}

try {
  const status = await waitBody()
  console.log('body:', status.adapter.self, status.adapter.position, status.adapter.health)
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, mcLink, { config: { baseUrl: base, pollMs: 60_000, logFile: path.join('C:/DSH/icl/.state/mc-link-smoke', 'link.jsonl') } })
  await host.enable('mc-link')
  const adapter = createSessionAdapter({ sessionId: 'mc-link-smoke', host, push: async () => {} })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  for (const name of ['mcb_status', 'mcb_look', 'mcb_inventory', 'mcb_map']) {
    const out = await tools[name].execute({})
    console.log(`${name}:`, String(out.text).split('\n')[0])
  }
  const scan = await tools.mcb_scan.execute({ name: 'dirt', radius: 8, count: 3 })
  console.log('mcb_scan:', String(scan.text).split('\n')[0])
  const task = await tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { block: 'dirt', count: 2, radius: 6 }, deadlineMs: 20_000 }] })
  console.log('mcb_task:', task.text)
  await sleep(5000)
  console.log('mcb_tasks:', String((await tools.mcb_do.execute({ steps: [{ op: 'tasks' }] })).text).split('\n')[0])
  console.log('mcb_help:', String((await tools.mcb_help.execute({ skill: 'trade' })).text).split('\n')[0])
  await adapter.drainOnce()
  host.disable('mc-link')
  adapter.dispose()
  process.exit(0)
} catch (error) {
  console.error('SMOKE FAIL', error?.stack ?? error)
  process.exit(1)
} finally {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(500)
  try { child.kill('SIGKILL') } catch { /* ignore */ }
}
