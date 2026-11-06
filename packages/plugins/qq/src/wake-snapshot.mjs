// 唤醒提醒里的"醒来第一眼快照"：把未读账本行按 oldest-first 压成一段可读摘要。
// 纯函数（不读文件/不发送）：index 在生成 wake signal 正文时调用；预算固定，超了给 partial + readThroughSeq。

export const WAKE_SNAPSHOT_DEFAULTS = Object.freeze({ maxItems: 12, maxChars: 6000 })

function stripEnvelope(text) {
  let s = String(text ?? '')
  // 去掉 [QQ私聊·主人]/[QQ私聊] 前缀，保留 [补课] 等提醒（不要重复 sender 信封）
  s = s.replace(/^\[QQ私聊[^\]]*\]\s*/u, '')
  return s.trim()
}

function clipText(value, max) {
  const s = String(value ?? '')
  if (s.length <= max) return s
  let cut = Math.max(0, max - 1)
  const code = s.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${s.slice(0, cut)}…`
}

/**
 * @param {Array<{seq:number,sender?:string,text?:string,at?:number|null}>} rows oldest-first
 * @returns {{text:string,count:number,included:number,partial:boolean,readThroughSeq:number|null}}
 */
export function buildWakeSnapshot(rows, { maxItems = WAKE_SNAPSHOT_DEFAULTS.maxItems, maxChars = WAKE_SNAPSHOT_DEFAULTS.maxChars } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && Number.isFinite(Number(row.seq)))
    .sort((a, b) => Number(a.seq) - Number(b.seq))
  if (!list.length) return { text: '', count: 0, included: 0, partial: false, readThroughSeq: null }
  const itemLimit = Math.max(1, Math.floor(Number(maxItems) || WAKE_SNAPSHOT_DEFAULTS.maxItems))
  const charLimit = Math.max(80, Math.floor(Number(maxChars) || WAKE_SNAPSHOT_DEFAULTS.maxChars))
  const lines = []
  let used = 0
  let included = 0
  let readThroughSeq = null
  let partial = false
  for (const row of list) {
    if (included >= itemLimit) { partial = true; break }
    const sender = row.sender ? `${row.sender}：` : ''
    let body = stripEnvelope(row.text)
    // 正文常已带"主人："，别和 sender 前缀重复。
    if (row.sender && body.startsWith(`${row.sender}：`)) body = body.slice(`${row.sender}：`.length)
    const prefix = `· #${row.seq} ${sender}`
    const budget = charLimit - used - prefix.length - 1
    if (budget <= 24) { partial = true; break }
    const clipped = body.length > budget
    const line = `${prefix}${clipText(body, budget)}`
    if (clipped) partial = true
    lines.push(line)
    used += line.length + 1
    included += 1
    readThroughSeq = Number(row.seq)
    if (clipped) break
  }
  partial = partial || included < list.length
  return {
    text: lines.join('\n'),
    count: list.length,
    included,
    partial,
    readThroughSeq,
  }
}
