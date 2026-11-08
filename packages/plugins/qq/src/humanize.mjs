// 出站人类化：纯函数层（移植自旧实现的可复用逻辑，不复制旧文件的结构）。
//
// 来源（只读参考）：
//   · focus-core apps/dsh-icl/src/domain/qq-send.js —— planBurst / typingMs / PACES / rateCheck
//   · dsh-qq src/md-to-plain.js —— mdToPlain / splitForQQ（代理对安全、URL 不被切断）
//   · dsh-qq src/bridge.js splitLongSegment/computeGapsV2 —— 超长段落按标点/URL 拆、长停顿概率
//
// 这里只做"怎么把一段话变成几条、每条间隔多久"的计划；不发送、不读配置、不碰 IO。

export const BURST = Object.freeze({
  maxMessages: 8,
  minGapMs: 1_000,
  maxGapMs: 3_000,
  longGapChance: 0.2,
  longGapMinMs: 5_000,
  longGapMaxMs: 10_000,
  clampMinMs: 100,
  clampMaxMs: 10_000,
  maxChars: 500,
  perMinute: 8,
  perHour: 60,
})

export const TYPING = Object.freeze({
  charsPerSecond: 1.4,
  minMs: 600,
  maxMs: 25_000,
  overheadMs: 400,
})

/** 语气档位：数字越大越慢（thoughtful 慢、blast 快）。 */
export const PACES = Object.freeze({
  thoughtful: 1.7,
  normal: 1.0,
  quick: 0.6,
  blast: 0.25,
})

export function paceFactor(pace) {
  return PACES[String(pace ?? 'normal')] ?? PACES.normal
}

/** 打这么多字要多久（毫秒）：默认 1.4 字/秒，夹在 600ms–25s。 */
export function typingMs(text, { charsPerSecond = TYPING.charsPerSecond, minMs = TYPING.minMs, maxMs = TYPING.maxMs, overheadMs = TYPING.overheadMs, pace = 'normal' } = {}) {
  const chars = String(text ?? '').replace(/\s+/g, '').length
  if (!chars) return 0
  const cps = Math.max(0.2, Number(charsPerSecond) || TYPING.charsPerSecond) / paceFactor(pace)
  const raw = overheadMs + (chars / cps) * 1000
  return Math.max(minMs, Math.min(maxMs, Math.round(raw)))
}

/** 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本（逐字移植 dsh-qq 的判定，保留其防注入/防 O(n²) 上限）。 */
export function mdToPlain(md) {
  let s = String(md ?? '')
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''))
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1')
  // 图片/链接：保留文字，链接附在括号里；长度有界（防大量 "![" 的 O(n²)）
  s = s.replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g, (_, alt, url) => (alt || url))
  s = s.replace(/\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/g, '$1 ($2)')
  // 粗体/斜体/删除线
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  // 单个 *：不跨行、开闭标记不能贴空白（否则 "2 * 3 * 4" 会被吃掉）
  s = s.replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  // 标题 / 引用 / 列表
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^>\s?/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '• ')
  s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + ' ')
  // 表格分隔行去掉，保留行文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line)).join('\n')
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff }
function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff }

/** 按 QQ 单条上限切分；优先在换行处切；绝不切开代理对（emoji）。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.floor(Number(max)) : 4000
  const parts = []
  let rest = String(text ?? '')
  while (rest.length > safeMax) {
    let cut = rest.lastIndexOf('\n', safeMax - 1)
    let eat = 0
    if (cut <= 0) cut = safeMax
    else eat = 1
    const code = rest.charCodeAt(cut - 1)
    if (isHighSurrogate(code)) cut -= 1
    if (cut <= 0) {
      const first = rest.charCodeAt(0)
      const second = rest.charCodeAt(1)
      cut = isHighSurrogate(first) && isLowSurrogate(second) ? 2 : 1
      eat = 0
    }
    parts.push(rest.slice(0, cut + eat))
    rest = rest.slice(cut + eat)
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/** 把文本拆成"URL 原子 + 普通片段"的 token，再贪心拼成 ≤max 的块；URL 整条保留、绝不切断。 */
export function splitLongText(text, max = BURST.maxChars) {
  const s = String(text ?? '')
  if (!s) return []
  const safeMax = Math.max(1, Math.floor(Number(max) || BURST.maxChars))
  const urlRe = /https?:\/\/[^\s，。；、]+/g
  const tokens = []
  let last = 0
  let match
  while ((match = urlRe.exec(s)) !== null) {
    if (match.index > last) tokens.push({ url: false, text: s.slice(last, match.index) })
    tokens.push({ url: true, text: match[0] })
    last = match.index + match[0].length
  }
  if (last < s.length) tokens.push({ url: false, text: s.slice(last) })

  const parts = []
  let current = ''
  const flush = () => { if (current) { parts.push(current); current = '' } }
  const pushChunks = (chunkText) => {
    for (const chunk of splitForQQ(chunkText, safeMax)) {
      if (!current) { current = chunk; continue }
      if ((current + chunk).length <= safeMax) { current += chunk; continue }
      flush()
      current = chunk
    }
  }
  for (const token of tokens) {
    if (token.text.length <= safeMax) {
      if (current && (current + token.text).length > safeMax) flush()
      current += token.text
      continue
    }
    if (token.url) {
      // URL 比单条上限还长：允许它自己超一点，也绝不切断
      flush()
      parts.push(token.text)
      continue
    }
    pushChunks(token.text)
  }
  flush()
  return parts
}

/** 兼容旧名：把一条消息拆成多条 QQ 气泡（不丢内容）。 */
export function splitBubbles(text, { maxChars = BURST.maxChars } = {}) {
  return splitLongText(text, maxChars)
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)))
const randInt = (min, max, random) => Math.min(max, Math.max(min, min + Math.floor((Number(random?.() ?? Math.random()) || 0) * (max - min + 1))))

/**
 * 只做计划，不发送：返回 [{ text, delayBeforeMs }]；第一条 delayBeforeMs=0。
 * gapMode: auto（默认，含 20% 长停顿）/ fixed / typing / byLength。
 */
export function planBurst(messages, {
  random = Math.random,
  gapMode = 'auto',
  gapMs = null,
  gaps = null,
  pace = 'normal',
  maxMessages = BURST.maxMessages,
  maxChars = BURST.maxChars,
  minGapMs = BURST.minGapMs,
  maxGapMs = BURST.maxGapMs,
  longGapChance = BURST.longGapChance,
  longGapMinMs = BURST.longGapMinMs,
  longGapMaxMs = BURST.longGapMaxMs,
  clampMaxMs = BURST.clampMaxMs,
} = {}) {
  const list = (Array.isArray(messages) ? messages : [messages])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxMessages) || BURST.maxMessages))
    .map((text) => (text.length > maxChars ? splitLongText(text, maxChars).join('') : text))
  const mode = ['auto', 'adaptive', 'fixed', 'typing', 'byLength'].includes(String(gapMode)) ? String(gapMode) : 'auto'
  const hardMin = Math.max(0, Number(minGapMs) || 0)
  const hardMax = Math.max(hardMin, Math.max(Number(clampMaxMs) || BURST.clampMaxMs, Number(maxGapMs) || 0))
  return list.map((text, i) => {
    if (i === 0) return { text, delayBeforeMs: 0 }
    if (mode === 'fixed') {
      const fixed = Array.isArray(gaps) && gaps[i - 1] != null ? Number(gaps[i - 1]) : Number(gapMs)
      const value = Number.isFinite(fixed) && fixed > 0 ? fixed : hardMin
      return { text, delayBeforeMs: clamp(value, BURST.clampMinMs, hardMax) }
    }
    if (mode === 'typing') {
      return { text, delayBeforeMs: clamp(typingMs(list[i - 1] ?? '', { pace }), BURST.clampMinMs, hardMax) }
    }
    if (mode === 'adaptive') {
      // 自适应：下一口气泡越长，等得越久（模拟"在打下一句"）。
      const typed = typingMs(list[i] ?? '', { charsPerSecond: 4, minMs: 600, maxMs: 8_000, pace })
      const base = randInt(hardMin, Math.max(hardMin, Number(maxGapMs) || hardMin), random)
      return { text, delayBeforeMs: clamp(Math.max(base, typed), BURST.clampMinMs, hardMax) }
    }
    if (mode === 'byLength') {
      return { text, delayBeforeMs: clamp(800 + 20 * (list[i - 1] ?? '').length, BURST.clampMinMs, hardMax) }
    }
    const long = Number(longGapChance) > 0 && Number(random?.() ?? Math.random()) < Number(longGapChance)
    const lo = long ? Math.max(hardMin, Number(longGapMinMs) || hardMin) : hardMin
    const hi = long ? Math.max(lo, Number(longGapMaxMs) || lo) : Math.max(lo, Number(maxGapMs) || lo)
    return { text, delayBeforeMs: clamp(randInt(lo, hi, random), BURST.clampMinMs, hardMax) }
  })
}

/** 频率闸门：最近发送时间戳数组 + 窗口上限。 */
export function rateCheck(recentSends, now = Date.now(), { perMinute = BURST.perMinute, perHour = BURST.perHour } = {}) {
  const list = Array.isArray(recentSends) ? recentSends.filter((t) => Number.isFinite(Number(t))) : []
  const lastMinute = list.filter((t) => now - Number(t) < 60_000).length
  const lastHour = list.filter((t) => now - Number(t) < 60 * 60_000).length
  if (perMinute > 0 && lastMinute >= perMinute) return { ok: false, reason: 'per_minute', lastMinute, lastHour }
  if (perHour > 0 && lastHour >= perHour) return { ok: false, reason: 'per_hour', lastMinute, lastHour }
  return { ok: true, reason: null, lastMinute, lastHour }
}

export function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0))
    if (typeof timer.unref === 'function') timer.unref()
  })
}
