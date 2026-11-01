# 插件实现报告（M0–M1）

> 用途：让主人看清"哪些是我替你定的细节、哪些是还空着的功能需求"。
> 当前所有实现都是**基础设施级**：没有主动行为、没有人格设定、没有定时打扰。
> 39 条测试，全部在 `packages/core/test`。

---

## 〇、核心（不是插件）

| 服务 | 做什么 | 明确不做 |
|---|---|---|
| `host` | 插件登记/启用/停用、注销器生命周期、依赖检查（`requires.plugins`） | 不加载网络插件、不做热更新 |
| `tools` | **唯一**工具注册通道：`register()` 返回注销器 | 不做工具分级/权限（留给以后） |
| `prompt` | 命名段 + order + 函数求值 + 条件 | 不拼整段系统提示词，不写"你该怎么做" |
| `focus` | 租约、TTL、glob 穿透规则 | 不替模型切焦点，不主动打扰 |
| `delivery` | 唯一投递通道：exactly-once、批次合并、ack 推进水位、nack 重试 | 不做通道优先级、不做"重要消息"判断 |
| `slots` | 插件声明形状，管理器按形状接线 | 不选模型、不知道具体服务 |
| `model-client` | 绑定、暂停、超时、401 重取凭据重试 | 不决定用哪个模型 |
| `session` | 单会话适配器：装配提示词、安装工具、drain 投递 | 不绑定多个会话 |

**边界守卫（有测试）**：插件直接 import `dsh-tools`、自己 `fetch`、写死 `baseUrl/apiKey`、插槽写 `model` —— 一律构建失败。

---

## 一、persona（人格）

- **职责**：提供"一张卡"+ 版本历史回滚。
- **清单**：tools 无；slots 无；无依赖（memory 可选）。
- **注入**：段 `persona`，order 20，`text: () => current`（每次装配求值 → 改完下一句就生效）。
- **服务**：`persona.current() / set(text,{by}) / rollback(idOrOffset) / versions(limit)`。
- **存储**：有 memory → 命名空间 `persona`，`persona-current` 一条 + `persona-version` 每版一条，超 50 版删最旧；没有 memory → 纯内存，`versions()` 返回空，日志写 `persisted:false`。

**我定的细节**
1. **不主动改卡**：没有任何工具让模型改自己的人格；只有别的插件/主控调用服务。
2. 版本号是 `v:<时间戳>-<序号>`（同秒不会互相覆盖）。
3. 回滚把"当前版本"也存成一条历史，所以回滚本身也可回滚。
4. `set('')` 直接拒绝（空卡会让模型失去身份，属于危险操作）。

**要你确认**：卡存 memory 命名空间 vs 独立文件？现在前者（不产生第二份库）。

---

## 二、memory（记忆）

- **职责**：通用记忆库，唯一真实源。
- **清单**：tools 无（被动）；slots `embed-text`（kind embedding, requires `dim:1024`）。
- **服务**：`put / query / search / remove / namespaces / stats / index`。
- **存储**：`state/memory.db`（SQLite 单文件，node:sqlite），表 `mem_items` + `mem_vec`。
- **检索**：插槽绑定了嵌入 → 余弦排序；没绑定 → 退化成 `LIKE` 关键词，不报错。
- **命名空间**：调用方自己带（`light:<session>`、`dream:<session>`、`persona`），插件之间零共享。

**我定的细节**
1. `key` 唯一（同命名空间内）→ 用来"更新而不是新增"。
2. `search` 默认只在该命名空间内，绝不跨命名空间（防串味）。
3. 向量存 Float32Array BLOB，先在内存里算余弦（目前数据量小，够用；以后换索引是内部事）。
4. 嵌入调用失败静默降级成关键词，不抛。

**要你确认**：`dim 1024` 是否就是 bge-m3 的维度（旧项目用 1024）？如果管理器的实际供应商是别的维度，这条插槽会一直 unmatched（测试里故意演示了）。

---

## 三、light-memory（轻量记忆）

- **职责**：当天可读写的短记忆，夜里交给梦境。
- **清单**：tools `remember / recall / forget`；依赖 memory。
- **命名空间**：`light:<sessionId>`（会话隔离，避免多个会话互相污染）。
- **工具语义**：
  - `remember(text, key?)` —— 一句话；给 key 则更新同一条
  - `recall(query?, limit?)` —— 只读**今天**（`dayStart..now`）
  - `forget(key)` —— 删自己的一条
- **不建库**：全部走 memory 服务。

**我定的细节**
1. 只暴露"记 / 看 / 删"三个，不给模型"清空全部"（危险且不需要）。
2. `recall` 只返回今天的——昨天的已经进长期记忆，不从这里召回（符合草稿）。
3. 工具描述是英文契约，不提任何设定（"你是……"这类话不在工具里）。

**要你确认**：`key` 对模型隐藏语义（它只要知道"可以覆盖同一条"）；是否需要"列出所有 key"的工具？现在不给。

---

## 四、rhythm（节律）

- **职责**：只做"到点触发做梦"。
- **清单**：tools 无；服务 `rhythm.onNightly(cb) / fire() / at`。
- **实现**：每 30 秒检查本地时间是否等于配置的 `dreamAt`（默认 22:30），当天只触发一次（用 `lastDay` 去重）。
- **明确不做**：闹钟、计时器、日历、随机唤醒——都没有。

**我定的细节**
1. 用"分钟粒度 + 当天去重"，不引入时区库；系统时区变了会按新时区算（简单）。
2. `fire()` 暴露给测试/手动触发；生产里不会自己多触发。
3. 没有持久化"今天已经触发过"——进程重启后同一天可能再触发一次（细节，可补）。

**要你确认**：重启后同日重复触发可接受吗？（补一行 kv 就解决，但会引入存储依赖）

---

## 五、dream（梦境）

- **职责**：被动记忆沉淀器。
- **清单**：slots `dream-chat`（kind chat, requires `tools:false`）；依赖 memory + rhythm。
- **服务**：`dream.run({now})`；启用时订阅 `rhythm.onNightly`。
- **流程**：取当天 `light:<session>` 笔记 → 拼成 user 消息 → `slots.call('dream-chat')` → 写 `dream:<session>` 命名空间（kind `summary`，key `dream:<dayStart>`）→ 若 memory 支持嵌入就异步 `index()`。
- **失败**：没有笔记 → `{skipped:'no-notes'}`；插槽没绑 → `{ok:false,error,slot}`，不写空记忆。

**我定的细节**
1. 提示词只有一句"压成第一人称、只留真会再想起的事"，不写人格、不写风格。
2. 一条总结对应当天（key 用 dayStart），同一天重跑会更新同一条。
3. 不产生"梦的内容"，只是沉淀（符合草稿）。
4. 没有重试/补偿：失败就等下一次触发（M1 够用）。

**要你确认**：summary 的长度上限我只传了 `maxTokens: 600`，没有字数后处理；要不要截断？

---

## 六、world-state（世界状态）

- **职责**：被动拼装 + 分层渲染。
- **清单**：tools `world_status(layer)`；无 slots/deps。
- **服务**：`world.registerSource({id, layer:'summary'|'detail', order, text}) / render(layer) / sources()`。
- **默认来源**：时间（summary, order 10）。
- **分层语义**：`summary` 只渲染 summary 层；`detail` 渲染两层。提示词里**永远只放 summary**。
- **不采集**：QQ/MC 以后各自注册来源，但只能注册计数/摘要，明细留给 detail。

**我定的细节**
1. 来源文本可以是函数（每次渲染求值）。
2. 单个来源抛错 → 跳过那一条，不影响整体。
3. 没有"筛选器 DSL"：现在只有两层 + order，够用且不会变成半个模板引擎。

**要你确认**：`detail` 是否要再分"按来源展开"（如 `world_status({source:'qq'})`）？现在不支持。

---

## 七、model-manager（模型管理）

- **职责**：把"服务"变成"按形状描述的供应商"，给插槽接线。
- **清单**：tools 无；无 slots。
- **服务**：`providers() / rebind() / unmatched()`。
- **流程**：读 `config.providers`（`id/kind/shape/baseUrl/model/apiKey`）→ `registerProvider` → `autoBind` → 订阅 `slots.onChange` 再绑。
- **chat 供应商**：走核心 `ctx.model.chat`（统一客户端：暂停/超时/401 重试都在那里）。
- **embedding 供应商**：走 `ctx.fetch`（唯一的 HTTP 出口），调用 `/embeddings`。

**我定的细节**
1. 它是**唯一**允许发 HTTP 的插件（边界测试放行它一个）。
2. 绑定策略是"第一个形状匹配的供应商"——没有优先级、没有权重、没有 fallback 链。
3. 不认识 `kind` → 抛错，不静默跳过。
4. 不管插件启停（那是宿主的事），也不管"要不要用模型"（那是 focus/投递的事）。

**要你确认**：需要"多供应商 + 优先级/降级"吗？现在是单匹配，够 M1，但真实环境可能需要。

---

## 八、我没有做、也不打算在这个阶段做的

- 任何主动行为：主动说话、主动记忆、主动提醒、情绪状态
- QQ / MC / B 站（M2 之后，按新契约重写，不搬旧代码）
- GUI / HTTP 控制台
- 多会话并发（适配器只认一个指定会话）
- 数据迁移
- 付费模型路由、配额、计费

---

## 九、需要你逐条拍板的细节（汇总）

1. persona 的卡存 memory 命名空间，还是独立文件？
2. memory 的嵌入维度 1024 是否正确？
3. rhythm 重启后同日重复触发，可接受还是补持久化？
4. dream 的总结是否需要硬字数上限？
5. world 的 detail 是否要支持"按来源展开"？
6. model-manager 是否需要多供应商优先级/降级？
