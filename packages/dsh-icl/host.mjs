// ICL 的 Host 侧挂载。
//
// 重要职责：DSH 桌面重启后不会自动把上次的 agent 恢复到运行态；QQ 只是外部信号，
// 没有 live agent 时 delivery 队列再完整也没人消费。这里在 Host 启动后尝试
// resume 最近一个 ICL 持久会话，让“重启后 QQ 消息仍能叫醒她”不依赖用户手动点开会话。
//
// 这是兜底：若失败（用户没建过会话、UI 先一步恢复、persistence 未就绪），
// 仍回退到原来的行为，由用户打开会话后 bindSession 保留队列并补投。

export const name = 'icl-host'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    if (disposed || handle) return
    const agents = sub.agents
    const persistence = sub.sessionPersistence
    const presets = sub.agentPresets
    if (!agents?.resume || !persistence?.list) return
    const headers = await persistence.list()
    const picked = pickResumeSession(headers, { presetId, sessionId })
    if (!picked) {
      log('info', { msg: 'icl-host.resume-skip', reason: 'no-session', presetId })
      return
    }
    if (agents.get?.(picked.id)) {
      log('info', { msg: 'icl-host.resume-skip', reason: 'already-live', id: picked.id })
      return
    }
    const resumed = await agents.resume({
      resumeSessionId: picked.id,
      setup: presets?.mount
        ? async (agentCtx) => { await presets.mount(agentCtx, presetId) }
        : undefined,
    })
    if (disposed) {
      try { resumed?.dispose?.() } catch { /* ignore */ }
      return
    }
    handle = resumed
    log('info', { msg: 'icl-host.resumed', id: picked.id })
  }

  function schedule(sub) {
    if (disposed || started) return
    started = true
    timer = setTimeout(() => {
      timer = null
      void (async () => {
        for (let i = 0; i < attempts && !disposed && !handle; i += 1) {
          try {
            await resumeOnce(sub)
            return
          } catch (error) {
            log('warn', { msg: 'icl-host.resume-fail', attempt: i + 1, error: String(error?.message ?? error) })
            if (i + 1 < attempts) await sleep(Math.min(5000, 1000 * (i + 1)))
          }
        }
      })()
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  if (autoResume) {
    try {
      ctx.inject(['agents', 'sessionPersistence', 'agentPresets'], (sub) => {
        schedule(sub)
      })
    } catch (error) {
      log('warn', { msg: 'icl-host.inject-fail', error: String(error?.message ?? error) })
    }
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
