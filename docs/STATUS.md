# 当前状态清单（冻结快照）

> 目的：在接 DSH、开长测之前，把"哪些是真的、哪些只是脚手架"钉死。
> 每次改动请更新本文件，不要靠记忆。
>
> 快照时间：2026-11-02（后续已变化）。**本文件的进度结论已被 `docs/TECHNICAL.md` + `docs/audit/` 取代。**

---

## A. 100% 已实现（有测试覆盖，可以依赖）

### A1. 核心（`packages/core`，无运行时依赖）

| 能力 | 文件 | 测试 |
|---|---|---|
| 插件宿主、生命周期、enable/disable | `host.mjs` | `host.test.mjs` |
| 工具注册表（描述合成、索引、参数校验） | `services.mjs` | `tool-constraints.test.mjs` |
| 工具面 surface（按预设过滤、变更通知） | `services.mjs` | `surface.test.mjs` |
| 提示词段 prompt sections + 每轮 brief | `services.mjs` | `context.test.mjs` |
| 槽位 slots（按 shape 匹配、失败回退） | `services.mjs` | `focus-model.test.mjs` 等 |
| 投递 delivery（`plugin\|activity\|seq` 恰好一次、ack/nack） | `services.mjs` | `delivery.test.mjs` |
| 原文来源 raw registry（search / list） | `services.mjs` | `dsh-raw.test.mjs` |
| 模型客户端（chat / chatDetailed 带 reasoning） | `model-client.mjs` | 间接覆盖 |
| 预设 presets（运行时切换） | `services.mjs` | `presets.test.mjs` |
| 会话装配（工具定义、系统提示） | `session.mjs` | `loop.test.mjs` |
| 边界规则（插件不直接发 HTTP 等） | — | `boundary.test.mjs` |

### A2. 记忆与召回

| 能力 | 状态 | 测试 |
|---|---|---|
| SQLite 存储、命名空间注册（recallable / halfLifeDays） | ✅ | `m1-plugins.test.mjs` |
| 混合检索（向量 + 字面 bigram + 字面词加权） | ✅ | `recall.test.mjs`、`literal.test.mjs` |
| 标签过滤、会话过滤、cursor | ✅ | `origin-tags.test.mjs` |
| 归档回退（raw 原文补细节） | ✅ | `archive-fallback.test.mjs` |
| 人物检索 `findPerson`（qq / name / subject） | ✅ | `route-person.test.mjs`、`subject.test.mjs` |
| 权重衰减、boost、补向量 | ✅ | `vector-backfill.test.mjs` |

### A3. 插件（15 个）

| 插件 | 成熟度 | 备注 |
|---|---|---|
| `memory` | ✅ 成熟 | 核心存储 |
| `recall` | ✅ 成熟 | 四类召回 + 原文兜底 |
| `note` | ✅ 成熟 | memo / memo_append / memo_commit / note_status |
| `lexicon` | ✅ 成熟 | 一术语一块，origins 多来源 |
| `dream` | ⚠️ 可用但质量待调 | 见 C 区 |
| `persona` | ✅ | 人格卡注入 |
| `world-state` | ✅ | 世界状态源汇总 |
| `rhythm` | ⚠️ 简化 | 固定做梦时间 + 倒计时，**无完整节律** |
| `eager-recall` | ✅ | 预取召回 |
| `compaction` | ⚠️ 未在 DSH 验证 | 单元测试有，真实压缩未联调 |
| `dsh-raw` | ✅ | 把 `~/.dsh/sessions` 当原文源 |
| `whois` | ✅ | 身份查询 + 逐句依据 |
| `model-manager` | ✅ | 槽位绑定模型 |
| `editor` | ⚠️ 最小可用 | 只有 read/write/list，无版本、无行编辑 |
| `bili` | ⚠️ 临时接缝 | 见 C 区 |

---

## B. 只是脚手架（不属于产品，随时可删）

| 东西 | 用途 | 风险 |
|---|---|---|
| `tools/marathon.mjs` | 自建 agent 循环，模拟"刷 B 站" | **不是产品路径**；协议是自定 JSON，真实 DSH 不走这里 |
| `tools/replay.mjs` | 用历史 QQ 记录回放做梦 | 只验证管线，不产生正式记忆 |
| `tools/recall-bench.mjs` / `recall-diagnose.mjs` | 召回基准与漏斗诊断 | 依赖冻结题目 |
| `tools/cleanup-eval.mjs` / `dream-eval.mjs` / `threshold-calib.mjs` | 评估/调参 | — |
| `tools/bili-run.py` | 调 bili-duty 的子进程桥 | 正式版应改成 MCP 客户端或库调用 |
| `config/marathon*.json`、`prompts/marathon.md` | 测试用的角色与配置 | 不是正式人格 |
| `state/marathon-*` | 测试产物与导出 | 可直接删 |
| `~/.dsh/plugins/icl-live` | 让 ICL 在 DSH 会话里跑的插件 | **尚未加载成功**，见 D |

---

## C. 临时实现 / 想到啥写啥（能跑，但不是最终形态）

1. **`bili` 插件**：子进程调 `bili-duty` 的 MCP 函数；路径写死；只有搜索/看/评论/切帧；**没有楼中楼、没有下载、没有关注流**。
2. **`bili_frames`**：调 `dsh-video-storyboard` 的 CLI，默认截前 4 分钟、240p；**会阻塞数十秒**。
3. **wash 的输入**：总预算 12000 字、单行 1200 字（`ctx.config.washChars` / `washLineChars`）。
4. **wash 的笔记**：带 `who` 时会写 `data.subject`，但**没有时间戳**，所以"按时间段成块"做不了。
5. **人物归属**：靠 wash 的 `who`，**没有"同一 UP 多次出现"判定**（按你的要求，不做机械阈值）。
6. **工具时间戳**：`ICL_TOOL_TIME=1` 时在每次工具结果后追加当前时间。
7. **`chatDetailed`**：新加，取 `reasoning_content`；思考记录只在脚手架里用。
8. **`icl-live` 插件**：提示词是**加载时快照**，世界状态不会每轮刷新。

---

## D. 明确没做（不要以为有）

| 缺口 | 影响 |
|---|---|
| **DSH 真实集成** | 适配器只对 fake DSH 测过；`icl-live` 未加载成功（见下） |
| **会话自动创建** | 旧插件用 `api.sessions.create`，我们没接 |
| **楼中楼** | `bili_comments` 只有顶层 + top_replies，翻不了楼 |
| **时间优先的块** | 块仍按"同一件事"合并，不是按时间段 |
| **印象优先** | wash 提示词还没强调"先挑留下印象的" |
| **完整节律** | 只有固定 23:00 做梦 + 倒计时 |
| **真实压缩联调** | `compaction` 插件未在 DSH 里跑过 |
| **向量索引常开** | 测试会话里 vectors=0，召回实际走字面 |
| **30 分钟正式长测** | 配置在，没跑 |

---

## E. 为什么 `icl-live` 没加载（已修复，待重启验证）

DSH 的插件不是放进 `~/.dsh/plugins/` 就自动生效，要满足三个条件：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里有它（`link:` 指向插件目录）
2. 同文件的 `dsh.profile.bundles` 数组里列出包名
3. 跑一次 `pnpm install`，然后重启 DSH

我们的插件目前**三个都没做**，而且 `package.json` 还缺 `dsh.bundle.patch`（指向一个 preset yml）。

**这是"接 DSH"这一整块还没完成的地面工作**，不是重启能解决的。

---

## F. 接 DSH 还有哪些地面工作（按顺序）

1. 给 `icl-live` 补 `dsh.bundle.patch` + 一个最小 preset yml
2. 加进 profile 依赖与 bundles，`pnpm install`
3. 重启，确认工具面出现在会话里
4. 世界状态/人格改成**每轮刷新**（接 `session/event`）
5. 确认模型能选到本地 llama-swap
6. 再谈"插件自动建会话"

在这六步完成之前，**不要开始 30 分钟长测**——否则测试结果会被接线问题污染。


---

## G. DSH 接线进度（2026-11-02 晚）

已完成：

1. `dsh.bundle.patch` + `presets/icl-live.patch.yml`（preset id `icl-live`，显示名「ICL Live」）
2. profile `dependencies` 加了 `dsh-icl-live: link:...`，`dsh.profile.bundles` 加了 `dsh-icl-live`
3. `pnpm install` 通过（lockfile 校验 192 条）
4. 提示词改成每 5 秒刷新（世界状态不再是快照）
5. 参数 schema 转成 DSH 认的形状（对象必须显式 additionalProperties）
6. 干跑验证：mock ctx 下 18 个工具全部注册成功
7. 修复 `apply` 必须同步（返回 disposer）：之前用 async apply 会让 cordis 报 "never started"；现在异步初始化在内部 boot()
8. preset 里的插件模块名改成包名 `dsh-icl-live/index.mjs`（之前写成 `icl-live/index.mjs` 解析不到）

待你重启 DSH 后验证：

- 新建会话时能看到「ICL Live」预设
- 会话里能看到 18 个工具（remember / recall / memo* / lexicon* / read_file / write_file / list_dir / bili_* / world_status）
- 人格段出现且时间在走

仍未做：

- 会话自动创建（`api.sessions.create`）
- 真实压缩联调
- 楼中楼、时间优先的块、印象优先提示词


---

## H. 整理（做梦）怎么触发

1. **到点自动**：`icl-live` 每 30 秒看一次 rhythm 的下一次做梦时间（默认 23:00），
   到点就跑一轮 wash → events → people → lexicon → consume → cleanup → index。
2. **手动收尾**：会话里有个 `dream_now` 工具，让她"睡一觉"或对方说"整理一下"即可，
   不用等到点。
3. **原文来源**：`dsh-raw` 已接进 live 会话，dream 从 `~/.dsh/sessions` 读原话。

## I. 压缩的坑（未解决，先绕开）

- live 预设**没有**接自定义压缩，DSH 自带压缩在上下文接近上限时会自动触发。
- 自动压缩会改写历史，做梦读到的原文就变样了。
- 现阶段的对策：**测试会话控制在 10–15 分钟**，结束前调 `dream_now`，
  不让上下文逼近上限。真正的压缩联调是后续工作。
