# ICL

一个最小的中间件适配器：**一个机器一个实例**，只指向一个被指定的 DSH 会话。
功能全部是插件，插件声明工具、提示词段、focus、模型插槽；核心只负责契约。

## 现状

- 阶段：**M0（骨架 + 契约）**
- 不含 QQ / MC / B 站；不含 GUI；不含数据迁移
- 旧服务 `../focus-core` 已停用，仅作参考实现

## 结构

```
packages/core     适配器：host、契约、focus、delivery、prompt、model、session
packages/plugins  插件：persona、world-state（M1 起加入 memory / dream / rhythm …）
```

## 跑

```
npm test
```

## 三条不变量（写进测试）

1. 插件卸载后，模型在下一轮看不到它的工具
2. 同一条消息（plugin+activity+seq）只会被投递一次
3. 投递失败不丢，留在队列里重试
