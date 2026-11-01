# 后续待办（逐步做，不一次做完）

## 1. 人物档案的通用性

目标：记忆里的人物档案**不与 QQ 绑定**。

- 现在 `person` 块的 `data.qq` 是必填语义，`findPerson({qq})` 也只认 QQ
- 要改成通用的 `subject`：`{ kind: 'qq' | 'mc' | 'discord' | 'name' | 自定义, value }`
- `ids` 已经是数组，扩成"任意身份"即可；旧的 `qq` 字段保留为兼容别名
- 人物 job 的输出 schema 要允许任意 `kind`
- whois 的入口也要从 `qq` 变成 `idKind + value` 或 `name`

验收：能用 MC 账号、Discord ID、纯名字各建一份档案并查回。

## 2. 工具面暴露与动态注入

目标：核心能真正兑现"动态注入工具"，并接线已有工具，让预设不是空白。

- 现在 session adapter 有 `toolDefinitions()`，但没有正式的"工具面"服务：
  谁在什么时候把工具交给 DSH、如何增量更新、如何声明禁用
- 需要一个 `toolSurface`：`expose(namespace?)`、`list()`、`onChange`、
  与 preset 的映射（哪个插件属于哪个预设）
- 未来 QQ 走同一条路：插件注册，核心暴露，适配器注入

验收：一个只有 memory 的会话，工具面里只有 remember/recall/forget；
启用 note 后，工具面出现 memo/memos，且不需要重启。

## 3. 记忆的自定义标签与来源

目标：记忆支持按自定义标签查找与展示，并能回答"这条记忆来自哪个聊天"。

- `data.tags` 已有，但只在 event 上、且只做过滤
- 要变成通用字段：任意命名空间都能带 tags；`memory.tags()` 已有频次
- 来源：`data.origin = { conv: 'group:1057812765', sender: '...', messageId }`
- recall / whois 展示时能带"来自哪个会话"
- 标签要有上限与归一化（复用 `normalizeTags`）

验收：`recall({tag:'看海', origin:'group:1057812765'})` 能工作。

## 3.5 适配器：把工具面/预设真正交给 DSH（已完成主体，待真实 DSH 联调）

- `surface.list()` 已经能回答"该给哪些工具"，但**没有代码把它注入 DSH**
- 需要 DSH 插件侧：读 `surface` + `presets.active()`，转成 `ctx.tools.register`，
  并在 `surface.onChange` 时增量更新
- 预设切换要能在会话内生效（我们自己的 preset，不是 DSH 的）
- 已实现：`attachDshAdapter(host, dsh)`，用假 DSH 测过注入/切换/卸载
- 待办：真实 DSH 联调（它的 tools.register 与 systemPrompt.section 契约）

## 4. slang 命名空间要改

梗的维护方式和事件/人物都不一样（需要：来源、时效、是否过气、同义词合并）。
等 1–3 完成后单独设计，先记着：**它现在只是能跑，不是最终形态**。

---

## 审计遗留（本轮已处理）

| 项 | 处理 |
|---|---|
| note 部分覆盖被误标已消化 | 只标被引用到的 note |
| 人物路由靠字数猜 | 改成显式 `kind=person` 参数 |
| dsh-raw 全量缓存无淘汰 | 加 TTL + 条数上限 |
| 时间注入不一致 | dream 统一走 `ctx.now()` |
| focus 服务零使用 | 保留为预留能力，未接任何插件；若两轮内仍无用则删除 |
