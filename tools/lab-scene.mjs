// lab 场景执行器：把一份场景 JSON 跑在正在运行的 lab 会话上，产出 verdict.md / verdict.json。
//
//   node tools/lab.mjs scene tools/scenarios/mc-A.json
//   node tools/lab.mjs scene tools/scenarios/mc-A.json --run <runId> --no-interview
//
// 判据口径见 docs/MC-ACCEPTANCE.md：机器断言 = 链路证据（events.jsonl 的 seq / 工具调用 / 进程存活）；
// 最后三问是**当事人自述**，原文记入 verdict，但不算链路证据。
//
// 场景 JSON：
//   { id, name, description, steps: [...], interview: [...] }
// step 的 op：
//   prompt   { text, timeoutSec=300, id }            发话并等 turn/end
//   wait     { seconds }
//   assert   { id, required=true, toolAny/toolAll/toolOrder/toolResultContains/
//              assistantContains/bodyAlive/noToolError/mcStatusDisconnected }
//   kill-body{ id }                                   杀掉 lab dsh 派生的 mc-body 子进程（C 场景）
//   snapshot { id }                                   落一份状态快照到 runDir/steps/<id>.json
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  apiFor, countTurnEnds, isPidAlive, killPidTree, lastTurnWindow, nowIso,
  orderedEvents, promptSession, readJson, readJsonl, rebuildTranscript, sleep, textOfMessage,
} from './lab-lib.mjs'

/* ── 进程表（找 lab 派生的 mc-body）────────────────────── */

async function processTable() {
  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      const child = spawn('ps', ['-eo', 'pid=,ppid=,args='], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('close', () => {
        const rows = []
        for (const line of out.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
          if (match) rows.push({ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), CommandLine: match[3] })
        }
        resolve(rows)
      })
      child.on('error', () => resolve([]))
    })
  }
  return new Promise((resolve) => {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]')
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch { resolve([]) }
    })
    child.on('error', () => resolve([]))
  })
}

function descendantsOf(table, rootPid) {
  const children = new Map()
  for (const row of table) {
    const parent = Number(row.ParentProcessId)
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(row)
  }
  const out = []
  const queue = [Number(rootPid)]
  const seen = new Set()
  while (queue.length) {
    const pid = queue.shift()
    for (const row of children.get(pid) ?? []) {
      const id = Number(row.ProcessId)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(row)
      queue.push(id)
    }
  }
  return out
}

/** lab dsh 进程树里属于 mc-body 的子进程。 */
export async function bodyProcesses(metaOrPid) {
  // 首选 mc-link 自己的 lifecycle 台账（state/<preset>/mc-link.jsonl 的 body-spawn/body-exit）：
  // 不依赖再 spawn PowerShell，也不会因为一次 WMI 查询抖动就把"body 明明活着"判成没有。
  if (metaOrPid && typeof metaOrPid === 'object') {
    const fromLedger = bodyPidsFromLedger(metaOrPid)
    if (fromLedger.length) return fromLedger.map((pid) => ({ ProcessId: pid, ParentProcessId: null, CommandLine: '(mc-link.jsonl body-spawn)' }))
    const dshPid = metaOrPid.pids?.dsh
    if (!dshPid) return []
    return processDescendantsBody(dshPid)
  }
  return processDescendantsBody(metaOrPid)
}

/** 从 mc-link.jsonl 读当前活着的 body pid（最后一次 lifecycle 是 body-spawn 且进程还在）。 */
function bodyPidsFromLedger(meta) {
  const file = path.join(meta.runDir ?? '', 'state', String(meta.preset ?? ''), 'mc-link.jsonl')
  const rows = readJsonl(file)
  const last = new Map()
  for (const row of rows) {
    if (row?.type !== 'body-spawn' && row?.type !== 'body-exit') continue
    const pid = Number(row.pid)
    if (!Number.isFinite(pid) || pid <= 0) continue
    last.set(pid, row.type === 'body-spawn')
  }
  const alive = []
  for (const [pid, spawned] of last) if (spawned && isPidAlive(pid)) alive.push(pid)
  return alive
}

async function processDescendantsBody(dshPid) {
  const table = await processTable()
  return descendantsOf(table, dshPid).filter((row) => /mc-body|mc_body|mcbody|cli\.mjs/i.test(String(row.CommandLine ?? '')))
}

/* ── 场景执行 ─────────────────────────────────────────── */

function eventWindow(eventsFile, startSeq) {
  return orderedEvents(eventsFile).filter((event) => Number(event.seq) > startSeq)
}

function collectTools(window) {
  const results = window.filter((event) => event.type === 'tool/result')
  return window.filter((event) => event.type === 'tool/call').map((call) => {
    const callId = String(call.data?.callId ?? '')
    const result = results.find((row) => {
      const id = String(row.data?.toolCallId ?? row.data?.message?.toolCallId ?? '')
      if (id && callId) return id === callId
      const seqs = row.data?.sourceEventSeqs
      return Array.isArray(seqs) && seqs.includes(call.seq)
    }) ?? null
    return {
      seq: call.seq,
      name: String(call.data?.name ?? ''),
      args: typeof call.data?.arguments === 'string' ? call.data.arguments : JSON.stringify(call.data?.arguments ?? {}),
      resultSeq: result?.seq ?? null,
      text: result ? textOfMessage(result.data?.message ?? result.data) : '',
      isError: Boolean(result?.data?.message?.isError ?? result?.data?.isError),
      ms: result && Number(result.time) && Number(call.time) ? Number(result.time) - Number(call.time) : null,
    }
  })
}

function assistantTextOf(window) {
  let text = ''
  for (const event of window) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) if (block?.type === 'text') text += block.text ?? ''
  }
  return text
}

/** 发一句话并等 turn/end；超时就 session/cancel（不再让场景被一个无界回合挂死），然后抛可读错误。 */
export async function promptAndWait(api, meta, text, timeoutSec = 300) {
  const eventsFile = path.join(meta.runDir, 'events.jsonl')
  const baseline = countTurnEnds(eventsFile)
  await promptSession(api, meta.sessionId, text)
  const timeoutMs = timeoutSec * 1000
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (countTurnEnds(eventsFile) > baseline) break
    if (!isPidAlive(meta.pids?.dsh)) throw new Error('等待 turn/end 期间 dsh 进程退出')
    await sleep(300)
  }
  if (countTurnEnds(eventsFile) > baseline) return lastTurnWindow(eventsFile)
  // 超时：取消当前回合，给 DSH 10s 收尾；记录证据后抛错（场景继续跑断言/三问）。
  let cancelled = null
  try {
    const out = await api.callUnary('session/cancel', { sessionId: meta.sessionId }, undefined, 'long')
    cancelled = out?.result?.ok ? 'ok' : JSON.stringify(out?.result?.error ?? out?.result)
  } catch (error) { cancelled = `cancel-failed: ${String(error?.message ?? error)}` }
  const cancelDeadline = Date.now() + 10_000
  while (Date.now() < cancelDeadline && countTurnEnds(eventsFile) <= baseline) await sleep(300)
  const turns = countTurnEnds(eventsFile) - baseline
  throw new Error(`prompt 超时（${timeoutSec}s）：${text.slice(0, 40)}；session/cancel=${cancelled}；取消后新增 turn/end=${turns}`)
}

function fingerprint(msg) {
  return `命中 seq=${msg.seq}`
}

/** 事件里的"插件来源消息"：source.kind 不是 user、也不是 runtime-context（即 MC/时间/焦点通知）。 */
function pluginNotices(window) {
  return window
    .filter((event) => event.type === 'user/message')
    .map((event) => {
      const kind = String(event.data?.source?.kind ?? 'user')
      return { seq: event.seq, kind, text: textOfMessage(event.data), at: event.time }
    })
    .filter((row) => row.kind !== 'user' && row.kind !== 'runtime-context')
}

/**
 * 信号自主唤醒的 turn：这一轮里没有人类用户消息、但有插件通知。
 * mc-link 的 crash signal 会自己叫醒会话，她的 mcb_status/mcb_join 发生在 prompt 之外——
 * 断言窗口必须把它算进去（2026-11-05 mc-link 在 C 里遇到的误判）。
 */
function autonomousTurnSeqs(window) {
  const turns = []
  let current = null
  for (const event of window) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, startSeq: event.seq, endSeq: null, human: false, notice: null }
      turns.push(current)
      continue
    }
    if (!current) continue
    if (event.type === 'user/message') {
      const kind = String(event.data?.source?.kind ?? 'user')
      if (kind === 'user') current.human = true
      else if (kind !== 'runtime-context') current.notice = textOfMessage(event.data).slice(0, 120)
    }
    if (event.type === 'turn/end') current.endSeq = event.seq
  }
  return turns.filter((turn) => !turn.human && turn.notice)
}

function evaluateAssertion(predicate, window, state) {
  const tools = collectTools(window)
  const names = tools.map((row) => row.name)
  const checks = []
  const add = (kind, ok, detail) => checks.push({ kind, ok, detail })

  if (predicate.toolAny) {
    const hit = tools.find((row) => predicate.toolAny.includes(row.name))
    add('toolAny', Boolean(hit), hit ? `${hit.name} @${hit.seq}` : `未调用任何：${predicate.toolAny.join('/')}`)
  }
  if (predicate.toolAll) {
    for (const name of predicate.toolAll) {
      const hit = tools.find((row) => row.name === name)
      add(`toolAll:${name}`, Boolean(hit), hit ? `seq=${hit.seq}` : '未调用')
    }
  }
  if (predicate.toolOrder) {
    let cursor = -1
    const hits = []
    let ok = true
    for (const name of predicate.toolOrder) {
      const index = names.findIndex((value, i) => i > cursor && value === name)
      if (index < 0) { ok = false; hits.push(`${name}?`); break }
      cursor = index
      hits.push(`${name}@${tools[index].seq}`)
    }
    add('toolOrder', ok, hits.join(' → '))
  }
  if (predicate.toolResultContains) {
    const { names: toolNames = [], any = [] } = predicate.toolResultContains
    const rows = tools.filter((row) => !toolNames.length || toolNames.includes(row.name))
    const hit = rows.find((row) => any.some((needle) => row.text.includes(needle)))
    add('toolResultContains', Boolean(hit), hit ? `${hit.name} @${hit.resultSeq} 含「${any.find((n) => hit.text.includes(n))}」` : `无匹配（看 ${rows.map((r) => r.name).join(',') || '无工具'}）`)
  }
  if (predicate.assistantContains) {
    const text = assistantTextOf(window)
    const needles = Array.isArray(predicate.assistantContains) ? predicate.assistantContains : [predicate.assistantContains]
    const needle = needles.find((item) => text.includes(item))
    add('assistantContains', Boolean(needle), needle ? `含「${needle}」` : `助手文本 ${text.length} 字，未含 ${needles.join('/')}`)
  }
  if (predicate.noToolError) {
    const failed = tools.filter((row) => row.isError)
    add('noToolError', failed.length === 0, failed.length ? failed.map((row) => `${row.name}@${row.resultSeq}`).join(',') : '无工具错误')
  }
  if (predicate.noticeContains) {
    const needles = Array.isArray(predicate.noticeContains) ? predicate.noticeContains : [predicate.noticeContains]
    const notices = pluginNotices(window)
    const hit = notices.find((row) => needles.some((needle) => row.text.includes(needle)))
    add('noticeContains', Boolean(hit), hit ? `通知 @${hit.seq}（${hit.kind}）含「${needles.find((n) => hit.text.includes(n))}」` : `无匹配通知（看到 ${notices.length} 条：${notices.map((row) => row.kind).join(',') || '无'}）`)
  }
  if (predicate.autonomousTurn) {
    const turns = autonomousTurnSeqs(window)
    add('autonomousTurn', turns.length > 0, turns.length ? `${turns.length} 个自主 turn（seq ${turns.map((turn) => turn.startSeq).join(',')}）` : '没有信号自主唤醒的 turn')
  }
  if (predicate.bodyAlive != null) {
    add('bodyAlive', Boolean(state.bodyAlive) === predicate.bodyAlive, `body 进程 ${state.bodyCount} 个（pid ${state.bodyPids.join(',') || '无'}）`)
  }
  if (state.extraChecks?.length) checks.push(...state.extraChecks)
  return checks
}

/**
 * 跑一个场景。
 * @returns {Promise<{ok:boolean, verdictFile:string, checks:object[]}>}
 */
export async function runScene({ run, sceneFile, interview = true, vars: inputVars = {} }) {
  const meta = { ...run.meta, runDir: run.runDir }
  if (!meta.sessionId) throw new Error('run 没有 sessionId；先 `lab up`')
  const scene = readJson(sceneFile, null)
  if (!scene) throw new Error(`读不到场景文件：${sceneFile}`)
  // 场景变量：同一份 A/C/E 既能跑 flat 超平坦，也能跑 survival/normal 地形。
  // 优先级：defaults < 命令行 --server/--username/--block。
  const vars = { server: 'flat', username: 'ICL-mclab-1', block: 'dirt', ...(scene.defaults ?? {}), ...inputVars }
  const subst = (text) => String(text ?? '').replace(/\{\{(\w+)\}\}/g, (match, key) => (vars[key] == null ? match : String(vars[key])))
  const eventsFile = path.join(run.runDir, 'events.jsonl')
  const api = apiFor(meta.port)
  const startedAt = nowIso()
  const started = Date.now()
  const before = orderedEvents(eventsFile)
  const startSeq = Number(before.at(-1)?.seq) || 0
  const checks = []
  const steps = []
  let bodyState = { bodyCount: 0, bodyPids: [], bodyAlive: false }
  // 断言窗口：从"上一次断言之后"到"这次断言"，把两次断言之间所有 turn（含 crash signal 自主唤醒的 turn）都算进来。
  let assertBoundarySeq = startSeq
  const lastSeqNow = () => Number(orderedEvents(eventsFile).at(-1)?.seq) || 0

  async function refreshBody() {
    const procs = await bodyProcesses(meta)
    bodyState = { bodyCount: procs.length, bodyPids: procs.map((row) => Number(row.ProcessId)), bodyAlive: procs.length > 0 }
    return bodyState
  }

  // 场景前置：清掉上一场/探测留下的 body，保证 A/C/E 每次从"未连接"开始，可连跑 3 次。
  // 杀一遍不够：mc-link 会把"意外退出"自动重启，所以最多清 3 轮直到没有活 body。
  const preCleanup = { killedPids: [] }
  for (let round = 0; round < 3; round += 1) {
    await refreshBody()
    if (!bodyState.bodyCount) break
    for (const pid of bodyState.bodyPids) {
      await killPidTree(pid)
      preCleanup.killedPids.push(pid)
    }
    preCleanup.forced = true
    await sleep(1500)
  }
  await refreshBody()
  if (preCleanup.forced) console.log(`[scene] 前置清理：杀掉残留 body ${preCleanup.killedPids.join(',')}，剩余 ${bodyState.bodyCount}`)

  const say = async (text, timeoutSec = 300) => promptAndWait(api, meta, subst(text), timeoutSec)

  for (const step of scene.steps ?? []) {
    const id = step.id ?? step.op
    const began = Date.now()
    try {
      if (step.op === 'prompt') {
        const window = await say(step.text, Number(step.timeoutSec ?? 300))
        steps.push({ id, op: 'prompt', ok: true, ms: Date.now() - began, text: subst(step.text), turn: window?.turn ?? null, turnStartSeq: window?.seqs?.[0] ?? null, turnEndSeq: window?.seqs?.[1] ?? null, tools: window?.tools ?? [], assistant: window?.assistant ?? '' })
        console.log(`[scene] ${id} → turn ${window?.turn}，工具 [${(window?.tools ?? []).join(',')}]`)
      } else if (step.op === 'wait') {
        await sleep(Number(step.seconds ?? 1) * 1000)
        steps.push({ id, op: 'wait', ok: true, ms: Date.now() - began })
      } else if (step.op === 'kill-body') {
        await refreshBody()
        const target = bodyState.bodyPids[0]
        if (!target) throw new Error('没有找到 mc-body 子进程（body 没起来或不是 lab 派生的）')
        await killPidTree(target)
        await sleep(1200)
        await refreshBody()
        steps.push({ id, op: 'kill-body', ok: true, ms: Date.now() - began, killedPid: target, bodyAfter: bodyState })
        console.log(`[scene] ${id} → 已 kill body pid=${target}，剩余 body=${bodyState.bodyCount}`)
      } else if (step.op === 'snapshot') {
        await refreshBody()
        const snapshot = {
          at: nowIso(),
          body: bodyState,
          state: stateSnapshot(meta),
          step: id,
        }
        const file = path.join(run.runDir, 'steps', `${id}.json`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8')
        steps.push({ id, op: 'snapshot', ok: true, ms: Date.now() - began, file })
      } else if (step.op === 'assert') {
        await refreshBody()
        const windowForStep = eventWindow(eventsFile, assertBoundarySeq)
        const results = evaluateAssertion(step, windowForStep, bodyState)
        const required = step.required !== false
        const ok = results.every((row) => row.ok)
        for (const row of results) checks.push({ id, required, ok: row.ok, kind: row.kind, detail: row.detail })
        steps.push({ id, op: 'assert', ok: ok || !required, ms: Date.now() - began, required, windowStartSeq: assertBoundarySeq, windowEndSeq: lastSeqNow(), checks: results })
        console.log(`[scene] ${id} ${ok ? '✓' : required ? '✗' : '⚠'} ${results.map((row) => `${row.kind}:${row.ok ? 'ok' : 'fail'}`).join(' ')}`)
        // 断言窗口是滚动前进的：下一次 assert 从此刻开始，避免把更早的调用重复算进来。
        assertBoundarySeq = lastSeqNow()
      } else {
        throw new Error(`未知 op：${step.op}`)
      }
    } catch (error) {
      const required = step.required !== false
      steps.push({ id, op: step.op, ok: false, required, ms: Date.now() - began, error: String(error?.message ?? error) })
      checks.push({ id, required, ok: false, kind: 'step', detail: String(error?.message ?? error) })
      console.error(`[scene] ${id} 失败：${String(error?.message ?? error)}`)
      if (required) break
    }
  }

  // 三问：当事人自述，原文记录，不算链路证据
  const answers = []
  if (interview && Array.isArray(scene.interview) && scene.interview.length) {
    for (const question of scene.interview) {
      try {
        const window = await say(question, 240)
        answers.push({ question, answer: window?.assistant ?? '', turn: window?.turn ?? null })
        console.log(`[scene] 三问：${question}\n${(window?.assistant ?? '').trim().slice(0, 200)}`)
      } catch (error) {
        answers.push({ question, answer: '', error: String(error?.message ?? error) })
      }
    }
  }

  await refreshBody()
  // 收尾：场景默认自己退出 MC（可 `"cleanup": false` 关掉）；如果还有残留 body，lab 强制杀掉并记账，
  // 保证 A/C/E 可以连跑 3 次而不留身体进程。
  const cleanup = { ran: false, reply: '', leftoverKilled: [] }
  if (scene.cleanup !== false) {
    const cleanupText = typeof scene.cleanup === 'string'
      ? subst(scene.cleanup)
      : '这局先到这里：如果身体还连着，用 mcb_leave 退出 MC，然后一句话说明你现在在哪、身体是不是已经退出。'
    try {
      const window = await say(cleanupText, 180)
      cleanup.ran = true
      cleanup.text = cleanupText
      cleanup.reply = window?.assistant ?? ''
      cleanup.turn = window?.turn ?? null
      console.log(`[scene] 收尾 → turn ${cleanup.turn}`)
    } catch (error) {
      cleanup.error = String(error?.message ?? error)
      console.error(`[scene] 收尾 prompt 失败：${cleanup.error}`)
    }
  }
  await refreshBody()
  if (bodyState.bodyCount) {
    for (const pid of bodyState.bodyPids) {
      await killPidTree(pid)
      cleanup.leftoverKilled.push(pid)
    }
    await sleep(800)
    await refreshBody()
    cleanup.forced = cleanup.leftoverKilled.length > 0
  }
  cleanup.bodyAfter = bodyState

  const failedRequired = checks.filter((row) => row.required && !row.ok)
  const ok = failedRequired.length === 0 && steps.every((step) => step.ok || step.required === false) && steps.some((step) => step.op === 'prompt')
  try { rebuildTranscript(run.runDir) } catch { /* ignore */ }

  const verdict = {
    scene: scene.id ?? path.basename(sceneFile),
    name: scene.name ?? '',
    runId: run.runId,
    preset: meta.preset,
    model: meta.model,
    sessionId: meta.sessionId,
    startedAt,
    endedAt: nowIso(),
    durationMs: Date.now() - started,
    startSeq,
    endSeq: Number(orderedEvents(eventsFile).at(-1)?.seq) || startSeq,
    ok,
    checks,
    steps,
    vars,
    preCleanup,
    body: bodyState,
    cleanup,
    interview: answers,
  }
  const verdictDir = path.join(run.runDir, 'scenes', String(verdict.scene))
  fs.mkdirSync(verdictDir, { recursive: true })
  const verdictFile = path.join(verdictDir, 'verdict.md')
  fs.writeFileSync(verdictFile, `${renderVerdict(verdict, meta)}`, 'utf8')
  fs.writeFileSync(path.join(verdictDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(verdictDir, 'interview.md'), `${answers.map((row) => `## 问：${row.question}\n\n${row.answer || '(没有回答)'}\n`).join('\n')}`, 'utf8')
  console.log(`[scene] ${ok ? 'PASS' : 'FAIL'} 场景 ${verdict.scene} · ${checks.filter((row) => row.ok).length}/${checks.length} 断言 · ${verdictFile}`)
  return { ok, verdictFile, checks, verdict }
}

function stateSnapshot(meta) {
  const stateDir = path.join(meta.runDir, 'state', meta.preset)
  const out = {}
  for (const name of ['time.json', 'focus.json']) {
    try { out[name] = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')) } catch { out[name] = null }
  }
  const mc = readJsonl(path.join(stateDir, 'mc-link.jsonl'), { limit: 20 })
  out['mc-link.jsonl'] = mc
  out['body.jsonl'] = readJsonl(path.join(meta.runDir, 'state', 'mc-body', 'body.jsonl'), { limit: 20 })
  out['bodyTasks'] = readJson(path.join(meta.runDir, 'state', 'mc-body', 'tasks.json'), null)
  return out
}

function renderVerdict(verdict, meta) {
  const lines = []
  const push = (line = '') => lines.push(line)
  push(`# Lab 场景 ${verdict.scene}·${verdict.name} — ${verdict.ok ? 'PASS' : 'FAIL'}`)
  push()
  push(`- run：\`${verdict.runId}\` · preset：\`${verdict.preset}\` · 模型：${verdict.model?.provider ?? '?'} / ${verdict.model?.model ?? '?'}`)
  push(`- session：\`${verdict.sessionId}\` · 端口：${meta.port}`)
  if (verdict.vars) push(`- 场景变量：server=${verdict.vars.server} · username=${verdict.vars.username} · block=${verdict.vars.block}`)
  push(`- 时间：${verdict.startedAt} → ${verdict.endedAt}（${(verdict.durationMs / 1000).toFixed(1)}s） · seq ${verdict.startSeq} → ${verdict.endSeq}`)
  if (verdict.preCleanup?.killedPids?.length) push(`- 前置清理：杀掉上一场残留 body pid ${verdict.preCleanup.killedPids.join(',')}（保证本场从"未连接"开始）`)
  push(`- 判据：docs/MC-ACCEPTANCE.md（机器断言=链路证据；三问=当事人自述，不算链路证据）`)
  push()
  push('## 断言')
  push()
  push('| # | 检查 | 必需 | 结果 | 证据 |')
  push('|---|---|---|---|---|')
  verdict.checks.forEach((row, index) => {
    push(`| ${index + 1} | ${row.id} / ${row.kind} | ${row.required ? '是' : '否'} | ${row.ok ? '✓' : '✗'} | ${String(row.detail).replace(/\|/g, '\\|')} |`)
  })
  push()
  push('## 步骤')
  push()
  for (const step of verdict.steps) {
    if (step.op === 'prompt') {
      push(`### ${step.id}（turn ${step.turn}，${(step.ms / 1000).toFixed(1)}s）`)
      push()
      push(`- 输入：${step.text}`)
      push(`- 工具：${(step.tools ?? []).map((name) => `\`${name}\``).join(' 、 ') || '（无）'}`)
      push('- 她的回复：')
      push()
      push(`> ${String(step.assistant ?? '').trim().replace(/\n/g, '\n> ') || '(空)'}`)
      push()
    } else {
      push(`- ${step.id}（${step.op}）：${step.ok ? '✓' : '✗'}${step.error ? ` — ${step.error}` : ''}${step.killedPid ? ` — killed pid ${step.killedPid}` : ''}`)
    }
  }
  push('## 进程与状态')
  push()
  push(`- 结束时 body 进程：${verdict.body.bodyCount} 个（pid ${verdict.body.bodyPids.join(',') || '无'}）`)
  if (verdict.cleanup) {
    push(`- 收尾：${verdict.cleanup.ran ? '她自己退出' : '未执行'}${verdict.cleanup.error ? `（失败：${verdict.cleanup.error}）` : ''}${verdict.cleanup.forced ? `；lab 强制清掉残留 body pid ${verdict.cleanup.leftoverKilled.join(',')}` : '；无残留 body'}`)
    if (verdict.cleanup.reply) {
      push()
      push(`> 收尾回复：${String(verdict.cleanup.reply).trim().slice(0, 400).replace(/\n/g, ' ')}`)
    }
  }
  push()
  push('## 三问（当事人自述，原文，非链路证据）')
  push()
  for (const row of verdict.interview) {
    push(`### 问：${row.question}`)
    push()
    push(row.answer ? row.answer : `(没有回答${row.error ? `：${row.error}` : ''})`)
    push()
  }
  push('## 证据')
  push()
  for (const file of ['transcript.md', 'events.jsonl', 'rounds.jsonl', 'state/', 'observer.status.json']) {
    push(`- \`${path.join(meta.runDir, file)}\``)
  }
  return `${lines.join('\n')}\n`
}
