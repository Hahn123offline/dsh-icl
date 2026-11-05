// 第一屏净化（红队 P0-1）：用"同名空段"在 agent scope 影子掉 DSH 全局的工程脚手架段。
//
// DSH 的 systemPrompt 分层语义（安装包 `SystemPrompt.section()` 文档）：
//   "A scoped section shadows a global section with the same name; duplicates within one layer throw."
// 所以预设里的插件只要注册一个**同名、空文本**的 section，就能让那一段消失，而：
//   · 不改全局配置（不需要用户批准宿主的 dsh-system-prompt config）；
//   · 不用 `complete: true`（那会整段替换、丢掉工具调用指引）；
//   · 不碰 cache 的 facts/system 布局（我们只 shadow 非 ICL 段，icl:core / icl:facts 不在这张表里）。
//
// order 取自 DSH 的 SECTION_ORDERS（安装包常量，这里只镜像需要的几项；空段的位置不影响渲染）。
export const PURIFY_CATALOG = Object.freeze({
  'harness:identity': -1000,                 // "You are an AI agent powered by DeepSeek Harness."
  'ui:deliverable-file-references': 9000,    // Markdown/Office/present/file-link 那大段（~1.3k 字）
  'harness:source': 10000,                   // "The DeepSeek Harness implementation checkout is at …"
  'app:web-surface': 10100,                  // "You are interacting with the user through the … Web GUI at …"
})

/**
 * 解析要净化的段名（允许配置里写任意 DSH 段名；未知名字给出稳定 order=9000 并在返回里标注）。
 * @param {string[]} names
 * @returns {{name:string, order:number, known:boolean}[]}
 */
export function resolvePurifySections(names = []) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const known = Object.hasOwn(PURIFY_CATALOG, name)
    out.push({ name, order: known ? PURIFY_CATALOG[name] : 9000, known })
  }
  return out
}

/**
 * 通过某个 scope 的 ctx 注册空段影子。
 * @param {{systemPrompt?:{section?:Function}}} ctx 插件 ctx 或 agent.ctx
 * @param {string[]} names 段名
 * @returns {{applied:string[], failed:{name:string,error:string}[], offs:Function[]}}
 */
export function registerPurifyShadows(ctx, names = []) {
  const applied = []
  const failed = []
  const offs = []
  const section = ctx?.systemPrompt?.section
  if (typeof section !== 'function') {
    return { applied, failed: names.map((name) => ({ name: String(name), error: 'systemPrompt.section 不可用' })), offs }
  }
  for (const { name, order } of resolvePurifySections(names)) {
    try {
      const off = section.call(ctx.systemPrompt, { name, order, text: '' })
      offs.push(typeof off === 'function' ? off : () => {})
      applied.push(name)
    } catch (error) {
      failed.push({ name, error: String(error?.message ?? error) })
    }
  }
  return { applied, failed, offs }
}
