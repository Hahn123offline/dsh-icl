// 视觉服务：把一张图片交给多模态模型，返回描述。
// 放在核心是因为"插件不许自己发 HTTP"——出站请求统一由核心提供。
import fs from 'node:fs'

export function createVisionService({ fetchImpl = globalThis.fetch } = {}) {
  async function describe({ path: file = null, image = null, prompt = '', system = '', config = {}, maxTokens = 700, timeoutMs = 120_000 } = {}) {
    const baseUrl = config?.baseUrl ?? null
    const model = config?.model ?? null
    const apiKey = config?.apiKey ?? null
    // 默认地址/模型只在这里出现，插件只声明"我要看图"
    const base = String(baseUrl ?? process.env.ICL_VISION_BASE ?? 'http://127.0.0.1:8088/v1').replace(/\/+$/, '')
    const chosen = String(model ?? process.env.ICL_VISION_MODEL ?? 'coder390-27b-q3-df2-4x500')
    if (!base || !chosen) throw new Error('vision.describe 没有可用的模型配置')
    const dataUrl = image
      ? (String(image).startsWith('data:') ? String(image) : `data:image/png;base64,${String(image)}`)
      : (file ? `data:image/png;base64,${fs.readFileSync(String(file)).toString('base64')}` : null)
    if (!dataUrl) throw new Error('vision.describe 需要 path 或 image')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('视觉模型超时')), Math.max(1000, Number(timeoutMs) || 120_000))
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: chosen,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: [
              { type: 'text', text: prompt || '描述这张图片。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ] },
          ],
          max_tokens: Number(maxTokens) || 700,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`视觉模型返回 ${res.status}`)
      const data = await res.json()
      return String(data?.choices?.[0]?.message?.content ?? '').trim()
    } finally { clearTimeout(timer) }
  }
  return { describe }
}
