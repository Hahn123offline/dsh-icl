# 插槽契约（M1 定稿）

## 一句话

**插件只声明"我要什么形状的模型"，从不写模型名、地址、key；模型管理插件按形状把供应商接上去。**

## 插件侧

在 `manifest.json` 里声明：

```json
"slots": [
  { "id": "embed-text", "kind": "embedding", "requires": { "dim": 1024 } },
  { "id": "dream-chat", "kind": "chat", "requires": { "tools": false } }
]
```

- `id`：本插件内的插槽名（同类插件各用各的，不冲突）
- `kind`：`chat` / `embedding`（以后可扩展 `image`、`rerank` …）
- `requires`：**形状要求**，逐项精确匹配（现在只支持相等，够用）

调用只走插槽：

```js
const text = await ctx.slots.call('dream-chat', { messages, maxTokens: 600 })
const vec = await ctx.slots.call('embed-text', { input: '今天的事' })
```

没接上时 `call` 抛 `SLOT_UNBOUND`；插件要自己降级（记忆插件就退化成关键词检索）。

## 模型管理侧

供应商是"形状 + 调用方式"：

```js
ctx.slots.registerProvider({
  id: 'bge-m3', kind: 'embedding',
  shape: { dim: 1024 },
  async call({ input }) { … }
})
```

管理器在启用时 `autoBind()`：**第一个形状匹配的供应商**接上；
之后任何新插槽出现（插件启用）也会自动再绑一次（订阅 `slots.onChange`）。

## 为什么这样

- 换模型 = 换供应商，插槽与调用方一行不改
- 维度/能力不匹配会表现为"没有绑定"（可见、可测），而不是运行到一半报错
- 插件里不出现 baseUrl / model / apiKey，也就不可能偷偷直连
