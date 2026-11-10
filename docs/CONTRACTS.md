# 结构化契约（Tool Contract / Feature Contract）

> 2026-11-10 P0。目标不是写协议文档，而是让“工具存在”和“模型被告知”在同一套注册流程里。

## 1. 两层

### Tool Contract

工具自己的契约跟着工具定义走：

```js
ctx.tools.register({
  name: 'compact_context',
  summary: '本轮结束后请求原生压缩',
  contract: {
    feature: 'compaction',
    requiresServices: ['compaction'],
    fallback: '当前宿主没有原生压缩服务',
    modelHint: '本轮只登记，下一轮才变短',
  },
  async execute() {},
})
```

- 工具参数、用法、单工具行为留在 `summary`/`description`；
- `contract` 只是可选元数据，不自动变成提示词；
- 不要求每个工具都写 `contract`：没有依赖/特殊失败语义的工具，`description` 本身就是契约。

### Feature Contract

跨工具/系统的行为登记到核心：

```js
ctx.contracts.registerFeature({
  id: 'compaction',
  order: 790,
  prompt: '需要时调用 compact_context；本轮结束后执行，下一轮才变短。',
  requiresServices: ['compaction'],        // provided service
  when: () => Boolean(service),
})
```

核心行为：

- 依赖的工具/service 都在，才把 `prompt` 放进提示词；
- 缺依赖时整段消失，不发布半截；
- `when` 抛错只让该契约不出现，不影响其他段；
- `ctx.contracts.status(id)` 返回 `{active, missingTools, missingServices}`。

## 2. 失败与注册原子性

- 插件 `apply` 失败：宿主回滚它注册的工具、提示词段、契约与 service；
- 工具在 DSH 侧注册失败：bridge 调 `host.services.contracts.markToolUnavailable(name, error)`；
  依赖它的 Feature Contract 立即失活；
- 工具注销/插件停用：工具从 core 工具面消失，依赖契约自动消失；
- 不做“提示词里有、工具清单里没有”。

## 3. 为什么不是每个工具都往 sim 写一段

- 69 个工具各写一段会制造第二套工具说明书，且与工具 description 重复；
- 工具 description 天然随注册出现/消失；
- 只有跨工具行为、可见性节奏、失败语义才进 Feature Contract；
- 人格/说话方式仍在 persona/sim，动态数值仍在 facts。

## 4. 当前落地

- `packages/core/src/services.mjs`：`createContractRegistry`、工具 `contract` 元数据；
- `host.mjs`：`ctx.contracts`、`host.services.contracts`；
- `dsh-icl/src/bridge.mjs`：
  - `compact_context` 是无条件注册的延迟原生压缩工具；
  - DSH 工具注册失败会标记 unavailable；
  - `compaction` Feature Contract 只在原生 service 可用时出现；
- `prompts/sim.md` 不再写死 `compact_context` 的条件说明；该行为由 Feature Contract 管。

## 5. 尚未做

- 把 `vitals_status` 做成正式只读工具；
- 把更多现有提示词行为迁移到 Feature Contract（需逐个评估是否属于 feature 而非 sim）；
- 为每个工具强制 `contract` 字段（当前刻意不强制，避免形式化）。
