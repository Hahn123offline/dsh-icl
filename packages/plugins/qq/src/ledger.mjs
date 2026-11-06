// QQ 入站账本：消息事实 + 每活动单调 seq + 水位（seen/delivered）。
//
// 为什么需要它（旧项目教训，见 docs/QQ-GAP.md §1.1/§2）：
//   · 断线补课需要"这条消息我处理过没有"的持久事实，光靠内存去重撑不过重启；
//   · "水位"只在**消息进入投递并且没有被闸门拦下**时前进；被 time/focus 拦下的留在水位之后，
//     等重放时按 signal id 去重，不能假装看过；
//   · 补课的 signal.id 复用原始 message_id（normalize.signalIdFor），所以账本与 signals 的幂等键同源。
//
// 存储：默认 SQLite（node:sqlite，与 memory 插件同路）；打不开时降级内存表并留日志——
// 绝不因为账本坏了就丢入站消息。
//
// 注意：插件能看到的最远一步是 signals.offer 被接受（进入 delivery 队列，未被 time/focus 拦下）。
// 真正的 bridge ack 在 dsh-icl 里，插件侧拿不到回调；因此这里的 delivered = "已交给投递队列"。
// 这个边界写在 docs/QQ.md 里，不能把它说成"用户已看到"。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_TEXT = 1000

function clip(value, max) {
  const s = value == null ? '' : String(value)
  return s.length > max ? s.slice(0, max) : s
}

function memoryLedger() {
  const activities = new Map() // activity -> { nextSeq, attendedSeq, lastQqId, lastAt, lastInAt, rows: Map<seq,row>, byQqId: Map<qqId,seq> }
  const get = (activity) => {
    let row = activities.get(activity)
    if (!row) {
      row = { nextSeq: 1, attendedSeq: 0, lastQqId: null, lastAt: null, lastInAt: null, rows: new Map(), byQqId: new Map() }
      activities.set(activity, row)
    }
    return row
  }
  /** 连续已交付高水位：从 seq=1 起逐条看 deliveredAt，遇到第一条未交付就停（跨过它不安全）。 */
  const deliveredThrough = (row) => {
    if (!row) return 0
    let through = 0
    for (const message of [...row.rows.values()].sort((a, b) => a.seq - b.seq)) {
      if (message.seq === through + 1 && message.deliveredAt != null) through = message.seq
      else if (message.seq > through + 1) break
    }
    return through
  }
  return {
    mode: 'memory',
    append({ activity, qqId = null, signalId = null, at = null, sentAt = null, receivedAt = null, sender = '', text = '', mention = false, media = null }) {
      const key = String(activity)
      const row = get(key)
      const id = qqId == null ? null : String(qqId)
      if (id && row.byQqId.has(id)) return { seq: row.byQqId.get(id), duplicate: true }
      const seq = row.nextSeq
      row.nextSeq += 1
      const message = {
        activity: key, seq, qqId: id, signalId: signalId == null ? null : String(signalId),
        at: Number(at) || null, sentAt: Number(sentAt) || null, receivedAt: Number(receivedAt) || null,
        sender: clip(sender, 200), text: clip(text, MAX_TEXT), mention: mention === true,
        media: media ? JSON.stringify(media) : null, deliveredAt: null, repliedAt: null,
        blockedReason: null, blockedAt: null,
      }
      row.rows.set(seq, message)
      if (id) row.byQqId.set(id, seq)
      row.lastQqId = id ?? row.lastQqId
      row.lastAt = message.at ?? row.lastAt
      row.lastInAt = message.receivedAt ?? row.lastInAt
      return { seq, duplicate: false }
    },
    hasMessage(activity, qqId) {
      const row = activities.get(String(activity))
      return Boolean(row && qqId != null && row.byQqId.has(String(qqId)))
    },
    markDelivered(activity, seq) {
      const row = activities.get(String(activity))
      const message = row?.rows.get(Number(seq))
      if (!message) return false
      if (message.deliveredAt == null) message.deliveredAt = Date.now()
      message.blockedReason = null
      message.blockedAt = null
      // 只记录"交付"事实，不动 attended：delivered 只代表进了投递队列，不代表模型看过/读过。
      return true
    },
    markBlocked(activity, seq, reason = 'blocked', at = Date.now()) {
      const row = activities.get(String(activity))
      const message = row?.rows.get(Number(seq))
      if (!message || message.deliveredAt != null) return false
      message.blockedReason = clip(reason, 200) || 'blocked'
      message.blockedAt = Number(at) || Date.now()
      return true
    },
    watermarks(activity) {
      const row = activities.get(String(activity))
      if (!row) return { lastSeq: 0, deliveredSeq: 0, attendedSeq: 0, undelivered: 0 }
      const deliveredSeq = deliveredThrough(row)
      const lastSeq = row.nextSeq - 1
      let undelivered = 0
      for (const message of row.rows.values()) if (message.deliveredAt == null) undelivered += 1
      return { lastSeq, deliveredSeq, attendedSeq: Math.min(row.attendedSeq, deliveredSeq), undelivered }
    },
    /** 未交付的账本行（通常是被 time/focus 拦下）：可见、可解释，但不许被 mark_read 跨过。 */
    undelivered(activity, { limit = 20 } = {}) {
      const row = activities.get(String(activity))
      if (!row) return []
      return [...row.rows.values()].filter((m) => m.deliveredAt == null).sort((a, b) => a.seq - b.seq)
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 20))).map((m) => ({ ...m }))
    },
    /** 按 seq 取消息（升序）；beforeSeq 用于"更早的 N 条"。 */
    messages(activity, { afterSeq = 0, beforeSeq = null, limit = 50 } = {}) {
      const row = activities.get(String(activity))
      if (!row) return []
      const max = Math.max(1, Math.min(200, Number(limit) || 50))
      const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0
      const rows = [...row.rows.values()].sort((a, b) => a.seq - b.seq)
        .filter((m) => m.seq > after && (beforeSeq == null || m.seq < Number(beforeSeq)))
      return rows.slice(0, max).map((m) => ({ ...m }))
    },
    /** 水位之后的消息（= 还没被算作"处理过"的）。 */
    unread(activity, { afterSeq = null, limit = 20 } = {}) {
      const row = activities.get(String(activity))
      if (!row) return { watermark: { attendedSeq: 0, lastSeq: 0 }, messages: [] }
      const after = afterSeq != null && Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : Math.min(row.attendedSeq, deliveredThrough(row))
      const messages = [...row.rows.values()].filter((m) => m.seq > after).sort((a, b) => a.seq - b.seq)
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 20))).map((m) => ({ ...m }))
      let undelivered = 0
      for (const message of row.rows.values()) if (message.deliveredAt == null) undelivered += 1
      return {
        watermark: {
          attendedSeq: Math.min(row.attendedSeq, deliveredThrough(row)),
          deliveredSeq: deliveredThrough(row),
          lastSeq: row.nextSeq - 1,
          undelivered,
          lastAt: row.lastAt,
        },
        messages,
      }
    },
    markReplied(activity, { throughSeq = null, at = Date.now() } = {}) {
      const row = activities.get(String(activity))
      if (!row) return 0
      const through = Number.isFinite(Number(throughSeq)) ? Number(throughSeq) : row.nextSeq - 1
      let count = 0
      for (const message of row.rows.values()) {
        if (message.seq <= through && message.repliedAt == null) { message.repliedAt = at; count += 1 }
      }
      return count
    },
    /** 手动标记已读：只推进水位（不发送、不标记 replied、不碰投递）。**不许跨过未交付空洞**。 */
    markRead(activity, { throughSeq = null, at = Date.now() } = {}) {
      const row = activities.get(String(activity))
      if (!row) return { attendedSeq: 0, deliveredSeq: 0, lastSeq: 0, advanced: 0, clampedToDelivered: false }
      const lastSeq = row.nextSeq - 1
      const deliveredSeq = deliveredThrough(row)
      const attended = Math.min(row.attendedSeq, deliveredSeq)
      const requested = throughSeq != null && Number.isFinite(Number(throughSeq)) ? Math.max(0, Number(throughSeq)) : deliveredSeq
      const through = Math.min(deliveredSeq, requested)
      if (through <= attended) return { attendedSeq: attended, deliveredSeq, lastSeq, advanced: 0, clampedToDelivered: requested > deliveredSeq, requested }
      const advanced = through - attended
      row.attendedSeq = through
      return { attendedSeq: through, deliveredSeq, lastSeq, advanced, clampedToDelivered: requested > deliveredSeq, requested }
    },
    replyState(activity, { messageId = null } = {}) {
      const row = activities.get(String(activity))
      if (!row) return messageId == null ? { lastSeq: 0, lastRepliedSeq: 0, lastRepliedAt: null, unreplied: 0 } : { found: false, replied: false }
      if (messageId != null) {
        const seq = row.byQqId.get(String(messageId))
        if (!seq) return { found: false, replied: false, messageId: String(messageId) }
        const message = row.rows.get(seq)
        return { found: true, messageId: String(messageId), seq, replied: message.repliedAt != null, repliedAt: message.repliedAt ?? null, at: message.at ?? null }
      }
      const rows = [...row.rows.values()].sort((a, b) => a.seq - b.seq)
      const repliedRows = rows.filter((m) => m.repliedAt != null)
      const lastReplied = repliedRows.length ? repliedRows[repliedRows.length - 1] : null
      return {
        lastSeq: row.nextSeq - 1,
        lastRepliedSeq: lastReplied ? lastReplied.seq : 0,
        lastRepliedAt: lastReplied ? lastReplied.repliedAt : null,
        unreplied: rows.filter((m) => m.repliedAt == null).length,
      }
    },
    lastKnown(activity) {
      const row = activities.get(String(activity))
      return row ? { lastQqId: row.lastQqId, lastAt: row.lastAt, attendedSeq: Math.min(row.attendedSeq, deliveredThrough(row)), deliveredSeq: deliveredThrough(row), lastInAt: row.lastInAt, lastSeq: row.nextSeq - 1 } : null
    },
    activities() {
      const out = []
      for (const [activity, row] of activities) {
        const rows = [...row.rows.values()]
        out.push({
          activity, total: rows.length, delivered: rows.filter((m) => m.deliveredAt != null).length,
          attendedSeq: Math.min(row.attendedSeq, deliveredThrough(row)), deliveredSeq: deliveredThrough(row),
          lastAt: row.lastAt, lastQqId: row.lastQqId,
        })
      }
      return out
    },
    stats() {
      let messages = 0
      let delivered = 0
      for (const row of activities.values()) {
        messages += row.rows.size
        for (const m of row.rows.values()) if (m.deliveredAt != null) delivered += 1
      }
      return { mode: 'memory', file: null, activities: activities.size, messages, delivered }
    },
    close() {},
  }
}

function sqliteLedger(file, log) {
  let db
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE IF NOT EXISTS qq_messages (
        activity TEXT NOT NULL,
        seq INTEGER NOT NULL,
        qq_id TEXT,
        signal_id TEXT,
        at INTEGER,
        sent_at INTEGER,
        received_at INTEGER,
        sender TEXT,
        text TEXT,
        mention INTEGER NOT NULL DEFAULT 0,
        media TEXT,
        delivered_at INTEGER,
        replied_at INTEGER,
        blocked_reason TEXT,
        blocked_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (activity, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_qq_messages_qq_id ON qq_messages(activity, qq_id);
      CREATE INDEX IF NOT EXISTS ix_qq_messages_at ON qq_messages(activity, at);
      CREATE TABLE IF NOT EXISTS qq_activity (
        activity TEXT PRIMARY KEY,
        next_seq INTEGER NOT NULL DEFAULT 1,
        attended_seq INTEGER NOT NULL DEFAULT 0,
        last_qq_id TEXT,
        last_at INTEGER,
        last_in_at INTEGER,
        updated_at INTEGER
      );
    `)
    // 旧库升级：replied_at（P1）/ blocked_reason、blocked_at（交付水位修复）都是后加的列。
    try { db.exec('ALTER TABLE qq_messages ADD COLUMN replied_at INTEGER') } catch { /* 已存在 */ }
    try { db.exec('ALTER TABLE qq_messages ADD COLUMN blocked_reason TEXT') } catch { /* 已存在 */ }
    try { db.exec('ALTER TABLE qq_messages ADD COLUMN blocked_at INTEGER') } catch { /* 已存在 */ }
  } catch (error) {
    try { db?.close() } catch { /* ignore */ }
    log?.({ level: 'warn', msg: 'qq.ledger.open-fail', error: String(error?.message ?? error), file })
    return null
  }

  const stAppendDup = db.prepare('SELECT seq FROM qq_messages WHERE activity = ? AND qq_id = ?')
  const stActivity = db.prepare('SELECT next_seq, attended_seq, last_qq_id, last_at, last_in_at FROM qq_activity WHERE activity = ?')
  const stInsert = db.prepare(`
    INSERT INTO qq_messages (activity, seq, qq_id, signal_id, at, sent_at, received_at, sender, text, mention, media, delivered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `)
  const stUpsertActivity = db.prepare(`
    INSERT INTO qq_activity (activity, next_seq, attended_seq, last_qq_id, last_at, last_in_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(activity) DO UPDATE SET
      next_seq = excluded.next_seq,
      last_qq_id = COALESCE(excluded.last_qq_id, qq_activity.last_qq_id),
      last_at = COALESCE(excluded.last_at, qq_activity.last_at),
      last_in_at = COALESCE(excluded.last_in_at, qq_activity.last_in_at),
      updated_at = excluded.updated_at
  `)
  const stHas = db.prepare('SELECT 1 AS hit FROM qq_messages WHERE activity = ? AND qq_id = ?')
  const stDeliver = db.prepare('UPDATE qq_messages SET delivered_at = COALESCE(delivered_at, ?), blocked_reason = NULL, blocked_at = NULL WHERE activity = ? AND seq = ?')
  const stBumpAttended = db.prepare('UPDATE qq_activity SET attended_seq = MAX(attended_seq, ?), updated_at = ? WHERE activity = ?')
  const stSetAttended = db.prepare('UPDATE qq_activity SET attended_seq = ?, updated_at = ? WHERE activity = ?')
  const stBlocked = db.prepare('UPDATE qq_messages SET blocked_reason = ?, blocked_at = ? WHERE activity = ? AND seq = ? AND delivered_at IS NULL')
  const stGap = db.prepare('SELECT MIN(seq) AS gap FROM qq_messages WHERE activity = ? AND delivered_at IS NULL')
  const stUndeliveredCount = db.prepare('SELECT COUNT(*) AS n FROM qq_messages WHERE activity = ? AND delivered_at IS NULL')
  const stUndelivered = db.prepare(`
    SELECT activity, seq, qq_id, signal_id, at, sent_at, received_at, sender, text, mention, media, delivered_at, replied_at, blocked_reason, blocked_at
    FROM qq_messages WHERE activity = ? AND delivered_at IS NULL ORDER BY seq ASC LIMIT ?
  `)
  const stLast = db.prepare('SELECT last_qq_id, last_at, attended_seq, last_in_at, next_seq FROM qq_activity WHERE activity = ?')
  const stMessages = db.prepare(`
    SELECT activity, seq, qq_id, signal_id, at, sent_at, received_at, sender, text, mention, media, delivered_at, replied_at, blocked_reason, blocked_at
    FROM qq_messages
    WHERE activity = ? AND seq > ? AND (? IS NULL OR seq < ?)
    ORDER BY seq ASC LIMIT ?
  `)
  const stUnread = db.prepare(`
    SELECT activity, seq, qq_id, signal_id, at, sent_at, received_at, sender, text, mention, media, delivered_at, replied_at, blocked_reason, blocked_at
    FROM qq_messages
    WHERE activity = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `)
  const stMarkReplied = db.prepare('UPDATE qq_messages SET replied_at = ? WHERE activity = ? AND seq <= ? AND replied_at IS NULL')
  const stReplyByQq = db.prepare('SELECT seq, at, replied_at FROM qq_messages WHERE activity = ? AND qq_id = ?')
  const stReplyAgg = db.prepare(`
    SELECT MAX(CASE WHEN replied_at IS NOT NULL THEN seq END) AS last_replied_seq,
           MAX(replied_at) AS last_replied_at,
           SUM(CASE WHEN replied_at IS NULL THEN 1 ELSE 0 END) AS unreplied,
           (SELECT next_seq - 1 FROM qq_activity WHERE activity = ?) AS last_seq
    FROM qq_messages WHERE activity = ?
  `)
  const stActivities = db.prepare(`
    SELECT a.activity,
           a.attended_seq,
           a.last_at,
           a.last_qq_id,
           a.next_seq,
           COUNT(m.seq) AS total,
           SUM(CASE WHEN m.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
           MIN(CASE WHEN m.delivered_at IS NULL THEN m.seq END) AS first_undelivered
    FROM qq_activity a
    LEFT JOIN qq_messages m ON m.activity = a.activity
    GROUP BY a.activity
    ORDER BY a.last_in_at DESC
  `)
  const stStats = db.prepare(`
    SELECT COUNT(*) AS messages,
           SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
    FROM qq_messages
  `)
  const stActivityCount = db.prepare('SELECT COUNT(*) AS n FROM qq_activity')

  function mapMessage(row) {
    return {
      activity: String(row.activity),
      seq: Number(row.seq),
      qqId: row.qq_id == null ? null : String(row.qq_id),
      signalId: row.signal_id == null ? null : String(row.signal_id),
      at: row.at == null ? null : Number(row.at),
      sentAt: row.sent_at == null ? null : Number(row.sent_at),
      receivedAt: row.received_at == null ? null : Number(row.received_at),
      sender: String(row.sender ?? ''),
      text: String(row.text ?? ''),
      mention: Number(row.mention) === 1,
      media: row.media == null ? null : row.media,
      deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
      repliedAt: row.replied_at == null ? null : Number(row.replied_at),
      blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
      blockedAt: row.blocked_at == null ? null : Number(row.blocked_at),
    }
  }

  /** 连续已交付高水位（遇到第一条未交付就停）与未交付数。 */
  function watermarksOf(key) {
    const known = stLast.get(key)
    if (!known) return { lastSeq: 0, deliveredSeq: 0, attendedSeq: 0, undelivered: 0 }
    const lastSeq = Number(known.next_seq) - 1
    const gap = stGap.get(key)?.gap
    const deliveredSeq = gap == null ? lastSeq : Number(gap) - 1
    const attendedSeq = Math.min(Number(known.attended_seq) || 0, deliveredSeq)
    const undelivered = Number(stUndeliveredCount.get(key)?.n) || 0
    return { lastSeq, deliveredSeq, attendedSeq, undelivered }
  }

  return {
    mode: 'sqlite',
    append({ activity, qqId = null, signalId = null, at = null, sentAt = null, receivedAt = null, sender = '', text = '', mention = false, media = null }) {
      const key = String(activity)
      const id = qqId == null ? null : String(qqId)
      if (id) {
        const dup = stAppendDup.get(key, id)
        if (dup) return { seq: Number(dup.seq), duplicate: true }
      }
      const row = stActivity.get(key)
      const seq = row ? Number(row.next_seq) : 1
      const atNum = Number(at) || null
      const receivedNum = Number(receivedAt) || null
      const nowMs = Date.now()
      stInsert.run(key, seq, id, signalId == null ? null : String(signalId), atNum, Number(sentAt) || null, receivedNum, clip(sender, 200), clip(text, MAX_TEXT), mention === true ? 1 : 0, media ? JSON.stringify(media) : null, nowMs)
      stUpsertActivity.run(key, seq + 1, id ?? null, atNum, receivedNum, nowMs)
      return { seq, duplicate: false }
    },
    hasMessage(activity, qqId) {
      return qqId != null && Boolean(stHas.get(String(activity), String(qqId)))
    },
    markDelivered(activity, seq) {
      const key = String(activity)
      const n = Number(seq)
      if (!Number.isFinite(n) || n <= 0) return false
      const result = stDeliver.run(Date.now(), key, n)
      if (!result || result.changes === 0) return false
      return true
    },
    markBlocked(activity, seq, reason = 'blocked', at = Date.now()) {
      const key = String(activity)
      const n = Number(seq)
      if (!Number.isFinite(n) || n <= 0) return false
      const result = stBlocked.run(clip(reason, 200) || 'blocked', Number(at) || Date.now(), key, n)
      return Boolean(result?.changes)
    },
    watermarks(activity) {
      return watermarksOf(String(activity))
    },
    undelivered(activity, { limit = 20 } = {}) {
      return stUndelivered.all(String(activity), Math.max(1, Math.min(100, Number(limit) || 20))).map(mapMessage)
    },
    lastKnown(activity) {
      const key = String(activity)
      const row = stLast.get(key)
      if (!row) return null
      const watermark = watermarksOf(key)
      return {
        lastQqId: row.last_qq_id == null ? null : String(row.last_qq_id),
        lastAt: row.last_at == null ? null : Number(row.last_at),
        attendedSeq: watermark.attendedSeq,
        deliveredSeq: watermark.deliveredSeq,
        lastInAt: row.last_in_at == null ? null : Number(row.last_in_at),
        lastSeq: watermark.lastSeq,
      }
    },
    messages(activity, { afterSeq = 0, beforeSeq = null, limit = 50 } = {}) {
      const rows = stMessages.all(String(activity), Number(afterSeq) || 0, beforeSeq == null ? null : Number(beforeSeq), beforeSeq == null ? null : Number(beforeSeq), Math.max(1, Math.min(200, Number(limit) || 50)))
      return rows.map(mapMessage)
    },
    unread(activity, { afterSeq = null, limit = 20 } = {}) {
      const key = String(activity)
      const watermark = watermarksOf(key)
      const after = afterSeq != null && Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : watermark.attendedSeq
      const rows = stUnread.all(key, after, Math.max(1, Math.min(100, Number(limit) || 20)))
      const known = stLast.get(key)
      return {
        watermark: {
          attendedSeq: watermark.attendedSeq,
          deliveredSeq: watermark.deliveredSeq,
          lastSeq: watermark.lastSeq,
          undelivered: watermark.undelivered,
          lastAt: known?.last_at == null ? null : Number(known.last_at),
        },
        messages: rows.map(mapMessage),
      }
    },
    markReplied(activity, { throughSeq = null, at = Date.now() } = {}) {
      const key = String(activity)
      const known = stLast.get(key)
      const through = Number.isFinite(Number(throughSeq)) ? Number(throughSeq) : (Number(known?.next_seq ?? 1) - 1)
      const result = stMarkReplied.run(at, key, through)
      return Number(result?.changes) || 0
    },
    markRead(activity, { throughSeq = null, at = Date.now() } = {}) {
      const key = String(activity)
      const known = stLast.get(key)
      if (!known) return { attendedSeq: 0, deliveredSeq: 0, lastSeq: 0, advanced: 0, clampedToDelivered: false }
      const watermark = watermarksOf(key)
      const requested = throughSeq != null && Number.isFinite(Number(throughSeq)) ? Math.max(0, Number(throughSeq)) : watermark.deliveredSeq
      const through = Math.min(watermark.deliveredSeq, requested)
      if (through <= watermark.attendedSeq) {
        return { attendedSeq: watermark.attendedSeq, deliveredSeq: watermark.deliveredSeq, lastSeq: watermark.lastSeq, advanced: 0, clampedToDelivered: requested > watermark.deliveredSeq, requested }
      }
      stBumpAttended.run(through, at, key)
      return { attendedSeq: through, deliveredSeq: watermark.deliveredSeq, lastSeq: watermark.lastSeq, advanced: through - watermark.attendedSeq, clampedToDelivered: requested > watermark.deliveredSeq, requested }
    },
    replyState(activity, { messageId = null } = {}) {
      const key = String(activity)
      if (messageId != null) {
        const row = stReplyByQq.get(key, String(messageId))
        if (!row) return { found: false, replied: false, messageId: String(messageId) }
        return {
          found: true, messageId: String(messageId), seq: Number(row.seq),
          replied: row.replied_at != null, repliedAt: row.replied_at == null ? null : Number(row.replied_at),
          at: row.at == null ? null : Number(row.at),
        }
      }
      const row = stReplyAgg.get(key, key) ?? {}
      return {
        lastSeq: Number(row.last_seq) || 0,
        lastRepliedSeq: Number(row.last_replied_seq) || 0,
        lastRepliedAt: row.last_replied_at == null ? null : Number(row.last_replied_at),
        unreplied: Number(row.unreplied) || 0,
      }
    },
    activities() {
      return stActivities.all().map((row) => {
        const lastSeq = Number(row.next_seq) - 1
        const deliveredSeq = row.first_undelivered == null ? lastSeq : Number(row.first_undelivered) - 1
        return {
          activity: String(row.activity),
          total: Number(row.total) || 0,
          delivered: Number(row.delivered) || 0,
          attendedSeq: Math.min(Number(row.attended_seq) || 0, deliveredSeq),
          deliveredSeq,
          lastAt: row.last_at == null ? null : Number(row.last_at),
          lastQqId: row.last_qq_id == null ? null : String(row.last_qq_id),
        }
      })
    },
    stats() {
      const row = stStats.get() ?? {}
      return { mode: 'sqlite', file, activities: Number(stActivityCount.get()?.n) || 0, messages: Number(row.messages) || 0, delivered: Number(row.delivered) || 0 }
    },
    close() {
      try { db?.close() } catch { /* ignore */ }
    },
  }
}

/**
 * 打开账本。file=null 或不传 → 纯内存（测试/无状态场景）；打开失败 → 内存降级 + 日志。
 * @returns {object} append/hasMessage/markDelivered/lastKnown/activities/stats/close
 */
export function createLedger({ file = null, log = () => {} } = {}) {
  if (!file) return memoryLedger()
  const sqlite = sqliteLedger(String(file), log)
  if (sqlite) return sqlite
  log({ level: 'warn', msg: 'qq.ledger.memory-fallback', file })
  return memoryLedger()
}

export { MAX_TEXT }
