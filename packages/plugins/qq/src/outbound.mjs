// 出站（发 QQ 私聊）：**默认关闭，双钥匙，本轮不接任何工具**。
//
// 为什么单独一个文件却不接进 index.mjs：任务是"只读入站"，但设计要留出收发的固定接缝。
// 出站必须同时满足三个条件才可能工作：
//   1. 配置 enabled === true（插件总开关，默认 false）
//   2. 配置 allowSend === true（出站开关，默认 false）
//   3. 配置 sendApproval === 'lead-approved'（lead 明确批准的字面量；不是布尔值，防止误填）
// 即便三个都满足，本模块也只提供 sendPrivate 这一条最小路径（白名单内、单条文本），
// 不做群发、不做富媒体、不自动重试。真正的发送代码要等用户单独批准"私聊回"之后再加。
//
// 参考：focus-core qq-ws.js 的 sendPrivate（reply/at 段拼接、echo 配对）——这里刻意不复用，
// 因为没有出站需求时写发送逻辑只有风险没有收益。
import { withToken } from './connector.mjs'

export const SEND_APPROVAL_TOKEN = 'lead-approved'

/** 三把钥匙是否都打开了。 */
export function sendEnabled(cfg = {}) {
  return cfg.enabled === true && cfg.allowSend === true && cfg.sendApproval === SEND_APPROVAL_TOKEN
}

/** 发送前的最后一道白名单：只允许配置里列出的私聊对象。 */
export function checkSendTarget(cfg = {}, peerId) {
  if (!sendEnabled(cfg)) return { ok: false, error: '出站未启用（需要 enabled + allowSend + sendApproval=lead-approved）' }
  const allow = new Set((Array.isArray(cfg.allowPrivate) ? cfg.allowPrivate : []).map(String))
  if (!allow.has(String(peerId))) return { ok: false, error: `目标 ${peerId} 不在私聊白名单里` }
  return { ok: true }
}

/**
 * 最小出站实现：单条文本私聊，靠 OneBot send_private_msg 动作。
 * **当前没有调用方**：index.mjs 不 import 这个函数；测试只验证"默认拒绝"。
 * @param {object} options
 * @param {(payload:object)=>void} options.send  注入的底层发送（测试用；生产应接 WS 的 call）
 */
export function createOutbound({ cfg = {}, send = null, log = () => {} } = {}) {
  async function sendPrivate(peerId, text) {
    const gate = checkSendTarget(cfg, peerId)
    if (!gate.ok) return { ok: false, error: gate.error }
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: '空消息不发送' }
    if (typeof send !== 'function') return { ok: false, error: '没有接发送通道（本轮不应走到这里）' }
    log({ msg: 'qq.outbound.attempt', peerId: String(peerId), chars: body.length })
    const result = await send({ action: 'send_private_msg', params: { user_id: Number(peerId), message: body } })
    return { ok: true, result }
  }
  return { sendPrivate, enabled: () => sendEnabled(cfg) }
}

// 预留：将来接实时 WS 时用 withToken 拼端点；现在导出只为让依赖关系显式。
export { withToken }
