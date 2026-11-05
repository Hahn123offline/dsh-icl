// dsh-icl 的 DSH 插件入口（在 DSH 里跑）。
//
// 生命周期：
//   apply(ctx, config)  同步注册事件监听，返回 disposer
//   session/created     领会话 / 单会话否决（同步 throw 让 DSH 回滚）
//   agent/created       await boot → 绑定 agent
//   session/event       turn-end + 原文层
//   agent/pre-step      每轮上下文
//   delivery tick       agent.followup
//
// 所有 DSH 侧能力都走官方 API；HTTP、端口发现、token 全部删掉。

import fs from 'node:fs'
import path from 'node:path'
import { createHost } from '../../core/src/index.mjs'
import { normalizeConfig } from './config.mjs'
import { bootstrapHost } from './bootstrap.mjs'
import { createDshBridge } from './bridge.mjs'

const MAX_BUFFERED_EVENTS = 500

export function createIclPlugin({ ctx, config = {} }) {
  const cfg = normalizeConfig(config)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('icl') : null
  const write = (level) => (entry) => {
    const text = typeof entry === 'string' ? entry : JSON.stringify(entry)
    try {
      if (logger?.[level]) logger[level](text)
      else if (level === 'error') console.error('[icl]', text)
      else console.log('[icl]', text)
    } catch { /* 日志坏了不影响加载 */ }
  }
  const log = write('info')
  const logWarn = write('warn')
  const logError = write('error')

  const state = {
    session: null,
    agent: null,
    host: null,
    bridge: null,
    boot: null,
    bootError: null,
    controlTimer: null,
    enabled: [],
    buffered: [],
    disposed: false,
  }

  function isOurSession(session) {
    const id = session?.id
    if (!id) return false
    const header = session.header ?? {}
    if (header.origin === 'subagent') return false
    if (Number(header.delegationDepth) > 0) return false
    if (cfg.sessionId && String(id) !== cfg.sessionId) return false
    if (cfg.presetId && header.agentPreset != null && String(header.agentPreset) !== cfg.presetId) return false
    return true
  }

  function claimSession(session) {
    const id = String(session.id)
    if (state.session && String(state.session.id) !== id) {
      const who = state.session.header?.cwd || state.session.id
      const error = new Error(`ICL 只允许一个会话：已占用「${who}」，拒绝新会话 ${id}。请回到原会话，或先关闭它。`)
      error.code = 'icl_single_session'
      throw error
    }
    state.session = session
    return state.session
  }

  async function boot() {
    // 关键：先让出一次，等 apply 返回、fiber 进入 started 之后再碰 ctx。
    // 在 apply 的同步阶段注册 section/tools 会让 preset 子插件停在 never started（实测）。
    await null
    fs.mkdirSync(cfg.stateDir, { recursive: true })
    const host = createHost({ log })
    state.host = host
    // 先起桥：raw / history / 提示词在插件启用前就位，dream 在 enable 时自查 due 也不会读到空来源。
    // 工具面此时是空的；surface.onChange 会随每个插件启用增量同步。
    const bridge = createDshBridge({ ctx, host, config: cfg, log })
    state.bridge = bridge
    // 闭环 preset 每次 app 启动从空原文开始；bridge 只在 start() 时读 raw 文件。
    if (cfg.presetId === 'icl-loop' && cfg.rawFile) {
      try { fs.writeFileSync(cfg.rawFile, '', 'utf8') } catch { /* ignore */ }
    }
    // 测试控制面：ICL 内部 shared 能力，供 loop-probe 的 reset 调用。
    try { host.shared.set('icl', { resetRaw: () => bridge.resetRaw() }) } catch { /* ignore */ }
    bridge.start()
    if (state.session) bridge.bindSession(state.session)
    if (state.agent) bridge.bindAgent(state.agent)
    const result = await bootstrapHost(host, cfg, { log })
    state.enabled = result.enabled
    if (state.disposed) return result
    for (const item of state.buffered.splice(0)) bridge.onEvent(item.session, item.event)
    log({
      msg: 'icl.ready',
      session: state.session?.id ?? null,
      plugins: result.enabled.length,
      failed: result.failed,
      tools: bridge.status().tools.length,
      stateDir: cfg.stateDir,
    })
    return result
  }

  function ensureBoot() {
    if (!state.boot) {
      state.boot = boot().catch((error) => {
        state.bootError = error
        logError({ msg: 'icl.boot-fail', error: String(error?.stack ?? error) })
        throw error
      })
    }
    return state.boot
  }

  const onSessionCreated = (session) => {
    if (state.disposed || !isOurSession(session)) return
    claimSession(session)
    void ensureBoot().catch(() => { /* 已在 boot 内记录；agent/created 会把它抛出去 */ })
  }

  const onSessionDisposed = (session) => {
    if (!state.session || String(session?.id) !== String(state.session.id)) return
    state.bridge?.unbindSession(session)
    state.session = null
    state.agent = null
    log({ msg: 'icl.session-disposed', id: String(session.id) })
  }

  const onAgentCreated = async (payload) => {
    const agent = payload?.agent
    const session = agent?.session
    if (!session || !isOurSession(session)) return
    claimSession(session)
    state.agent = agent
    // 这里 await：DSH 会等 agent/created 完成再发布 agent，工具/提示词一定在第一轮之前就位
    await ensureBoot()
    state.bridge?.bindAgent(agent)
  }

  const onAgentDisposed = (payload) => {
    const agent = payload?.agent
    if (!state.agent || agent?.session?.id !== state.session?.id) return
    // 归档会话会 dispose agent，但不会发 session/disposed；如果这里不释放 claim，
    // 同一天再开一个 ICL 会话会被单会话锁永久拒绝，且 bridge 还绑在旧 session 上。
    onSessionDisposed(state.session)
    log({ msg: 'icl.agent-disposed', id: String(agent?.session?.id ?? '') })
  }

  const onSessionEvent = (session, event) => {
    if (!state.session || String(session?.id) !== String(state.session.id)) return
    if (state.bridge) state.bridge.onEvent(session, event)
    else {
      state.buffered.push({ session, event })
      if (state.buffered.length > MAX_BUFFERED_EVENTS) state.buffered.shift()
    }
  }

  const onPreStep = async (payload, next) => {
    if (!state.bridge || !state.agent) return next()
    if (payload?.agent && payload.agent.session?.id !== state.session?.id) return next()
    return state.bridge.preStep(payload, next)
  }

  ctx.on('session/created', onSessionCreated)
  ctx.on('session/disposed', onSessionDisposed)
  ctx.on('agent/created', onAgentCreated)
  ctx.on('agent/disposed', onAgentDisposed)
  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/pre-step', onPreStep)

  // 闭环测试专用：app 可能恢复上一条 loop 会话并占着单会话锁，而 DSH 没有
  // “dispose session” 的公开 API。driver 在创建新会话前写 control.json，
  // 这里释放 claim/解绑 bridge；非 icl-loop preset 不挂这个控制面。
  if (cfg.presetId === 'icl-loop') {
    const controlFile = path.join(cfg.stateDir, 'control.json')
    const timer = setInterval(() => {
      try {
        const cmd = JSON.parse(fs.readFileSync(controlFile, 'utf8'))
        if (cmd?.cmd !== 'release') return
        if (state.session) onSessionDisposed(state.session)
        else state.bridge?.unbindSession()
        fs.unlinkSync(controlFile)
        log({ msg: 'icl.control-release' })
      } catch { /* 没有控制文件 */ }
    }, 200)
    if (typeof timer.unref === 'function') timer.unref()
    state.controlTimer = timer
  }

  // preset 在 DSH 启动时就挂载；工具/提示词要在任何 agent 创建之前就位，
  // 所以这里立即装配（不在第一个 session 上懒加载）。
  void ensureBoot().catch(() => { /* 已在 boot 内记录；agent/created 会把失败抛给 DSH */ })

  return {
    log,
    status: () => ({
      ...(state.bridge?.status() ?? { sessionId: state.session?.id ?? null, agentId: state.agent?.id ?? null, tools: [], raw: 0 }),
      plugins: state.host?.list?.() ?? [],
      bootError: state.bootError ? String(state.bootError?.message ?? state.bootError) : null,
      stateDir: cfg.stateDir,
    }),
    dispose() {
      if (state.disposed) return
      state.disposed = true
      if (state.controlTimer) { clearInterval(state.controlTimer); state.controlTimer = null }
      try { state.bridge?.dispose() } catch (error) { logWarn({ msg: 'icl.dispose-bridge', error: String(error?.message ?? error) }) }
      state.bridge = null
      try { state.host?.shared?.delete('icl') } catch { /* ignore */ }
      // 插件的定时器/订阅也要一起收回：bridge 只管 DSH 侧
      for (const id of [...state.enabled].reverse()) {
        try { state.host?.disable(id) } catch (error) { logWarn({ msg: 'icl.disable-fail', id, error: String(error?.message ?? error) }) }
      }
      state.enabled = []
      state.buffered = []
      state.session = null
      state.agent = null
    },
  }
}
