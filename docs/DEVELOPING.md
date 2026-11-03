# 开发指南

> 读者：要改代码或写文档的人。
> 范围：约定与流程。事实查 [STATUS.md](STATUS.md)，契约查 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 环境与命令

没有构建步骤，没有打包，没有 lint 配置。

```bash
npm test        # node --test packages/core/test
```

- Node ≥ 22（`engines`），实测 Node 26。
- 核心零依赖。只有适配器需要 `js-yaml` 与 `@deepseek-ai/dsh-host-apiproxy`——
  **这两个还没写进任何 `package.json`**，目前靠 `node_modules` 里的链接。
  在这个缺陷修掉之前，`npm install` 会删掉它们。
- 所有测试跑在 `os.tmpdir()` 的临时 SQLite 上，**不碰真实 DSH、模型与网络**。这是硬约束：
  测试一旦需要网络就不可信了。

## 2. 加一个插件

```
packages/plugins/<id>/
  manifest.json     # id / version / entry / tools / slots / focus / requires
  package.json      # name + type:module
  src/index.mjs     # export function apply(ctx) { ... return dispose }
```

五条容易踩的规则：

1. **`apply` 必须同步返回 disposer**。异步初始化放在内部 `boot()`，否则 cordis 报 `never started`。
2. **工具必须同时写进 `manifest.tools`**。注册表本身不校验归属，真正过滤发生在 `surface.list()`
   （它靠 manifest 反查 owner）——漏写不会报错，工具会静默消失。
3. **插件不直接发 HTTP、不写模型名和 key**。`boundary.test.mjs` 会扫源码，只有 `model-manager` 例外。
   要模型就声明 `slots`，要形状就写 `requires: { dim: 1024 }` 之类。
4. **依赖只声明 `requires.plugins`**（启用顺序检查）。服务/能力依赖靠 `ctx.services.require()`，
   核心不校验，取不到就抛。
5. **`presets` 目前是空转的**。插件的 `manifest.presets` 不会被任何代码读取，
   唯一预设有且只有 `default`，`presets.use()` 没有调用方。想按预设裁剪工具面，
   得先把这条链接通，而不是在 manifest 里加字段。

## 3. 加一个服务 / 一个工具

- 加服务要动四处：`services.mjs` 的工厂、`host.mjs` 的装配、`ctx` 的挂载、`index.mjs` 的导出。
  最后一项最容易漏——现在就有 8 个工厂没从 `index.mjs` 导出，测试只能深路径 import。
- 加工具走 `ctx.tools.register({ name, summary, description, when, avoid, safety, parameters, execute })`。
  `summary` 会被截到 160 字符进索引；描述由核心拼装，总长上限 900。
- 名字必须匹配 `^[a-z][a-z0-9_]*$`——**不允许连字符**。

## 4. 写测试

- 用 `createHost()` + `registerPlugin()` + `enable()` 起一个真宿主，不要 mock 服务。
- 需要 DSH 就写 `fakeDsh`（只有 `tools.register` 与 `systemPrompt.section`），不要去连真端口。
- 覆盖"跳过"与"失败"分支：做梦的每个 job 都至少要有 `already-ran`、`no-input`、模型抛错三种。
- 负向断言要能失败。历史上出现过 `doesNotMatch(/出处：/)` 这种恒真断言——代码里根本没有那个字符串。

## 5. 写文档

### 一份事实只有一个归属地

| 事实 | 只写在这里 |
|---|---|
| 服务签名、预算常量、SQLite 表结构、装配顺序 | `ARCHITECTURE.md` |
| 命名空间、打分公式、做梦七步 | `MEMORY.md` |
| 时间状态机、`time_arrange` 语法、控制通道 | `TIME.md` |
| 每个插件的工具、配置、成熟度 | `PLUGINS.md` |
| profile / preset / 会话创建 / 发消息 | `DSH-INTEGRATION.md` |
| 测试数、缺陷、下一步 | `STATUS.md` |
| 代际关系与教训 | `HISTORY.md` |
| 项目是什么、卡在哪 | `OVERVIEW.md` |

别的文档一律**链接**过去，不要复制一段数字——复制就会分叉。

### 三条硬规则

1. **数字必须能追溯**：写"193 通过（2026-11-03 实测）"，不写"测试全部通过"。
2. **不写"本文已过期"**。文档过期只有两种处理：改对，或删掉。加上过期头只会让下一个人多读一份。
3. **不写规划进参考文档**。计划放 `STATUS.md §7`，参考文档只描述"现在是什么"。

### 文档检查清单（改完自查）

- [ ] 每个数字都能在代码或测试里找到
- [ ] 没有和另一份文档重复的事实段
- [ ] 引用的文件路径与锚点存在
- [ ] 没有"我们认为 / 值得注意的是 / 综上所述"
- [ ] 删掉的文档没有别处还在引用

## 6. 用官方 DSH skill

`.dsh/skills/` 里是从 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
取来的官方 skill。在这个工作区里，agent 应该：

| 场景 | 加载哪个 |
|---|---|
| 写/改 DSH 插件、bundle、preset、工具面 | `cordis-plugin-development` |
| 改 `cordis.yml` / 组合配置 | `editing-cordis-compositions`、`cordis-composition-reference` |
| 代码审查 | `dsh-code-review` |
| 写文档、改注释 | `dsh-prose-standard` |
| 错误处理与失败上报 | `dsh-error-handling` |
| 会话状态/投影相关 | `dsh-session-projection` |

它们描述的是 DSH 上游的写法（TypeScript、`@deepseek-ai/dsh-*` 包、pnpm workspace），
**本仓库是纯 ESM 的 `.mjs`、无构建、自有宿主**——照搬会跑偏。用法是取原则，不取形式：
错误要显式、注册要可注销、配置要显式、失败要响。来源与版本见 [.dsh/skills/README.md](../.dsh/skills/README.md)。

## 7. 提交前

```bash
npm test                                   # 必须全绿
git status --short                         # 不要提交 state/ 与评测产物
```

提交信息沿用现有风格：`type(scope): 一句话说做了什么`（`feat` / `fix` / `docs` / `refactor` / `test`）。
描述写"为什么"，不写"改了哪几行"。
