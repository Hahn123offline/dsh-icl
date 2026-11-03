# 开测前的准备度检查（2026-11-03）

> 结论：**可以开始一轮受控测试**，但有 4 个"不规范位置"要先记录，其中 2 个
> 属于临时设施，不影响测试结论；另外 2 个会污染测试，需要先处理或明确绕开。

## 已经干净的

| 项 | 状态 |
|---|---|
| 15 个插件 + 7 个时间工具 + 信号层 | 187 测试通过 |
| 做梦流水线（wash 只去 JSON / 事件 / 人物 / 词汇 / 整理） | 固定素材验证过 |
| 人格化压缩 | 已接 live，单元测试覆盖 |
| DSH 会话创建与指向 | 实测通过（`docs/DSH-SESSIONS.md`） |
| 时间模块控制面 | CLI + 验收 9/9 |
| 探针文件 | **已改为只在 `ICL_PROBE=1` 时写**，不再污染 state |

## 不规范位置（按影响排序）

### 1. 适配器依赖是 junction（开发期临时）

`packages/adapters/dsh-client.mjs` 需要 `js-yaml` 和
`@deepseek-ai/dsh-host-apiproxy`，本机用 junction 链到了 `dsh-qq/node_modules`。

- 影响：换机器/清理旧项目就断
- 处理：正式版写进 `package.json` 依赖；测试期先记着
- 风险等级：低（本机可跑）

### 2. 压缩的历史来源是"所有 DSH 会话"

`icl-live` 用 `dsh-raw` 的原文当历史，而它扫的是整台机器的日志。

- 影响：长会话压缩时可能把**别的会话**的内容写进摘要
- 测试期对策：**测试会话控制在 15 分钟内、不发大量内容**，压缩大概率不触发
  （阈值 12000 字符）
- 风险等级：中（只影响长会话）

### 3. 单会话锁没有真正生效

`host.claimSession` 有了，但 `icl-live` 走的是 DSH 原生会话，没有调用它。

- 影响：同时开两个 ICL Live 会话，两个实例都会跑，定时器/记忆各自独立
- 测试期对策：**只开一个测试会话**
- 风险等级：中（人为保证即可）

### 3.5 raw 覆盖不全（新发现）

`dsh-raw` 只解析 `user/message` 与 `assistant/message` **两种事件**。
工具结果（B 站视频信息、评论 JSON、QQ 详情）不在里面，所以：

- raw 不是"唯一完整源"，它缺工具观测
- wash 去掉 JSON 之后，这部分信息就真的丢了

修法（未做）：把 `tool/result` 事件也解析成 raw 行（role=`tool`），raw 保留完整内容；
wash 只影响当天可读的 log，原始 JSON 仍可在 raw 里检索/导出。

### 4. 测试会话不会自己消失

没有接删除会话的 API。

- 影响：每测一次多一个会话，GUI 会越堆越多
- 风险等级：低

## 测试计划（定时器版，已按复盘修正）

**不要预写 `time.json`**：插件启动时会把自己读到的状态写回去，预写可能被覆盖。
正确顺序是"先起会话，再用 inbox 下命令"：

```bash
# 1. 建会话（一个，且只用一个工作区）
node tools/dsh-session.mjs create --preset icl-live \
  --workspace C:/DSH/qwenstuff/icl/state/test-a

# 2. 等插件启动（time.json 时间戳变化）

# 3. 通过控制通道设定时器（会话内 time 插件 15 秒内处理）
node tools/time.mjs arrange \
  '{"mode":"wake","kind":"span","sleep":true,"in":"1m","duration":"3m","message":"你困了"}' \
  --state <会话工作区>/time.json

# 4. 发第一条消息
node tools/dsh-session.mjs prompt --session <id> --text "去刷吧"

# 5. 结束：cancel + memory_export + raw_export
```

`tools/plan-test.mjs` 只在"确认没有旧插件实例"时用来预置状态。

要观察的：

1. 睡觉消息是否准点
2. 睡眠期间外部消息是否积压
3. 醒来是否批释放
4. dream 是否在 sleep-start 时跑、产出块/人物/词汇
5. 压缩是否**没有**在 15 分钟内触发

## 我建议的顺序

1. 先跑这一轮 5 分钟受控测试（确认定时器与做梦在真实会话里工作）
2. 再修第 2 条（会话级历史），然后跑 30 分钟
3. 单会话锁等正式版再做


## 导出通道（新增）

```
memory_export({ path, format: 'json'|'md', namespace? })
  写入整库快照；服务 side 是 memory.exportAll()

raw_export({ path, sessionId?, since?, limit? })
  把某个 DSH 会话的原文导出成文本
```

测试结束后的标准动作：`memory_export` 一份 JSON + `raw_export` 一份原文，
两者一起归档，就能对照"记忆 vs 原话"。
