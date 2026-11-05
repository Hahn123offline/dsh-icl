// OneBot v11 HTTP 动作客户端：只做"补课/已读"这类只读或幂等动作，不承担发送。
//
// 为什么另开 HTTP（而不是复用 WS）：
//   · 入站连接必须保持 framesSent===0 的只读不变量（断线补课也不能让它发帧）；
//   · 出站 WS 连接只有三把钥匙打开时才存在，而影子模式/只读模式也需要补课；
//   · SnowLuma 的 HTTP 动作端（默认 127.0.0.1:3000）与 WS 共用同一套 OneBot 动作。
//
// token：SnowLuma 的 httpServers[0].accessToken 是独立的，不等同 WS token；
// 发现时从 config/onebot_<uin>.json 读，或显式配置 httpToken。
export function createOneBotHttp({
  endpointUrl = '',
  token = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const base = String(endpointUrl ?? '').replace(/\/+$/, '')
  if (!base) {
    return {
      ok: false,
      endpointUrl: null,
      async call() { throw new Error('没有配置 OneBot HTTP 端点（httpUrl / SnowLuma 发现）') },
    }
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, endpointUrl: base, async call() { throw new Error('当前环境没有 fetch') } }
  }
  async function call(action, params = {}, { timeout = timeoutMs } = {}) {
    const name = String(action ?? '').trim()
    if (!name) throw new Error('OneBot 动作名不能为空')
    let res
    try {
      res = await fetchImpl(`${base}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(Math.max(1000, Number(timeout) || timeoutMs)),
      })
    } catch (error) {
      throw new Error(`OneBot ${name} 请求失败：${error?.message ?? error}`)
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json?.status === 'failed' || (json?.retcode != null && Number(json.retcode) !== 0)) {
      throw new Error(`OneBot ${name} 失败：${json?.wording ?? json?.retcode ?? res.status}`)
    }
    return json?.data ?? null
  }
  return { ok: true, endpointUrl: base, call }
}
