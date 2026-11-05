// 断线补课：重连后把"断线期间漏掉的私聊消息"从 OneBot 历史接口捞回来。
//
// 契约（2026-11-06 先用 fake 定义，真机待用户在场时验证；见 docs/QQ.md §7.4 / §13.7）：
//   · 动作：`get_friend_msg_history`，参数 `{ user_id, count }`；返回消息数组
//     （或 `{ messages: [...] }` / 单条）。每条至少要有 `message_id`、`time`、`user_id` 或
//     `sender.user_id`、`message`（数组）或 `raw_message`（字符串）。
//   · 游标：优先用本地账本的 `last_at`（毫秒）+ `hasMessage(activity,message_id)` 双判：
//     时间早于水位太多且 id 没见过 → 视为更旧的历史，不补；时间在窗口内且 id 未见 → 补。
//     这样即使上游不认自定义锚点（SnowLuma 文档只说"无锚点时取最新双向记录"），也不会重放旧消息。
//   · 只补私聊；群消息本轮整类不收（phase 2）。
//   · 复用原 signal id（normalize.signalIdFor 的 message_id 规则）；账本按 (activity,qq_id) 唯一，
//     补课重复跑不会双投。
//   · **不调用 `mark_msg_as_read` / `mark_private_msg_as_read`**：那会把"已读"同步到用户自己的 QQ，
//     属于产品决定；P0 只做补课，已读留给 P1 的 qq_mark_read 显式动作。
//   · 失败不抛：记 gap.failed 并在 status 可见；绝不因为补课失败影响实时入站。
import { activityIdForPrivate } from './normalize.mjs'

const HISTORY_ACTIONS = Object.freeze(['get_friend_msg_history'])

function timeMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  // OneBot 的 time 一般是秒；有些实现给毫秒。> 10^11 视为毫秒。
  return n > 100_000_000_000 ? Math.round(n) : Math.round(n * 1000)
}

function extractMessages(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.messages)) return data.messages
  if (data.message && data.message_id != null) return [data]
  return []
}

function senderIdOf(item) {
  return item?.user_id ?? item?.sender?.user_id ?? item?.userId ?? null
}

function convertToEvent(item, { peerId, selfId }) {
  const userId = senderIdOf(item)
  const message = Array.isArray(item?.message)
    ? item.message
    : (typeof item?.message === 'string' ? [{ type: 'text', data: { text: item.message } }] : null)
  const fallback = typeof item?.raw_message === 'string'
    ? [{ type: 'text', data: { text: item.raw_message } }]
    : null
  return {
    post_type: item?.post_type ?? 'message',
    message_type: 'private',
    sub_type: item?.sub_type ?? 'friend',
    time: item?.time ?? null,
    self_id: item?.self_id ?? selfId ?? null,
    user_id: userId ?? Number(peerId),
    message_id: item?.message_id ?? item?.messageId ?? item?.id ?? null,
    message: message ?? fallback ?? [],
    raw_message: typeof item?.raw_message === 'string' ? item.raw_message : '',
    sender: item?.sender ?? { user_id: userId ?? Number(peerId) },
  }
}

/**
 * 创建补课器。
 * @param {object} deps
 * @param {{ok:boolean, call:Function}} deps.http       OneBot HTTP 客户端（onebot-http.mjs）
 * @param {object} deps.ledger                          账本（ledger.mjs）
 * @param {(event:object, opts:{backfilled:true})=>object} deps.ingest  把补课消息送进入站闸门/投递
 * @param {()=>string[]} [deps.peers]                   哪些私聊要补（owner/白名单/账本里见过的）
 * @param {number} [deps.count]                         每次拉多少条（默认 50）
 * @param {number} [deps.maxAgeMs]                      超过多久的旧消息不补（默认 6h）
 * @param {number} [deps.maxPeers]                      一次最多补几个会话（默认 5）
 */
export function createBackfill({
  http = null,
  ledger = null,
  ingest = () => ({ accept: false, code: 'no-ingest' }),
  peers = () => [],
  now = () => Date.now(),
  log = () => {},
  selfId = null,
  count = 50,
  maxAgeMs = 6 * 3600_000,
  maxPeers = 5,
  action = HISTORY_ACTIONS[0],
} = {}) {
  const state = {
    runs: 0,
    filled: 0,
    dropped: 0,
    failed: 0,
    unsupported: 0,
    skipped: 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    lastReason: null,
    lastPeers: 0,
    inFlight: false,
  }

  async function run({ reason = 'reconnect', peerList = null } = {}) {
    if (state.inFlight) { state.skipped += 1; return { skipped: true, runs: state.runs } }
    state.inFlight = true
    state.runs += 1
    state.lastRunAt = now()
    state.lastReason = String(reason)
    const startedAt = now()
    try {
      if (!http?.ok) {
        state.unsupported += 1
        state.lastError = '没有可用的 OneBot HTTP 端点，补课跳过（gap 仍可见）'
        log({ level: 'warn', msg: 'qq.backfill.no-http' })
        return { unsupported: true, runs: state.runs }
      }
      let list = Array.isArray(peerList) ? peerList : (typeof peers === 'function' ? peers() : [])
      list = [...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))].slice(0, Math.max(1, maxPeers))
      state.lastPeers = list.length
      let filledHere = 0
      let droppedHere = 0
      let failedHere = 0
      for (const peer of list) {
        const activity = activityIdForPrivate(peer)
        const known = ledger?.lastKnown?.(activity) ?? null
        let data
        try {
          data = await http.call(action, { user_id: Number(peer), count })
        } catch (error) {
          failedHere += 1
          state.failed += 1
          state.lastError = String(error?.message ?? error)
          log({ level: 'warn', msg: 'qq.backfill.fetch-fail', peer, error: state.lastError })
          continue
        }
        const items = extractMessages(data)
        for (const item of items) {
          const qqId = item?.message_id ?? item?.messageId ?? item?.id
          if (qqId == null) continue
          if (ledger?.hasMessage?.(activity, qqId)) continue
          const senderId = senderIdOf(item)
          // 历史是双向的：自己发出去的消息不进入站账本（它由发送审计负责）
          if (selfId != null && senderId != null && String(senderId) === String(selfId)) continue
          const at = timeMs(item?.time)
          if (known?.lastAt != null && at != null && at < Number(known.lastAt) - 2000) continue
          if (maxAgeMs > 0 && at != null && now() - at > maxAgeMs) {
            droppedHere += 1
            state.dropped += 1
            log({ level: 'info', msg: 'qq.backfill.old-skip', peer, ageMs: now() - at })
            continue
          }
          const event = convertToEvent(item, { peerId: peer, selfId })
          let decision
          try { decision = await ingest(event, { backfilled: true }) } catch (error) {
            failedHere += 1
            state.failed += 1
            state.lastError = String(error?.message ?? error)
            log({ level: 'warn', msg: 'qq.backfill.ingest-fail', peer, error: state.lastError })
            continue
          }
          if (decision?.accept) { filledHere += 1; state.filled += 1 } else {
            droppedHere += 1
            state.dropped += 1
            log({ level: 'info', msg: 'qq.backfill.drop', peer, code: decision?.code ?? null })
          }
        }
      }
      state.lastDurationMs = now() - startedAt
      log({ msg: 'qq.backfill.done', reason, peers: list.length, filled: filledHere, dropped: droppedHere, failed: failedHere, ms: state.lastDurationMs })
      return { runs: state.runs, filled: filledHere, dropped: droppedHere, failed: failedHere, peers: list.length }
    } finally {
      state.inFlight = false
    }
  }

  return {
    run,
    status() { return { ...state } },
    get busy() { return state.inFlight },
  }
}

export { HISTORY_ACTIONS }
