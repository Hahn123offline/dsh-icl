// 原文行的来源画像：产品形成链路与评测工具共用同一份分类，避免两套实现漂移。
//
// 分类语义（2026-11-11 Phase 1，审计 F6/R2）：
//   human          真人直接说的话（DSH 直聊用户消息）
//   qq_envelope    QQ 未读摘要/私信信封：里面包着真人的话，但外层是转述
//   agent_visible  她真正发出去的回复（可以作为共同经历的上下文）
//   agent_internal 旧 raw 里混进来的未发送计划/推理，不进形成材料
//   tool           工具结果
//   env            心跳、状态通知、闹钟等环境事件
//   memory         我们自己注入的上下文（不该再被当成记忆原料）
//   unknown        无法判断：保守保留（宁可多记，也不能丢真人话）
//
// 输入可以是 bridge 的 raw 行（role/time/text/...），也可以是评测 fixture 行
// （带 source 字段）；raw 服务注册时会注入 sourceId，不参与这里的判断。

export const RAW_SOURCES = Object.freeze([
  'human', 'qq_envelope', 'agent_visible', 'agent_internal', 'tool', 'env', 'memory', 'unknown',
])

/** 形成阶段允许进主材料的来源。 */
export const FORMATION_SOURCES = Object.freeze(['human', 'qq_envelope', 'agent_visible', 'unknown'])

/** 评测 fixture 的 profile 选择器用：判断一行是否属于形成主材料。 */
export function isFormationSource(source) {
  return FORMATION_SOURCES.includes(String(source ?? 'unknown'))
}

const SOURCE_SET = new Set(RAW_SOURCES)

/**
 * 判断一条 raw 行的来源。优先显式字段（sourceKind / source），
 * 否则按 role + 文本信封特征兜底。
 */
export function inferRawSource(row) {
  const explicit = String(row?.sourceKind ?? row?.source ?? '').trim()
  if (SOURCE_SET.has(explicit)) return explicit
  const role = String(row?.role ?? '')
  const text = String(row?.text ?? '').trim()
  if (text.startsWith('<icl-context>')) return 'memory'
  if (role === 'tool') return 'tool'
  if (role === 'assistant') {
    // 旧 raw 里混着未发送的英文计划；无中文且像 plan 的长文本按"内部思考"处理。
    const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjk === 0 && text.length > 40 && /\b(?:I|we|let me|maybe|should|need|actually|okay)\b/i.test(text)) return 'agent_internal'
    return 'agent_visible'
  }
  // QQ 未读摘要/私聊信封里包着真人的话：单独一类，形成时保留但要提醒模型"这是转述"。
  if (text.startsWith('QQ 还有没看过的消息') || /^\[QQ[^\]]*\]/.test(text)) return 'qq_envelope'
  if (role === 'user') {
    if (text.startsWith('【心跳】') || text.startsWith('[QQ戳一戳]') || /^Alarm fired/.test(text)) return 'env'
    return 'human'
  }
  return 'unknown'
}
