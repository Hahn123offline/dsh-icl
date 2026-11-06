// DSH 契约：把 ICL 的工具/消息/提示词形状翻译成 DSH 真正认识的东西。
//
// 这些形状来自安装包，不是猜的：
//   · ctx.tools.register 要求 { name, description, parameters, output, execute }
//     —— output 缺失会抛 TypeError（@deepseek-ai/dsh-tools register）
//   · parameters 是原始 JSON Schema（@deepseek-ai/dsh-llm ToolSchema）
//   · 消息是 { id, role:'user', content:[{type:'text',text}], source:{kind:'user'} }
//     —— id 用 randomUUID，与 createUserMessage 一致
//
// 本文件不 import 任何 @deepseek-ai/*：核心保持零依赖，测试可在本机跑。

import { randomUUID } from 'node:crypto'

/** 工具结果在 DSH 里的规范形状：只能是声明的 JSON 值。 */
export const TEXT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
})

/**
 * 带图片的工具结果：`{ text, images?: ImageAttachmentRef[] }`。
 *
 * 图片**不是**路径：路径在 execute 阶段已经被 `ctx.attachments.saveImage()` 换成
 * 不可变引用（ref），这里只负责把它渲染成 DSH 的 image content block。
 * `images` 可选：绝大多数 ICL 工具仍然只回文本。
 *
 * 注意：这里必须是**合法 JSON Schema**。旧版 DSH（0.2.0-rc.2）不接受
 * `items: { type: 'json' }`（非标准类型），会让 `ctx.tools.register` 抛错、
 * 进而静默丢掉全部 ICL 工具（见 docs/E2-BLOCKER-tool-registration.md）。
 * 图片能力本身还有 bridge 的运行时回退（text-only），见 bridge.syncTools。
 */
export const IMAGE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['text'],
})

/** 规范化 ICL 的 JSON Schema 参数：对象必须显式 additionalProperties。 */
export function normalizeParameters(parameters) {
  const schema = parameters && typeof parameters === 'object' ? parameters : { type: 'object' }
  if (schema.type !== 'object') return { ...schema }
  const properties = {}
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    properties[key] = normalizeValueSchema(value)
  }
  const normalized = { type: 'object', properties, additionalProperties: schema.additionalProperties === true }
  if (Array.isArray(schema.required)) {
    // 只保留确实声明过的属性，避免 DSH 校验出 "required 指向不存在的属性"
    const required = schema.required.filter((key) => Object.hasOwn(properties, key))
    if (required.length) normalized.required = required
  }
  if (typeof schema.description === 'string') normalized.description = schema.description
  return normalized
}

function normalizeValueSchema(value) {
  if (!value || typeof value !== 'object') return { type: 'string' }
  if (value.type === 'object') {
    const properties = {}
    for (const [key, child] of Object.entries(value.properties ?? {})) properties[key] = normalizeValueSchema(child)
    const normalized = { ...value, type: 'object', properties, additionalProperties: value.additionalProperties === true }
    if (Array.isArray(value.required)) {
      const required = value.required.filter((key) => Object.hasOwn(properties, key))
      if (required.length) normalized.required = required
      else delete normalized.required
    }
    return normalized
  }
  if (value.type === 'array') {
    return { ...value, type: 'array', ...(value.items ? { items: normalizeValueSchema(value.items) } : {}) }
  }
  return { ...value }
}

/**
 * ICL 插件执行结果 → DSH 规范值。字符串与 { text } 都接受。
 *
 * 图片：插件可以回 `{ text, images: [绝对路径] }`（或旧的单个 `imagePath`）。
 * 给了 `saveImage` 时，路径会被提交成 attachment 引用，模型真的能看到图；
 * 没给（测试/老宿主）时退化成文本提示——绝不假装图已经在上下文里。
 * @param {unknown} result
 * @param {{ saveImage?: ((file: string) => Promise<unknown>) | null }} [options]
 */
export async function normalizeToolResult(result, { saveImage = null } = {}) {
  if (result == null) return { text: '' }
  if (typeof result === 'string') return { text: result }
  if (typeof result !== 'object') return { text: String(result) }
  const text = typeof result.text === 'string' ? result.text : String(result.text ?? '')
  const listed = Array.isArray(result.images)
    ? result.images.filter((file) => typeof file === 'string' && file)
    : []
  if (typeof result.imagePath === 'string' && result.imagePath) listed.push(result.imagePath)
  if (!listed.length) return { text }

  if (typeof saveImage === 'function') {
    const images = []
    for (const file of listed) {
      try {
        const ref = await saveImage(file)
        if (ref) images.push(ref)
      } catch { /* 单张失败不拖垮整次调用，下面会退回文本提示 */ }
    }
    if (images.length) return { text, images }
  }
  // 没有附件服务：至少别让路径信息丢掉。
  const suffix = listed.map((file) => `（图片文件：${file}）`).join('\n')
  return { text: [text, suffix].filter(Boolean).join('\n') }
}

/**
 * 把 ICL 工具定义翻成 DSH 的 ToolDefinition（含必填 output）。
 * @param {object} definition
 * @param {{ execute?: Function | null, saveImage?: ((file: string) => Promise<unknown>) | null }} [options]
 */
export function toDshToolDefinition(definition, { execute = null, saveImage = null, imageOutput = true } = {}) {
  const name = String(definition?.name ?? '')
  if (!name) throw new Error('DSH 工具缺少 name')
  if (typeof definition.execute !== 'function' && typeof execute !== 'function') {
    throw new Error(`${name} 缺少 execute`)
  }
  return {
    name,
    description: String(definition.description ?? definition.summary ?? ''),
    parameters: normalizeParameters(definition.parameters),
    output: imageOutput
      ? {
          schema: IMAGE_OUTPUT_SCHEMA,
          render: (_args, value) => {
            const images = Array.isArray(value?.images) ? value.images : []
            const blocks = images.map((attachment) => ({ type: 'image', attachment }))
            blocks.push({ type: 'text', text: String(value?.text ?? '') })
            return blocks
          },
        }
      : {
          // 兼容旧 DSH：只声明文本输出；图片以"（图片文件：路径）"文本返回，不假装已进上下文。
          schema: TEXT_OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
    async execute(args, exec) {
      const out = await (execute ?? definition.execute)(args, exec)
      // 回退到 text-only 时不要提交附件（output schema 不声明 images，提交了反而可能被宿主拒绝）。
      return normalizeToolResult(out, { saveImage: imageOutput ? saveImage : null })
    },
  }
}

/**
 * 一条 user-role 消息；与 @deepseek-ai/dsh-llm 的 createUserMessage 同形。
 * images 是 DSH attachment ref 列表（ImageAttachmentRef），由 bridge 用
 * ctx.attachments.saveImages 生成；字节/路径/URL 都不进正文。
 */
export function toDshUserMessage(text, { id = null, source = { kind: 'user' }, images = [] } = {}) {
  const body = String(text ?? '')
  const content = []
  if (body || !Array.isArray(images) || images.length === 0) content.push({ type: 'text', text: body })
  for (const attachment of Array.isArray(images) ? images : []) {
    if (!attachment || typeof attachment !== 'object') continue
    content.push({ type: 'image', attachment })
  }
  return {
    id: id ?? randomUUID(),
    role: 'user',
    content,
    source,
  }
}

/**
 * 系统提示词段：text 是函数，每次装配求值，不重注册。
 *
 * `range`（可选 {minOrder,maxOrder}）用来把 ICL 的段切成"静态块 / 易变事实块"：
 * DSH 对系统提示词的新增/替换是整段语义，本地引擎又按前缀保留 KV，
 * 所以静态段进 systemPrompt.section、易变段由调用方注册成 runtime-context。
 */
export function toDshPromptSection({ host, sessionId = null, name = 'icl:core', order = 30, onError = null, range = null }) {
  const currentSession = typeof sessionId === 'function' ? sessionId : () => sessionId
  return {
    name,
    order,
    text: () => {
      try {
        return host.services.prompt.assemble({ sessionId: currentSession() ?? undefined }, range)
      } catch (error) {
        onError?.(error)
        return ''
      }
    },
  }
}

/** 从 DSH session event 里取模型可见文本（user/assistant/tool）。 */
export function textOfSessionEvent(event) {
  const data = event?.data ?? event ?? {}
  if (event?.type === 'tool/result') {
    const blocks = data?.message?.content ?? data?.content
    return textFromContent(blocks)
  }
  const message = data.message ?? data
  return textFromContent(message?.content ?? message)
}

function textFromContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content.text === 'string') return content.text
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .filter(Boolean)
    .join('\n')
}
