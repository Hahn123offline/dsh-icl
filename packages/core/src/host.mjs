// 插件宿主：加载、启用、停用。
//
// "动态工具面"的全部答案就在这里：apply() 期间插件拿到的一切注册都会返回注销器，
// 宿主把这些注销器按逆序排好；disable 时依次调用，于是下一轮装配就看不到它的工具、
// 提示词段、focus 租约。没有第二套状态需要同步。

import { validateManifest } from './contracts.mjs'
import { createRawSourceRegistry, createToolRegistry, createPromptService, createFocusService, createDeliveryService, createSlotRegistry } from './services.mjs'
import { createModelClient } from './model-client.mjs'

export function createHost({ log = () => {}, now = () => Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const tools = createToolRegistry({ onChange: (event) => log({ msg: 'tools.change', ...event }) })
  const prompt = createPromptService()
  const focus = createFocusService({ now })
  const delivery = createDeliveryService({ now })
  const raw = createRawSourceRegistry()
  const slots = createSlotRegistry()
  const model = createModelClient({ fetchImpl, now })

  /** id -> { manifest, module, apply, dispose:Function[], enabled:boolean } */
  const plugins = new Map()
  /** 插件之间共享能力的注册表：provide/get */
  const shared = new Map()

  function makeContext(manifest, record) {
    const pluginId = manifest.id
    return {
      id: pluginId,
      manifest,
      log: (entry) => log({ plugin: pluginId, ...(typeof entry === 'string' ? { msg: entry } : entry) }),
      now,
      /** 记录一个注销器（宿主统一管理生命周期）。 */
      onDispose(fn) { if (typeof fn === 'function') record.dispose.push(fn) },
      tools: {
        register(definition) {
          const dispose = tools.register({ ...definition, plugin: pluginId })
          record.dispose.push(dispose)
          return dispose
        },
      },
      prompt: {
        section(section) {
          const dispose = prompt.section(section)
          record.dispose.push(dispose)
          return dispose
        },
        onTurn(provider) {
          const dispose = prompt.onTurn(provider)
          record.dispose.push(dispose)
          return dispose
        },
      },
      focus: {
        enter(options) {
          const lease = focus.enter({ owner: pluginId, ...options })
          record.dispose.push(lease.release)
          return lease
        },
        canPierce: (label, opts) => focus.canPierce(label, opts),
        current: () => focus.current(),
      },
      delivery: {
        push: (input) => delivery.push({ ...input, source: { plugin: pluginId, ...(input?.source ?? {}) } }),
      },
      slots: {
        declare(slot) {
          const dispose = slots.declare({ ...slot, owner: pluginId })
          record.dispose.push(dispose)
          return dispose
        },
        call: (id, request) => slots.call(id, request),
        resolve: (id) => slots.resolve(id),
        require: (id) => slots.require(id),
        onChange: (fn) => { const off = slots.onChange(fn); record.dispose.push(off); return off },
        registerProvider: (provider) => { const off = slots.registerProvider(provider); record.dispose.push(off); return off },
        autoBind: () => slots.autoBind(),
        unmatched: () => slots.unmatched(),
        providers: () => slots.providers(),
        list: () => slots.list(),
      },
      services: {
        raw: {
          register: (def) => { const off = raw.register(def); record.dispose.push(off); return off },
          search: (req) => raw.search(req),
          ids: () => raw.ids(),
        },
        provide(name, api) {
          const key = String(name)
          if (shared.has(key)) throw new Error(`能力重复：${key}`)
          shared.set(key, api)
          const dispose = () => { shared.delete(key) }
          record.dispose.push(dispose)
          return dispose
        },
        get(name) { return shared.get(String(name)) ?? null },
        require(name) {
          const api = shared.get(String(name))
          if (!api) throw new Error(`缺少依赖能力：${name}`)
          return api
        },
        list() { return [...shared.keys()] },
      },
      model: {
        chat: (input) => model.chat(input),
        bind: (binding) => model.bind(binding),
        pause: (reason) => model.pause(reason),
        resume: () => model.resume(),
        isPaused: () => model.isPaused(),
      },
      config: record.config ?? {},
      /** 统一的 HTTP 出口：插件不直接碰 globalThis.fetch，方便测试与代理 */
      fetch: (...args) => fetchImpl(...args),
    }
  }

  return {
    services: { tools, prompt, focus, delivery, slots, model, raw },

    /** 登记一个插件（不启用）。 */
    registerPlugin(manifestInput, module, { config = {} } = {}) {
      const checked = validateManifest(manifestInput)
      if (!checked.ok) throw new Error(`插件清单不合法：${checked.error}`)
      const manifest = checked.manifest
      const apply = module?.apply
      if (typeof apply !== 'function') throw new Error(`${manifest.id} 缺少导出的 apply(ctx)`)
      if (plugins.has(manifest.id)) throw new Error(`插件重复：${manifest.id}`)
      plugins.set(manifest.id, { manifest, module, apply, config, dispose: [], enabled: false })
      return manifest
    },

    /** 启用：调用 apply，记录它注册的一切。 */
    async enable(id) {
      const record = plugins.get(String(id))
      if (!record) throw new Error(`没有这个插件：${id}`)
      if (record.enabled) return { enabled: true, already: true }
      const requires = record.manifest.requires ?? {}
      for (const dep of requires.plugins ?? []) {
        const depRecord = plugins.get(String(dep))
        if (!depRecord?.enabled) throw new Error(`${record.manifest.id} 需要先启用插件：${dep}`)
      }
      record.dispose = []
      record.enabled = true
      const ctx = makeContext(record.manifest, record)
      // 清单里声明的插槽由宿主代为注册：插件只写"需要什么形状"，
      // 不自己去 declare，也就不可能写死模型名。
      for (const slot of record.manifest.slots ?? []) {
        try { record.dispose.push(slots.declare({ ...slot, owner: record.manifest.id })) } catch (error) {
          for (const dispose of record.dispose.reverse()) { try { dispose() } catch { /* 忽略 */ } }
          record.dispose = []
          record.enabled = false
          throw error
        }
      }
      try {
        const extra = await record.apply(ctx)
        if (typeof extra === 'function') record.dispose.push(extra)
      } catch (error) {
        record.enabled = false
        // apply 失败要把它已经注册的东西收回去，不能留半套
        for (const dispose of record.dispose.reverse()) { try { dispose() } catch { /* 忽略 */ } }
        record.dispose = []
        throw error
      }
      log({ msg: 'plugin.enabled', id: record.manifest.id, disposers: record.dispose.length })
      return { enabled: true }
    },

    /** 停用：逆序注销。 */
    disable(id) {
      const record = plugins.get(String(id))
      if (!record) throw new Error(`没有这个插件：${id}`)
      if (!record.enabled) return { enabled: false, already: true }
      for (const dispose of record.dispose.reverse()) { try { dispose() } catch { /* 单个失败不阻塞其余 */ } }
      record.dispose = []
      record.enabled = false
      log({ msg: 'plugin.disabled', id: record.manifest.id })
      return { enabled: false }
    },

    list() {
      return [...plugins.values()].map((record) => ({
        id: record.manifest.id,
        version: record.manifest.version,
        enabled: record.enabled,
        tools: record.manifest.tools,
        slots: record.manifest.slots.map((s) => s.id),
      }))
    },
    has(id) { return plugins.has(String(id)) },
    manifestOf(id) { return plugins.get(String(id))?.manifest ?? null },
    /** 插件之间共享能力的只读视图（调试用）。 */
    shared,
  }
}
