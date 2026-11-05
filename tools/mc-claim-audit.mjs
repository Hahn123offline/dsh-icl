// CLI：node tools/mc-claim-audit.mjs --run <loop run dir> [--body <events.jsonl>] [--out <faile>]
import fs from 'node:fs'
import path from 'node:path'
import { audit, renderAudit } from './mc-audit-lib.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const runDir = arg('--run')
if (!runDir) { console.error('用法：node tools/mc-claim-audit.mjs --run <loop run dir> [--body <events.jsonl>]'); process.exit(2) }
const readJsonl = (file) => {
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}
const events = readJsonl(path.join(runDir, 'events.jsonl'))
const bodyEvents = readJsonl(arg('--body', path.join(runDir, 'body-events.jsonl')))
const result = audit({ events, bodyEvents })
const text = renderAudit(result)
const out = path.resolve(String(arg('--out', path.join(runDir, 'claims.md'))))
fs.writeFileSync(out, text, 'utf8')
console.log(text)
console.log(`\n-> ${out}`)
