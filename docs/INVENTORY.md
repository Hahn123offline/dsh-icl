# 盘点：这个仓库现在到底是什么

> 写于 2026-11-02 晚，暂停所有测试与 DSH 接缝之后。
> 事实来源：源码与测试，不是记忆。细节见 `docs/audit/` 下的四份文档。

## 一句话

一个**没有 GUI、没有生产部署**的 ICL 运行时：核心服务 + 15 个插件，用 SQLite 存记忆，
做梦时把原话洗成笔记再凝成块/人物/词汇，靠 DSH 适配器对外接线——**适配器只对假 DSH 测过**。

## 规模

| 部分 | 文件 | 行数 |
|---|---|---|
| 核心 `packages/core/src` | 7 | ~1,070 |
| 插件 `packages/plugins/*` | 15 个插件 | ~2,300 |
| 测试 `packages/core/test` | 35 个文件 | ~2,400 |
| 工具 `tools/` | 9 个脚本 | — |

测试：**154 通过 / 0 失败**（`node --test packages/core/test`，37 个文件）。

## 插件清单（15）

| 插件 | 一句话职责 | 成熟度 |
|---|---|---|
| memory | SQLite 记忆：命名空间、检索、权重、向量 | 成熟 |
| recall | 四类召回（事件/人物/词汇/待解），原文兜底 | 成熟 |
| note | 备忘：建/追加/完成/查询状态 | 成熟 |
| lexicon | 词汇档案：一术语一块、多来源 origins | 成熟 |
| whois | 身份查询（按 QQ/名字/主体），逐句依据 | 成熟 |
| dream | 夜间整理：wash→events→people→lexicon→consume→cleanup→index | 可用，质量待调 |
| persona | 人格卡注入系统提示 | 成熟 |
| world-state | 只读信息总线，深度 2 的树 | 成熟 |
| rhythm | 做梦时间与倒计时（**无真正定时器**） | 简化 |
| eager-recall | 每轮预取召回 | 成熟 |
| compaction | 压缩钩子（**未在 DSH 联调**） | 未验证 |
| dsh-raw | 把 `~/.dsh/sessions` 当原文来源 | 成熟 |
| model-manager | 槽位 → 模型绑定 | 成熟 |
| editor | 最小文件读写（read/write/list） | 最小可用 |
| bili | B 站接缝：子进程调外部 MCP（搜索/看/评论/切帧） | 临时接缝 |

## 现在被关掉的接缝

- **icl-live（DSH 插件）**：已从 `~/.dsh/profiles/desktop/package.json` 的依赖与 bundles 里移除，
  文件仍在 `~/.dsh/plugins/icl-live/`（含 preset 与 bundle patch），需要重启 DSH 才彻底不加载。
- **bili 插件**：留在仓库里，但属于"临时接缝"，不参与正式路径。

## 模型实际看到的世界状态（实测输出）

系统提示里的 `world` 段：

```
时间：现在是 2026-11-02 19:55。；下一次做梦：23:00（还有 3 小时 4 分）。
待办：还有 1 件事没了结。
```

`world_status` 工具默认输出与上面**完全相同**；按 owner 展开：

```
· 现在是 2026-11-02 19:55。
· 下一次做梦：23:00（还有 3 小时 4 分）。
```

已知瑕疵：`。；` 是"时间"与"作息"两个来源同属 `owner: clock` 被 `；` 拼接造成的。

## 文档地图

| 文件 | 内容 |
|---|---|
| `docs/audit/core.md` | 核心服务、契约、数据形状 |
| `docs/audit/memory-plugins.md` | 记忆/召回/笔记/词汇/身份 的工具面与算法 |
| `docs/audit/dream-and-life.md` | 做梦流水线、人格、世界、节律、其余插件 |
| `docs/audit/tooling-and-tests.md` | 测试覆盖、工具脚本、外部依赖、文档准确性 |
| `docs/STATUS.md` | 进度清单与合作约定（会过时，以本盘点为准） |
| `docs/DIAGNOSIS-THIN-MEMORY.md` | 记忆偏薄的四条原因（已部分修复） |
