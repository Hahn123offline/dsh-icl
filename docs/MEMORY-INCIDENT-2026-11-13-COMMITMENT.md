# P0 事件记录：记忆状态说"承诺 25"，recall kind=commitment 却返回空

- 日期：2026-11-13 21:22（live 观察期第 1 天）
- 级别：P0（记忆自知与检索契约不一致，直接误导 Agent 放弃回忆）
- 状态：根因已定位；修复已实现并测试；待重启 DSH 生效
- 变更预算：本周第 1 个改动（P0）

## 1. 现象（用户原文）

世界状态行注入：
> 记忆：经历 67 段（10-22..11-11）；上次整理 11-12 形成 0 段；未结承诺 25；人物 8；语料 37。

ICL 看到「未结承诺 25」后调用：
```json
{ "kind": "commitment", "limit": 10 }
```
得到：
> 最近没有能想起来的（范围内的记忆是空的）。

随后判断"没有"，不再深究。

## 2. 根因链（四层）

1. **状态口径**：`memoryState()` 统计的是 episode 的**块内注释** `data.annotations.commitments`
   （live：67 段里有 25 条），标签却写成「未结承诺」——让人以为存在独立、可查询的承诺条目。
2. **检索实现没跟上 v3**：recall 的显式分类分支 `namespaces = [kind]` 直接搜旧 namespace。
   v3 下 `commitment / fact / preference` 旧 namespace **从未写入**（live 行数 0），
   于是 `kind=commitment` 必然空；`kind=event` 同样搜旧 event 归档（live 39 行全部 superseded/归档）。
   schema=v3 的命名空间过滤只作用于默认路径，没作用于显式 kind。
3. **空结果话术**：无 query 时直接返回「范围内的记忆是空的」，没有说明"承诺在经历块注释里"，
   也没有给出下一步（`kind=commitment` 无 query 本应列出块内承诺）。
4. **Agent 行为**：模型据此判断"记忆里没有承诺"，停止追问——这是合理的；错在工具/状态的契约。

**排除项**：`人物 8` 不是 bug——live person block 共 12，其中 4 条 superseded，存活 8 条；
`语料 37` 与 lexicon 行数一致。

## 3. 修复（已实现）

1. **v3 分类映射**（recall）：
   - `kind=event` → 检索 `episode`；
   - `kind=commitment / fact / preference` → 检索带对应 `annotations` 字段的 episode；
2. **无 query 的显式分类**：直接列出最近带该注释的经历，并渲染
   `（块内承诺：…）`，不再返回空；
3. **有 query 的显式分类**：候选只保留带该注释的 episode，命中的注释挂到结果上直接展示；
   全部不相关时明确说"有 N 段经历带承诺注释，可以不带 query 查看"，而不是"记忆是空的"；
4. **状态行措辞**：`未结承诺 25` → `块内承诺 25 条（历史累计）`；
   memory_status 详情注明"可能已兑现/过时，用 recall kind=commitment 查看"；
5. recall 工具描述补充 v3 语义（event→episode、typed→块内注释）；
6. 测试：新增 `kind=commitment` 无 query 列出承诺、`kind=event` 映射到 episode；
   更新状态行断言。

**live 库拷贝验证**（修复后）：
- `kind=commitment, limit=5` 返回 5 段经历及块内承诺（如「以后要压缩上下文先打招呼…」）；
- `kind=event, limit=3` 返回 3 段经历完整正文；
- `memory_status` 显示「块内承诺 25 条（历史累计）」。

## 4. 同次排查发现的第二个问题（待决策，未修）

**未完结日被提前 dream 并写死账本**：
- live 账本显示 `run:2026-11-13:episodes` 在 **11-13 21:06** 执行成功，
  payload 328 字、episodes=0、`empty=true`；
- 当时 11-13 还未结束（用户 21:22 仍在对话）。`alreadyRan(day, 'episodes')` 已置位，
  当晚后续消息在之后 dream 中会被 skip，存在"当天后段内容不进入记忆"的数据丢失风险；
- 可能原因：睡眠触发的 dream 在 21:06 把 target day 算成"今天"，而正常 23:00/04:00 的账本语义
  假设"一天只整理一次"。

**候选修复（尚未实施，需拍板）**：
- A. 目标日规则：`now < 22:00` 时 dream 只整理**昨天**，避免处理未完结日；
- B. 增量重跑：当天已有账本时，若 raw 行数增长则允许 episodes 增量补跑（复杂，风险高）；
- C. 接受现状：睡眠即视为当天结束（若用户常在 21 点睡且不再醒，可接受）。

> 该问题独立于本次 P0；按变更预算不顺手改，先记录并由用户选择。

## 5. 观察期影响

- 本次是观察期第 1 天暴露的 P0，符合"P0 才修"的规则；
- 修复需**重启一次 DSH** 生效；重启后再观察：
  - 世界状态行是否显示「块内承诺 N 条（历史累计）」；
  - ICL 是否能用 `kind=commitment` 直接看到承诺；
  - 下次 dream 账本时间/目标日是否符合预期。

---

## 6. 契约修复更新（2026-11-13 晚，替换最初的映射补丁）

用户确认"按 1→2→3 修契约"后，已把最初 `kind→annotations` 的临时映射替换为：

1. **统一能力表** `packages/core/src/memory-capabilities.mjs`：
   - v3 可查询类型只有 `episode / person / lexicon`；
   - `event / fact / preference / commitment / slang` 标记为归档 namespace，v3 读取路径不得读取；
   - recall kind 枚举、默认范围、eager 可见集、memory_status 词表由同一份表驱动。
2. **recall**：v3 拒绝 `kind=commitment/fact/preference/event`，返回
   "没有这个记忆分类：… 可用：episode / person / lexicon"，不再静默查旧 namespace；
   承诺问题用 `recall(query)`，注释仍参与内容门槛/排序，并展示为「块内承诺：…」。
3. **whois**：改用同一 schema/能力表，v3 只读 episode/annotations；补上此前从未输出的档案正文；
   "最近事件"来自 episode（按 people/entities/别名）。
4. **自知**：world 不再显示「未结承诺」；memory_status 只写"块内承诺注释（历史记录，不跟踪完成状态）"。
5. 测试：新增 whois v3、kind 枚举、旧 kind 拒绝、状态措辞；全仓 925 tests / 924 pass。
6. 三源 db-seed 回归：focus 90.6/anyHit 100、QQ 96.2/anyHit 100、live 100/anyHit 100（无回退）。

**仍需遵守**：本修复只统一了 v3 读取契约；`mem_ns.recallable` 旧标记、段级分区、v2 归档数据清理
仍是后续独立议题（见 MEMORY-COMPONENT-AUDIT.md）。
