# 测试原则：当事人的第一感受优先（2026-11-06 用户拍板）

> 用户原话（2026-11-06）："所有测试都要考虑当事人的第一感受，否则会丢失大量消息。后续记住任何测试时的回复都很重要。"
> 背景：长跑/lab 测试里，受试会话的**第一人称回复**（聊天、抱怨、困惑、反复说的话）往往比 metrics 更早暴露真问题（如 local3 的 say 刷屏、shelter 反复失败、暂停死锁）。只抄 metrics 会丢消息。

## 规则

1. **任何测试都必须保存受试者的第一人称输出**：`transcript.md` + `events.jsonl`（assistant/message、user/message、tool/call/result）为最低证据；不得只在报告里写汇总数字。
2. **报告必须引用当事人原话**：每个 P0/P1 结论至少附 1 条受试原话（截断到必要长度）或事件 seq；"她说了什么/她重复说了什么/她卡在哪"优先于"turns/tools 统计"。
3. **聊天/抱怨/重复话是信号**：同一句 say ≥3、同一工具参数 ≥3、反复问同一句、明显困惑措辞 = 触发人工复核，不能当噪声过滤掉。
4. **测试结束先收当事人证据再收资源**：停进程前确认 transcript/events 已落盘；清理 workspace 不删除 run 证据（证据在 `.state/lab/<run>/`，桌面 session 清理不影响它）。
5. **测试 workspace 不得污染 desktop**：lab 使用共享 `$DSH_HOME` 时，sessions/workspace.json 会进 desktop 列表；每次 lab down 后必须清理本次 run 的 workspace/session（工具见 `tools/dsh-clean-test-workspaces.mjs`，只清 `icl-wt/*`、`.state/lab/*`、`her-lab-workspace`、`.state/live2` 等测试路径，保留用户真实工作区，备份到 `.state/archive/desktop-cleanup-*`）。
6. **隐私/人格**：受试者的第一人称内容属于当事人；只在本地证据与报告中引用必要片段，不自动外发。

## 落地位置

- `docs/E2-HARNESS.md §10/§11`：长跑验收必须包含"第一人称证据" gate。
- `docs/TIME.md`/`docs/QQ.md` 的测试章节引用本文件。
- 任何新测试脚本的验收报告模板：先引用当事人原话，再列 metrics。
