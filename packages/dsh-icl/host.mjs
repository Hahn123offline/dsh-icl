// ICL 的 Host 侧挂载。
//
// 重要职责：DSH 桌面重启后不会自动把上次的 agent 恢复到运行态；QQ 只是外部信号，
// 没有 live agent 时 delivery 队列再完整也没人消费。这里在 Host 启动后尝试
// resume 最近一个 ICL 持久会话，让“重启后 QQ 消息仍能叫醒她”不依赖用户手动点开会话。
//
// 这是兜底：若失败（用户没建过会话、UI 先一步恢复、persistence 未就绪），
// 仍回退到原来的行为，由用户打开会话后 bindSession 保留队列并补投。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'icl-host'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function diagFileOf() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'icl', 'state', 'icl-host.jsonl')
}

let diagEnabled = true

function diag(event) {
  if (!diagEnabled) return
  try {
    const file = diagFileOf()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8')
  } catch { /* 诊断失败不影响启动 */ }
}

/**
 * 从持久化 header 中挑最近一个 ICL 顶层会话。
 * 只认 header.agentPreset；不猜 cwd，也不碰子会话。
 */
export function pickResumeSession(headers, { presetId = 'icl', sessionId = null } = {}) {
  const list = Array.isArray(headers) ? headers : []
  if (sessionId) return list.find((row) => String(row?.id ?? '') === String(sessionId)) ?? null
  return list
    .filter((row) => row && row.origin !== 'subagent' && String(row.agentPreset ?? '') === String(presetId))
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0] ?? null
}

export function apply(ctx, config = {}) {
  diagEnabled = config.diag !== false
  const presetId = String(config.presetId ?? 'icl')
  const autoResume = config.autoResume !== false
  const sessionId = config.resumeSessionId ? String(config.resumeSessionId) : null
  const delayMs = Math.max(0, Number(config.autoResumeDelayMs ?? 2000) || 0)
  const attempts = Math.max(1, Math.min(10, Number(config.autoResumeAttempts ?? 4) || 4))
  let disposed = false
  let timer = null
  let handle = null
  let started = false

  const log = (level, data) => {
    try {
      diag({ level, ...(typeof data === 'object' ? data : { message: data }) })
    } catch { /* ignore */ }
    try {
      if (typeof ctx.logger === 'function') {
        const logger = ctx.logger('icl-host')
        const fn = logger?.[level]
        if (typeof fn === 'function') fn(typeof data === 'string' ? data : JSON.stringify(data))
        return
      }
      console[level === 'error' ? 'error' : 'log']('[icl-host]', typeof data === 'string' ? data : JSON.stringify(data))
    } catch { /* 日志不影响启动 */ }
  }

  async function resumeOnce(sub) {
    if (disposed || handle) return 'skip'
    const agents = sub.agents
    const persistence = sub.sessionPersistence
    const presets = sub.agentPresets
    if (!agents?.resume || !persistence?.list) return 'not-ready'
    const headers = await persistence.list()
    diag({ msg: 'icl-host.list', sessions: Array.isArray(headers) ? headers.length : null })
    const picked = pickResumeSession(headers, { presetId, sessionId })
    if (!picked) {
      log('info', { msg: 'icl-host.resume-skip', reason: 'no-session', presetId })
      return 'no-session'
    }
    if (agents.get?.(picked.id)) {
      log('info', { msg: 'icl-host.resume-skip', reason: 'already-live', id: picked.id })
      return 'live'
    }
    const resumed = await agents.resume({
      resumeSessionId: picked.id,
      setup: presets?.mount
        ? async (agentCtx) => { await presets.mount(agentCtx, presetId) }
        : undefined,
    })
    if (disposed) {
      try { resumed?.dispose?.() } catch { /* ignore */ }
      return 'disposed'
    }
    handle = resumed
    log('info', { msg: 'icl-host.resumed', id: picked.id })
    return 'resumed'
  }

  function schedule(sub) {
    if (disposed || started) return
    started = true
    diag({ msg: 'icl-host.schedule', delayMs })
    timer = setTimeout(() => {
      timer = null
      void (async () => {
        for (let i = 0; i < attempts && !disposed && !handle; i += 1) {
          try {
            const result = await resumeOnce(sub)
            if (result === 'resumed' || result === 'live' || result === 'disposed') return
            if (i + 1 < attempts) await sleep(Math.min(5000, 1000 * (i + 1)))
          } catch (error) {
            diag({ msg: 'icl-host.resume-fail', attempt: i + 1, error: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 600) })
            log('warn', { msg: 'icl-host.resume-fail', attempt: i + 1, error: String(error?.message ?? error) })
            if (i + 1 < attempts) await sleep(Math.min(5000, 1000 * (i + 1)))
          }
        }
      })()
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  if (autoResume) {
    diag({ msg: 'icl-host.apply', presetId, delayMs, attempts, sessionId })
    try {
      ctx.inject(['agents', 'sessionPersistence', 'agentPresets'], (sub) => {
        diag({ msg: 'icl-host.injected' })
        schedule(sub)
      })
    } catch (error) {
      diag({ msg: 'icl-host.inject-fail', error: String(error?.message ?? error) })
      log('warn', { msg: 'icl-host.inject-fail', error: String(error?.message ?? error) })
    }
  } else {
    diag({ msg: 'icl-host.disabled' })
  }

  return () => {
    disposed = true
    if (timer) { clearTimeout(timer); timer = null }
    if (handle) {
      try { handle.dispose?.() } catch { /* ignore */ }
      handle = null
    }
  }
}
